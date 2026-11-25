package tech.mengfei.agentboard.data

import android.app.ApplicationExitInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PreviousProcessExitTest {
    @Test fun classifiesOnlyConfirmedAbnormalExits() {
        assertEquals(DiagnosticReason.ANR, exitDiagnosticReason(ApplicationExitInfo.REASON_ANR))
        assertEquals(DiagnosticReason.CRASH, exitDiagnosticReason(ApplicationExitInfo.REASON_CRASH_NATIVE))
        assertEquals(DiagnosticReason.CRASH, exitDiagnosticReason(ApplicationExitInfo.REASON_CRASH))
        assertEquals(DiagnosticReason.LOW_MEMORY, exitDiagnosticReason(ApplicationExitInfo.REASON_LOW_MEMORY))
        assertNull(exitDiagnosticReason(ApplicationExitInfo.REASON_USER_REQUESTED))
        assertNull(exitDiagnosticReason(ApplicationExitInfo.REASON_EXIT_SELF))
        assertNull(exitDiagnosticReason(ApplicationExitInfo.REASON_UNKNOWN))
    }
}
