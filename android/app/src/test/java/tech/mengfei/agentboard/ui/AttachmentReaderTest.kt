package tech.mengfei.agentboard.ui

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import tech.mengfei.agentboard.data.DiagnosticReason
import java.io.ByteArrayInputStream

class AttachmentReaderTest {
    @Test fun rejectKnownOversizeButKeepReadableFilesWithNoReportedMimeType() {
        val oversize = readAttachment("private", ATTACHMENT_BYTE_LIMIT + 1L, "text/plain") { error("unexpected read") }
        assertEquals(AttachmentRead.Failed(DiagnosticReason.TOO_LARGE), oversize)
        val noType = readAttachment("private", 1, null) { byteArrayOf(1).inputStream() } as AttachmentRead.Loaded
        assertEquals("application/octet-stream", noType.item.mime)
    }

    @Test fun handleUnknownSizeEmptyAndUnreadableProviders() {
        val oversize = readAttachment(null, null, "text/plain") { ByteArray(ATTACHMENT_BYTE_LIMIT + 1).inputStream() }
        assertEquals(AttachmentRead.Failed(DiagnosticReason.TOO_LARGE), oversize)
        val empty = readAttachment(null, -1, "text/plain") { ByteArray(0).inputStream() }
        assertEquals(AttachmentRead.Failed(DiagnosticReason.EMPTY), empty)
        assertEquals(AttachmentRead.Failed(DiagnosticReason.UNREADABLE), readAttachment(null, null, "text/plain") { null })
    }

    @Test fun oversizedSelectionSkipsExtraProvidersAndReportsOnlyReasons() =
        runTest {
            val reasons = mutableListOf<DiagnosticReason>()
            val opened = mutableListOf<Int>()
            val picked =
                readSelection(listOf(1, 2, 3), ATTACHMENT_COUNT_LIMIT - 2, reasons::add) { number ->
                    opened.add(number)
                    if (number == 2) {
                        AttachmentRead.Failed(DiagnosticReason.UNREADABLE)
                    } else {
                        readAttachment(null, null, "text/plain") { byteArrayOf(1).inputStream() }
                    }
                }
            assertEquals(1, picked.size)
            assertEquals(listOf(1, 2), opened)
            assertEquals(listOf(DiagnosticReason.LIMIT, DiagnosticReason.UNREADABLE), reasons)
        }

    @Test fun keepValidMetadataAndPayloadOnSuccessOnly() {
        val ok =
            readAttachment(
                "  report.txt  ",
                null,
                " text/plain ",
            ) { ByteArrayInputStream("ok".toByteArray()) } as AttachmentRead.Loaded
        assertEquals("report.txt", ok.item.originalName)
        assertEquals("text/plain", ok.item.mime)
        assertEquals(2L, ok.item.size)
        assertEquals("b2s=", ok.item.dataBase64)
    }
}
