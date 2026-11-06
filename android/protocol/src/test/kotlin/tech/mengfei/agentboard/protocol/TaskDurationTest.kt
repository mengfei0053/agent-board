package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskDurationTest {
    private val t0 = 1_700_000_000_000L
    private fun min(n: Long) = n * 60_000L

    private fun task(status: String, iteration: Int, vararg turns: RelayTurn, startedAt: Long? = null, endedAt: Long? = null, updatedAt: Long = 1) =
        RelayTask("t", "T", status, updatedAt, iteration = iteration, startedAt = startedAt, endedAt = endedAt, turns = turns.toList())

    @Test
    fun `sums each round and leaves out the idle gap between rounds`() {
        val task = task(
            "succeeded", 2,
            RelayTurn(1, "a", "x", t0, t0 + min(2)),
            RelayTurn(2, "b", "y", t0 + min(60), t0 + min(65)),
        )
        assertEquals(min(7), taskTotalDurationMs(task, now()))
    }

    @Test
    fun `the running round counts up to now`() {
        val task = task("running", 2, RelayTurn(1, "a", "x", t0, t0 + min(1)), RelayTurn(2, "b", null, t0 + min(10), null))
        assertEquals(min(1) + min(3), taskTotalDurationMs(task, t0 + min(13)))
    }

    @Test
    fun `a finished current round without a reply time falls back to endedAt then updatedAt`() {
        val withEnd = task("failed", 1, RelayTurn(1, "a", null, t0, null), endedAt = t0 + min(4))
        assertEquals(min(4), taskTotalDurationMs(withEnd, now()))
        val withUpdated = task("stopped", 1, RelayTurn(1, "a", null, t0, null), updatedAt = t0 + min(5))
        assertEquals(min(5), taskTotalDurationMs(withUpdated, now()))
    }

    @Test
    fun `the first round starts at startedAt when the turn has no time`() {
        val task = task("succeeded", 1, RelayTurn(1, "a", "x", null, t0 + min(3)), startedAt = t0)
        assertEquals(min(3), taskTotalDurationMs(task, now()))
    }

    @Test
    fun `nothing to total returns null instead of zero`() {
        assertNull(taskTotalDurationMs(task("queued", 1), now()))
        assertNull(taskTotalDurationMs(task("succeeded", 1, RelayTurn(1, "a", "x", null, null)), now()))
        // a reply before its prompt is ignored
        assertNull(taskTotalDurationMs(task("succeeded", 1, RelayTurn(1, "a", "x", t0 + min(5), t0)), now()))
    }

    @Test
    fun `later rounds than the current iteration are ignored`() {
        val task = task("succeeded", 1, RelayTurn(1, "a", "x", t0, t0 + min(1)), RelayTurn(2, "b", "y", t0 + min(9), t0 + min(99)))
        assertEquals(min(1), taskTotalDurationMs(task, now()))
    }

    @Test
    fun `formats like the web board`() {
        assertEquals("1秒", formatDurationMs(400))
        assertEquals("0秒", formatDurationMs(0))
        assertEquals("45秒", formatDurationMs(45_000))
        assertEquals("3分钟", formatDurationMs(180_000))
        assertEquals("3分钟5秒", formatDurationMs(185_000))
        assertEquals("2小时", formatDurationMs(7_200_000))
        assertEquals("2小时1分钟1秒", formatDurationMs(7_261_000))
        assertEquals("3min 5s", formatDurationMs(185_000, english = true))
        assertEquals("1h 2min", formatDurationMs(3_720_000, english = true))
    }

    @Test
    fun `parses outputAt from the wire and tolerates its absence`() {
        val with = parseTask("""{"id":"t","title":"T","status":"succeeded","updatedAt":1,"turns":[{"iteration":1,"at":10,"outputAt":20}]}""")
        assertEquals(20L, with.turns?.single()?.outputAt)
        val without = parseTask("""{"id":"t","title":"T","status":"succeeded","updatedAt":1,"turns":[{"iteration":1,"at":10}]}""")
        assertNull(without.turns?.single()?.outputAt)
    }

    private fun parseTask(json: String): RelayTask =
        readTask(relayJson.parseToJsonElement(json) as JsonObject)!!

    private fun now() = t0 + min(1_000)
}
