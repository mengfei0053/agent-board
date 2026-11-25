package tech.mengfei.agentboard.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.DataOutputStream
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
        repeat(51) { n ->
            first.record(
                a.credentialId,
                DiagnosticEvent.COMMAND_EXECUTED,
                DiagnosticOperation.entries[n % 20],
                DiagnosticReason.entries[
                    n /
                        20,
                ],
            )
        }
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

    @Test fun mergesOnlyUnpublishedMatchingInputsAndNeverChangesSubmittedContent() {
        val engine = restart()
        engine.updateTargets(listOf(a, b), false)

        fun recordGroup() = engine.record(a.credentialId, DiagnosticEvent.NETWORK_FAILED, DiagnosticOperation.CONNECT, DiagnosticReason.TLS)
        repeat(65536) { recordGroup() }
        engine.record(a.credentialId, DiagnosticEvent.NETWORK_FAILED, DiagnosticOperation.CONNECT, DiagnosticReason.DNS)
        engine.record(a.credentialId, DiagnosticEvent.NETWORK_FAILED, DiagnosticOperation.HEALTH, DiagnosticReason.TLS)
        engine.record(b.credentialId, DiagnosticEvent.NETWORK_FAILED, DiagnosticOperation.CONNECT, DiagnosticReason.TLS)
        engine.recordLocal(DiagnosticEvent.NETWORK_FAILED, DiagnosticOperation.CONNECT, DiagnosticReason.TLS)
        now = 30_000
        ack = { throw IOException("private message") }
        engine.tick()
        val sent = calls.single().second
        assertEquals(listOf(65535, 1, 1, 1), sent.map { it.count })
        assertEquals(5, engine.status.value.pendingCount)
        assertEquals(65540L, engine.status.value.errorCount)
        recordGroup()
        engine.tick() // b's error cannot alter a's batch
        val after = restart()
        after.updateTargets(listOf(a), false)
        now += 30_000
        after.tick()
        val replay = calls.last().second
        assertEquals(sent, replay.dropLast(1))
        assertFalse(replay.last().id in sent.map { it.id })
    }

    @Test fun statusPersistsAckCountsAndTenRecentErrorsEvenOfflineWithoutUploadingLocalEvents() {
        val engine = restart()
        engine.updateTargets(listOf(a), false)
        repeat(12) { engine.record(a.credentialId, DiagnosticEvent.APP_EXIT_ABNORMAL, reason = DiagnosticReason.entries[it]) }
        engine.record(a.credentialId, DiagnosticEvent.NOTIFICATION_FAILED, reason = DiagnosticReason.PERMISSION)
        repeat(3) { engine.recordLocal(DiagnosticEvent.APP_EXIT_ABNORMAL, reason = DiagnosticReason.CRASH) }
        engine.record(a.credentialId, DiagnosticEvent.BOARD_ONLINE)
        engine.record(a.credentialId, DiagnosticEvent.BOARD_OFFLINE)
        engine.tick()
        assertEquals(DiagnosticWaitReason.USER_ACTIVE, engine.status.value.waitReason)
        assertEquals(2, engine.status.value.pendingCount)
        now += 30_000
        engine.tick()
        assertEquals(listOf(DiagnosticEvent.BOARD_ONLINE, DiagnosticEvent.BOARD_OFFLINE), calls.single().second.map { it.event })
        val snapshot = engine.status.value
        assertEquals(0, snapshot.pendingCount)
        assertTrue(snapshot.lastAckAtMs!! > 0)
        assertEquals(1L, snapshot.infoCount)
        assertEquals(17L, snapshot.errorCount)
        assertEquals(10, snapshot.recentErrors.size)
        assertEquals(DiagnosticEvent.BOARD_OFFLINE, snapshot.recentErrors.first().event)
        assertEquals(3, snapshot.recentErrors[1].count)
        assertEquals(DiagnosticReason.CRASH, snapshot.recentErrors[1].reason)
        val offline = restart()
        assertEquals(DiagnosticWaitReason.LOADING, offline.status.value.waitReason)
        offline.tick()
        assertEquals(snapshot, offline.status.value)
        assertEquals(1, calls.size)
    }

    @Test fun fullV1SnapshotMigratesWithoutRewritingIdsOrUploadingLocalRecords() {
        val file = temp.root.resolve("queue")
        val owner = DiagnosticKey(a.credentialId, a.deviceId, a.httpBase).digest
        val id = UUID.randomUUID()
        DataOutputStream(file.outputStream().buffered()).use { out ->
            out.writeInt(0x44494131)
            repeat(DiagnosticStore.LIMIT) { i ->
                out.writeUTF(if (i == 1) owner else ":".repeat(43))
                val uuid = if (i == 1) id else UUID.randomUUID()
                out.writeLong(uuid.mostSignificantBits)
                out.writeLong(uuid.leastSignificantBits)
                out.writeLong(100L + i)
                out.writeByte(i % 10)
            }
        }
        assertEquals(215044L, file.length())
        val engine = restart()
        engine.updateTargets(emptyList(), false)
        now = 30_000
        engine.tick()
        assertEquals(DiagnosticWaitReason.OFFLINE, engine.status.value.waitReason)
        assertEquals(1, engine.status.value.pendingCount)
        assertTrue(calls.isEmpty())
        val original = saved()
        engine.recordLocal(DiagnosticEvent.APP_EXIT_ABNORMAL, reason = DiagnosticReason.ANR)
        engine.tick()
        assertEquals(original.drop(1), saved().dropLast(1))
        val migrated = restart()
        migrated.updateTargets(listOf(a), false)
        now += 30_000
        migrated.tick()
        assertEquals(DiagnosticRow(owner, id, 101L, DiagnosticEvent.RELAY_CONNECTED), calls.single().second.single())
        assertEquals(0, migrated.status.value.pendingCount)
        assertEquals(3073L, migrated.status.value.infoCount + migrated.status.value.errorCount)
    }

    @Test fun oldRelay400UsesLongBackoffWithoutReportingItsOwnErrors() {
        val engine = restart()
        engine.updateTargets(listOf(a), false)
        engine.record(a.credentialId, DiagnosticEvent.LOOKUP_RESULT, DiagnosticOperation.LOOKUP, DiagnosticReason.EXECUTED)
        now = 30_000
        ack = { throw DiagnosticHttpFailure(DiagnosticWaitReason.BAD_REQUEST) }
        engine.tick()
        repeat(99) {
            now += 3_000
            engine.tick()
        }
        assertEquals(1, calls.size)
        assertEquals(DiagnosticWaitReason.BAD_REQUEST, engine.status.value.waitReason)
        assertEquals(0L, engine.status.value.errorCount)
        assertTrue(
            engine.status.value.recentErrors
                .isEmpty(),
        )
        ack = { throw DiagnosticHttpFailure(DiagnosticWaitReason.HTTP_SERVER) }
        now += 3_000
        engine.tick()
        engine.tick()
        assertEquals(2, calls.size)
        assertEquals(calls.first().second, calls.last().second)
        assertEquals(DiagnosticWaitReason.HTTP_SERVER, engine.status.value.waitReason)
        assertEquals(1, saved().size)
    }

    @Test fun failedLocalAckWriteBacksOffWithoutChangingTheSubmittedRow() {
        val engine = restart()
        engine.updateTargets(listOf(a), false)
        engine.record(a.credentialId, DiagnosticEvent.SYNC_RECOVERED)
        now = 30_000
        val blocked = temp.root.resolve("queue.tmp")
        ack = { batch ->
            assertTrue(blocked.mkdir())
            batch.map { it.id.toString() }.toSet()
        }
        engine.tick()
        engine.tick()
        assertEquals(1, calls.size)
        assertEquals(DiagnosticWaitReason.STORAGE, engine.status.value.waitReason)
        assertEquals(0L, engine.status.value.errorCount)
        assertTrue(blocked.delete())
        ack = { batch -> batch.map { it.id.toString() }.toSet() }
        now += 10_000
        engine.tick()
        assertEquals(calls.first().second, calls[1].second)
        assertEquals(0, engine.status.value.pendingCount)
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
        repeat(10000) { n ->
            engine.recordLocal(DiagnosticEvent.COMMAND_FAILED, DiagnosticOperation.entries[n % 20], DiagnosticReason.entries[n / 20 % 26])
        }
        assertTrue(temp.root.listFiles()!!.isEmpty())
        engine.tick()
        assertEquals(DiagnosticEngine.INBOX_LIMIT, saved().size)
        assertTrue(saved().all { it.event == DiagnosticEvent.COMMAND_FAILED })
        val oldest = saved().first().id
        repeat(DiagnosticStore.LIMIT / DiagnosticEngine.INBOX_LIMIT) {
            repeat(DiagnosticEngine.INBOX_LIMIT) { n ->
                engine.record(
                    a.credentialId,
                    DiagnosticEvent.SNAPSHOT_SYNCED,
                    DiagnosticOperation.entries[n % 20],
                    DiagnosticReason.entries[
                        n /
                            20,
                    ],
                )
            }
            engine.tick()
        }
        val full = saved()
        assertEquals(DiagnosticStore.LIMIT, full.size)
        assertFalse(full.any { it.id == oldest || it.event == DiagnosticEvent.COMMAND_FAILED })
        val committed = temp.root.listFiles()!!.single()
        assertTrue(committed.length() <= DiagnosticStore.MAX_BYTES)
        // Simulate a process death before rename: temp never counts as committed data.
        val scratch = temp.root.resolve("queue.tmp")
        committed.copyTo(scratch)
        assertTrue(temp.root.listFiles()!!.sumOf { it.length() } <= 430088L)
        assertEquals(full, saved())
        assertFalse(scratch.exists())
    }
}
