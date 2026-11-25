package tech.mengfei.agentboard.data

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

internal data class DiagnosticKey(
    val credentialId: String,
    val deviceId: String,
    val httpBase: String,
) {
    // Length-prefixed tuple, not a delimiter-joined name. Tokens never enter the inbox or store.
    val digest: String by lazy {
        val tuple = ByteArrayOutputStream()
        DataOutputStream(tuple).use {
            it.writeUTF(credentialId)
            it.writeUTF(deviceId)
            it.writeUTF(httpBase)
        }
        encodeDigest(MessageDigest.getInstance("SHA-256").digest(tuple.toByteArray()))
    }
}

private fun encodeDigest(bytes: ByteArray): String = Base64.getEncoder().withoutPadding().encodeToString(bytes)

internal data class DiagnosticRow(
    val owner: String,
    val id: UUID,
    val ts: Long,
    val event: DiagnosticEvent,
    val operation: DiagnosticOperation? = null,
    val reason: DiagnosticReason? = null,
    val count: Int = 1,
) {
    init {
        require(count in 1..65535)
    }
}

/** One worker-confined FIFO and one atomic snapshot, including local-only status history.
 * V1: 4 + 3072 * 70 = 215044 bytes. V2 encodes the same digest as 32 binary bytes
 * plus an explicit local marker: 29 + 10 * 13 + 3072 * 62 = 190623 bytes maximum.
 * Either snapshot plus a replacement fits in the original 430088-byte budget.
 */
internal class DiagnosticStore(
    directory: File,
) {
    private val file = File(directory, "queue")
    private val temp = File(directory, "queue.tmp")
    var rows: List<DiagnosticRow> = emptyList()
        private set
    var status = DiagnosticStatus(waitReason = null)
        private set

    init {
        Files.createDirectories(directory.toPath())
        Files.deleteIfExists(temp.toPath())
        if (file.length() > MAX_BYTES) Files.delete(file.toPath())
        if (file.exists()) {
            try {
                DataInputStream(file.inputStream().buffered()).use { load(it, file.length()) }
            } catch (_: IllegalArgumentException) {
                // Damaged metadata. Never use partial rows or guess an owner.
            } catch (_: java.io.EOFException) {
                // Truncated snapshot.
            }
        }
    }

    fun append(new: List<DiagnosticRow>) = replace((rows + new).takeLast(LIMIT), summarize(status, new))

    fun ack(
        owner: String,
        ids: Set<UUID>,
        atMs: Long,
    ) = replace(rows.filterNot { it.owner == owner && it.id in ids }, status.copy(lastAckAtMs = atMs))

    private fun summarize(
        previous: DiagnosticStatus,
        new: List<DiagnosticRow>,
    ): DiagnosticStatus {
        var info = previous.infoCount
        var errors = previous.errorCount
        val recent = previous.recentErrors.toMutableList()
        for (row in new) {
            if (row.event.level == "error") {
                errors += row.count
                recent.add(0, DiagnosticError(row.ts, row.event, row.operation, row.reason, row.count))
                if (recent.size > RECENT_LIMIT) recent.removeAt(RECENT_LIMIT)
            } else {
                info += row.count
            }
        }
        return previous.copy(infoCount = info, errorCount = errors, recentErrors = recent)
    }

    private fun replace(
        next: List<DiagnosticRow>,
        summary: DiagnosticStatus,
    ) {
        FileOutputStream(temp).use { stream ->
            val out = DataOutputStream(stream.buffered())
            out.writeInt(V2)
            out.writeLong(summary.lastAckAtMs ?: -1)
            out.writeLong(summary.infoCount)
            out.writeLong(summary.errorCount)
            out.writeByte(summary.recentErrors.size)
            for (error in summary.recentErrors) {
                out.writeFields(error.timestampMs, error.event, error.operation, error.reason, error.count)
            }
            for (row in next) {
                out.writeBoolean(row.owner == LOCAL_ONLY)
                out.write(if (row.owner == LOCAL_ONLY) LOCAL_BYTES else Base64.getDecoder().decode(row.owner))
                out.writeLong(row.id.mostSignificantBits)
                out.writeLong(row.id.leastSignificantBits)
                out.writeFields(row.ts, row.event, row.operation, row.reason, row.count)
            }
            out.flush()
            stream.fd.sync()
        }
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        install(next, summary)
    }

    private fun install(
        next: List<DiagnosticRow>,
        summary: DiagnosticStatus,
    ) {
        rows = next
        status = summary.copy(pendingCount = next.count { it.owner != LOCAL_ONLY })
    }

    private fun load(
        input: DataInputStream,
        size: Long,
    ) {
        when (input.readInt()) {
            V1 -> {
                val legacy =
                    List(rowCount(size - 4, 70)) {
                        require(input.readUnsignedShort() == 43)
                        val owner = ByteArray(43).also(input::readFully).toString(Charsets.US_ASCII)
                        require(owner == LOCAL_ONLY || encodeDigest(Base64.getDecoder().decode(owner)) == owner)
                        val id = UUID(input.readLong(), input.readLong())
                        val ts = input.readLong()
                        val code = input.readUnsignedByte()
                        require(code < 10)
                        DiagnosticRow(owner, id, ts, DiagnosticEvent.entries[code])
                    }
                install(legacy, summarize(status, legacy)) // Lazy migration at the next normal write/ACK.
            }

            V2 -> {
                val ack = input.readLong()
                val info = input.readLong()
                val errors = input.readLong()
                val recentSize = input.readUnsignedByte()
                require(info >= 0 && errors >= 0 && recentSize <= RECENT_LIMIT)
                val count = rowCount(size - 29 - 13 * recentSize, 62)
                val recent = List(recentSize) { input.readFields().also { require(it.event.level == "error") } }
                val next =
                    List(count) {
                        val local = input.readUnsignedByte()
                        require(local <= 1)
                        val bytes = ByteArray(32).also(input::readFully)
                        val owner = if (local == 1) LOCAL_ONLY else encodeDigest(bytes)
                        val id = UUID(input.readLong(), input.readLong())
                        val (ts, event, op, reason, repeats) = input.readFields()
                        require(!event.localOnly || owner == LOCAL_ONLY)
                        DiagnosticRow(owner, id, ts, event, op, reason, repeats)
                    }
                install(
                    next,
                    status.copy(lastAckAtMs = ack.takeUnless { it == -1L }, infoCount = info, errorCount = errors, recentErrors = recent),
                )
            }
        }
    }

    private fun rowCount(
        bytes: Long,
        width: Int,
    ): Int {
        require(bytes in 0..LIMIT.toLong() * width && bytes % width == 0L)
        return (bytes / width).toInt()
    }

    private fun DataOutputStream.writeFields(
        ts: Long,
        event: DiagnosticEvent,
        op: DiagnosticOperation?,
        reason: DiagnosticReason?,
        count: Int,
    ) {
        writeLong(ts)
        writeByte(event.ordinal)
        writeByte(op?.ordinal ?: NONE)
        writeByte(reason?.ordinal ?: NONE)
        writeShort(count)
    }

    private fun DataInputStream.readFields(): DiagnosticError {
        val ts = readLong()
        val event = requireNotNull(DiagnosticEvent.entries.getOrNull(readUnsignedByte()))
        val op = readUnsignedByte().takeUnless { it == NONE }?.let { requireNotNull(DiagnosticOperation.entries.getOrNull(it)) }
        val reason = readUnsignedByte().takeUnless { it == NONE }?.let { requireNotNull(DiagnosticReason.entries.getOrNull(it)) }
        val count = readUnsignedShort()
        require(count > 0)
        return DiagnosticError(ts, event, op, reason, count)
    }

    companion object {
        const val LIMIT = 3072
        const val MAX_BYTES = 215044L
        val LOCAL_ONLY = ":".repeat(43)
        private val LOCAL_BYTES = ByteArray(32)
        private const val V1 = 0x44494131
        private const val V2 = 0x44494132
        private const val NONE = 255
        private const val RECENT_LIMIT = 10
    }
}
