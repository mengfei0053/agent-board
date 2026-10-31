package tech.mengfei.agentboard

import android.app.Application
import tech.mengfei.agentboard.data.OkHttpRelay
import tech.mengfei.agentboard.data.SessionStore
import tech.mengfei.agentboard.notify.DoneNotifier

class AgentBoardApp : Application() {
    lateinit var session: SessionStore
        private set
    lateinit var relay: OkHttpRelay
        private set
    lateinit var notifier: DoneNotifier
        private set

    override fun onCreate() {
        super.onCreate()
        session = SessionStore(this)
        relay = OkHttpRelay()
        notifier = DoneNotifier(this)
    }
}
