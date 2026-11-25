package tech.mengfei.agentboard

import android.app.Application
import tech.mengfei.agentboard.data.AppDiagnostics
import tech.mengfei.agentboard.data.DiagnosticEvent
import tech.mengfei.agentboard.data.DiagnosticReason
import tech.mengfei.agentboard.data.OkHttpRelay
import tech.mengfei.agentboard.data.RelayApi
import tech.mengfei.agentboard.data.SessionStore
import tech.mengfei.agentboard.data.recordPreviousProcessExit
import tech.mengfei.agentboard.notify.DoneNotifier

class AgentBoardApp : Application() {
    val diagnostics by lazy { AppDiagnostics(this) }
    lateinit var store: SessionStore
        private set
    lateinit var relay: RelayApi
        private set
    lateinit var notifier: DoneNotifier
        private set

    override fun onCreate() {
        super.onCreate()
        store = SessionStore(this)
        diagnostics.recordLocal(DiagnosticEvent.APP_STARTED)
        recordPreviousProcessExit(this, diagnostics)
        relay = OkHttpRelay()
        notifier =
            DoneNotifier(this) {
                diagnostics.recordLocal(DiagnosticEvent.NOTIFICATION_FAILED, reason = DiagnosticReason.PERMISSION)
            }
        notifier.ensureChannel()
    }
}
