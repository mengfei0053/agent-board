package tech.mengfei.agentboard.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import tech.mengfei.agentboard.BoardViewModel
import tech.mengfei.agentboard.R
import tech.mengfei.agentboard.UiState
import tech.mengfei.agentboard.protocol.ARCHIVED_STATUS
import tech.mengfei.agentboard.protocol.RelayTask
import tech.mengfei.agentboard.protocol.TERMINAL_STATUSES
import tech.mengfei.agentboard.protocol.agentEnabled
import tech.mengfei.agentboard.protocol.canContinueStatus
import tech.mengfei.agentboard.protocol.canStopStatus

private enum class DetailPanel { More, Options, Queue, Attachments }

@Composable
internal fun DetailFooter(
    state: UiState,
    model: BoardViewModel,
    task: RelayTask,
    onShowLogs: () -> Unit,
    inputOptions: @Composable (onFilled: () -> Unit) -> Unit,
) {
    val archived = state.detailArchived || task.status == ARCHIVED_STATUS
    val active = task.status in setOf("queued", "running", "paused", "blocked")
    val composerAllowed = !archived && agentEnabled(task.agent, state.grokEnabled)
    val queueMode = composerAllowed && active
    val continueMode = composerAllowed && !active && canContinueStatus(task.status)
    val showAttachments = (continueMode || queueMode) && task.agent != "grok"
    val hasInput = state.continuePrompt.isNotBlank() || state.continueAttachments.isNotEmpty()
    val canAdd = queueMode && state.canQueueFollowup && hasInput && state.followups.size < 5
    val addToQueue: () -> Unit = {
        if (canAdd && model.queueFollowup(state.continuePrompt)) model.updateContinuePrompt("")
    }
    val pendingLookup = state.followups.any { it.needsLookup }
    val canContinue =
        state.writesAllowed && !state.followupBusy && state.continueMode != "busy" &&
            (state.continueMode != "send" || (!pendingLookup && (hasInput || state.followups.isNotEmpty())))
    val showStop = !archived && (canStopStatus(task.status) || state.stopMode in setOf("lookup", "reuse"))
    val showQueue = !archived && (queueMode || state.followups.isNotEmpty())
    var panel by remember { mutableStateOf<DetailPanel?>(null) }
    val clipboard = LocalClipboardManager.current
    LaunchedEffect(continueMode) { if (continueMode && !state.continueOpen) model.openContinue() }

    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (continueMode || queueMode) {
            DetailPromptField(state.continuePrompt, model::updateContinuePrompt, if (queueMode) addToQueue else null) {
                if (showAttachments) TextButton(onClick = { panel = DetailPanel.Attachments }) {
                    Text(stringResource(R.string.detail_attach_count, state.continueAttachments.size))
                }
            }
        }
        // One row even at large font scales; narrow windows can scroll to the trailing actions.
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (queueMode) MakeAction(stringResource(R.string.detail_queue_add), addToQueue, primary = true, enabled = canAdd)
            if (continueMode) {
                MakeAction(
                    actionLabel(state.continueMode, stringResource(R.string.continue_task)),
                    model::submitContinue,
                    primary = true,
                    enabled = canContinue,
                )
            }
            if (showStop) {
                MakeAction(
                    actionLabel(state.stopMode, stringResource(R.string.stop)),
                    model::submitStop,
                    danger = true,
                    enabled = state.writesAllowed && state.stopMode != "busy",
                )
            }
            if (showQueue) MakeAction(stringResource(R.string.detail_queue_button, state.followups.size), { panel = DetailPanel.Queue })
            MakeAction(stringResource(R.string.detail_more), { panel = DetailPanel.More })
        }
        if (queueMode && !canAdd) ActionReason(queueAddBlockReason(state))
        if (continueMode && !canContinue) ActionReason(continueBlockReason(state))
    }
    when (panel) {
        DetailPanel.Queue -> {
            if (showQueue) {
                val queueTitle = stringResource(R.string.detail_queue_count, state.followups.size)
                DetailActionDialog(queueTitle, { panel = null }) {
                    if (state.followups.isEmpty()) Text(stringResource(R.string.detail_queue_empty))
                    state.followups.forEach { item ->
                        FollowupRow(
                            prompt = listOf(item.prompt, item.attachments.joinToString(" · ") { it.originalName }).filter { it.isNotBlank() }.joinToString("\n"),
                            needsLookup = item.needsLookup,
                            sendBlockReason = followupBlockReason(state, task, active, item),
                            canRemove = !state.followupBusy,
                            onSend = { model.sendFollowup(item.id) },
                            onRemove = { model.removeFollowup(item.id) },
                        )
                    }
                }
            }
        }

        DetailPanel.Attachments -> if (showAttachments) {
            DetailActionDialog(stringResource(R.string.attachments_label), { panel = null }) {
                if (active) Text(stringResource(R.string.detail_attachment_queue_hint))
                AttachmentPickerSection(state.continueAttachments, model::addContinueAttachments,
                    model::removeContinueAttachment, model::recordAttachmentFailure)
            }
        }

        DetailPanel.Options -> {
            if (continueMode) {
                DetailActionDialog(stringResource(R.string.detail_options), { panel = null }) {
                    inputOptions { panel = null }
                }
            }
        }

        DetailPanel.More -> {
            DetailActionDialog(stringResource(R.string.detail_more), { panel = null }) {
                if (continueMode) {
                    MakeAction(
                        stringResource(R.string.detail_options),
                        { panel = DetailPanel.Options },
                        Modifier.fillMaxWidth(),
                    )
                }
                if (!archived) {
                    if (!continueMode && state.continueMode in setOf("lookup", "reuse")) {
                        MakeAction(
                            actionLabel(state.continueMode, stringResource(R.string.continue_task)),
                            {
                                panel = null
                                model.submitContinue()
                            },
                            Modifier.fillMaxWidth(),
                            enabled = state.writesAllowed && !state.followupBusy,
                        )
                    }
                    if (state.continueResend) {
                        MakeAction(
                            stringResource(R.string.resend_continue),
                            {
                                panel = null
                                model.resendContinue()
                            },
                            Modifier.fillMaxWidth(),
                            enabled = state.writesAllowed && !state.followupBusy,
                        )
                    }
                    if (state.stopResend) {
                        MakeAction(
                            stringResource(R.string.resend_stop),
                            {
                                panel = null
                                model.resendStop()
                            },
                            Modifier.fillMaxWidth(),
                            enabled = state.writesAllowed && !state.followupBusy,
                        )
                    }
                    if (state.archiveWrite) {
                        MakeAction(
                            stringResource(R.string.archive_task),
                            {
                                panel = null
                                model.submitArchive()
                            },
                            Modifier.fillMaxWidth(),
                            enabled = state.writesAllowed && !state.followupBusy && task.status in TERMINAL_STATUSES,
                        )
                    }
                }
                MakeAction(stringResource(R.string.detail_view_logs), {
                    panel = null
                    onShowLogs()
                }, Modifier.fillMaxWidth(), enabled = state.logs.isNotEmpty())
                MakeAction(stringResource(R.string.copy_task_id), {
                    clipboard.setText(AnnotatedString(task.id))
                    panel = null
                }, Modifier.fillMaxWidth())
                task.resumeCommand?.let { command ->
                    MakeAction(stringResource(R.string.copy_resume), {
                        clipboard.setText(AnnotatedString(command))
                        panel = null
                    }, Modifier.fillMaxWidth())
                }
            }
        }

        null -> {
            Unit
        }
    }
}
