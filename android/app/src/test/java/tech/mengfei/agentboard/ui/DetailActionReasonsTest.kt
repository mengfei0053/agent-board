package tech.mengfei.agentboard.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import tech.mengfei.agentboard.R
import tech.mengfei.agentboard.TaskFollowup
import tech.mengfei.agentboard.UiState
import tech.mengfei.agentboard.protocol.OutgoingAttachment
import tech.mengfei.agentboard.protocol.RelayTask

class DetailActionReasonsTest {
    private val task = RelayTask("task", "", "running", 1L, agent = "pi")
    private val item = TaskFollowup("item", "prompt")
    private val attachment = OutgoingAttachment("file", dataBase64 = "AA==")
    private val state = UiState(writesAllowed = true, sawSnapshot = true)

    @Test fun reasonsExplainEachBlockWithoutPreventingStoredResultChecks() {
        assertEquals(R.string.action_steer_unsupported, followupBlockReason(state, task, true, item))
        assertEquals(R.string.action_running_pi_needed, followupBlockReason(state, task.copy(agent = "cursor"), true, item))
        assertEquals(R.string.action_running_pi_needed, followupBlockReason(state, task.copy(status = "paused"), true, item))
        assertEquals(
            R.string.action_attachment_next_round,
            followupBlockReason(state, task, true, item.copy(attachments = listOf(attachment))),
        )
        assertEquals(R.string.action_busy, followupBlockReason(state.copy(followupBusy = true), task, true, item))
        assertEquals(R.string.action_lookup_needed, followupBlockReason(state.copy(continueMode = "lookup"), task, true, item))
        assertNull(followupBlockReason(state.copy(continueMode = "lookup"), task, true, item.copy(needsLookup = true)))
        assertEquals(R.string.action_not_synced, queueAddBlockReason(UiState()))
        assertEquals(R.string.action_read_only, queueAddBlockReason(state.copy(writesAllowed = false)))
        assertEquals(R.string.action_busy, continueBlockReason(state.copy(continueMode = "busy")))
        assertEquals(R.string.action_input_needed, continueBlockReason(state))
    }

    @Test fun reasonIsAbsentExactlyWhenOriginalSendGateAllowsAction() {
        for (bits in 0 until (1 shl 8)) {
            fun flag(bit: Int) = bits and (1 shl bit) != 0
            val writable = flag(0)
            val busy = flag(1)
            val steer = flag(2)
            val active = flag(3)
            val attached = flag(4)
            val lookup = flag(5)
            val otherLookup = flag(6)
            val checkingContinue = flag(7)
            val row = item.copy(needsLookup = lookup, attachments = if (attached) listOf(attachment) else emptyList())
            val ui =
                state.copy(
                    writesAllowed = writable,
                    followupBusy = busy,
                    canSteerFollowup = steer,
                    followups = listOf(row, item.copy(id = "other", needsLookup = otherLookup)),
                    continueMode = if (checkingContinue) "lookup" else "send",
                )
            val expected = !busy && writable && (lookup || (steer && (!active || !attached) && !otherLookup && !checkingContinue))
            assertEquals("gate combination $bits", expected, followupBlockReason(ui, task, active, row) == null)
        }
    }
}
