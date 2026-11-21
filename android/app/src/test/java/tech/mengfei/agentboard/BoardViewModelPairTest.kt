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
    fun cachedSnapshotDoesNotMarkAnOfflineBoardConnected() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            relay.listedBoards = listOf(ListedBoard("board-a", online = false, generation = 1))
            model.onForeground()
            relay.authenticate()
            assertEquals("离线", model.state.value.connection)
            assertFalse(model.state.value.writesAllowed)
            relay.snapshot("board-a", 1)
            assertEquals("离线", model.state.value.connection)
            assertFalse(model.state.value.writesAllowed)
        } finally { owner.clear() }
    }

    @Test
    fun presenceEventAndBoardSwitchFollowTheSelectedBoard() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val store = SessionStore(MemoryPrefs(), MemoryPrefs())
        store.apply(DiskOp.PutCredential(CredentialSecret("c1", "dt_test", "dev", Long.MAX_VALUE,
            "https://relay.example", "wss://relay.example/v1/ws", listOf("board-a", "board-b"))))
        store.apply(DiskOp.PutCatalog(CatalogDocument(catalogVersion = 1,
            migrationState = MigrationState.COMMITTED, order = listOf("s1", "s2"),
            sessions = listOf(
                PhoneSession("s1", "c1", "board-a", "Office", 1),
                PhoneSession("s2", "c1", "board-b", "Cabin", 2),
            ),
            activeSessionId = "s1", migrationCredentialId = null)))
        val relay = ConnectionRelay()
        relay.listedBoards = listOf(
            ListedBoard("board-a", online = true, generation = 1),
            ListedBoard("board-b", online = false, generation = 2),
        )
        val model = BoardViewModel(store, relay, DoneNotifier(mock(Context::class.java)),
            clock = { 1_000L + main.scheduler.currentTime })
        val owner = androidx.lifecycle.ViewModelStore()
        owner.put("model", model)
        try {
            model.onForeground()
            relay.authenticate()
            relay.snapshot("board-b", 2)
            assertEquals("已连接", model.state.value.connection)
            assertTrue(model.state.value.writesAllowed)
            assertEquals("已连接", model.state.value.sessions.first { it.sessionId == "s1" }.pill)
            assertEquals("离线", model.state.value.sessions.first { it.sessionId == "s2" }.pill)
            model.activateSession("s2")
            assertEquals("离线", model.state.value.connection)
            assertFalse(model.state.value.writesAllowed)
            model.activateSession("s1")
            assertEquals("已连接", model.state.value.connection)
            relay.listener.onMessage("""{"v":1,"id":"down","type":"evt.board","ts":4,"payload":{"boardId":"board-a","online":false,"generation":1}}""")
            assertEquals("离线", model.state.value.connection)
            relay.listener.onMessage("""{"v":1,"id":"up-b","type":"evt.board","ts":5,"payload":{"boardId":"board-b","online":true,"generation":2}}""")
            assertEquals("离线", model.state.value.connection)
            model.activateSession("s2")
            assertEquals("已连接", model.state.value.connection)
        } finally { owner.clear() }
    }

    @Test
    fun workspaceSwitchKeepsTheBoardPillAndADeadPhoneSocketIsNotConnected() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            relay.authenticate()
            relay.listener.onMessage(
                """{"v":1,"id":"snapshot-ws","type":"evt.snapshot","ts":2,"payload":{"boardId":"board-a","generation":1,"seq":2,"tasks":[],"workspaces":[{"id":"ws_1","name":"Main","path":"/tmp/main","isGit":true},{"id":"ws_2","name":"Other","path":"/tmp/other","isGit":false}]}}""",
            )
            assertEquals("已连接", model.state.value.connection)
            model.selectWorkspace("ws_2")
            assertEquals("ws_2", model.state.value.selectedWorkspaceId)
            assertEquals("已连接", model.state.value.connection)
            relay.listener.onClosed("relay unreachable")
            assertEquals("弱连接", model.state.value.connection)
            assertFalse(model.state.value.writesAllowed)
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
    fun consecutiveCreatesStartBlankAndCompleteIndependently() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            relay.authenticateWithWorkspaceAndSettings()
            model.openCreate()
            model.updateDraftTitle("First")
            model.updateDraftPrompt("First prompt")
            model.submitCreate()
            val first = relay.sent.last { it.type == "cmd.create" }
            relay.replyCreated(first.id, "task_1")
            assertEquals(Screen.Detail("s1", "task_1"), model.state.value.screen)
            model.pop()
            assertEquals(Screen.Tasks, model.state.value.screen)

            model.openCreate()
            assertEquals("", model.state.value.draftTitle)
            assertEquals("", model.state.value.draftPrompt)
            model.updateDraftTitle("Second")
            model.updateDraftPrompt("Second prompt")
            model.submitCreate()
            val creates = relay.sent.filter { it.type == "cmd.create" }
            assertEquals(2, creates.size)
            val second = creates.last()
            assertEquals("Second", second.text("title"))
            assertEquals("Second prompt", second.text("prompt"))
            assertFalse(first.text("idempotencyKey") == second.text("idempotencyKey"))
            relay.replyCreated(first.id, "task_1") // A late reply cannot finish the second create.
            assertEquals("busy", model.state.value.createMode)
            relay.replyCreated(second.id, "task_2")
            assertEquals(Screen.Detail("s1", "task_2"), model.state.value.screen)
        } finally { owner.clear() }
    }

    @Test
    fun reopeningDiscardsCancelledDraftButNotPendingCreate() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            relay.authenticateWithWorkspaceAndSettings()
            model.openCreate()
            model.updateDraftTitle("Abandoned")
            model.updateDraftPrompt("Abandoned prompt")
            model.pop()
            model.openCreate()
            assertEquals("", model.state.value.draftTitle)
            assertEquals("", model.state.value.draftPrompt)

            model.updateDraftTitle("Pending")
            model.updateDraftPrompt("Pending prompt")
            model.submitCreate()
            model.pop()
            model.openCreate()
            assertEquals(Screen.Tasks, model.state.value.screen)
            assertEquals("busy", model.state.value.createMode)
            val pending = relay.sent.single { it.type == "cmd.create" }
            relay.replyCreated(pending.id, "task_1")
            assertEquals(Screen.Detail("s1", "task_1"), model.state.value.screen)
        } finally { owner.clear() }
    }

    @Test
    fun newFormAfterLookupDoesNotSubmitTheOldCommand() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            model.onForeground()
            relay.authenticateWithWorkspaceAndSettings()
            model.openCreate()
            model.updateDraftTitle("Old")
            model.updateDraftPrompt("Old prompt")
            model.submitCreate()
            val first = relay.sent.last { it.type == "cmd.create" }
            relay.listener.onMessage("""{"v":1,"id":"timeout","type":"ack","ts":2,"payload":{"ref":"${first.id}","stage":"timeout"}}""")
            val lookup = relay.sent.last { it.type == "cmd.lookup" }
            relay.listener.onMessage("""{"v":1,"id":"result","type":"ack","ts":3,"payload":{"ref":"${lookup.id}","stage":"unknown"}}""")
            assertEquals("lookup", model.state.value.createMode)
            assertEquals("Old prompt", model.state.value.draftPrompt)
            model.pop()
            model.openCreate()
            assertEquals("send", model.state.value.createMode)
            assertEquals("", model.state.value.draftTitle)
            assertEquals("", model.state.value.draftPrompt)
            model.updateDraftTitle("New")
            model.updateDraftPrompt("New prompt")
            model.submitCreate()
            assertEquals("cmd.create", relay.sent.last().type)
            assertFalse(first.text("idempotencyKey") == relay.sent.last().text("idempotencyKey"))
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
            // Even when snapshot had no thinkingEffort, detail response updates continueThinkingEffort to task's previous choice ("high")
            val detailCmd = relay.sent.last { it.type == "cmd.detail" }
            relay.replyDetailWithEffort(detailCmd.id, "task_1", "high")
            assertEquals("high", model.state.value.continueThinkingEffort)
            settingsGetAfterOpen = relay.sent.last { it.type == "cmd.settings.get" }
            relay.executeSettings(settingsGetAfterOpen.id)
            assertEquals("high", model.state.value.continueThinkingEffort)
            model.updateContinuePrompt("Continue with new model")
            model.updateContinueModel("mgp/antigravity/gemini-4-argon")
            model.updateContinueThinkingEffort("xhigh")
            model.addContinueAttachments(
                listOf(tech.mengfei.agentboard.protocol.OutgoingAttachment("log.txt", "text/plain", 5L, "aGVsbG8=")),
            )
            model.submitContinue()
            val contCmd = relay.sent.last { it.type == "cmd.continue" }
            assertEquals("task_1", contCmd.text("taskId"))
            assertEquals("Continue with new model", contCmd.text("prompt"))
            assertEquals("mgp/antigravity/gemini-4-argon", contCmd.text("model"))
            assertEquals("xhigh", contCmd.text("thinkingEffort"))
        } finally { owner.clear() }
    }

    @Test
    fun queuedPromptsAreBoundedAndScopedBySessionAndTask() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness(secondBoard = true)
        try {
            relay.authenticate()
            relay.snapshot("board-b", 1)
            relay.task("task_1", "running", 2)
            relay.task("task_1", "running", 2, board = "board-b")
            model.openTask("task_1")
            assertFalse(model.queueFollowup("  "))
            repeat(5) { assertTrue(model.queueFollowup(" p$it ")) }
            assertFalse(model.queueFollowup("overflow"))
            val fromA = model.state.value.followups
            assertEquals("p0", fromA.first().prompt)
            relay.task("task_2", "running", 3)
            model.openTask("task_2")
            assertTrue(model.state.value.followups.isEmpty())
            model.sendFollowup(fromA[1].id)
            model.activateSession("s2")
            model.openTask("task_1")
            assertTrue(model.state.value.followups.isEmpty())
            assertTrue(model.queueFollowup("board B"))
            model.removeFollowup(fromA.first().id)
            model.sendFollowup(fromA[1].id)
            assertFalse(relay.sent.any { it.type == "cmd.steer" })
            model.activateSession("s1")
            model.openTask("task_1")
            model.removeFollowup(fromA.first().id)
            assertEquals(fromA.drop(1), model.state.value.followups)
        } finally { owner.clear() }
    }

    @Test
    fun steerIsSingleFlightAndUnknownOnlyLooksUpEvenAfterTaskEnds() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            relay.offerSteer = true
            relay.authenticate()
            relay.task("task_1", "running", 2)
            model.openTask("task_1")
            assertTrue(model.state.value.canSteerFollowup)
            model.queueFollowup("one")
            model.queueFollowup("two")
            val second = model.state.value.followups.last()
            model.sendFollowup(second.id)
            model.removeFollowup(second.id)
            model.sendFollowup(second.id)
            val cmd = relay.sent.single { it.type == "cmd.steer" }
            assertEquals(second.prompt, cmd.text("prompt"))
            relay.stage(cmd.id, "accepted")
            assertEquals(2, model.state.value.followups.size)
            relay.stage(cmd.id, "timeout")
            val firstLookup = relay.sent.single { it.type == "cmd.lookup" }
            relay.stage(firstLookup.id, "unknown")
            assertTrue(model.state.value.followups.last().needsLookup)
            relay.task("task_1", "succeeded", 3)
            model.sendFollowup(second.id)
            val check = relay.sent.last { it.type == "cmd.lookup" }
            assertEquals(cmd.text("idempotencyKey"), check.text("idempotencyKey"))
            assertEquals("cmd.steer", check.text("cmd"))
            relay.replyCreated(check.id, "task_1")
            assertEquals(listOf("one"), model.state.value.followups.map { it.prompt })
            assertFalse(relay.sent.any { it.type == "cmd.continue" })
            assertEquals(1, relay.sent.count { it.type == "cmd.steer" })
        } finally { owner.clear() }
    }

    @Test
    fun manualTerminalSendChoosesTheTappedItemWithoutSteerCapability() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            relay.authenticate()
            relay.task("task_1", "running", 2)
            model.openTask("task_1")
            model.addContinueAttachments(listOf(tech.mengfei.agentboard.protocol.OutgoingAttachment("note.txt", dataBase64 = "QQ==")))
            assertFalse(model.queueFollowup("not without my file"))
            assertEquals(1, model.state.value.continueAttachments.size)
            model.removeContinueAttachment(0)
            model.queueFollowup("first")
            model.queueFollowup("second")
            assertFalse(model.state.value.canSteerFollowup)
            model.sendFollowup(model.state.value.followups.last().id)
            assertFalse(relay.sent.any { it.type == "cmd.steer" })
            relay.snapshot("board-a", 1) // No automatic writes after a replay.
            relay.task("task_1", "failed", 4)
            assertTrue(model.state.value.canSteerFollowup)
            model.sendFollowup(model.state.value.followups.last().id)
            val cmd = relay.sent.single { it.type == "cmd.continue" }
            assertEquals("second", cmd.text("prompt"))
            relay.replyCreated(cmd.id, "task_1")
            assertEquals(listOf("first"), model.state.value.followups.map { it.prompt })
        } finally { owner.clear() }
    }

    @Test
    fun boardRejectionRetainsSteerForNextRunButOfflineCompletionDoesNotSend() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            relay.offerSteer = true
            relay.authenticate()
            relay.task("task_1", "running", 2)
            model.openTask("task_1")
            model.queueFollowup("retained")
            model.sendFollowup(model.state.value.followups.single().id)
            val cmd = relay.sent.single { it.type == "cmd.steer" }
            relay.stage(cmd.id, "failed", "bad_request")
            val lookup = relay.sent.single { it.type == "cmd.lookup" }
            relay.stage(lookup.id, "failed", "bad_request")
            assertFalse(model.state.value.followups.single().needsLookup)
            relay.listener.onMessage("""{"v":1,"id":"offline","type":"evt.board","ts":4,"payload":{"boardId":"board-a","online":false,"generation":1}}""")
            assertFalse(model.state.value.canSteerFollowup)
            model.sendFollowup(model.state.value.followups.single().id)
            relay.task("task_1", "succeeded", 3)
            assertFalse(relay.sent.any { it.type == "cmd.continue" })
            assertEquals(1, relay.sent.count { it.type == "cmd.steer" })
            assertEquals("retained", model.state.value.followups.single().prompt)
        } finally { owner.clear() }
    }

    @Test
    fun autoDrainUsesLiveTerminalEdgeNotSelectionSnapshotOrPausedState() = kotlinx.coroutines.test.runTest(main.scheduler) {
        val (model, relay, owner) = harness()
        try {
            relay.authenticate()
            relay.task("task_1", "running", 2, agent = "codex")
            model.openTask("task_1")
            model.queueFollowup("first")
            model.queueFollowup("second")
            assertFalse(model.state.value.canSteerFollowup)
            model.sendFollowup(model.state.value.followups.first().id)
            assertFalse(relay.sent.any { it.type == "cmd.steer" })
            relay.task("task_1", "paused", 3, agent = "codex")
            assertTrue(model.state.value.canQueueFollowup)
            assertFalse(relay.sent.any { it.type == "cmd.continue" })
            relay.task("task_2", "running", 4)
            model.openTask("task_2")
            model.updateContinuePrompt("a different task's draft")
            relay.task("task_1", "succeeded", 5, agent = "codex")
            val cmd = relay.sent.single { it.type == "cmd.continue" }
            assertEquals("first", cmd.text("prompt"))
            assertEquals("task_1", cmd.text("taskId"))
            assertNull(cmd.text("thinkingEffort"))
            relay.stage(cmd.id, "accepted")
            relay.task("task_1", "succeeded", 6, agent = "codex")
            relay.replyCreated(cmd.id, "task_1")
            assertEquals("a different task's draft", model.state.value.continuePrompt)
            model.openTask("task_1")
            assertEquals(listOf("second"), model.state.value.followups.map { it.prompt })
            relay.snapshot("board-a", 1)
            relay.task("task_1", "running", 2, agent = "codex")
            relay.task("task_1", "succeeded", 5, agent = "codex")
            assertEquals(1, relay.sent.count { it.type == "cmd.continue" })
            model.submitContinue()
            val manual = relay.sent.last { it.type == "cmd.continue" }
            assertEquals("second", manual.text("prompt"))
            // A malformed/mismatched execution is not confirmation of this prompt.
            relay.replyCreated(manual.id, "task_2")
            assertTrue(model.state.value.followups.single().needsLookup)
        } finally { owner.clear() }
    }

    private fun harness(secondBoard: Boolean = false): Triple<BoardViewModel, ConnectionRelay, androidx.lifecycle.ViewModelStore> {
        val store = SessionStore(MemoryPrefs(), MemoryPrefs())
        store.apply(DiskOp.PutCredential(CredentialSecret("c1", "dt_test", "dev", Long.MAX_VALUE,
            "https://relay.example", "wss://relay.example/v1/ws", if (secondBoard) listOf("board-a", "board-b") else listOf("board-a"))))
        val sessions = listOfNotNull(PhoneSession("s1", "c1", "board-a", "Office", 1),
            if (secondBoard) PhoneSession("s2", "c1", "board-b", "Cabin", 2) else null)
        store.apply(DiskOp.PutCatalog(CatalogDocument(catalogVersion = 1,
            migrationState = MigrationState.COMMITTED, order = sessions.map { it.sessionId },
            sessions = sessions,
            activeSessionId = "s1", migrationCredentialId = null)))
        val relay = ConnectionRelay()
        if (secondBoard) relay.listedBoards += ListedBoard("board-b", true, 1)
        val model = BoardViewModel(store, relay, DoneNotifier(mock(Context::class.java)),
            clock = { 1_000L + main.scheduler.currentTime })
        val owner = androidx.lifecycle.ViewModelStore()
        owner.put("model", model)
        return Triple(model, relay, owner)
    }
}

private data class ListedBoard(val boardId: String, val online: Boolean, val generation: Long)

private class ConnectionRelay : RelayApi {
    lateinit var listener: SocketListener
    val sent = mutableListOf<tech.mengfei.agentboard.protocol.Envelope>()
    var opens = 0
    var replyToLists = true
    var offerSteer = false
    var listedBoards = listOf(ListedBoard("board-a", online = true, generation = 1))
    override suspend fun request(method: String, url: String, body: String?) = HttpResult(200, "{}")
    override fun openSocket(credentialId: String, url: String, listener: SocketListener) {
        opens += 1
        this.listener = listener
    }
    override fun send(credentialId: String, text: String): Boolean {
        val message = tech.mengfei.agentboard.protocol.parseEnvelope(text)
        sent += message
        if (message.type == "board.list" && replyToLists) {
            val boards = listedBoards.joinToString(",") { board ->
                """{"boardId":"${board.boardId}","online":${board.online},"generation":${board.generation},"capabilities":["board.settings","workspace.settings"${if (offerSteer) ",\"task.steer\"" else ""}]}"""
            }
            listener.onMessage("""{"v":1,"id":"list-ack","type":"ack","ts":1,"payload":{"ref":"${message.id}","stage":"executed","boards":[$boards]}}""")
        }
        return true
    }
    fun authenticate() {
        listener.onOpen()
        val hello = sent.last { it.type == "client.hello" }
        listener.onMessage("""{"v":1,"id":"hello-ack","type":"ack","ts":1,"payload":{"ref":"${hello.id}","stage":"executed"}}""")
        listener.onMessage("""{"v":1,"id":"snapshot","type":"evt.snapshot","ts":1,"payload":{"boardId":"board-a","generation":1,"seq":1,"tasks":[],"workspaces":[]}}""")
    }
    fun task(id: String, status: String, seq: Long, agent: String = "pi", board: String = "board-a") {
        listener.onMessage("""{"v":1,"id":"e-$seq","type":"evt.task","ts":2,"payload":{"boardId":"$board","generation":1,"seq":$seq,"task":{"id":"$id","title":"Work","status":"$status","agent":"$agent","updatedAt":$seq}}}""")
    }
    fun stage(ref: String, stage: String, code: String = "") {
        listener.onMessage("""{"v":1,"id":"r-$ref","type":"ack","ts":2,"payload":{"ref":"$ref","stage":"$stage","code":"$code"}}""")
    }
    fun gap() {
        listener.onMessage("""{"v":1,"id":"gap","type":"evt.gap","ts":2,"payload":{"boardId":"board-a","generation":1,"expectedSeq":3,"reason":"seq_gap"}}""")
    }
    fun newGenerationSnapshot(generation: Long) {
        listener.onMessage("""{"v":1,"id":"up-$generation","type":"evt.board","ts":3,"payload":{"boardId":"board-a","online":true,"generation":$generation}}""")
        listener.onMessage("""{"v":1,"id":"snap-$generation","type":"evt.snapshot","ts":3,"payload":{"boardId":"board-a","generation":$generation,"seq":1,"tasks":[],"workspaces":[]}}""")
    }
    fun snapshot(boardId: String, generation: Long) {
        listener.onMessage("""{"v":1,"id":"snap-$boardId","type":"evt.snapshot","ts":2,"payload":{"boardId":"$boardId","generation":$generation,"seq":1,"tasks":[],"workspaces":[]}}""")
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
        listener.onMessage("""{"v":1,"id":"snapshot","type":"evt.snapshot","ts":1,"payload":{"boardId":"board-a","generation":1,"seq":1,"tasks":[{"id":"task_1","title":"Done task","status":"succeeded","updatedAt":10,"agent":"pi","workspaceId":"ws_1","model":"old-model","sessionId":"sess_1"}],"workspaces":[{"id":"ws_1","name":"Main","path":"/tmp/main","isGit":true}]}}""")
    }
    fun replyCreated(ref: String, taskId: String) {
        listener.onMessage("""{"v":1,"id":"ack-$taskId","type":"ack","ts":2,"payload":{"ref":"$ref","stage":"executed","task":{"id":"$taskId","title":"Created","status":"queued","updatedAt":2,"workspaceId":"ws_1"}}}""")
    }
    fun replyDetailWithEffort(ref: String, taskId: String, effort: String) {
        listener.onMessage("""{"v":1,"id":"detail-ack","type":"ack","ts":2,"payload":{"ref":"$ref","stage":"executed","boardId":"board-a","task":{"id":"$taskId","title":"Done task","status":"succeeded","updatedAt":10,"agent":"pi","workspaceId":"ws_1","model":"old-model","thinkingEffort":"$effort","sessionId":"sess_1","detail":"full"}}}""")
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
