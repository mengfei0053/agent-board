package tech.mengfei.agentboard.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.systemBars
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import tech.mengfei.agentboard.R
import tech.mengfei.agentboard.protocol.TaskChip
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import tech.mengfei.agentboard.BoardViewModel
import tech.mengfei.agentboard.Screen
import tech.mengfei.agentboard.UiState
import tech.mengfei.agentboard.protocol.AGENT_KINDS
import tech.mengfei.agentboard.protocol.ARCHIVED_STATUS
import tech.mengfei.agentboard.protocol.PAIR_CODE_LENGTH
import tech.mengfei.agentboard.protocol.RelayFormatException
import tech.mengfei.agentboard.protocol.RelayTask
import tech.mengfei.agentboard.protocol.inspectPairCode
import tech.mengfei.agentboard.protocol.pairIssueMessage
import tech.mengfei.agentboard.protocol.pairSubmitAllowed
import tech.mengfei.agentboard.protocol.trimOuter
import tech.mengfei.agentboard.protocol.canContinueStatus
import tech.mengfei.agentboard.protocol.canStopStatus
import tech.mengfei.agentboard.protocol.continueHint
import tech.mengfei.agentboard.protocol.deriveWsUrl
import tech.mengfei.agentboard.protocol.detailError
import tech.mengfei.agentboard.protocol.filterWorkspaces
import tech.mengfei.agentboard.protocol.detailPrompt
import tech.mengfei.agentboard.protocol.detailRounds
import tech.mengfei.agentboard.protocol.turnHeading
import tech.mengfei.agentboard.protocol.resumeCommandLabel
import tech.mengfei.agentboard.protocol.statusLabel
import tech.mengfei.agentboard.protocol.tasksForChip
import tech.mengfei.agentboard.protocol.visibleTasks
import tech.mengfei.agentboard.protocol.workspaceBanner
import tech.mengfei.agentboard.protocol.workspaceDisplayName
import tech.mengfei.agentboard.protocol.workspaceSwitchItems
import java.text.DateFormat
import java.util.Date

@Composable
fun RootScreen(state: UiState, model: BoardViewModel) {
    val active = state.sessions.find { it.sessionId == state.activeSessionId }
    val title = when (val screen = state.screen) {
        Screen.Pair -> stringResource(R.string.title_pair)
        Screen.Reading -> stringResource(R.string.title_reading)
        Screen.Tasks -> active?.displayName ?: stringResource(R.string.title_tasks)
        Screen.MyBoards -> stringResource(R.string.title_my_boards)
        Screen.AddBoard -> if (state.repairSessionId == null) stringResource(R.string.title_add_board) else stringResource(R.string.title_repair)
        is Screen.Detail -> {
            val card = if (state.detailArchived) state.archiveDetail ?: state.archiveTasks.find { it.id == screen.taskId }
            else state.tasks.find { it.id == screen.taskId }
            card?.title ?: screen.taskId
        }
        is Screen.Create -> stringResource(R.string.title_new_task)
        is Screen.WorkspaceCreate -> stringResource(R.string.title_new_workspace)
        Screen.WorkspaceSettings -> stringResource(R.string.title_workspace_settings)
        Screen.BoardSettings -> stringResource(R.string.title_board_settings)
    }
    var switcher by remember { mutableStateOf(false) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.systemBars,
        floatingActionButton = {
            if (state.screen == Screen.Tasks && state.chip != TaskChip.ARCHIVE && state.writesAllowed) {
                FloatingActionButton(onClick = model::openCreate) { Text(stringResource(R.string.new_task)) }
            }
        },
        topBar = {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { switcher = true }, enabled = state.sessions.isNotEmpty()) {
                        Text(title, style = MaterialTheme.typography.headlineSmall, maxLines = 1)
                        if (state.screen == Screen.Tasks) Text(" ▾")
                    }
                    DropdownMenu(expanded = switcher, onDismissRequest = { switcher = false }) {
                        state.sessions.forEach { row ->
                            DropdownMenuItem(
                                text = { Text(row.displayName) },
                                onClick = {
                                    switcher = false
                                    model.activateSession(row.sessionId)
                                },
                            )
                        }
                    }
                    if (state.sessions.isNotEmpty() && state.screen == Screen.Tasks) {
                        TextButton(onClick = model::openMyBoards) { Text(stringResource(R.string.my_boards)) }
                    }
                }
                Text(state.connection.ifBlank { stringResource(R.string.not_connected) }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                state.pillDetail?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
    ) { padding ->
        when (state.screen) {
            Screen.Pair -> PairScreen(state, model, padding)
            Screen.Reading -> ReadingScreen(padding, state)
            Screen.MyBoards -> MyBoardsScreen(state, model, padding)
            Screen.AddBoard -> AddBoardScreen(state, model, padding)
            Screen.Tasks -> TaskScreen(state, model, padding)
            is Screen.Detail -> DetailScreen(state, model, padding)
            is Screen.Create -> CreateScreen(state, model, padding)
            is Screen.WorkspaceCreate -> WorkspaceCreateScreen(state, model, padding)
            Screen.WorkspaceSettings -> WorkspaceSettingsScreen(state, model, padding)
            Screen.BoardSettings -> BoardSettingsScreen(state, model, padding)
        }
    }
}

@Composable
private fun PairScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    val clipboard = LocalClipboardManager.current
    val trimmed = trimOuter(state.pairCode)
    val issue = inspectPairCode(state.pairCode)
    ScrollColumn(padding) {
        Text(stringResource(R.string.pair_intro), style = MaterialTheme.typography.bodyMedium)
        Banner(state.banner)
        OutlinedTextField(
            value = state.httpBase,
            onValueChange = model::updateHttpBase,
            label = { Text(stringResource(R.string.relay_http)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text(wsPreview(state.httpBase, state.englishUi), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = state.pairCode,
            onValueChange = model::updatePairCode,
            label = { Text(stringResource(R.string.pair_code)) },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
            maxLines = 4,
        )
        Text(
            "${trimmed.length}/$PAIR_CODE_LENGTH",
            style = MaterialTheme.typography.titleMedium,
        )
        if (issue != null && trimmed.isNotEmpty()) {
            Text(pairIssueMessage(issue, state.englishUi), color = MaterialTheme.colorScheme.error)
        }
        TextButton(onClick = {
            val pasted = clipboard.getText()?.text ?: return@TextButton
            model.pastePairCode(pasted)
        }) { Text(stringResource(R.string.paste)) }
        OutlinedTextField(
            value = state.displayName,
            onValueChange = model::updateDisplayName,
            label = { Text(stringResource(R.string.board_display_name)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = model::updateDeviceName,
            label = { Text(stringResource(R.string.device_name)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(
            onClick = model::pair,
            enabled = pairSubmitAllowed(state.pairCode, state.httpBase, state.secureStore, state.busy),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (state.busy) stringResource(R.string.working) else stringResource(R.string.pair_action)) }
        OutlinedButton(onClick = model::checkRelay, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.check_relay))
        }
    }
}

@Composable
private fun ReadingScreen(padding: PaddingValues, state: UiState) {
    Column(Modifier.fillMaxSize().padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.reading_boards))
        Banner(state.banner)
    }
}

@Composable
private fun MyBoardsScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
        Banner(state.banner)
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::pop) { Text(stringResource(R.string.back)) }
            TextButton(onClick = model::openAddBoard) { Text(stringResource(R.string.add_board)) }
        }
        LazyColumn(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
            items(state.sessions, key = { it.sessionId }) { row ->
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text(row.displayName, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                    Text(row.subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(row.pill, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    row.expiresAt?.let {
                        Text(
                            stringResource(R.string.sign_in_expires, DateFormat.getDateTimeInstance().format(Date(it))),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Row {
                        TextButton(onClick = { model.activateSession(row.sessionId) }) { Text(stringResource(R.string.switch_board)) }
                        TextButton(onClick = { model.openRepair(row.sessionId) }) { Text(stringResource(R.string.repair_board)) }
                        TextButton(onClick = { model.refreshCredential(row.sessionId) }) { Text(stringResource(R.string.refresh_token)) }
                        TextButton(onClick = { model.requestForget(row.sessionId) }, enabled = state.forgetEnabled) {
                            Text(stringResource(R.string.forget_board))
                        }
                    }
                }
                HorizontalDivider()
            }
        }
        if (!state.forgetEnabled) {
            Text(stringResource(R.string.keep_one_board), modifier = Modifier.padding(horizontal = 20.dp))
        }
        if (state.confirmForgetId != null) {
            AlertDialog(
                onDismissRequest = model::cancelForget,
                title = { Text(stringResource(R.string.forget_board)) },
                text = { Text(stringResource(R.string.forget_board_body)) },
                confirmButton = { TextButton(onClick = model::confirmForget) { Text(stringResource(R.string.forget_board)) } },
                dismissButton = { TextButton(onClick = model::cancelForget) { Text(stringResource(R.string.cancel)) } },
            )
        }
    }
}

@Composable
private fun AddBoardScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    val clipboard = LocalClipboardManager.current
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(stringResource(R.string.back)) }
        Banner(state.banner)
        if (state.repairSessionId == null) {
            OutlinedTextField(
                value = state.displayName,
                onValueChange = model::updateDisplayName,
                label = { Text(stringResource(R.string.board_display_name)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
        }
        OutlinedTextField(
            value = state.httpBase,
            onValueChange = model::updateHttpBase,
            label = { Text(stringResource(R.string.relay_http)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            enabled = state.repairSessionId == null,
        )
        OutlinedTextField(
            value = state.pairCode,
            onValueChange = model::updatePairCode,
            label = { Text(stringResource(R.string.pair_code)) },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
        )
        TextButton(onClick = {
            val pasted = clipboard.getText()?.text ?: return@TextButton
            model.pastePairCode(pasted)
        }) { Text(stringResource(R.string.paste)) }
        Button(onClick = model::pair, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text(if (state.busy) stringResource(R.string.working) else stringResource(R.string.pair_action))
        }
    }
}

@Composable
private fun TaskScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
        Banner(state.banner)
        state.cacheSentence?.let {
            Text(it, modifier = Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Banner(state.commandNote)
        Banner(state.formError)
        state.createdHidden?.let { Text(it, modifier = Modifier.padding(horizontal = 20.dp)) }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = state.chip == TaskChip.ALL, onClick = { model.selectChip(TaskChip.ALL) }, label = { Text(stringResource(R.string.chip_all)) })
            FilterChip(selected = state.chip == TaskChip.TODO, onClick = { model.selectChip(TaskChip.TODO) }, label = { Text(stringResource(R.string.chip_todo)) })
            FilterChip(selected = state.chip == TaskChip.RUNNING, onClick = { model.selectChip(TaskChip.RUNNING) }, label = { Text(stringResource(R.string.chip_running)) })
            FilterChip(selected = state.chip == TaskChip.DONE, onClick = { model.selectChip(TaskChip.DONE) }, label = { Text(stringResource(R.string.chip_done)) })
            FilterChip(selected = state.chip == TaskChip.ARCHIVE, onClick = { model.selectChip(TaskChip.ARCHIVE) }, label = { Text(stringResource(R.string.chip_archive)) })
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::openWorkspaceSettings, enabled = !state.selectedWorkspaceId.isNullOrEmpty()) { Text(stringResource(R.string.workspace_settings)) }
            TextButton(onClick = model::openBoardSettings) { Text(stringResource(R.string.board_settings)) }
        }
        if (state.chip != TaskChip.ARCHIVE) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::openWorkspaceCreate) { Text(stringResource(R.string.new_workspace)) }
            TextButton(
                onClick = model::requestDeleteWorkspace,
                enabled = state.workspaces.any { it.id == state.selectedWorkspaceId },
            ) { Text(stringResource(R.string.delete)) }
        }
        if (state.workspaceDeleteMode == "lookup") {
            TextButton(onClick = model::startDifferentWorkspaceDelete, modifier = Modifier.padding(horizontal = 12.dp)) {
                Text(stringResource(R.string.delete_new_key))
            }
        }
        OutlinedTextField(
            value = state.searchQuery,
            onValueChange = model::updateSearch,
            label = { Text(stringResource(R.string.workspace_search)) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            singleLine = true,
        )
        state.workspaceMenuEmpty?.let {
            Text(it, modifier = Modifier.padding(horizontal = 20.dp))
        }
        val chips = filterWorkspaces(state.searchQuery, workspaceSwitchItems(state.tasks, state.workspaces, englishNow()))
        if (chips.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                chips.forEach { chip ->
                    FilterChip(
                        selected = chip.id == state.selectedWorkspaceId,
                        onClick = { model.selectWorkspace(chip.id) },
                        label = { Text(chip.label) },
                    )
                }
            }
        }
        val banner = workspaceBanner(state.selectedWorkspaceId, state.workspaces, englishNow())
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
            Text(banner.title, style = MaterialTheme.typography.titleMedium)
            banner.detail?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        }
        if (state.chip == TaskChip.ARCHIVE) {
            ArchiveList(state, model)
        } else {
        val visible = tasksForChip(visibleTasks(state.tasks, state.workspaces, state.selectedWorkspaceId), state.chip)
        if (!state.sawSnapshot) {
            Text(stringResource(R.string.loading_tasks), modifier = Modifier.padding(horizontal = 20.dp))
        } else if (visible.isEmpty()) {
            Text(
                state.filterEmpty ?: if (state.selectedWorkspaceId == null) stringResource(R.string.no_workspace) else stringResource(R.string.no_tasks),
                modifier = Modifier.padding(horizontal = 20.dp),
            )
        } else {
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)) {
                items(visible, key = { it.id }) { task ->
                    TaskRow(task, workspaceDisplayName(task.workspaceId, state.workspaces, englishNow()), englishNow()) { model.openTask(task.id) }
                    HorizontalDivider()
                }
            }
        }
        }
        if (state.confirmDeleteWorkspace) {
            val name = state.workspaces.find { it.id == state.selectedWorkspaceId }?.name ?: ""
            AlertDialog(
                onDismissRequest = model::cancelDeleteWorkspace,
                title = { Text(stringResource(R.string.delete_workspace_title)) },
                text = { Text(stringResource(R.string.delete_workspace_body, name)) },
                confirmButton = {
                    TextButton(
                        onClick = model::confirmDeleteWorkspace,
                        enabled = state.createMode != "busy",
                    ) { Text(stringResource(R.string.delete)) }
                },
                dismissButton = {
                    TextButton(onClick = model::cancelDeleteWorkspace) { Text(stringResource(R.string.cancel)) }
                },
            )
        }
    }
}

@Composable
private fun ColumnScope.ArchiveList(state: UiState, model: BoardViewModel) {
    when {
        !state.archiveSupported -> Text(
            state.archiveError ?: stringResource(R.string.archive_unavailable),
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        state.archiveBusy && state.archiveTasks.isEmpty() -> Text(
            stringResource(R.string.loading_archive),
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        state.archiveTasks.isEmpty() -> Text(
            state.archiveError ?: stringResource(R.string.no_archived),
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        else -> LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)) {
            items(state.archiveTasks, key = { it.id }) { task ->
                TaskRow(task, workspaceDisplayName(task.workspaceId, state.workspaces, englishNow()), englishNow()) {
                    model.openArchiveTask(task.id)
                }
                HorizontalDivider()
            }
            item {
                state.archiveError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (state.archiveStale) {
                    Text(stringResource(R.string.archive_stale))
                }
                if (state.archiveNextCursor != null) {
                    TextButton(onClick = model::loadMoreArchive, enabled = !state.archiveBusy) {
                        Text(if (state.archiveBusy) stringResource(R.string.loading) else stringResource(R.string.load_more))
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: RelayTask, workspaceLabel: String, english: Boolean, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Text(task.title, style = MaterialTheme.typography.titleMedium)
            Text(workspaceLabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                "${statusLabel(task.status, english)}${task.agent?.let { " · $it" } ?: ""}",
                color = statusColor(task.status),
            )
        }
    }
}

@Composable
private fun DetailScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    val task = if (state.detailArchived) {
        state.archiveDetail ?: state.archiveTasks.find { it.id == state.selectedTaskId }
    } else {
        state.tasks.find { it.id == state.selectedTaskId }
    }
    val readOnly = task?.status == ARCHIVED_STATUS
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    ScrollColumn(padding) {
        val english = englishNow()
        TextButton(onClick = model::pop) { Text(stringResource(R.string.back_tasks)) }
        if (task == null) {
            Text(stringResource(R.string.task_missing))
        } else {
            Text(
                "${task.id} · ${task.agent ?: "—"} · ${statusLabel(task.status, english)} · ${stringResource(R.string.iteration_line, task.iteration ?: 1)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(stringResource(R.string.detail_info), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
            MetaLine(stringResource(R.string.task_id), task.id)
            TextButton(onClick = {
                clipboard.setText(AnnotatedString(task.id))
                copied = true
            }) { Text(if (copied) stringResource(R.string.copied) else stringResource(R.string.copy_task_id)) }
            MetaLine(stringResource(R.string.status), statusLabel(task.status, english))
            MetaLine(stringResource(R.string.iteration), (task.iteration ?: 1).toString())
            MetaLine(stringResource(R.string.started), epochLabel(task.startedAt))
            MetaLine(stringResource(R.string.ended), epochLabel(task.endedAt))
            MetaLine("Agent", task.agent ?: "—")
            MetaLine(stringResource(R.string.model), task.model ?: "—")
            MetaLine("PID", task.pid?.toString() ?: "—")
            MetaLine(stringResource(R.string.exit_code), task.exitCode?.toString() ?: "—")
            MetaLine(stringResource(R.string.session), task.sessionId ?: "—")
            val resume = resumeCommandLabel(task, english)
            val resumeCommand = task.resumeCommand
            MetaLine(stringResource(R.string.resume_label), resume)
            if (resumeCommand != null) {
                TextButton(onClick = { clipboard.setText(AnnotatedString(resumeCommand)) }) { Text(stringResource(R.string.copy_resume)) }
            }
            MetaLine(stringResource(R.string.workspace), workspaceDisplayName(task.workspaceId, state.workspaces, english))
            MetaLine(stringResource(R.string.cwd), task.cwd ?: "—")
            val branch = task.worktreeBranch
            if (!branch.isNullOrBlank()) MetaLine(stringResource(R.string.git_branch), branch)
            turnHeading(task, english)?.let {
                Text(it, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
            }
            if (task.promptTruncated) {
                Text(stringResource(R.string.prompt_truncated), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val jobs = task.sideJobs.orEmpty()
            if (jobs.isNotEmpty()) {
                Text(stringResource(R.string.side_jobs), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    jobs.forEach { job ->
                        FilterChip(selected = false, onClick = {}, label = { Text(job.toolName?.ifBlank { job.title } ?: job.title) })
                    }
                }
            }
            Text(stringResource(R.string.progress), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
            detailError(task, english)?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            val rounds = detailRounds(task, english)
            if (rounds.isEmpty()) {
                Text(
                    if (task.status == "queued" || task.status == "running" || task.status == "paused") {
                        stringResource(R.string.waiting_reply)
                    } else {
                        stringResource(R.string.no_reply)
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                rounds.forEach { round ->
                    Text(
                        stringResource(R.string.round_line, round.iteration, round.kindLabel) +
                            if (round.pending) stringResource(R.string.round_live) else "",
                        style = MaterialTheme.typography.labelLarge,
                    )
                    Text(stringResource(R.string.prompt), style = MaterialTheme.typography.labelMedium)
                    SelectionContainer { Text(round.prompt ?: stringResource(R.string.no_record)) }
                    Text(stringResource(R.string.reply), style = MaterialTheme.typography.labelMedium)
                    val reply = round.output
                    SelectionContainer {
                        Text(
                            when {
                                !reply.isNullOrBlank() -> reply
                                round.pending -> stringResource(R.string.reply_pending)
                                else -> stringResource(R.string.no_round_reply)
                            },
                        )
                    }
                }
                if (task.outputTruncated) {
                    Text(stringResource(R.string.reply_truncated), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Banner(state.commandNote)
        Banner(state.formError)
        if (readOnly) {
            Text(stringResource(R.string.archive_readonly))
        }
        if (!readOnly && task != null && (canStopStatus(task.status) || state.stopMode != "send")) {
            Button(onClick = model::submitStop, enabled = state.stopMode != "busy") {
                Text(actionLabel(state.stopMode, stringResource(R.string.stop)))
            }
        }
        if (!readOnly && task != null && canContinueStatus(task.status)) {
            if (!state.continueOpen) {
                OutlinedButton(onClick = model::openContinue, enabled = state.writesAllowed) { Text(stringResource(R.string.continue_task)) }
            } else {
                Text(continueHint(task, english), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (state.quickPrompts.isNotEmpty()) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        state.quickPrompts.forEach { prompt ->
                            FilterChip(selected = false, onClick = { model.updateContinuePrompt(prompt.content) }, label = { Text(prompt.label) })
                        }
                    }
                }
                OutlinedTextField(
                    value = state.continuePrompt,
                    onValueChange = model::updateContinuePrompt,
                    label = { Text(stringResource(R.string.continue_prompt_label)) },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                )
                val continueEnabled = state.continuePrompt.trim().isNotEmpty() && state.continueMode != "busy" && state.writesAllowed
                OutlinedButton(onClick = model::submitContinue, enabled = continueEnabled) {
                    Text(actionLabel(state.continueMode, stringResource(R.string.continue_task)))
                }
            }
        } else if (!readOnly && task != null && (task.status == "queued" || task.status == "running")) {
            Text(
                if (task.status == "running") stringResource(R.string.continue_running) else stringResource(R.string.continue_queued),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (!readOnly && task != null && state.archiveWrite && (task.status == "succeeded" || task.status == "failed" || task.status == "stopped")) {
            TextButton(onClick = model::submitArchive, enabled = state.writesAllowed) { Text(stringResource(R.string.archive_task)) }
        }
        if (!readOnly && state.stopResend) {
            TextButton(onClick = model::resendStop) { Text(stringResource(R.string.resend_stop)) }
        }
        if (!readOnly && state.continueResend) {
            TextButton(onClick = model::resendContinue) { Text(stringResource(R.string.resend_continue)) }
        }
        Text(stringResource(R.string.raw_logs), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
        if (state.logs.isEmpty()) {
            Text(stringResource(R.string.no_logs), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            SelectionContainer {
                Column {
                    state.logs.forEach { line ->
                        Text(
                            "${line.stream}: ${line.line}",
                            fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MetaLine(label: String, value: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer { Text(value) }
    }
}

private fun epochLabel(epoch: Long?): String {
    if (epoch == null || epoch <= 0L) return "—"
    return DateFormat.getDateTimeInstance().format(Date(epoch))
}

@Composable
private fun sideJobKind(kind: String): String = when (kind) {
    "agent" -> stringResource(R.string.side_agent)
    "task" -> "Task"
    "monitor" -> "Monitor"
    "background" -> stringResource(R.string.side_background)
    else -> kind.ifBlank { stringResource(R.string.side_other) }
}

@Composable
private fun sideJobStatus(status: String): String = when (status) {
    "running" -> stringResource(R.string.side_running)
    "succeeded" -> stringResource(R.string.side_succeeded)
    "failed" -> stringResource(R.string.side_failed)
    "stopped" -> stringResource(R.string.side_stopped)
    else -> status.ifBlank { stringResource(R.string.side_unknown) }
}

@Composable
private fun CreateScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(stringResource(R.string.back_tasks)) }
        val selected = state.workspaces.find { it.id == state.selectedWorkspaceId }
        if (selected != null && state.draftCwd.trim() == selected.path) {
            Text(stringResource(R.string.workspace_line, selected.name, selected.path))
        }
        Text(stringResource(R.string.create_hint))
        Banner(state.banner)
        Banner(state.commandNote)
        Banner(state.formError)
        OutlinedTextField(
            value = state.draftTitle,
            onValueChange = model::updateDraftTitle,
            label = { Text(stringResource(R.string.title)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.draftPrompt,
            onValueChange = model::updateDraftPrompt,
            label = { Text(stringResource(R.string.prompt)) },
            modifier = Modifier.fillMaxWidth(),
            minLines = 4,
        )
        Text("Agent", style = MaterialTheme.typography.labelLarge)
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AGENT_KINDS.forEach { agent ->
                FilterChip(
                    selected = state.draftAgent == agent,
                    onClick = { model.updateDraftAgent(agent) },
                    label = { Text(agent) },
                )
            }
        }
        OutlinedTextField(
            value = state.draftCwd,
            onValueChange = model::updateDraftCwd,
            label = { Text(stringResource(R.string.cwd)) },
            placeholder = { Text("/home/me/src/app") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(
                checked = state.draftUseGitWorktree && state.worktreeEnabled,
                onCheckedChange = model::setUseGitWorktree,
                enabled = state.worktreeEnabled,
            )
            Text(stringResource(R.string.worktree))
        }
        Text(
            if (state.worktreeEnabled) stringResource(R.string.worktree_on) else stringResource(R.string.worktree_off),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(
            onClick = model::submitCreate,
            enabled = state.createMode != "busy",
            modifier = Modifier.fillMaxWidth(),
        ) { Text(actionLabel(state.createMode, stringResource(R.string.create))) }
        if (state.createMode == "lookup") {
            TextButton(onClick = model::startDifferentCreate) {
                Text(stringResource(R.string.new_command))
            }
        }
    }
}

@Composable
private fun WorkspaceCreateScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(stringResource(R.string.back_tasks)) }
        Text(stringResource(R.string.workspace_create_hint))
        Banner(state.commandNote)
        Banner(state.formError)
        OutlinedTextField(
            value = state.draftWorkspaceName,
            onValueChange = model::updateDraftWorkspaceName,
            label = { Text(stringResource(R.string.name)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.draftWorkspacePath,
            onValueChange = model::updateDraftWorkspacePath,
            label = { Text(stringResource(R.string.path)) },
            placeholder = { Text("/home/me/src/app") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(
            onClick = model::submitWorkspaceCreate,
            enabled = state.workspaceCreateMode != "busy",
            modifier = Modifier.fillMaxWidth(),
        ) { Text(actionLabel(state.workspaceCreateMode, stringResource(R.string.create))) }
        if (state.workspaceCreateMode == "lookup") {
            TextButton(onClick = model::startDifferentWorkspaceCreate) {
                Text(stringResource(R.string.new_command))
            }
        }
    }
}

@Composable
private fun WorkspaceSettingsScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(stringResource(R.string.back)) }
        val blocked = state.settingsBlocked
        if (blocked != null) {
            Text(blocked)
        } else {
            val form = state.workspaceForm
            if (form == null) {
                Text(stringResource(R.string.loading))
            } else {
                OutlinedTextField(form.name, { model.updateWorkspaceField(name = it) }, label = { Text(stringResource(R.string.name)) }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(form.path, { model.updateWorkspaceField(path = it) }, label = { Text(stringResource(R.string.path)) }, modifier = Modifier.fillMaxWidth())
                Text(stringResource(R.string.path_keeps_cwd), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(form.systemPrompt, { model.updateWorkspaceField(prompt = it) }, label = { Text(stringResource(R.string.first_run_prompt)) }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                OutlinedTextField(form.skills, { model.updateWorkspaceField(skills = it) }, label = { Text(stringResource(R.string.skills)) }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                OutlinedTextField(form.mcp, { model.updateWorkspaceField(mcp = it) }, label = { Text(stringResource(R.string.mcp_note)) }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                Button(onClick = model::saveWorkspaceSettings, enabled = state.writesAllowed, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.save))
                }
            }
        }
        Banner(state.formError)
        Banner(state.banner)
    }
}

@Composable
private fun BoardSettingsScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(stringResource(R.string.back)) }
        val blocked = state.settingsBlocked
        if (blocked != null) {
            Text(blocked)
        } else {
            Text(stringResource(R.string.default_model_sentence))
            Text(stringResource(R.string.quick_prompts), style = MaterialTheme.typography.titleMedium)
            state.quickPrompts.forEach { prompt ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(prompt.label)
                        Text(prompt.content, style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton(onClick = { model.removeQuickPrompt(prompt.id) }) { Text(stringResource(R.string.delete)) }
                }
            }
            var label by remember { mutableStateOf("") }
            var content by remember { mutableStateOf("") }
            OutlinedTextField(label, { label = it }, label = { Text(stringResource(R.string.name)) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(content, { content = it }, label = { Text(stringResource(R.string.prompt)) }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            TextButton(onClick = {
                model.addQuickPrompt(label, content)
                label = ""
                content = ""
            }) { Text(stringResource(R.string.create)) }
            Button(onClick = model::saveBoardSettings, enabled = state.writesAllowed && state.settingsLoaded, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.save))
            }
        }
        Banner(state.formError)
        Banner(state.banner)
    }
}

@Composable
private fun ScrollColumn(padding: PaddingValues, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = { content() },
    )
}

@Composable
private fun Banner(text: String?) {
    if (text.isNullOrBlank()) return
    Text(text, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun englishNow(): Boolean {
    val locales = LocalConfiguration.current.locales
    val language = if (locales.isEmpty) java.util.Locale.getDefault().language else locales[0].language
    return !language.lowercase().startsWith("zh")
}

@Composable
private fun connectionLabel(connection: String): String = when (connection) {
    "online" -> stringResource(R.string.connected)
    "connecting" -> stringResource(R.string.connecting)
    "reconnecting" -> stringResource(R.string.reconnecting)
    else -> stringResource(R.string.not_connected)
}

@Composable
private fun actionLabel(mode: String, send: String): String = when (mode) {
    "busy" -> stringResource(R.string.waiting)
    "lookup" -> stringResource(R.string.check_stored)
    "reuse" -> stringResource(R.string.send_again, send)
    else -> send
}

private fun wsPreview(httpBase: String, english: Boolean): String = try {
    "WebSocket ${deriveWsUrl(httpBase)}"
} catch (error: RelayFormatException) {
    localize(english, error.message ?: "relay URL is invalid")
}
