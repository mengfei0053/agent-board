package tech.mengfei.agentboard.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

class ProtocolTest {
    @Test
    fun httpBaseAndWebsocket() {
        assertEquals("https://Relay.mengfei.tech", normalizeHttpBase(" HTTPS://Relay.mengfei.tech/ "))
        assertEquals("wss://relay.mengfei.tech/v1/ws", deriveWsUrl("https://relay.mengfei.tech"))
        assertEquals("ws://10.0.2.2:8787/v1/ws", deriveWsUrl("http://10.0.2.2:8787/health"))
        assertEquals("wss://relay.mengfei.tech/v1/ws", deriveWsUrl("https://relay.mengfei.tech/v1/ws"))
        assertFailsWith<RelayFormatException> { normalizeHttpBase("ftp://relay.mengfei.tech") }
        assertFailsWith<RelayFormatException> { normalizeHttpBase("") }
    }

    @Test
    fun pairResponseAndHealth() {
        val body = encodePairBody("once", "phone")
        assertTrue(body.contains("\"pairCode\":\"once\""))
        val parsed = parsePairResponse(
            """{"deviceId":"d1","deviceToken":"tok","role":"phone","boardIds":["board-a"],"expiresAt":9}""",
        )
        assertEquals(listOf("board-a"), parsed.boardIds)
        assertFailsWith<RelayFormatException> {
            parsePairResponse("""{"deviceId":"d","deviceToken":"t","role":"board","boardIds":[],"expiresAt":1}""")
        }
        assertEquals("revoked: no", parseRelayError("""{"error":{"code":"revoked","message":"no"}}"""))
        assertEquals(2L, parseHealth("""{"ok":true,"boardsOnline":2}""")?.boardsOnline)
        assertNull(parseHealth("""{"ok":false}"""))
        assertIs<PairGate.Hold>(persistThenConnect(false))
        assertIs<PairGate.OpenSocket>(persistThenConnect(true))
    }

    @Test
    fun envelopeRoundTripAndCreateWorktreeFlag() {
        val raw = """{"v":1,"id":"m1","type":"evt.task","ts":3,"payload":{"boardId":"b"}}"""
        val parsed = parseEnvelope(raw)
        assertEquals("evt.task", parsed.type)
        assertEquals(parsed, parseEnvelope(encodeEnvelope(parsed)))
        assertFailsWith<RelayFormatException> { parseEnvelope("""{"v":2,"id":"m1","type":"x","ts":1,"payload":{}}""") }

        val created = validateCreate(
            id = "m1",
            ts = 1,
            boardId = "board",
            title = " title ",
            prompt = "do it",
            agent = "pi",
            cwd = "/home/me/repo",
            idempotencyKey = "ph-key-ok",
            useGitWorktree = true,
        )
        val ok = assertIs<Validated.Ok<Envelope>>(created)
        assertEquals(true, ok.value.payload["useGitWorktree"].toString().toBooleanStrict())
        val plain = assertIs<Validated.Ok<Envelope>>(
            validateCreate("m1", 1, "board", "t", "p", "codex", "/tmp/x", "ph-key-ok", false),
        )
        assertFalse(plain.value.payload.containsKey("useGitWorktree"))
        assertIs<Validated.Invalid>(
            validateCreate("m1", 1, "board", "t", "p", "codex", "https://nope", "ph-key-ok"),
        )
    }

    @Test
    fun worktreeEligibilityStaysOffUntilSnapshotIsFresh() {
        val git = ThinWorkspace("w1", "repo", "/src", isGit = true)
        val other = ThinWorkspace("w2", "notes", "/notes", isGit = false)
        assertFalse(worktreeAllowed("", listOf(git)))
        assertTrue(worktreeAllowed("/src", listOf(git, other)))
        assertFalse(worktreeAllowedFresh("/src", listOf(git), online = true, needsResync = true, eligibilityFresh = true))
        assertFalse(worktreeAllowedFresh("/src", listOf(git), online = false, needsResync = false, eligibilityFresh = true))
        assertTrue(worktreeAllowedFresh("/src", listOf(git), online = true, needsResync = false, eligibilityFresh = true))

        val key = workspaceListKey(listOf(git))
        assertTrue(keptWorktreeChoice(true, "/src", listOf(git), key))
        assertFalse(keptWorktreeChoice(true, "/src", listOf(git, other), key))

        var session = WorktreeSession(cwd = "/src").hello()
        assertFalse(session.allowed)
        session = session.snapshot(listOf(git), stillStale = true)
        assertTrue(session.needsResync)
        assertFalse(session.allowed)
        session = session.copy(checked = true).snapshot(listOf(git), stillStale = false)
        assertTrue(session.allowed)
        assertTrue(session.checked)
        session = session.gap()
        assertFalse(session.checked)
        assertTrue(session.needsResync)
    }

    @Test
    fun reducerAppliesSnapshotGapAndDoneOnce() {
        val reducer = BoardReducer(logTail = 2)
        val view = BoardView("board")
        val snapshot = envelope(
            "evt.snapshot",
            buildJsonObject {
                put("boardId", "board")
                put("generation", 1)
                put("seq", 4)
                putJsonArray("tasks") {
                    add(buildJsonObject {
                        put("id", "t1")
                        put("title", "One")
                        put("status", "running")
                        put("updatedAt", 2)
                    })
                }
                putJsonArray("workspaces") {
                    add(buildJsonObject {
                        put("id", "w")
                        put("name", "repo")
                        put("path", "/src")
                        put("isGit", true)
                    })
                }
            },
        )
        val applied = assertIs<ApplyOutcome.Applied>(reducer.apply(view, snapshot))
        assertEquals(1, applied.view.tasks.size)
        assertEquals("/src", applied.view.workspaces.single().path)
        assertFalse(applied.view.needsResync)

        val gap = assertIs<ApplyOutcome.Resync>(
            reducer.apply(applied.view, envelope("evt.gap", buildJsonObject {
                put("boardId", "board")
                put("expectedSeq", 9)
            })),
        )
        assertTrue(gap.view.needsResync)
        assertEquals("seq_gap", gap.reason)

        val still = assertIs<ApplyOutcome.Applied>(
            reducer.apply(gap.view, envelope("evt.snapshot", buildJsonObject {
                put("boardId", "board")
                put("generation", 1)
                put("seq", 8)
                putJsonArray("tasks") { }
            })),
        )
        assertTrue(still.view.needsResync)

        val caught = assertIs<ApplyOutcome.Applied>(
            reducer.apply(still.view, envelope("evt.snapshot", buildJsonObject {
                put("boardId", "board")
                put("generation", 1)
                put("seq", 9)
                putJsonArray("tasks") { }
            })),
        )
        assertFalse(caught.view.needsResync)

        val donePayload = buildJsonObject {
            put("boardId", "board")
            put("eventId", "e1")
            put("taskId", "t1")
            put("status", "succeeded")
            put("title", "One")
            put("seq", 10)
        }
        val first = assertIs<ApplyOutcome.Applied>(reducer.apply(caught.view, envelope("evt.task.done", donePayload)))
        assertEquals("succeeded", first.notice?.status)
        val second = assertIs<ApplyOutcome.Ignored>(reducer.apply(first.view, envelope("evt.task.done", donePayload)))
        assertEquals(first.view, second.view)

        val log = envelope("evt.log", buildJsonObject {
            put("boardId", "board")
            put("eventId", "l1")
            put("taskId", "t1")
            put("line", "hi")
            put("seq", 11)
        })
        val withLog = assertIs<ApplyOutcome.Applied>(reducer.apply(first.view, log))
        assertEquals("hi", withLog.view.logs.getValue("t1").single().line)
        assertIs<ApplyOutcome.Ignored>(reducer.apply(withLog.view, log))
    }

    @Test
    fun commandRetryDoesNotResendCreateBlindly() {
        val accepted = interpretCommand(envelope("ack", buildJsonObject { put("stage", "accepted") }))
        assertEquals(Retry.None, accepted?.retry)
        assertFalse(accepted!!.settled)
        assertEquals(CommandAction.Wait, nextCommandAction(false, accepted))

        val offline = interpretCommand(envelope("err", buildJsonObject {
            put("code", "board_offline")
            put("message", "down")
        }))
        assertEquals(Retry.ReuseSameKey, offline?.retry)
        val stored = interpretCommand(envelope("err", buildJsonObject { put("code", "conflict") }))
        assertEquals(Retry.LookupOnly, stored?.retry)
        assertEquals(CommandAction.SendLookup, nextCommandAction(false, stored!!))
        assertEquals(CommandAction.Settle, nextCommandAction(true, stored))

        assertIs<SubmitPlan.Busy>(planSubmit("cmd.stop", inflight = true, last = null, lastKey = null) { "new" })
        assertEquals(
            SubmitPlan.Lookup("same", "cmd.stop"),
            planSubmit("cmd.stop", false, stored, "same") { "new" },
        )
        assertEquals(
            SubmitPlan.Send("same"),
            planSubmit("cmd.create", false, offline, "same") { "new" },
        )
        assertFalse(explicitResendAllowed("cmd.create", stored))
        assertTrue(explicitResendAllowed("cmd.stop", stored))

        val outstanding = OutstandingCommand("cmd.create", "board", "ph-key-ok", polls = 1)
        val polled = assertIs<Recovery.Poll>(
            recoverFromLookup(outstanding, envelope("ack", buildJsonObject { put("stage", "accepted") })),
        )
        assertEquals(2, polled.command.polls)
        assertIs<Recovery.Clear>(
            recoverFromLookup(polled.command, envelope("ack", buildJsonObject { put("stage", "accepted") })),
        )
        assertTrue(sessionRejected(envelope("err", buildJsonObject { put("code", "revoked") })))
        assertFalse(sessionRejected(envelope("err", buildJsonObject { put("code", "conflict") })))
    }

    private fun envelope(type: String, payload: JsonObject) = Envelope(1, "m1", type, 1, payload)
}
