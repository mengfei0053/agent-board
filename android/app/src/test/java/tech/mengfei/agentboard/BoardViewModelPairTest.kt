package tech.mengfei.agentboard

import android.content.Context
import kotlinx.coroutines.ExperimentalCoroutinesApi
import android.content.SharedPreferences
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import tech.mengfei.agentboard.data.HttpResult
import tech.mengfei.agentboard.data.RelayApi
import tech.mengfei.agentboard.data.SessionStore
import tech.mengfei.agentboard.data.SocketListener
import tech.mengfei.agentboard.notify.DoneNotifier
import tech.mengfei.agentboard.protocol.CatalogDocument
import tech.mengfei.agentboard.protocol.CredentialSecret
import tech.mengfei.agentboard.protocol.DiskOp
import tech.mengfei.agentboard.protocol.MigrationState
import tech.mengfei.agentboard.protocol.PhoneSession
import tech.mengfei.agentboard.protocol.SWITCHED_PREFIX
import tech.mengfei.agentboard.protocol.decodeCatalog
import tech.mengfei.agentboard.protocol.text

/**
 * Holds the pair HTTP call inside [BoardViewModel.pair], then releases a successful body
 * after a real navigation entry point has left Add.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BoardViewModelPairTest {
    private val main = UnconfinedTestDispatcher()

    @Before
    fun setMain() {
        Dispatchers.setMain(main)
    }

    @After
    fun resetMain() {
        Dispatchers.resetMain()
    }

    @Test
    fun sameSessionNotificationDoesNotPersistTheDeferredPair() {
        val harness = heldAdd(listOf(board("sA", "Office", "board-a")))
        harness.model.openNotification("sA", "task_9")
        val detail = harness.model.state.value.screen
        assertEquals(Screen.Detail("sA", "task_9"), detail)
        harness.releaseSuccess()
        assertEquals(Screen.Detail("sA", "task_9"), harness.model.state.value.screen)
        assertEquals("sA", harness.model.state.value.activeSessionId)
        assertEquals("sA", harness.store.readDisk().catalog!!.activeSessionId)
        assertEquals(listOf("sA"), harness.persistedOrder())
        assertEquals(setOf("c1"), harness.store.readDisk().credentials.keys)
        assertNull(harness.model.state.value.banner)
    }

    @Test
    fun backDoesNotPersistTheDeferredPair() {
        val harness = heldAdd(listOf(board("sA", "Office", "board-a")))
        harness.model.pop()
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        harness.releaseSuccess()
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        assertEquals("sA", harness.model.state.value.activeSessionId)
        assertEquals("sA", harness.store.readDisk().catalog!!.activeSessionId)
        assertEquals(listOf("sA"), harness.persistedOrder())
        assertEquals(setOf("c1"), harness.store.readDisk().credentials.keys)
        assertNull(harness.model.state.value.banner)
    }

    @Test
    fun boardSelectionDoesNotPersistTheDeferredPair() {
        val harness = heldAdd(
            listOf(
                board("sA", "Office", "board-a"),
                board("sB", "Cabin", "board-b"),
            ),
        )
        harness.model.activateSession("sB", tech.mengfei.agentboard.protocol.BoardPickPath.TopSwitcher)
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        assertEquals("sB", harness.model.state.value.activeSessionId)
        harness.releaseSuccess()
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        assertEquals("sB", harness.model.state.value.activeSessionId)
        assertEquals("sB", harness.store.readDisk().catalog!!.activeSessionId)
        assertEquals(listOf("sA", "sB"), harness.persistedOrder())
        assertEquals(setOf("c1"), harness.store.readDisk().credentials.keys)
        assertEquals(SWITCHED_PREFIX + "Cabin", harness.model.state.value.banner)
        assertFalse(harness.model.state.value.banner!!.contains("Home Mac"))
    }

    @Test
    fun pairThatStaysOnAddPersistsTheNewBoard() {
        val harness = heldAdd(listOf(board("sA", "Office", "board-a")))
        assertEquals(Screen.AddBoard, harness.model.state.value.screen)
        harness.releaseSuccess()
        val order = harness.persistedOrder()
        val active = harness.store.readDisk().catalog!!.activeSessionId
        assertEquals(Screen.Tasks, harness.model.state.value.screen)
        assertTrue(harness.model.state.value.banner!!.startsWith(SWITCHED_PREFIX))
        assertTrue(harness.model.state.value.banner!!.contains("Home Mac"))
        assertEquals(2, order.size)
        assertEquals("sA", order.first())
        assertEquals(order.last(), active)
        assertEquals(active, harness.model.state.value.activeSessionId)
        assertEquals(2, harness.store.readDisk().credentials.size)
    }

    private fun heldAdd(sessions: List<PhoneSession>): Harness {
        val plain = MemoryPrefs()
        val secretPrefs = MemoryPrefs()
        val store = SessionStore(plain, secretPrefs)
        val boards = sessions.map { it.boardId }
        store.apply(
            DiskOp.PutCredential(
                CredentialSecret("c1", "dt_old", "dev", 50, "https://relay.example", "wss://relay.example/v1/ws", boards),
            ),
        )
        store.apply(
            DiskOp.PutCatalog(
                CatalogDocument(
                    catalogVersion = 1,
                    migrationState = MigrationState.COMMITTED,
                    order = sessions.map { it.sessionId },
                    sessions = sessions,
                    activeSessionId = sessions.first().sessionId,
                    migrationCredentialId = null,
                ),
            ),
        )
        val relay = HoldingRelay()
        val model = BoardViewModel(store, relay, DoneNotifier(mock(Context::class.java)), englishUi = false)
        model.openAddBoard()
        model.updateDisplayName("Home Mac")
        model.updateHttpBase("https://relay.example")
        model.updatePairCode("pc_" + "a".repeat(43))
        model.pair()
        assertTrue(relay.started.isCompleted)
        assertTrue(model.state.value.busy)
        assertEquals(Screen.AddBoard, model.state.value.screen)
        return Harness(model, store, plain, relay)
    }

    private fun board(id: String, name: String, boardId: String) = PhoneSession(id, "c1", boardId, name, 1)

    private class Harness(
        val model: BoardViewModel,
        val store: SessionStore,
        val plain: MemoryPrefs,
        val relay: HoldingRelay,
    ) {
        fun releaseSuccess() {
            relay.release(
                HttpResult(
                    200,
                    """{"deviceId":"dev_new","deviceToken":"dt_newtoken","role":"phone","boardIds":["board-new"],"expiresAt":80}""",
                ),
            )
        }

        fun persistedOrder(): List<String> = decodeCatalog(plain.getString("catalog", null)!!)!!.order
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class BoardConnectionTest {
    private val main = UnconfinedTestDispatcher()

    @Before
    fun setup() { Dispatchers.setMain(main) }

    @After
    fun teardown() { Dispatchers.resetMain() }

    @Test
    fun coldStartPollsAfterAuthenticationAndDoesNotReplayHealthySubscriptions() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground() // The socket has not authenticated yet.
            relay.authenticate()
            assertEquals("已连接", model.state.value.connection)
            main.scheduler.advanceTimeBy(90_001)
            assertEquals("已连接", model.state.value.connection)
            assertTrue(relay.sent.count { it.type == "board.list" } >= 7)
            assertEquals(1, relay.sent.count { it.type == "sub.tasks" })
            model.onBackground()
            val count = relay.sent.size
            main.scheduler.advanceTimeBy(30_001)
            assertEquals(count, relay.sent.size)
            model.onForeground()
            assertEquals("已连接", model.state.value.connection)
        } finally { owner.clear() }
    }

    @Test
    fun unansweredStatusRequestReconnectsInsteadOfStayingAuthenticatedForever() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            relay.authenticate()
            relay.replyToLists = false
            main.scheduler.advanceTimeBy(31_001)
            assertTrue(relay.opens > 1)
            assertFalse(model.state.value.connection == "已连接")
        } finally { owner.clear() }
    }

    @Test
    fun socketThatNeverAuthenticatesIsRetriedAfterTheHandshakeDeadline() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            main.scheduler.advanceTimeBy(20_001)
            assertEquals(2, relay.opens)
            assertFalse(model.state.value.connection == "已连接")
        } finally { owner.clear() }
    }

    @Test
    fun repeatedGapNotificationsDoNotCreateAResubscribeStorm() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            relay.authenticate()
            repeat(100) { relay.gap() }
            main.scheduler.advanceTimeBy(1_000)
            assertEquals(1, relay.sent.count { it.type == "sub.tasks" })
            assertEquals("正在同步", model.state.value.connection)
            main.scheduler.advanceTimeBy(15_001)
            assertEquals(2, relay.sent.count { it.type == "sub.tasks" })
            relay.newGenerationSnapshot(2)
            assertEquals("已连接", model.state.value.connection)
            model.reconnectActiveBoard()
            assertEquals(2, relay.opens)
        } finally { owner.clear() }
    }

    @Test
    fun openCreateLoadsSettingsWithoutBlockingCreateOrShowingAcceptedBanner() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            relay.authenticateWithWorkspaceAndSettings()
            model.openCreate()
            assertEquals(Screen.Create("s1"), model.state.value.screen)
            assertEquals("send", model.state.value.createMode)
            assertNull(model.state.value.commandNote)
            assertNull(model.state.value.formError)
            val settingsGet = relay.sent.last { it.type == "cmd.settings.get" }
            relay.acceptSettings(settingsGet.id)
            assertEquals("send", model.state.value.createMode)
            assertNull(model.state.value.commandNote)
            assertNull(model.state.value.formError)
            relay.executeSettings(settingsGet.id)
            assertEquals("send", model.state.value.createMode)
            assertNull(model.state.value.commandNote)
            assertNull(model.state.value.formError)
            assertEquals(1, model.state.value.quickPrompts.size)
            assertEquals(
                listOf("mgp/antigravity/gemini-4-argon"),
                model.state.value.modelCatalog.agentModels["pi"]?.map { it.model },
            )
            model.updateDraftAgent("pi")
            model.updateDraftModel("mgp/antigravity/gemini-4-argon")
            model.updateDraftThinkingEffort("high")
            model.updateDraftTitle("Ship model picker")
            model.updateDraftPrompt("Run with selected model")
            model.submitCreate()
            val createCmd = relay.sent.last { it.type == "cmd.create" }
            assertEquals("pi", createCmd.text("agent"))
            assertEquals("mgp/antigravity/gemini-4-argon", createCmd.text("model"))
            assertEquals("high", createCmd.text("thinkingEffort"))
        } finally { owner.clear() }
    }

    @Test
    fun continueTaskForwardsSelectedModelAndThinkingEffort() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            relay.authenticateWithCompletedTask()
            val settingsGetAfterOpen: tech.mengfei.agentboard.protocol.Envelope
            model.openTask("task_1")
            model.openContinue()
            settingsGetAfterOpen = relay.sent.last { it.type == "cmd.settings.get" }
            relay.executeSettings(settingsGetAfterOpen.id)
            model.updateContinuePrompt("Continue with new model")
            model.updateContinueModel("mgp/antigravity/gemini-4-argon")
            model.updateContinueThinkingEffort("xhigh")
            model.submitContinue()
            val contCmd = relay.sent.last { it.type == "cmd.continue" }
            assertEquals("task_1", contCmd.text("taskId"))
            assertEquals("Continue with new model", contCmd.text("prompt"))
            assertEquals("mgp/antigravity/gemini-4-argon", contCmd.text("model"))
            assertEquals("xhigh", contCmd.text("thinkingEffort"))
        } finally { owner.clear() }
    }

    private fun harness(): Triple<BoardViewModel, ConnectionRelay, androidx.lifecycle.ViewModelStore> {
        val store = SessionStore(MemoryPrefs(), MemoryPrefs())
        store.apply(DiskOp.PutCredential(CredentialSecret("c1", "dt_test", "dev", Long.MAX_VALUE,
            "https://relay.example", "wss://relay.example/v1/ws", listOf("board-a"))))
        store.apply(DiskOp.PutCatalog(CatalogDocument(catalogVersion = 1,
            migrationState = MigrationState.COMMITTED, order = listOf("s1"),
            sessions = listOf(PhoneSession("s1", "c1", "board-a", "Office", 1)),
            activeSessionId = "s1", migrationCredentialId = null)))
        val relay = ConnectionRelay()
        val model = BoardViewModel(store, relay, DoneNotifier(mock(Context::class.java)),
            clock = { 1_000L + main.scheduler.currentTime })
        val owner = androidx.lifecycle.ViewModelStore()
        owner.put("model", model)
        return Triple(model, relay, owner)
    }
}

private class ConnectionRelay : RelayApi {
    lateinit var listener: SocketListener
    val sent = mutableListOf<tech.mengfei.agentboard.protocol.Envelope>()
    var opens = 0
    var replyToLists = true
    override suspend fun request(method: String, url: String, body: String?) = HttpResult(200, "{}")
    override fun openSocket(credentialId: String, url: String, listener: SocketListener) {
        opens += 1
        this.listener = listener
    }
    override fun send(credentialId: String, text: String): Boolean {
        val message = tech.mengfei.agentboard.protocol.parseEnvelope(text)
        sent += message
        if (message.type == "board.list" && replyToLists) {
            listener.onMessage("""{"v":1,"id":"list-ack","type":"ack","ts":1,"payload":{"ref":"${message.id}","stage":"executed","boards":[{"boardId":"board-a","online":true,"generation":1,"capabilities":["board.settings","workspace.settings"]}]}}""")
        }
        return true
    }
    fun authenticate() {
        listener.onOpen()
        val hello = sent.last { it.type == "client.hello" }
        listener.onMessage("""{"v":1,"id":"hello-ack","type":"ack","ts":1,"payload":{"ref":"${hello.id}","stage":"executed"}}""")
        listener.onMessage("""{"v":1,"id":"snapshot","type":"evt.snapshot","ts":1,"payload":{"boardId":"board-a","generation":1,"seq":1,"tasks":[],"workspaces":[]}}""")
    }
    fun gap() {
        listener.onMessage("""{"v":1,"id":"gap","type":"evt.gap","ts":2,"payload":{"boardId":"board-a","generation":1,"expectedSeq":3,"reason":"seq_gap"}}""")
    }
    fun newGenerationSnapshot(generation: Long) {
        listener.onMessage("""{"v":1,"id":"snap-$generation","type":"evt.snapshot","ts":3,"payload":{"boardId":"board-a","generation":$generation,"seq":1,"tasks":[],"workspaces":[]}}""")
    }
    fun authenticateWithWorkspaceAndSettings() {
        listener.onOpen()
        val hello = sent.last { it.type == "client.hello" }
        listener.onMessage("""{"v":1,"id":"hello-ack","type":"ack","ts":1,"payload":{"ref":"${hello.id}","stage":"executed"}}""")
        listener.onMessage("""{"v":1,"id":"snapshot","type":"evt.snapshot","ts":1,"payload":{"boardId":"board-a","generation":1,"seq":1,"tasks":[],"workspaces":[{"id":"ws_1","name":"Main","path":"/tmp/main","isGit":true}]}}""")
    }
    fun authenticateWithCompletedTask() {
        listener.onOpen()
        val hello = sent.last { it.type == "client.hello" }
        listener.onMessage("""{"v":1,"id":"hello-ack","type":"ack","ts":1,"payload":{"ref":"${hello.id}","stage":"executed"}}""")
        listener.onMessage("""{"v":1,"id":"snapshot","type":"evt.snapshot","ts":1,"payload":{"boardId":"board-a","generation":1,"seq":1,"tasks":[{"id":"task_1","title":"Done task","status":"succeeded","updatedAt":10,"agent":"pi","workspaceId":"ws_1","model":"old-model","thinkingEffort":"medium","sessionId":"sess_1"}],"workspaces":[{"id":"ws_1","name":"Main","path":"/tmp/main","isGit":true}]}}""")
    }
    fun acceptSettings(ref: String) {
        listener.onMessage("""{"v":1,"id":"settings-accepted","type":"ack","ts":2,"payload":{"ref":"$ref","stage":"accepted","commandId":"cmd-1"}}""")
    }
    fun executeSettings(ref: String) {
        listener.onMessage("""{"v":1,"id":"settings-exec","type":"ack","ts":3,"payload":{"ref":"$ref","stage":"executed","settings":{"quickPrompts":[{"id":"q1","label":"Fix","content":"Fix bug"}],"agentModels":{"pi":[{"model":"mgp/antigravity/gemini-4-argon","thinkingEfforts":["low","medium","high","xhigh"]}]},"thinkingEfforts":{"pi":["low","medium","high","xhigh"]},"modelHistory":{"pi":["mgp/antigravity/gemini-4-argon"]}}}}""")
    }
    override fun closeSocket(credentialId: String) = Unit
    override fun closeAll() = Unit
}

private class HoldingRelay : RelayApi {
    val started = CompletableDeferred<Unit>()
    private val pending = CompletableDeferred<HttpResult>()

    override suspend fun request(method: String, url: String, body: String?): HttpResult {
        if (!started.isCompleted) started.complete(Unit)
        return pending.await()
    }

    fun release(result: HttpResult) {
        pending.complete(result)
    }

    override fun openSocket(credentialId: String, url: String, listener: SocketListener) = Unit
    override fun send(credentialId: String, text: String): Boolean = true
    override fun closeSocket(credentialId: String) = Unit
    override fun closeAll() = Unit
}

private class MemoryPrefs : SharedPreferences {
    private val values = HashMap<String, Any?>()

    override fun getAll(): MutableMap<String, *> = HashMap(values)
    override fun getString(key: String, defValue: String?): String? = values[key] as? String ?: defValue
    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
    override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue
    override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue
    override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue
    override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
    override fun contains(key: String): Boolean = key in values
    override fun edit(): SharedPreferences.Editor = Editor()
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit

    private inner class Editor : SharedPreferences.Editor {
        private val puts = HashMap<String, Any?>()
        private val removals = HashSet<String>()
        private var clearAll = false

        override fun putString(key: String, value: String?): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun putStringSet(key: String, values: MutableSet<String>?): SharedPreferences.Editor = this
        override fun putInt(key: String, value: Int): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun putLong(key: String, value: Long): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun putFloat(key: String, value: Float): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun putBoolean(key: String, value: Boolean): SharedPreferences.Editor {
            puts[key] = value
            return this
        }

        override fun remove(key: String): SharedPreferences.Editor {
            removals.add(key)
            return this
        }

        override fun clear(): SharedPreferences.Editor {
            clearAll = true
            return this
        }

        override fun commit(): Boolean {
            apply()
            return true
        }

        override fun apply() {
            if (clearAll) values.clear()
            removals.forEach { values.remove(it) }
            puts.forEach { (key, value) ->
                if (value == null) values.remove(key) else values[key] = value
            }
        }
    }
}
