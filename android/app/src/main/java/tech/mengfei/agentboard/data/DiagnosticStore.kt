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
        Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(tuple.toByteArray()))
    }
}

internal data class DiagnosticRow(
    val owner: String,
    val id: UUID,
    val ts: Long,
    val event: DiagnosticEvent,
)

/** One process-wide FIFO, not one file/quota per credential. Worker-thread only.
 * V1: 4-byte header + up to 3072 fixed 70-byte records = 215044 bytes.
 * Atomic replacement needs one same-sized temp: <=430088 bytes total file contents, excluding FS metadata.
 * `diag-v1` and the ordinal mapping below are on-disk format identifiers; do not reorder the codes.
 */
internal class DiagnosticStore(
    directory: File,
) {
    private val file = File(directory, "queue")
    private val temp = File(directory, "queue.tmp")
    var rows: List<DiagnosticRow> = emptyList()
        private set

    init {
        Files.createDirectories(directory.toPath())
        Files.deleteIfExists(temp.toPath()) // Only the atomically committed snapshot is authoritative.
        if (file.length() > MAX_BYTES) Files.delete(file.toPath()) // Do not retain an oversized damaged snapshot.
        if (file.exists()) rows = load()
    }

    fun append(new: List<DiagnosticRow>) = replace((rows + new).takeLast(LIMIT))

    fun ack(
        owner: String,
        ids: Set<UUID>,
    ) = replace(rows.filterNot { it.owner == owner && it.id in ids })

    private fun replace(next: List<DiagnosticRow>) {
        FileOutputStream(temp).use { stream ->
            val out = DataOutputStream(stream.buffered())
            out.writeInt(MAGIC)
            for (row in next) {
                out.writeUTF(row.owner) // 2 + 43 ASCII bytes
                out.writeLong(row.id.mostSignificantBits)
                out.writeLong(row.id.leastSignificantBits)
                out.writeLong(row.ts)
                out.writeByte(CODES.indexOf(row.event))
            }
            out.flush()
            stream.fd.sync()
        }
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        rows = next
    }

    private fun load(): List<DiagnosticRow> {
        val bytes = file.length()
        if (bytes !in 4L..MAX_BYTES || (bytes - 4) % RECORD_BYTES != 0L) return emptyList()
        return DataInputStream(file.inputStream().buffered()).use { input ->
            if (input.readInt() != MAGIC) return emptyList()
            buildList {
                repeat(((bytes - 4) / RECORD_BYTES).toInt()) {
                    // Check the fixed width before reading, even for a damaged file.
                    if (input.readUnsignedShort() != 43) return emptyList()
                    val owner = ByteArray(43).also(input::readFully).toString(Charsets.US_ASCII)
                    if (!owner.all { it.code in 0x21..0x7e }) return emptyList() // Keep re-serialized owners exactly 43 bytes.
                    val id = UUID(input.readLong(), input.readLong())
                    val ts = input.readLong()
                    val event = CODES.getOrNull(input.readUnsignedByte()) ?: return emptyList()
                    add(DiagnosticRow(owner, id, ts, event))
                }
            }
        }
    }

    companion object {
        const val LIMIT = 3072
        private const val RECORD_BYTES = 70
        const val MAX_BYTES = 4L + LIMIT * RECORD_BYTES
        private const val MAGIC = 0x44494131
        private val CODES =
            listOf(
                DiagnosticEvent.APP_STARTED,
                DiagnosticEvent.RELAY_CONNECTED,
                DiagnosticEvent.SNAPSHOT_SYNCED,
                DiagnosticEvent.COMMAND_SENT,
                DiagnosticEvent.COMMAND_EXECUTED,
                DiagnosticEvent.RELAY_DISCONNECTED,
                DiagnosticEvent.AUTH_REJECTED,
                DiagnosticEvent.SYNC_GAP,
                DiagnosticEvent.COMMAND_FAILED,
                DiagnosticEvent.COMMAND_TIMEOUT,
            )
    }
}
