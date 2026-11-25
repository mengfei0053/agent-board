package tech.mengfei.agentboard.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.IOException
import java.util.UUID

class AppDiagnosticsTest {
    @get:Rule val temp = TemporaryFolder()
    private val a = DiagnosticTarget("credential-A", "device-A", "https://a.invalid", "secret-device-token-A", true)
    private val b = a.copy(credentialId = "credential-B")
    private var now = 0L
    private val calls = mutableListOf<Pair<DiagnosticTarget, List<DiagnosticRow>>>()
    private var ack: (List<DiagnosticRow>) -> Set<String> = { rows -> rows.map { it.id.toString() }.toSet() }

    private fun restart() =
        DiagnosticEngine({ temp.root }, { now }) { target, rows ->
            calls.add(target to rows)
            ack(rows)
        }

    private fun saved() = DiagnosticStore(temp.root).rows

    @Test fun requiresOwnConnectionNoWorkAndThirtySecondsSinceLastInteraction() {
        val engine = restart()
        val off = a.copy(connected = false)
        engine.updateTargets(listOf(off, b), false)
        engine.record(a.credentialId, DiagnosticEvent.APP_STARTED)
        now = 60_000
        engine.tick()
        engine.updateTargets(listOf(a), true)
        engine.tick()
        engine.updateTargets(listOf(off, a), false) // One authenticated board on the same target is enough.
        engine.onUserInteraction()
        now += 29_999
        engine.tick()
        assertTrue(calls.isEmpty())
        now++
        engine.tick()
        assertEquals(listOf(a), calls.map { it.first })
        assertTrue(saved().isEmpty())
    }

    @Test fun capturesAllThreeIdentityFieldsAtRecordTimeAndNeverAdoptsLocalLogs() {
        val engine = restart()
        engine.recordLocal(DiagnosticEvent.AUTH_REJECTED)
        engine.record("unknown", DiagnosticEvent.COMMAND_SENT)
        engine.updateTargets(listOf(a), true)
        engine.record(a.credentialId, DiagnosticEvent.SYNC_GAP)
        now = 90_000
        // Replacements happen before the worker even drains its inbox.
        for (replacement in listOf(b, a.copy(deviceId = "new-device"), a.copy(httpBase = "https://b.invalid"))) {
            engine.updateTargets(listOf(replacement), false)
            engine.tick()
        }
        engine.updateTargets(listOf(a, a.copy(deviceId = "ambiguous")), false)
        engine.tick()
        assertTrue(calls.isEmpty())
        assertEquals(2, saved().size)
        val rotated = a.copy(deviceToken = "rotated-token")
        val after = restart()
        now += 30_000
        after.updateTargets(listOf(rotated), false)
        after.tick()
        after.tick()
        val call = calls.single()
        assertEquals(rotated, call.first)
        assertEquals(DiagnosticEvent.SYNC_GAP, call.second.single().event)
        assertEquals(DiagnosticEvent.AUTH_REJECTED, saved().single().event)
    }

    @Test fun retriesAreIdempotentAcrossRestartAndAckCannotDeleteOutsideSentBatch() {
        val first = restart()
        first.updateTargets(listOf(a, b), true)
        repeat(51) { first.record(a.credentialId, DiagnosticEvent.COMMAND_EXECUTED) }
        first.record(b.credentialId, DiagnosticEvent.APP_STARTED)
        first.tick()
        val before = saved()
        val bytes =
            temp.root
                .resolve("queue")
                .readBytes()
                .toString(Charsets.ISO_8859_1)
        for (secret in listOf(a.credentialId, a.deviceId, a.httpBase, a.deviceToken)) assertFalse(bytes.contains(secret))
        first.updateTargets(listOf(a, b), false)
        now = 30_000
        val serverIds = mutableSetOf<UUID>()
        ack = { batch ->
            serverIds.addAll(batch.map { it.id })
            throw IOException("ACK lost")
        }
        first.tick()
        assertEquals(50, serverIds.size)
        assertEquals(before, saved())
        val second = restart()
        second.updateTargets(listOf(a), false)
        now += 30_000
        ack = { batch ->
            assertEquals(before.take(50), batch)
            assertFalse(serverIds.addAll(batch.map { it.id }))
            setOf(batch.first().id.toString(), before[50].id.toString(), before[51].id.toString())
        }
        second.tick()
        assertEquals(before.drop(1), saved())
        ack = { it.map { row -> row.id.toString() }.toSet() }
        now += 10_000
        second.tick()
        assertEquals(before.takeLast(1), saved())
        second.updateTargets(listOf(b), false)
        second.tick()
        assertTrue(saved().isEmpty())
        assertTrue(calls.all { it.second.size in 1..50 })
    }

    @Test fun backsOffFailuresPerOwnerWithoutBlockingAnotherAccount() {
        val engine = restart()
        engine.updateTargets(listOf(a, b), false)
        engine.record(a.credentialId, DiagnosticEvent.COMMAND_TIMEOUT)
        engine.record(b.credentialId, DiagnosticEvent.COMMAND_FAILED)
        now = 30_000
        ack = { throw IOException() }
        engine.tick()
        ack = { it.map { row -> row.id.toString() }.toSet() }
        engine.tick()
        now += 9999
        engine.tick()
        assertEquals(listOf(a, b), calls.map { it.first })
        now++
        ack = { emptySet() }
        engine.tick()
        now += 19_999
        engine.tick()
        assertEquals(3, calls.size)
        now++
        engine.tick()
        assertEquals(4, calls.size)
        assertEquals(1, saved().size)
    }

    @Test fun oversizedDamagedFileDoesNotDisableSubsequentRecords() {
        temp.root.resolve("queue").writeBytes(ByteArray(DiagnosticStore.MAX_BYTES.toInt() + 1))
        val engine = restart()
        engine.recordLocal(DiagnosticEvent.APP_STARTED)
        engine.tick()
        assertEquals(DiagnosticEvent.APP_STARTED, saved().single().event)
        assertTrue(temp.root.resolve("queue").length() < DiagnosticStore.MAX_BYTES)
    }

    @Test fun inboxAndSnapshotHaveGlobalHardCapsAndEvictOldestIncludingLocalOnly() {
        val engine = restart()
        engine.updateTargets(listOf(a), true)
        engine.record(a.credentialId, DiagnosticEvent.APP_STARTED)
        repeat(10000) { engine.recordLocal(DiagnosticEvent.COMMAND_FAILED) }
        assertTrue(temp.root.listFiles()!!.isEmpty())
        engine.tick()
        assertEquals(DiagnosticEngine.INBOX_LIMIT, saved().size)
        assertTrue(saved().all { it.event == DiagnosticEvent.COMMAND_FAILED })
        val oldest = saved().first().id
        repeat(DiagnosticStore.LIMIT / DiagnosticEngine.INBOX_LIMIT) {
            repeat(DiagnosticEngine.INBOX_LIMIT) { engine.record(a.credentialId, DiagnosticEvent.SNAPSHOT_SYNCED) }
            engine.tick()
        }
        val full = saved()
        assertEquals(DiagnosticStore.LIMIT, full.size)
        assertFalse(full.any { it.id == oldest || it.event == DiagnosticEvent.COMMAND_FAILED })
        val committed = temp.root.listFiles()!!.single()
        assertEquals(DiagnosticStore.MAX_BYTES, committed.length())
        // Simulate a process death before rename: temp never counts as committed data.
        val scratch = temp.root.resolve("queue.tmp")
        committed.copyTo(scratch)
        assertTrue(temp.root.listFiles()!!.sumOf { it.length() } <= 512 * 1024)
        assertEquals(full, saved())
        assertFalse(scratch.exists())
    }
}
