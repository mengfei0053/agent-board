package tech.mengfei.agentboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    @Test
    fun parsesPairResponse() {
        val parsed = parsePairResponse(
            """
            {"deviceId":"dev_0123abcd","deviceToken":"dt_example","role":"phone",
             "boardIds":["thinkbook-main"],"expiresAt":1761890300000}
            """.trimIndent(),
        )
        assertEquals("dev_0123abcd", parsed.deviceId)
        assertEquals("dt_example", parsed.deviceToken)
        assertEquals("phone", parsed.role)
        assertEquals(listOf("thinkbook-main"), parsed.boardIds)
        assertEquals(1761890300000L, parsed.expiresAt)
    }

    @Test
    fun rejectsPairResponseWithoutToken() {
        val error = runCatching { parsePairResponse("""{"deviceId":"dev_1","role":"phone","boardIds":[],"expiresAt":1}""") }
        assertTrue(error.exceptionOrNull() is RelayFormatException)
    }

    @Test
    fun pairBodyEscapesDeviceName() {
        val body = encodePairBody("pc_abc", """Pixel "8"""")
        val parsed = relayJson.parseToJsonElement(body) as kotlinx.serialization.json.JsonObject
        assertEquals("pc_abc", parsed.text("pairCode"))
        assertEquals("""Pixel "8"""", parsed.text("deviceName"))
    }

    @Test
    fun readsRelayError() {
        assertEquals("unauthorized: pair code rejected", parseRelayError("""{"error":{"code":"unauthorized","message":"pair code rejected"}}"""))
    }
}

class RelayUrlTest {
    @Test
    fun derivesWebSocketFromHttp() {
        assertEquals("wss://relay.mengfei.tech/v1/ws", deriveWsUrl("https://relay.mengfei.tech"))
        assertEquals("wss://relay.mengfei.tech/v1/ws", deriveWsUrl("https://relay.mengfei.tech/"))
        assertEquals("ws://10.0.2.2:8787/v1/ws", deriveWsUrl("http://10.0.2.2:8787"))
        assertEquals("https://relay.mengfei.tech", normalizeHttpBase("https://relay.mengfei.tech/v1/ws"))
    }
}

class EventApplyTest {
    private val reducer = BoardReducer(logTail = 2)

    @Test
    fun snapshotThenTaskUpsertsTheRow() {
        var view = BoardView("thinkbook-main")
        view = applied(view, snapshot("""{"id":"task_01","title":"Fix login flake","status":"queued","updatedAt":10,"agent":"cursor"}"""))
        assertEquals(1, view.tasks.size)
        assertEquals("queued", view.tasks.single().status)
        view = applied(view, taskEvent("""{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":20,"agent":"cursor"}""", seq = 2))
        assertEquals("running", view.tasks.single().status)
        assertEquals(2L, view.seq)
        assertNull(notice(viewOf = null, raw = snapshot("""{"id":"task_01","title":"Done already","status":"succeeded","updatedAt":5}""")))
    }

    @Test
    fun doneIsOncePerEventIdAndSurvivesALaterSnapshot() {
        var view = BoardView("thinkbook-main")
        val first = reducer.apply(view, done("evt-done-1"))
        val applied = first as ApplyOutcome.Applied
        assertEquals("evt-done-1", applied.notice?.eventId)
        assertEquals("stopped", applied.notice?.status)
        assertEquals("Fix login flake", applied.notice?.title)
        assertEquals("stopped", applied.view.tasks.single().status)
        view = applied.view
        val repeat = reducer.apply(view, done("evt-done-1"))
        assertTrue(repeat is ApplyOutcome.Ignored)
        view = applied(view, snapshot("""{"id":"task_01","title":"Fix login flake","status":"stopped","updatedAt":30}"""))
        assertEquals("stopped", view.tasks.single().status)
        assertFalse(view.needsResync)
        val again = reducer.apply(view, done("evt-done-1"))
        assertTrue(again is ApplyOutcome.Ignored)
    }

    @Test
    fun deduperDropsOldestEventId() {
        val dedupe = EventIdDeduper(capacity = 2)
        assertTrue(dedupe.claim("a"))
        assertTrue(dedupe.claim("b"))
        assertFalse(dedupe.claim("a"))
        assertTrue(dedupe.claim("c"))
        assertTrue(dedupe.claim("a"))
    }

    @Test
    fun gapThenCachedSnapshotStaysStaleUntilANewerSnapshot() {
        var view = applied(BoardView("thinkbook-main"), snapshot("""{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":10}"""))
        val gap = reducer.apply(view, env("evt.gap", """{"boardId":"thinkbook-main","generation":1,"expectedSeq":3,"gotSeq":5,"reason":"seq_gap"}"""))
        val resync = gap as ApplyOutcome.Resync
        assertEquals("seq_gap", resync.reason)
        assertEquals("task_01", resync.view.tasks.single().id)
        assertTrue(resync.view.needsResync)
        view = applied(resync.view, snapshot("""{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":11}""", seq = 1))
        assertEquals("task_01", view.tasks.single().id)
        assertTrue(view.needsResync)
        view = applied(view, snapshot("""{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":12}""", seq = 3, eventId = "snap-fresh"))
        assertFalse(view.needsResync)
    }

    @Test
    fun contiguousLogDoesNotClearAGapBeforeARecoverySnapshot() {
        val task = """{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":10}"""
        var view = applied(BoardView("thinkbook-main"), snapshot(task))
        view = (reducer.apply(view, env(
            "evt.gap",
            """{"boardId":"thinkbook-main","generation":1,"expectedSeq":3,"gotSeq":5,"reason":"seq_gap"}""",
        )) as ApplyOutcome.Resync).view
        view = applied(view, snapshot(task, seq = 1, eventId = "snap-cached"))
        assertTrue(view.needsResync)
        view = applied(view, log("log-contiguous", "accepted after the hole"))
        assertTrue(view.needsResync)
        view = applied(view, taskEvent(task, seq = 4))
        assertTrue(view.needsResync)
        view = applied(view, done("evt-done-after-gap"))
        assertTrue(view.needsResync)
        view = applied(view, snapshot(task, seq = 1, eventId = "snap-cached-again"))
        assertTrue(view.needsResync)
        assertEquals("running", view.tasks.single().status)
        view = applied(view, snapshot(task, seq = 3, eventId = "snap-recovered"))
        assertFalse(view.needsResync)
    }

    @Test
    fun aNewGenerationClearsTheGap() {
        var view = applied(BoardView("thinkbook-main"), snapshot("""{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":10}"""))
        view = (reducer.apply(view, env("evt.gap", """{"boardId":"thinkbook-main","generation":1,"expectedSeq":3,"gotSeq":5,"reason":"seq_gap"}""")) as ApplyOutcome.Resync).view
        val fresh = reducer.apply(view, env(
            "evt.snapshot",
            """{"boardId":"thinkbook-main","generation":2,"seq":1,"eventId":"snap-gen2","version":1,"tasks":[{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":12}]}""",
        )) as ApplyOutcome.Applied
        assertFalse(fresh.view.needsResync)
        assertEquals(2L, fresh.view.generation)
    }

    @Test
    fun doneDedupeIsSharedAcrossBoardReducers() {
        val dones = EventIdDeduper()
        val first = BoardReducer(doneDedupe = dones)
        val second = BoardReducer(doneDedupe = dones)
        val once = first.apply(BoardView("thinkbook-main"), done("evt-done-1")) as ApplyOutcome.Applied
        assertEquals("evt-done-1", once.notice?.eventId)
        val again = second.apply(BoardView("other-board"), done("evt-done-1"))
        assertTrue(again is ApplyOutcome.Ignored)
    }

    @Test
    fun logTailDedupesEventId() {
        var view = BoardView("thinkbook-main")
        view = applied(view, log("log-1", "one"))
        assertTrue(reducer.apply(view, log("log-1", "one again")) is ApplyOutcome.Ignored)
        view = applied(view, log("log-2", "two"))
        view = applied(view, log("log-3", "three"))
        assertEquals(listOf("two", "three"), view.logs.getValue("task_01").map { it.line })
    }

    @Test
    fun generationChangeClearsLogsWithoutNotifyingTerminalSnapshot() {
        var view = applied(BoardView("thinkbook-main"), log("log-1", "kept"))
        view = view.copy(generation = 1)
        val outcome = reducer.apply(view, env(
            "evt.snapshot",
            """{"boardId":"thinkbook-main","generation":2,"seq":1,"eventId":"snap-2","version":1,"tasks":[{"id":"task_01","title":"Old","status":"succeeded","updatedAt":9}]}""",
        ))
        val applied = outcome as ApplyOutcome.Applied
        assertNull(applied.notice)
        assertTrue(applied.view.logs.isEmpty())
        assertEquals(2L, applied.view.generation)
    }

    private fun applied(view: BoardView, message: Envelope): BoardView {
        val outcome = reducer.apply(view, message)
        return (outcome as ApplyOutcome.Applied).view
    }

    private fun notice(viewOf: BoardView?, raw: Envelope): DoneNotice? {
        val outcome = reducer.apply(viewOf ?: BoardView("thinkbook-main"), raw)
        return (outcome as? ApplyOutcome.Applied)?.notice
    }

    private fun snapshot(task: String, seq: Long = 1, eventId: String = "snap-$seq") = env(
        "evt.snapshot",
        """{"boardId":"thinkbook-main","generation":1,"seq":$seq,"eventId":"$eventId","version":$seq,"tasks":[$task]}""",
    )

    private fun taskEvent(task: String, seq: Long) = env(
        "evt.task",
        """{"boardId":"thinkbook-main","generation":1,"seq":$seq,"eventId":"task-$seq","task":$task}""",
    )

    private fun done(eventId: String) = env(
        "evt.task.done",
        """{"boardId":"thinkbook-main","taskId":"task_01","status":"stopped","generation":1,"seq":5,"eventId":"$eventId","title":"Fix login flake","summary":"Stopped by client"}""",
    )

    private fun log(eventId: String, line: String) = env(
        "evt.log",
        """{"boardId":"thinkbook-main","generation":1,"seq":3,"eventId":"$eventId","taskId":"task_01","stream":"system","line":"$line"}""",
    )

    private fun env(type: String, payload: String) = parseEnvelope("""{"v":1,"id":"m1","type":"$type","ts":10,"payload":$payload}""")
}

class WorktreeChoiceTest {
    private val app = ThinWorkspace("ws_app", "App", "/home/me/src/app", true)

    @Test
    fun checkboxMatchesOnlyAnExactGitWorkspacePath() {
        val rooms = listOf(app)
        assertTrue(worktreeAllowed("/home/me/src/app", rooms))
        assertFalse(worktreeAllowed("/home/me/src/app/", rooms))
        assertFalse(worktreeAllowed("/tmp/other", rooms))
        assertFalse(worktreeAllowed("/home/me/src/app", listOf(app.copy(isGit = false))))
        assertFalse(worktreeAllowed("/home/me/src/app", emptyList()))
        val key = workspaceListKey(rooms)
        assertTrue(keptWorktreeChoice(true, "/home/me/src/app", rooms, key))
        assertFalse(keptWorktreeChoice(true, "/tmp/other", rooms, key))
        assertFalse(keptWorktreeChoice(true, "/home/me/src/app", rooms, "changed"))
    }

    @Test
    fun disconnectClearsTheWorktreeChoiceUntilAFreshSnapshot() {
        val rooms = listOf(app)
        var session = WorktreeSession(cwd = "/home/me/src/app", online = true)
            .snapshot(rooms, stillStale = false)
            .check()
        assertTrue(session.allowed)
        assertTrue(session.checked)
        session = session.disconnect()
        assertFalse(session.allowed)
        assertFalse(session.checked)
        assertFalse(worktreeAllowedFresh("/home/me/src/app", rooms, online = false, needsResync = false, eligibilityFresh = false))
        session = session.hello()
        assertFalse(session.allowed)
        assertFalse(session.checked)
        session = session.snapshot(rooms, stillStale = false).check()
        assertTrue(session.allowed)
        assertTrue(session.checked)
    }

    @Test
    fun gapClearsTheWorktreeChoiceUntilTheRecoverySnapshot() {
        val rooms = listOf(app)
        var session = WorktreeSession(cwd = "/home/me/src/app", online = true)
            .snapshot(rooms, stillStale = false)
            .check()
        session = session.gap()
        assertFalse(session.allowed)
        assertFalse(session.checked)
        session = session.snapshot(rooms, stillStale = true)
        assertFalse(session.allowed)
        assertFalse(session.checked)
        session = session.snapshot(rooms, stillStale = false)
        assertTrue(session.allowed)
        assertFalse(session.checked)
        assertTrue(session.check().checked)
        session = session.switchBoard()
        assertFalse(session.allowed)
        assertFalse(session.checked)
    }

    @Test
    fun missingWorkspacesFailClosedAndATaskEventDoesNotClearThem() {
        val reducer = BoardReducer()
        val first = reducer.apply(BoardView("thinkbook-main"), snap(
            """"workspaces":[{"id":"ws_app","name":"App","path":"/home/me/src/app","isGit":true}]""",
        )) as ApplyOutcome.Applied
        assertTrue(worktreeAllowed("/home/me/src/app", first.view.workspaces))
        val task = reducer.apply(first.view, parseEnvelope(
            """{"v":1,"id":"m","type":"evt.task","ts":2,"payload":{"boardId":"thinkbook-main","generation":1,"seq":2,"eventId":"t2","task":{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":2,"agent":"cursor"}}}""",
        )) as ApplyOutcome.Applied
        assertEquals("/home/me/src/app", task.view.workspaces.single().path)
        val old = reducer.apply(task.view, snap("")) as ApplyOutcome.Applied
        assertTrue(old.view.workspaces.isEmpty())
        assertFalse(worktreeAllowed("/home/me/src/app", old.view.workspaces))
        val broken = reducer.apply(first.view, snap(
            """"workspaces":[{"id":"ws_app","name":"App","path":"/home/me/src/app","isGit":"yes"}]""",
        )) as ApplyOutcome.Applied
        assertTrue(broken.view.workspaces.isEmpty())
    }

    private fun snap(extra: String): Envelope {
        val tail = if (extra.isEmpty()) "" else ",$extra"
        return parseEnvelope(
            """{"v":1,"id":"m","type":"evt.snapshot","ts":1,"payload":{"boardId":"thinkbook-main","generation":1,"seq":1,"eventId":"s1","version":1,"tasks":[]$tail}}""",
        )
    }
}

class ResyncSchedulerTest {
    @Test
    fun snapshotCancelsTheGapResubscribe() {
        val gate = ResyncScheduler()
        assertTrue(gate.onGap())
        assertFalse(gate.onGap())
        gate.onSnapshot()
        assertFalse(gate.consumeIfStillNeeded())
    }

    @Test
    fun gapWithoutSnapshotResubscribesOnce() {
        val gate = ResyncScheduler()
        assertTrue(gate.onGap())
        assertTrue(gate.consumeIfStillNeeded())
        assertFalse(gate.consumeIfStillNeeded())
    }
}

class CreatePayloadTest {
    @Test
    fun createPayloadCarriesRequiredFields() {
        val built = validateCreate(
            id = "phone-create-1",
            ts = 1761890000000,
            boardId = "thinkbook-main",
            title = "Fix login flake",
            prompt = "Investigate the flaky login test.",
            agent = "cursor",
            cwd = "/home/me/src/app",
            idempotencyKey = "android-req-7f3a",
        ) as Validated.Ok
        val message = built.value
        assertEquals("cmd.create", message.type)
        assertEquals(1, message.v)
        assertEquals("thinkbook-main", message.payload.text("boardId"))
        assertEquals("android-req-7f3a", message.payload.text("idempotencyKey"))
        assertEquals("Fix login flake", message.payload.text("title"))
        assertEquals("Investigate the flaky login test.", message.payload.text("prompt"))
        assertEquals("cursor", message.payload.text("agent"))
        assertEquals("/home/me/src/app", message.payload.text("cwd"))
        assertFalse(encodeEnvelope(message).contains("deviceToken"))
        assertNull(message.payload.bool("useGitWorktree"))
        val opted = validateCreate(
            id = "phone-create-1",
            ts = 1761890000000,
            boardId = "thinkbook-main",
            title = "Fix login flake",
            prompt = "Investigate the flaky login test.",
            agent = "cursor",
            cwd = "/home/me/src/app",
            idempotencyKey = "android-req-7f3a",
            useGitWorktree = true,
        ) as Validated.Ok
        assertEquals(true, opted.value.payload.bool("useGitWorktree"))
        assertNull(message.payload.text("workspaceId"))
        val filed = validateCreate(
            id = "phone-create-1",
            ts = 1761890000000,
            boardId = "thinkbook-main",
            title = "Fix login flake",
            prompt = "Investigate the flaky login test.",
            agent = "cursor",
            cwd = "/home/me/src/app",
            idempotencyKey = "android-req-7f3a",
            workspaceId = "ws_app",
        ) as Validated.Ok
        assertEquals("ws_app", filed.value.payload.text("workspaceId"))
        assertTrue(validateCreate(
            "id", 1, "thinkbook-main", "T", "prompt", "cursor", "/home/me", "android-req-7f3a", workspaceId = "bad id",
        ) is Validated.Invalid)
    }

    @Test
    fun createRejectsMissingCwdUnknownAgentAndShortKey() {
        assertTrue(validateCreate("id", 1, "thinkbook-main", "T", "prompt", "cursor", "", "android-req-7f3a") is Validated.Invalid)
        assertTrue(validateCreate("id", 1, "thinkbook-main", "T", "prompt", "cursor", "https://example", "android-req-7f3a") is Validated.Invalid)
        assertTrue(validateCreate("id", 1, "thinkbook-main", "T", "prompt", "Claude", "/home/me", "android-req-7f3a") is Validated.Invalid)
        assertTrue(validateCreate("id", 1, "thinkbook-main", "T", "prompt", "cursor", "/home/me", "short") is Validated.Invalid)
    }

    @Test
    fun stopAndContinueShapes() {
        val stop = validateStop("phone-stop-1", 20, "thinkbook-main", "task_01", "idem-stop-01") as Validated.Ok
        assertEquals("cmd.stop", stop.value.type)
        assertEquals("task_01", stop.value.payload.text("taskId"))
        assertEquals("user tapped stop", stop.value.payload.text("reason"))
        val cont = validateContinue("phone-continue-1", 21, "thinkbook-main", "task_01", "idem-continue") as Validated.Ok
        assertEquals("cmd.continue", cont.value.type)
        assertNull(cont.value.payload.text("reason"))
        assertNull(cont.value.payload.text("prompt"))
        val withPrompt = validateContinue(
            "phone-continue-1", 21, "thinkbook-main", "task_01", "idem-continue", "keep going",
        ) as Validated.Ok
        assertEquals("keep going", withPrompt.value.payload.text("prompt"))
        val detail = validateDetail("phone-detail-1", 22, "thinkbook-main", "task_01", "android-detail-01") as Validated.Ok
        assertEquals("cmd.detail", detail.value.type)
        assertEquals("task_01", detail.value.payload.text("taskId"))
    }
}

class CommandPolicyTest {
    @Test
    fun timeoutLooksUpAndDoesNotMintACreate() {
        val timeout = interpretCommand(ack("timeout", "timeout"))!!
        assertEquals(Retry.LookupOnly, timeout.retry)
        assertEquals(CommandAction.SendLookup, nextCommandAction(lookupAlreadySent = false, timeout))
        assertEquals(CommandAction.Settle, nextCommandAction(lookupAlreadySent = true, timeout))
        var minted = false
        val plan = planSubmit("cmd.create", inflight = false, timeout, "android-req-7f3a") {
            minted = true
            "new-key-should-not-happen"
        }
        val lookup = plan as SubmitPlan.Lookup
        assertEquals("android-req-7f3a", lookup.idempotencyKey)
        assertEquals("cmd.create", lookup.cmd)
        assertFalse(minted)
        assertFalse(explicitResendAllowed("cmd.create", timeout))
    }

    @Test
    fun offlineErrorReusesTheSameKey() {
        val offline = interpretCommand(err("board_offline", "board thinkbook-main is not connected"))!!
        assertEquals(Retry.ReuseSameKey, offline.retry)
        assertEquals(CommandAction.Settle, nextCommandAction(false, offline))
        val plan = planSubmit("cmd.create", false, offline, "android-req-7f3a") { error("mint") }
        assertEquals("android-req-7f3a", (plan as SubmitPlan.Send).idempotencyKey)
    }

    @Test
    fun acceptedWaitsAndExecutedCanSendANewCommand() {
        val accepted = interpretCommand(ack("accepted", null))!!
        assertFalse(accepted.settled)
        assertEquals(CommandAction.Wait, nextCommandAction(false, accepted))
        val executed = interpretCommand(parseEnvelope(
            """{"v":1,"id":"r","type":"ack","ts":3,"payload":{"ref":"c","stage":"executed","task":{"id":"task_01","title":"Fix login flake","status":"queued","updatedAt":4,"agent":"cursor"}}}""",
        ))!!
        assertEquals("task_01", executed.task?.id)
        assertEquals("queued", executed.task?.status)
        assertNull(executed.task?.workspaceId)
        val filed = interpretCommand(parseEnvelope(
            """{"v":1,"id":"r","type":"ack","ts":3,"payload":{"ref":"c","stage":"executed","workspace":{"id":"ws_app","name":"App","path":"/home/me/src/app","isGit":true},"deleted":"ws_old"}}""",
        ))!!
        assertEquals("ws_app", filed.workspace?.id)
        assertEquals("App", filed.workspace?.name)
        assertEquals("ws_old", filed.deletedWorkspaceId)
        assertFalse(explicitResendAllowed("cmd.workspace.delete", interpretCommand(ack("failed", "bad_request"))))
        val plan = planSubmit("cmd.create", false, executed, "android-req-7f3a") { "ph-next" }
        assertEquals("ph-next", (plan as SubmitPlan.Send).idempotencyKey)
        assertEquals(SubmitPlan.Busy, planSubmit("cmd.stop", inflight = true, null, null) { "x" })
    }

    @Test
    fun storedFailureLooksUpInsteadOfCreate() {
        val failed = interpretCommand(ack("failed", "board_http"))!!
        assertEquals(Retry.LookupOnly, failed.retry)
        val unknown = interpretCommand(ack("unknown", null))!!
        assertEquals(Retry.LookupOnly, unknown.retry)
        assertTrue(explicitResendAllowed("cmd.stop", failed))
    }

    private fun ack(stage: String, code: String?): Envelope {
        val extra = if (code == null) "" else ""","code":"$code","message":"board did not acknowledge the command""""
        return parseEnvelope("""{"v":1,"id":"r","type":"ack","ts":2,"payload":{"ref":"c","stage":"$stage"$extra}}""")
    }

    private fun err(code: String, message: String) = parseEnvelope(
        """{"v":1,"id":"r","type":"err","ts":2,"payload":{"ref":"c","stage":"failed","code":"$code","message":"$message","idempotencyKey":"android-req-7f3a"}}""",
    )
}

class ReconnectRecoveryTest {
    @Test
    fun droppedCreateLooksUpAndIsNotBusyForever() {
        val tracker = InflightTracker()
        tracker.start("cmd.create", "thinkbook-main", "android-req-7f3a")
        tracker.reconnect()
        assertEquals(listOf("cmd.lookup"), tracker.outbound)
        assertTrue(tracker.busy)
        tracker.lookupReply(ack("timeout", "timeout"))
        assertFalse(tracker.busy)
        assertFalse(tracker.outbound.any { it == "cmd.create" || it == "cmd.stop" })
        var minted = false
        val plan = planSubmit("cmd.create", tracker.busy, tracker.interpretation, "android-req-7f3a") {
            minted = true
            "new-key"
        }
        assertTrue(plan is SubmitPlan.Lookup)
        assertEquals("android-req-7f3a", (plan as SubmitPlan.Lookup).idempotencyKey)
        assertFalse(minted)
    }

    @Test
    fun droppedStopLooksUpInsteadOfStoppingAgain() {
        val tracker = InflightTracker()
        tracker.start("cmd.stop", "thinkbook-main", "idem-stop-01")
        tracker.reconnect()
        tracker.lookupReply(ack("executed", null))
        assertFalse(tracker.busy)
        assertEquals(listOf("cmd.lookup"), tracker.outbound)
    }

    @Test
    fun acceptedLookupPollsThenClearsWithoutResend() {
        val tracker = InflightTracker()
        tracker.start("cmd.create", "thinkbook-main", "android-req-7f3a")
        tracker.reconnect()
        repeat(MAX_ACCEPTED_POLLS) {
            assertTrue(tracker.busy)
            tracker.lookupReply(ack("accepted", null))
        }
        assertFalse(tracker.busy)
        assertTrue(tracker.outbound.all { it == "cmd.lookup" })
        assertEquals(MAX_ACCEPTED_POLLS, tracker.outbound.size)
        val plan = planSubmit("cmd.create", tracker.busy, tracker.interpretation, "android-req-7f3a") { error("mint") }
        assertTrue(plan is SubmitPlan.Lookup)
    }

    @Test
    fun missingKeyClearsBusy() {
        val tracker = InflightTracker()
        tracker.start("cmd.create", "thinkbook-main", "")
        tracker.reconnect()
        assertFalse(tracker.busy)
        assertTrue(tracker.outbound.isEmpty())
        assertTrue(tracker.note!!.contains("not sent again"))
    }

    private fun ack(stage: String, code: String?): Envelope {
        val extra = if (code == null) "" else ""","code":"$code","message":"board did not acknowledge the command""""
        return parseEnvelope("""{"v":1,"id":"r","type":"ack","ts":2,"payload":{"ref":"c","stage":"$stage"$extra}}""")
    }
}

/**
 * Mirrors reconnect recovery: lookup only, then clear Busy when the lookup settles or polls run out.
 */
private class InflightTracker {
    private var outstanding: OutstandingCommand? = null
    var busy: Boolean = false
        private set
    var interpretation: CommandInterpretation? = null
        private set
    var note: String? = null
        private set
    val outbound = mutableListOf<String>()

    fun start(cmd: String, boardId: String, key: String) {
        outstanding = OutstandingCommand(cmd, boardId, key)
        busy = true
    }

    fun reconnect() = apply(recoverAfterHello(outstanding))

    fun lookupReply(message: Envelope) {
        val current = outstanding ?: return
        apply(recoverFromLookup(current, message))
    }

    private fun apply(step: Recovery?) {
        when (step) {
            null -> Unit
            is Recovery.Lookup -> {
                outbound += "cmd.lookup"
                outstanding = step.command
                busy = true
            }
            is Recovery.Poll -> {
                outbound += "cmd.lookup"
                outstanding = step.command
                busy = true
            }
            is Recovery.Clear -> {
                outstanding = null
                busy = false
                note = step.summary
                interpretation = step.interpretation
            }
        }
    }
}

class PairPersistTest {
    @Test
    fun failedCommitDoesNotConnect() {
        val store = FakeDeviceTokenStore(commitSucceeds = false)
        var connected = false
        val saved = store.saveToken(samplePair())
        when (val gate = persistThenConnect(saved)) {
            PairGate.OpenSocket -> connected = true
            is PairGate.Hold -> assertTrue(gate.message.contains("Not connecting"))
        }
        assertFalse(saved)
        assertFalse(connected)
        assertNull(store.stored)
    }

    @Test
    fun successfulCommitCanConnect() {
        val store = FakeDeviceTokenStore(commitSucceeds = true)
        var connected = false
        val saved = store.saveToken(samplePair())
        if (persistThenConnect(saved) == PairGate.OpenSocket) connected = true
        assertTrue(connected)
        assertEquals("dt_example", store.stored?.deviceToken)
    }

    private fun samplePair() = parsePairResponse(
        """{"deviceId":"dev_0123abcd","deviceToken":"dt_example","role":"phone","boardIds":["thinkbook-main"],"expiresAt":1761890300000}""",
    )
}

class WorkspaceListTest {
    private val app = ThinWorkspace("ws_app", "App", "/home/me/src/app", true)
    private val other = ThinWorkspace("ws_other", "Other", "/tmp/other", false)

    @Test
    fun snapshotKeepsWorkspaceIdAndOldFramesStayUnassigned() {
        val reducer = BoardReducer()
        val task = """{"id":"task_01","title":"Fix login flake","status":"queued","updatedAt":10,"agent":"cursor","workspaceId":"ws_app"}"""
        var view = applied(reducer, BoardView("thinkbook-main"), snapshot(task))
        assertEquals("ws_app", view.tasks.single().workspaceId)
        view = applied(reducer, view, taskEvent(
            """{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":20,"agent":"cursor","workspaceId":"ws_other"}""",
            seq = 2,
        ))
        assertEquals("running", view.tasks.single().status)
        assertEquals("ws_other", view.tasks.single().workspaceId)
        view = applied(reducer, view, taskEvent(
            """{"id":"task_01","title":"Fix login flake","status":"running","updatedAt":21,"agent":"cursor"}""",
            seq = 3,
        ))
        assertNull(view.tasks.single().workspaceId)
        val legacy = applied(reducer, BoardView("thinkbook-main"), snapshot(
            """{"id":"task_01","title":"Fix login flake","status":"queued","updatedAt":10,"agent":"cursor"}""",
        ))
        assertNull(legacy.tasks.single().workspaceId)
        val junk = applied(reducer, BoardView("thinkbook-main"), snapshot(
            """{"id":"task_01","title":"Fix login flake","status":"queued","updatedAt":10,"workspaceId":"bad id"}""",
        ))
        assertEquals("task_01", junk.tasks.single().id)
        assertNull(junk.tasks.single().workspaceId)
    }

    @Test
    fun filtersBySelectedWorkspaceAndKeepsAnUnassignedBucket() {
        val rooms = listOf(app, other)
        val tasks = listOf(
            RelayTask("a", "Owned", "succeeded", 30, "codex", "ws_app"),
            RelayTask("b", "Missing", "failed", 20, "devin", null),
            RelayTask("c", "Unknown", "stopped", 10, "pi", "gone"),
        )
        assertEquals(listOf("a"), visibleTasks(tasks, rooms, "ws_app").map { it.id })
        assertEquals(listOf("b", "c"), visibleTasks(tasks, rooms, UNASSIGNED_WORKSPACE_ID).map { it.id })
        assertEquals(listOf("ws_app", "ws_other", ""), workspaceSwitchItems(tasks, rooms).map { it.id })
        assertEquals(UNASSIGNED_LABEL, workspaceSwitchItems(tasks, rooms).last().label)
        assertEquals("App", workspaceDisplayName("ws_app", rooms))
        assertEquals(UNASSIGNED_LABEL, workspaceDisplayName(null, rooms))
        assertEquals(UNASSIGNED_LABEL, workspaceDisplayName("gone", rooms))
        assertEquals("ws_app", resolveWorkspaceSelection(null, rooms, tasks))
        assertEquals(UNASSIGNED_WORKSPACE_ID, resolveWorkspaceSelection(null, rooms, listOf(tasks[1])))
        assertEquals("ws_app", resolveWorkspaceSelection(null, rooms, emptyList()))
        assertEquals("ws_other", resolveWorkspaceSelection("ws_other", rooms, tasks))
        assertEquals(UNASSIGNED_WORKSPACE_ID, resolveWorkspaceSelection("", rooms, tasks))
        assertEquals("ws_app", resolveWorkspaceSelection("deleted", rooms, tasks))
        assertEquals("App", workspaceBanner("ws_app", rooms).title)
        assertEquals("/home/me/src/app", workspaceBanner("ws_app", rooms).detail)
        assertEquals("未选择工作区", workspaceBanner(null, rooms).title)
        assertEquals(UNASSIGNED_LABEL, workspaceBanner("", rooms).title)
        assertEquals(listOf("ws_app", "ws_other"), workspaceSwitchItems(listOf(tasks[0]), rooms).map { it.id })
    }

    @Test
    fun newTaskDefaultsToTheSelectedWorkspacePath() {
        assertEquals("/tmp/other", cwdForNewTask("", "/tmp/other", listOf("/home/me/src/app", "/tmp/other")))
        assertEquals("/tmp/other", cwdForNewTask("/home/me/src/app", "/tmp/other", listOf("/home/me/src/app", "/tmp/other")))
        assertEquals("/custom", cwdForNewTask("/custom", "/tmp/other", listOf("/home/me/src/app", "/tmp/other")))
        assertEquals("ws_other", workspaceIdForCreate("/tmp/other", "ws_other", "/tmp/other"))
        assertNull(workspaceIdForCreate("/custom", "ws_other", "/tmp/other"))
        assertNull(workspaceIdForCreate("/tmp/other", null, null))
    }

    @Test
    fun workspaceCommandsMatchTheBoardFields() {
        val created = validateWorkspaceCreate(
            "phone-ws-create-1",
            30,
            "thinkbook-main",
            " App ",
            " /home/me/src/app ",
            "android-ws-7f3a",
        ) as Validated.Ok
        assertEquals("cmd.workspace.create", created.value.type)
        assertEquals("App", created.value.payload.text("name"))
        assertEquals("/home/me/src/app", created.value.payload.text("path"))
        assertTrue(validateWorkspaceCreate("id", 1, "thinkbook-main", " ", "/tmp", "android-ws-7f3a") is Validated.Invalid)
        assertTrue(validateWorkspaceCreate("id", 1, "thinkbook-main", "App", "relative", "android-ws-7f3a") is Validated.Invalid)
        val deleted = validateWorkspaceDelete("phone-ws-delete-1", 32, "thinkbook-main", "_nanoid01", "android-ws-del-1") as Validated.Ok
        assertEquals("cmd.workspace.delete", deleted.value.type)
        assertEquals("_nanoid01", deleted.value.payload.text("workspaceId"))
        assertTrue(validateWorkspaceDelete("id", 1, "thinkbook-main", "bad id", "android-ws-del-1") is Validated.Invalid)
    }

    @Test
    fun fullDetailReplacesTurnsAndASnapshotPreviewDoesNot() {
        val preview = RelayTask(
            id = "task_01",
            title = "Fix",
            status = "running",
            updatedAt = 2,
            agent = "cursor",
            iteration = 1,
            promptPreview = "short",
            outputPreview = "partial",
        )
        val full = preview.copy(
            detailFull = true,
            prompt = "full prompt",
            output = "full reply",
            turns = listOf(RelayTurn(1, "full prompt", "full reply")),
            sideJobs = listOf(RelaySideJob("j1", "monitor", "watch", "running")),
            resumeCommand = "cd /tmp && agent --resume sess",
            sessionId = "sess",
        )
        val merged = mergeRelayTask(preview, full)
        assertEquals("full reply", merged.output)
        assertEquals(1, detailRounds(merged).size)
        assertEquals("full prompt", detailRounds(merged).single().prompt)
        val again = mergeRelayTask(merged, preview.copy(status = "succeeded", updatedAt = 3, outputPreview = "partial"))
        assertEquals("succeeded", again.status)
        assertEquals("full reply", again.output)
        assertEquals("partial", again.outputPreview)
        assertFalse(canContinueStatus("running"))
        assertTrue(canContinueStatus("paused"))
        assertTrue(canStopStatus("paused"))
        assertEquals("将续会话 sess", continueHint(merged.copy(status = "failed")))
        assertEquals("任务运行中，请先停止再继续", continueHint(again.copy(status = "running")))
        assertEquals("尚无会话", resumeCommandLabel(preview))
        assertEquals("cd /tmp && agent --resume sess", resumeCommandLabel(merged))
        assertEquals("任务失败", detailError(RelayTask("task_01", "Fix", "failed", 1)))
    }

    @Test
    fun acceptedDetailAckDoesNotSettleAndSnapshotKeepsTheFullCard() {
        val accepted = parseEnvelope(
            """{"v":1,"id":"r","type":"ack","ts":1,"payload":{"ref":"d","stage":"accepted","boardId":"thinkbook-main"}}""",
        )
        assertFalse(detailReplySettled(accepted))
        val executed = parseEnvelope(
            """{"v":1,"id":"r2","type":"ack","ts":2,"payload":{"ref":"d","stage":"executed","task":{"id":"task_01","title":"Fix","status":"running","updatedAt":4,"detail":"full","prompt":"full prompt","turns":[{"iteration":1,"prompt":"full prompt","output":"full reply"}]}}}""",
        )
        assertTrue(detailReplySettled(executed))
        assertTrue(detailReplySettled(parseEnvelope(
            """{"v":1,"id":"e","type":"err","ts":3,"payload":{"ref":"d","code":"board_offline","message":"offline"}}""",
        )))

        val reducer = BoardReducer()
        var view = applied(reducer, BoardView("thinkbook-main"), executedTask())
        assertEquals("full reply", view.tasks.single().turns?.single()?.output)
        assertFalse(view.sawSnapshot)
        view = applied(reducer, view, parseEnvelope(
            """{"v":1,"id":"m","type":"evt.snapshot","ts":5,"payload":{"boardId":"thinkbook-main","generation":1,"seq":2,"eventId":"snap","version":2,"tasks":[{"id":"task_01","title":"Fix","status":"running","updatedAt":5,"promptPreview":"short","outputPreview":"partial"}]}}""",
        ))
        assertTrue(view.sawSnapshot)
        assertEquals("full reply", view.tasks.single().output)
        assertEquals("full reply", view.tasks.single().turns?.single()?.output)
        assertEquals("partial", view.tasks.single().outputPreview)
        assertEquals("running", view.tasks.single().status)
    }

    @Test
    fun openingABoardDoesNotEraseASavedWorkspaceBeforeTheSnapshot() {
        val rooms = listOf(app, other)
        val waiting = nextWorkspaceSelection("ws_other", emptyList(), emptyList(), sawSnapshot = false)
        assertEquals("ws_other", waiting.selectedId)
        assertFalse(waiting.persist)
        val restored = nextWorkspaceSelection("ws_other", rooms, emptyList(), sawSnapshot = true)
        assertEquals("ws_other", restored.selectedId)
        assertFalse(restored.persist)
        val missing = nextWorkspaceSelection("gone", rooms, emptyList(), sawSnapshot = true)
        assertEquals("ws_app", missing.selectedId)
        assertTrue(missing.persist)
    }

    @Test
    fun localWorkspaceInsertAndRemovalDoNotDropTasks() {
        val view = BoardView(
            boardId = "thinkbook-main",
            tasks = listOf(RelayTask("a", "Owned", "queued", 1, "cursor", "ws_app")),
            workspaces = listOf(app),
        )
        val added = view.withWorkspace(other)
        assertEquals(listOf("ws_app", "ws_other"), added.workspaces.map { it.id })
        val replaced = added.withWorkspace(other.copy(name = "Renamed"))
        assertEquals("Renamed", replaced.workspaces[1].name)
        val removed = replaced.withoutWorkspace("ws_other")
        assertEquals(listOf("ws_app"), removed.workspaces.map { it.id })
        assertEquals("a", removed.tasks.single().id)
    }

    private fun executedTask() = parseEnvelope(
        """{"v":1,"id":"m","type":"evt.task","ts":4,"payload":{"boardId":"thinkbook-main","generation":1,"seq":1,"eventId":"t","task":{"id":"task_01","title":"Fix","status":"running","updatedAt":4,"detail":"full","prompt":"full prompt","output":"full reply","turns":[{"iteration":1,"prompt":"full prompt","output":"full reply"}]}}}""",
    )

    private fun applied(reducer: BoardReducer, view: BoardView, message: Envelope): BoardView {
        return (reducer.apply(view, message) as ApplyOutcome.Applied).view
    }

    private fun snapshot(task: String) = parseEnvelope(
        """{"v":1,"id":"m1","type":"evt.snapshot","ts":1,"payload":{"boardId":"thinkbook-main","generation":1,"seq":1,"eventId":"snap-1","version":1,"tasks":[$task]}}""",
    )

    private fun taskEvent(task: String, seq: Long) = parseEnvelope(
        """{"v":1,"id":"m1","type":"evt.task","ts":$seq,"payload":{"boardId":"thinkbook-main","generation":1,"seq":$seq,"eventId":"task-$seq","task":$task}}""",
    )
}

class PairCodeUxTest {
    private val code = "pc_" + "A".repeat(43)

    @Test
    fun exactFortySixCanSubmitAndShorterOrLongerCannot() {
        assertEquals(46, code.length)
        assertNull(inspectPairCode(code))
        assertNull(inspectPairCode("  $code\n"))
        assertEquals(code, trimOuter("  $code\n"))
        assertEquals(PairIssue.Short, inspectPairCode(code.dropLast(1)))
        assertEquals(PairIssue.Long, inspectPairCode(code + "Z"))
        assertEquals(PairIssue.Prefix, inspectPairCode("xx_" + "A".repeat(43)))
        assertEquals(PairIssue.Alphabet, inspectPairCode("pc_" + "A".repeat(21) + "+" + "A".repeat(21)))
        assertTrue(pairSubmitAllowed(code, "https://relay.mengfei.tech", secure = true, busy = false))
        assertFalse(pairSubmitAllowed(code.dropLast(1), "https://relay.mengfei.tech", secure = true, busy = false))
        assertFalse(pairSubmitAllowed(code + "Z", "https://relay.mengfei.tech", secure = true, busy = false))
        assertFalse(pairSubmitAllowed(code, "https://relay.mengfei.tech", secure = false, busy = false))
        assertFalse(pairSubmitAllowed(code, "https://relay.mengfei.tech", secure = true, busy = true))
        assertFalse(pairSubmitAllowed(code, "not a url", secure = true, busy = false))
    }

    @Test
    fun pairFailuresShareOneSentenceExceptRateLimit() {
        val unknown = pairHttpFailure(401, """{"error":{"code":"unauthorized","message":"pair code rejected"}}""", english = false)
        val expired = pairHttpFailure(401, """{"error":{"code":"unauthorized","message":"pair code expired"}}""", english = false)
        val used = pairHttpFailure(401, """{"error":{"code":"unauthorized","message":"pair code already used"}}""", english = false)
        assertEquals(unknown, expired)
        assertEquals(unknown, used)
        assertTrue(unknown.contains("无效或已过期"))
        assertFalse(unknown.contains("pair code"))
        val limited = pairHttpFailure(429, """{"error":{"code":"rate_limited","message":"too many pair attempts"}}""", english = false)
        assertTrue(limited.contains("频繁"))
        assertFalse(limited == unknown)
    }
}

class ArchiveAndBoardSwitchTest {
    private val reducer = BoardReducer()
    private val active = """{"id":"task_01","title":"Live","status":"running","updatedAt":10}"""

    @Test
    fun archiveLeavesActiveWithoutADoneNotice() {
        var view = applied(reducer, BoardView("thinkbook-main"), snapshot(active))
        assertEquals(1, view.tasks.size)
        val archived = reducer.apply(view, taskEvent("""{"id":"task_01","title":"Live","status":"archived","updatedAt":11}""", 2))
        val appliedArchive = archived as ApplyOutcome.Applied
        assertNull(appliedArchive.notice)
        assertTrue(appliedArchive.view.tasks.isEmpty())
        view = applied(reducer, BoardView("thinkbook-main"), snapshot(active, seq = 1))
        val gone = reducer.apply(view, snapshot("", seq = 2))
        assertTrue((gone as ApplyOutcome.Applied).view.tasks.isEmpty())
        assertNull((gone as ApplyOutcome.Applied).notice)
        val done = reducer.apply(BoardView("thinkbook-main"), env(
            "evt.task.done",
            """{"boardId":"thinkbook-main","taskId":"task_01","status":"archived","generation":1,"seq":3,"eventId":"done-arch","title":"Live"}""",
        ))
        assertTrue(done is ApplyOutcome.Ignored)
    }

    @Test
    fun archivePageParsesSeparatelyAndDoesNotDuplicate() {
        val page = readArchivePage(parseEnvelope(
            """{"v":1,"id":"m","type":"ack","ts":1,"payload":{"archive":{"tasks":[{"id":"task_01","title":"Old","status":"archived","updatedAt":9}],"nextCursor":"9:task_01"}}}""",
        ).payload)
        assertEquals(ARCHIVED_STATUS, page?.tasks?.single()?.status)
        assertEquals("9:task_01", page?.nextCursor)
        val more = RelayTask("task_02", "Next", ARCHIVED_STATUS, 8)
        val merged = mergeArchivePages(page!!.tasks, listOf(page.tasks.single(), more))
        assertEquals(listOf("task_01", "task_02"), merged.map { it.id })
        assertFalse(canContinueStatus(ARCHIVED_STATUS))
        assertFalse(canStopStatus(ARCHIVED_STATUS))
    }

    @Test
    fun boardSwitchDropsThePreviousDetail() {
        val previous = listOf(RelayTask("task_a", "A", "running", 1))
        assertTrue(tasksAfterBoardSwitch("board-a", "board-b", previous).isEmpty())
        assertEquals("task_a", tasksAfterBoardSwitch("board-b", "board-b", previous).single().id)
        val request = DetailRequest("req-1", "board-a", "task_a", epoch = 1)
        val task = RelayTask("task_a", "A", "running", 1)
        assertNull(activeDetailTask(request, epoch = 2, viewBoardId = "board-b", ref = "req-1", task = task))
        assertNull(activeDetailTask(request, epoch = 1, viewBoardId = "board-b", ref = "req-1", task = task))
        assertEquals(task, activeDetailTask(request, epoch = 1, viewBoardId = "board-a", ref = "req-1", task = task))
        val archived = task.copy(status = ARCHIVED_STATUS)
        assertNull(activeDetailTask(request.copy(taskId = "task_a"), 1, "board-a", "req-1", archived))
        assertEquals(archived, archivedDetailTask(request, 1, "board-a", "req-1", archived))
    }

    @Test
    fun boardListReadsArchiveCapability() {
        val boards = parseBoardList(parseEnvelope(
            """{"v":1,"id":"m","type":"ack","ts":1,"payload":{"boards":[{"boardId":"thinkbook-main","online":true,"capabilities":["archive.list"]}]}}""",
        ).payload)
        assertEquals(listOf(ARCHIVE_CAPABILITY), boards?.single()?.capabilities)
        val built = validateArchiveList("m-arch", 10, "thinkbook-main", "archive-key-1", "9:task_01", 20)
        val ok = built as Validated.Ok
        assertEquals("cmd.archive.list", ok.value.type)
        assertEquals("9:task_01", ok.value.payload.text("cursor"))
    }

    private fun applied(reducer: BoardReducer, view: BoardView, message: Envelope): BoardView {
        return (reducer.apply(view, message) as ApplyOutcome.Applied).view
    }

    private fun snapshot(task: String, seq: Long = 1) = env(
        "evt.snapshot",
        """{"boardId":"thinkbook-main","generation":1,"seq":$seq,"eventId":"snap-$seq","version":$seq,"tasks":[${task}]}""",
    )

    private fun taskEvent(task: String, seq: Long) = env(
        "evt.task",
        """{"boardId":"thinkbook-main","generation":1,"seq":$seq,"eventId":"task-$seq","task":$task}""",
    )

    private fun env(type: String, payload: String) = parseEnvelope("""{"v":1,"id":"m1","type":"$type","ts":10,"payload":$payload}""")
}
