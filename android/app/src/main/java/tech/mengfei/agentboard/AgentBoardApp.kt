package tech.mengfei.agentboard

import android.app.Application
import tech.mengfei.agentboard.data.OkHttpRelay
import tech.mengfei.agentboard.data.RelayApi
import tech.mengfei.agentboard.data.SessionStore
import tech.mengfei.agentboard.notify.DoneNotifier

class AgentBoardApp : Application() {
    lateinit var store: SessionStore
        private set
    lateinit var relay: RelayApi
        private set
    lateinit var notifier: DoneNotifier
        private set

    override fun onCreate() {
        super.onCreate()
        store = SessionStore(this)
        relay = OkHttpRelay()
        notifier = DoneNotifier(this)
        notifier.ensureChannel()
    }
}
