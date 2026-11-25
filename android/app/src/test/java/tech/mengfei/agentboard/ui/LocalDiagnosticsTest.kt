package tech.mengfei.agentboard.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import tech.mengfei.agentboard.R
import tech.mengfei.agentboard.data.DiagnosticEvent
import tech.mengfei.agentboard.data.DiagnosticReason
import tech.mengfei.agentboard.data.DiagnosticWaitReason

class LocalDiagnosticsTest {
    @Test fun processExitsAndNotificationErrorsHaveDistinctReadableLabels() {
        assertEquals(R.string.diag_exit_abnormal, DiagnosticEvent.APP_EXIT_ABNORMAL.label())
        assertEquals(R.string.diag_notification_failed, DiagnosticEvent.NOTIFICATION_FAILED.label())
        assertEquals(R.string.diag_crash, DiagnosticReason.CRASH.label())
        assertEquals(R.string.diag_anr, DiagnosticReason.ANR.label())
        assertEquals(R.string.diag_low_memory, DiagnosticReason.LOW_MEMORY.label())
        assertEquals(R.string.diag_permission, DiagnosticReason.PERMISSION.label())
    }

    @Test fun uploadWaitsAreNotReportedAsBoardPresence() {
        assertEquals(R.string.diag_no_route, DiagnosticWaitReason.OFFLINE.label())
        assertEquals(R.string.diag_user_active, DiagnosticWaitReason.USER_ACTIVE.label())
        assertEquals(R.string.diag_board_offline, DiagnosticEvent.BOARD_OFFLINE.label())
    }
}
