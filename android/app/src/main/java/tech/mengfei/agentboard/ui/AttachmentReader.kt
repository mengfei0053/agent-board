package tech.mengfei.agentboard.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.CancellationException
import tech.mengfei.agentboard.R
import tech.mengfei.agentboard.data.DiagnosticReason
import tech.mengfei.agentboard.protocol.OutgoingAttachment
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Base64

internal const val ATTACHMENT_COUNT_LIMIT = 10
internal const val ATTACHMENT_BYTE_LIMIT = 8 * 1024 * 1024

internal sealed interface AttachmentRead {
    data class Loaded(
        val item: OutgoingAttachment,
    ) : AttachmentRead

    data class Failed(
        val reason: DiagnosticReason,
    ) : AttachmentRead
}

// Limit the selection before opening any provider; an oversized selection must not cause unbounded I/O.
internal suspend fun <T> readSelection(
    selected: List<T>,
    existingCount: Int,
    onFailure: (DiagnosticReason) -> Unit,
    read: suspend (T) -> AttachmentRead,
): List<OutgoingAttachment> {
    val remaining = (ATTACHMENT_COUNT_LIMIT - existingCount).coerceAtLeast(0)
    if (selected.size > remaining) onFailure(DiagnosticReason.LIMIT)
    return selected.take(remaining).mapNotNull { uri ->
        when (val result = read(uri)) {
            is AttachmentRead.Loaded -> {
                result.item
            }

            is AttachmentRead.Failed -> {
                onFailure(result.reason)
                null
            }
        }
    }
}

// Called on Dispatchers.IO. Neither provider metadata nor exceptions leave the failure path.
internal fun readUriAttachment(
    context: Context,
    uri: Uri,
): AttachmentRead =
    try {
        val resolver = context.contentResolver
        var name: String? = null
        var size: Long? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val s = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n)
                if (s >= 0 && !cursor.isNull(s)) size = cursor.getLong(s)
            }
        }
        readAttachment(name, size, resolver.getType(uri)) { resolver.openInputStream(uri) }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        AttachmentRead.Failed(DiagnosticReason.UNREADABLE)
    }

internal fun readAttachment(
    name: String?,
    size: Long?,
    type: String?,
    open: () -> InputStream?,
): AttachmentRead {
    if (size != null && size > ATTACHMENT_BYTE_LIMIT) return AttachmentRead.Failed(DiagnosticReason.TOO_LARGE)
    val bytes =
        open()?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(16 * 1024)
            while (true) {
                val count = input.read(buf)
                if (count < 0) break
                if (out.size() + count > ATTACHMENT_BYTE_LIMIT) return AttachmentRead.Failed(DiagnosticReason.TOO_LARGE)
                out.write(buf, 0, count)
            }
            out.toByteArray()
        } ?: return AttachmentRead.Failed(DiagnosticReason.UNREADABLE)
    if (bytes.isEmpty()) return AttachmentRead.Failed(DiagnosticReason.EMPTY)
    return AttachmentRead.Loaded(
        OutgoingAttachment(
            originalName = name?.trim()?.takeIf { it.isNotEmpty() }?.take(180) ?: "attachment",
            mime = type?.trim()?.takeIf { it.isNotEmpty() }?.take(120) ?: "application/octet-stream",
            size = bytes.size.toLong(),
            dataBase64 = Base64.getEncoder().encodeToString(bytes),
        ),
    )
}

internal fun attachmentFailureText(reason: DiagnosticReason): Int =
    when (reason) {
        DiagnosticReason.TOO_LARGE -> R.string.attachment_too_large
        DiagnosticReason.EMPTY -> R.string.attachment_missing_content
        DiagnosticReason.LIMIT -> R.string.attachment_count_exceeded
        else -> R.string.attachment_read_failed
    }
