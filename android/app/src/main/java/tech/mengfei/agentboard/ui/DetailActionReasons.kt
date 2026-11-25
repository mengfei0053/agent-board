package tech.mengfei.agentboard.ui

import tech.mengfei.agentboard.R
import tech.mengfei.agentboard.TaskFollowup
import tech.mengfei.agentboard.UiState
import tech.mengfei.agentboard.protocol.RelayTask

// These explain disabled controls; VM availability flags remain authoritative.
private fun UiState.writeBlockReason() = if (sawSnapshot) R.string.action_read_only else R.string.action_not_synced

internal fun queueAddBlockReason(state: UiState): Int =
    when {
        !state.writesAllowed -> state.writeBlockReason()
        !state.canQueueFollowup -> R.string.action_queue_unavailable
        state.followups.size >= 5 -> R.string.action_queue_full
        else -> R.string.action_input_needed
    }

internal fun continueBlockReason(state: UiState): Int =
    when {
        !state.writesAllowed -> state.writeBlockReason()
        state.followupBusy || state.continueMode == "busy" -> R.string.action_busy
        state.followups.any { it.needsLookup } -> R.string.action_lookup_needed
        else -> R.string.action_input_needed
    }

internal fun followupBlockReason(
    state: UiState,
    task: RelayTask,
    active: Boolean,
    item: TaskFollowup,
): Int? =
    when {
        !state.writesAllowed -> state.writeBlockReason()

        state.followupBusy -> R.string.action_busy

        // Checking the original command does not require steer capability or a new send.
        item.needsLookup -> null

        state.followups.any { it.needsLookup } || state.continueMode == "lookup" -> R.string.action_lookup_needed

        active && item.attachments.isNotEmpty() -> R.string.action_attachment_next_round

        state.canSteerFollowup -> null

        active && (task.agent != "pi" || task.status != "running") -> R.string.action_running_pi_needed

        active -> R.string.action_steer_unsupported

        else -> R.string.action_queue_unavailable
    }
