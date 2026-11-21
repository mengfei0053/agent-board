package tech.mengfei.agentboard.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SteerTest {
    private fun build(prompt: String) = validateSteer("phone-1", 1, "board-1", "task-1", "android-queue-01", prompt)

    @Test
    fun sendsOnlyTheSelectedTextToTheTask() {
        val message = (build("  first\nsecond  ") as Validated.Ok).value
        assertEquals("cmd.steer", message.type)
        assertEquals(setOf("boardId", "taskId", "idempotencyKey", "prompt"), message.payload.keys)
        assertEquals("first\nsecond", message.payload.text("prompt"))
        assertTrue(build("   ") is Validated.Invalid)
        assertTrue(build("x".repeat(20_001)) is Validated.Invalid)
    }
}
