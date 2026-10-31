package tech.mengfei.agentboard.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import tech.mengfei.agentboard.protocol.detailPrompt
import tech.mengfei.agentboard.protocol.detailRounds
import tech.mengfei.agentboard.protocol.resumeCommandLabel
import tech.mengfei.agentboard.protocol.statusLabel
import tech.mengfei.agentboard.protocol.visibleTasks
import tech.mengfei.agentboard.protocol.workspaceBanner
import tech.mengfei.agentboard.protocol.workspaceDisplayName
import tech.mengfei.agentboard.protocol.workspaceSwitchItems
import java.text.DateFormat
import java.util.Date

@Composable
fun RootScreen(state: UiState, model: BoardViewModel) {
    val title = when (val screen = state.screen) {
        Screen.Pair -> state.tx("配对这台手机", "Pair this phone")
        Screen.Boards -> state.tx("看板", "Boards")
        Screen.Settings -> state.tx("中继", "Relay")
        is Screen.Tasks -> state.boards.find { it.boardId == screen.boardId }?.label ?: screen.boardId
        is Screen.Detail -> {
            val card = if (state.detailArchived) state.archiveDetail ?: state.archiveTasks.find { it.id == screen.taskId }
            else state.tasks.find { it.id == screen.taskId }
            card?.title ?: screen.taskId
        }
        is Screen.Create -> state.tx("新建任务", "New task")
        is Screen.WorkspaceCreate -> state.tx("新建工作区", "New workspace")
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
                Text(title, style = MaterialTheme.typography.headlineSmall)
                Text(connectionLabel(state.connection, state.englishUi), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
    ) { padding ->
        when (state.screen) {
            Screen.Pair -> PairScreen(state, model, padding)
            Screen.Boards -> BoardScreen(state, model, padding)
            Screen.Settings -> SettingsScreen(state, model, padding)
            is Screen.Tasks -> TaskScreen(state, model, padding)
            is Screen.Detail -> DetailScreen(state, model, padding)
            is Screen.Create -> CreateScreen(state, model, padding)
            is Screen.WorkspaceCreate -> WorkspaceCreateScreen(state, model, padding)
        }
    }
}

@Composable
private fun PairScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    val clipboard = LocalClipboardManager.current
    val trimmed = trimOuter(state.pairCode)
    val issue = inspectPairCode(state.pairCode)
    ScrollColumn(padding) {
        Text(
            state.tx(
                "这台手机只连接中继，不会直接拨号 ThinkBook。请索取一次性配对码 pc_（共 46 位），再粘贴到这里。只去掉首尾空白。",
                "This phone talks only to the relay. It never dials the ThinkBook board. Paste a one-time pc_ code (46 characters). Only outer whitespace is removed.",
            ),
            style = MaterialTheme.typography.bodyMedium,
        )
        Banner(state.banner)
        OutlinedTextField(
            value = state.httpBase,
            onValueChange = model::updateHttpBase,
            label = { Text(state.tx("中继 HTTP 地址", "Relay HTTP URL")) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text(wsPreview(state.httpBase, state.englishUi), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = state.pairCode,
            onValueChange = model::updatePairCode,
            label = { Text(state.tx("配对码", "Pair code")) },
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
        }) { Text(state.tx("从剪贴板粘贴", "Paste from clipboard")) }
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = model::updateDeviceName,
            label = { Text(state.tx("设备名称", "Device name")) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(
            onClick = model::pair,
            enabled = pairSubmitAllowed(state.pairCode, state.httpBase, state.secureStore, state.busy),
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (state.busy) state.tx("处理中", "Working") else state.tx("配对", "Pair")) }
        OutlinedButton(onClick = model::checkRelay, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text(state.tx("检查中继", "Check relay"))
        }
        TextButton(onClick = model::openSettings) { Text(state.tx("中继设置", "Relay settings")) }
    }
}

@Composable
private fun BoardScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding)) {
        Banner(state.banner)
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::refreshBoards, enabled = state.connection == "online") { Text(state.tx("刷新", "Refresh")) }
            TextButton(onClick = model::openSettings) { Text(state.tx("设置", "Settings")) }
        }
        if (state.boards.isEmpty()) {
            Text(
                state.tx(
                    "这个令牌下还没有看板。看板向中继注册之后才会出现。",
                    "No boards on this token yet. The board has to register with the relay before one appears.",
                ),
                modifier = Modifier.padding(20.dp),
            )
        } else {
            LazyColumn(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
                items(state.boards, key = { it.boardId }) { board ->
                    TextButton(onClick = { model.openBoard(board.boardId) }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth()) {
                            Text(board.label ?: board.boardId, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${board.boardId} · ${if (board.online) state.tx("在线", "online") else state.tx("离线", "offline")}",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun TaskScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding)) {
        Banner(state.banner)
        if (state.selectedOnline == false) {
            Text(
                state.tx("看板不在线，中继不会排队。", "This board is offline. The relay will not queue a command."),
                modifier = Modifier.padding(horizontal = 20.dp),
                color = MaterialTheme.colorScheme.error,
            )
        }
        Banner(state.commandNote)
        Banner(state.formError)
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::pop) { Text(state.tx("看板", "Boards")) }
            TextButton(onClick = model::openCreate, enabled = state.lane == "active") { Text(state.tx("新建任务", "New task")) }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = state.lane == "active", onClick = model::showActive, label = { Text(state.tx("进行中", "Active")) })
            FilterChip(selected = state.lane == "archive", onClick = model::showArchive, label = { Text(state.tx("归档", "Archive")) })
        }
        if (state.lane == "active") {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::openWorkspaceCreate) { Text(state.tx("新建工作区", "New workspace")) }
            TextButton(
                onClick = model::requestDeleteWorkspace,
                enabled = state.workspaces.any { it.id == state.selectedWorkspaceId },
            ) { Text("删除") }
        }
        if (state.workspaceDeleteMode == "lookup") {
            TextButton(onClick = model::startDifferentWorkspaceDelete, modifier = Modifier.padding(horizontal = 12.dp)) {
                Text(state.tx("换一次删除（新的幂等键）", "Start a different delete (new idempotency key)"))
            }
        }
        val chips = workspaceSwitchItems(state.tasks, state.workspaces)
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
        val banner = workspaceBanner(state.selectedWorkspaceId, state.workspaces)
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
            Text(banner.title, style = MaterialTheme.typography.titleMedium)
            banner.detail?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        }
        if (state.lane == "archive") {
            ArchiveList(state, model)
        } else {
        val visible = visibleTasks(state.tasks, state.workspaces, state.selectedWorkspaceId)
        if (!state.sawSnapshot) {
            Text(state.tx("正在加载任务…", "Loading tasks…"), modifier = Modifier.padding(horizontal = 20.dp))
        } else if (visible.isEmpty()) {
            Text(
                if (state.selectedWorkspaceId == null) state.tx("当前没有工作区。", "No workspace yet.") else state.tx("当前工作区暂无任务", "No tasks in this workspace"),
                modifier = Modifier.padding(horizontal = 20.dp),
            )
        } else {
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)) {
                items(visible, key = { it.id }) { task ->
                    TaskRow(task, workspaceDisplayName(task.workspaceId, state.workspaces), state.englishUi) { model.openTask(task.id) }
                    HorizontalDivider()
                }
            }
        }
        }
        if (state.confirmDeleteWorkspace) {
            val name = state.workspaces.find { it.id == state.selectedWorkspaceId }?.name ?: ""
            AlertDialog(
                onDismissRequest = model::cancelDeleteWorkspace,
                title = { Text("删除工作区") },
                text = { Text("删除工作区「$name」？\n若仍有任务将无法删除。") },
                confirmButton = {
                    TextButton(
                        onClick = model::confirmDeleteWorkspace,
                        enabled = state.createMode != "busy",
                    ) { Text("删除") }
                },
                dismissButton = {
                    TextButton(onClick = model::cancelDeleteWorkspace) { Text("取消") }
                },
            )
        }
    }
}

@Composable
private fun ColumnScope.ArchiveList(state: UiState, model: BoardViewModel) {
    when {
        !state.archiveSupported -> Text(
            state.archiveError ?: state.tx(
                "此看板暂不支持归档浏览。需要更新后的中继和看板连接。",
                "This board cannot list archived tasks yet.",
            ),
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        state.archiveBusy && state.archiveTasks.isEmpty() -> Text(
            state.tx("正在加载归档…", "Loading archive…"),
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        state.archiveTasks.isEmpty() -> Text(
            state.archiveError ?: state.tx("没有归档任务", "No archived tasks"),
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        else -> LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)) {
            items(state.archiveTasks, key = { it.id }) { task ->
                TaskRow(task, workspaceDisplayName(task.workspaceId, state.workspaces), state.englishUi) {
                    model.openArchiveTask(task.id)
                }
                HorizontalDivider()
            }
            item {
                state.archiveError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                if (state.archiveStale) {
                    Text(state.tx("归档列表已过期，正在刷新。", "Archive list is stale and refreshing."))
                }
                if (state.archiveNextCursor != null) {
                    TextButton(onClick = model::loadMoreArchive, enabled = !state.archiveBusy) {
                        Text(if (state.archiveBusy) state.tx("加载中", "Loading") else state.tx("加载更多", "Load more"))
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
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(state.tx("返回任务", "Tasks")) }
        if (task == null) {
            Text(state.tx("当前列表里没有这个任务。", "This task is not in the current list."))
        } else {
            Text(
                "${task.id} · ${task.agent ?: "—"} · ${statusLabel(task.status, state.englishUi)} · ${state.tx("迭代", "iteration")} ${task.iteration ?: 1}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text("任务信息", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp))
            MetaLine("任务 ID", task.id)
            MetaLine(state.tx("状态", "Status"), statusLabel(task.status, state.englishUi))
            MetaLine("迭代", (task.iteration ?: 1).toString())
            MetaLine("开始时间", epochLabel(task.startedAt))
            MetaLine("结束时间", epochLabel(task.endedAt))
            MetaLine("Agent", task.agent ?: "—")
            MetaLine("模型", task.model ?: "—")
            MetaLine("PID", task.pid?.toString() ?: "—")
            MetaLine("退出码", task.exitCode?.toString() ?: "—")
            MetaLine("会话", task.sessionId ?: "—")
            val resume = resumeCommandLabel(task)
            val resumeCommand = task.resumeCommand
            MetaLine("继续会话", resume)
            if (resumeCommand != null) {
                TextButton(onClick = { clipboard.setText(AnnotatedString(resumeCommand)) }) { Text("复制继续会话") }
            }
            MetaLine("工作区", workspaceDisplayName(task.workspaceId, state.workspaces))
            MetaLine("工作目录", task.cwd ?: "—")
            val branch = task.worktreeBranch
            if (!branch.isNullOrBlank()) MetaLine("Git 分支", branch)
            Text("初始提示词", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp))
            SelectionContainer {
                Text(detailPrompt(task) ?: "—", style = MaterialTheme.typography.bodyMedium)
            }
            if (task.promptTruncated) {
                Text("提示词已截断", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val jobs = task.sideJobs.orEmpty()
            if (jobs.isNotEmpty()) {
                Text("后台 / Monitor", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                jobs.forEach { job ->
                    Text("${sideJobKind(job.kind)} · ${sideJobStatus(job.status)}", style = MaterialTheme.typography.labelLarge)
                    Text(job.title)
                    val summary = job.summary
                    if (!summary.isNullOrBlank()) {
                        Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    val toolName = job.toolName
                    if (!toolName.isNullOrBlank()) {
                        Text(toolName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Text("任务进度", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
            detailError(task)?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            val rounds = detailRounds(task)
            if (rounds.isEmpty()) {
                Text(
                    if (task.status == "queued" || task.status == "running" || task.status == "paused") "任务进行中，等待本轮回复…" else "暂无本轮回复。",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                rounds.forEach { round ->
                    Text(
                        "第 ${round.iteration} 轮 · ${round.kindLabel}${if (round.pending) " · 实时" else ""}",
                        style = MaterialTheme.typography.labelLarge,
                    )
                    Text("提示词", style = MaterialTheme.typography.labelMedium)
                    SelectionContainer { Text(round.prompt ?: "（无记录）") }
                    Text("回复", style = MaterialTheme.typography.labelMedium)
                    val reply = round.output
                    SelectionContainer {
                        Text(
                            when {
                                !reply.isNullOrBlank() -> reply
                                round.pending -> "回复生成中…"
                                else -> "本轮暂无回复"
                            },
                        )
                    }
                }
                if (task.outputTruncated) {
                    Text("回复已截断", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Banner(state.commandNote)
        Banner(state.formError)
        if (readOnly) {
            Text(state.tx("归档任务只读，不能停止或继续。", "Archived tasks are read-only."))
        }
        if (!readOnly && task != null && (canStopStatus(task.status) || state.stopMode != "send")) {
            Button(onClick = model::submitStop, enabled = state.stopMode != "busy") {
                Text(actionLabel(state.stopMode, state.tx("停止", "Stop"), state.englishUi))
            }
        }
        if (!readOnly && task != null) {
            OutlinedTextField(
                value = state.continuePrompt,
                onValueChange = model::updateContinuePrompt,
                label = { Text("补充续跑说明") },
                placeholder = { Text("留空则「请基于当前上下文继续完成任务」") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2,
            )
            Text(continueHint(task), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val continueEnabled = state.continueMode != "busy" && (state.continueMode != "send" || canContinueStatus(task.status))
            OutlinedButton(onClick = model::submitContinue, enabled = continueEnabled) {
                Text(actionLabel(state.continueMode, state.tx("继续任务", "Continue"), state.englishUi))
            }
        }
        if (!readOnly && state.stopResend) {
            TextButton(onClick = model::resendStop) { Text(state.tx("再发一次停止", "Send a new stop")) }
        }
        if (!readOnly && state.continueResend) {
            TextButton(onClick = model::resendContinue) { Text(state.tx("再发一次继续", "Send a new continue")) }
        }
        Text("原始日志", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
        if (state.logs.isEmpty()) {
            Text("暂无日志。订阅期间的新行会显示在这里。", color = MaterialTheme.colorScheme.onSurfaceVariant)
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

private fun sideJobKind(kind: String): String = when (kind) {
    "agent" -> "子代理"
    "task" -> "Task"
    "monitor" -> "Monitor"
    "background" -> "后台"
    else -> kind.ifBlank { "其他" }
}

private fun sideJobStatus(status: String): String = when (status) {
    "running" -> "进行中"
    "succeeded" -> "成功"
    "failed" -> "失败"
    "stopped" -> "已停止"
    else -> status.ifBlank { "未知" }
}

@Composable
private fun CreateScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(state.tx("返回任务", "Tasks")) }
        val selected = state.workspaces.find { it.id == state.selectedWorkspaceId }
        if (selected != null && state.draftCwd.trim() == selected.path) {
            Text("工作区：${selected.name} · ${selected.path}")
        }
        Text(state.tx(
            "需要选择 Agent 和本机工作目录。路径可以不是工作区根目录，看板仍可能把它归到默认工作区。",
            "The board needs an agent and a local working directory. A path that is not a workspace root still runs, and the board may file it under the default workspace.",
        ))
        Banner(state.banner)
        Banner(state.commandNote)
        Banner(state.formError)
        OutlinedTextField(
            value = state.draftTitle,
            onValueChange = model::updateDraftTitle,
            label = { Text(state.tx("标题", "Title")) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.draftPrompt,
            onValueChange = model::updateDraftPrompt,
            label = { Text(state.tx("提示词", "Prompt")) },
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
            label = { Text(state.tx("工作目录", "Working directory")) },
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
            Text(state.tx("在 Git worktree 中启动", "Start in a git worktree"))
        }
        Text(
            if (state.worktreeEnabled) {
                state.tx(
                    "默认关闭。当前目录与快照里的 Git 工作区根目录一致。",
                    "Off by default. This cwd matches a git workspace root in the current snapshot.",
                )
            } else {
                state.tx(
                    "默认关闭。需要当前目录是快照里的 Git 工作区根目录，中继已连接，且任务列表没有过期。",
                    "Off by default. It stays disabled until this cwd matches a git workspace root in a current snapshot, while the relay is connected and the task list is not stale.",
                )
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(
            onClick = model::submitCreate,
            enabled = state.createMode != "busy",
            modifier = Modifier.fillMaxWidth(),
        ) { Text(actionLabel(state.createMode, state.tx("创建", "Create"), state.englishUi)) }
        if (state.createMode == "lookup") {
            TextButton(onClick = model::startDifferentCreate) {
                Text(state.tx("换一条新命令（新的幂等键）", "Start a different command (new idempotency key)"))
            }
        }
    }
}

@Composable
private fun WorkspaceCreateScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(state.tx("返回任务", "Tasks")) }
        Text(state.tx(
            "名称和路径与网页看板的新建工作区相同。路径必须是 ThinkBook 上的绝对目录。",
            "Name and path match the web board. The path must be an absolute directory on the board.",
        ))
        Banner(state.commandNote)
        Banner(state.formError)
        OutlinedTextField(
            value = state.draftWorkspaceName,
            onValueChange = model::updateDraftWorkspaceName,
            label = { Text(state.tx("名称", "Name")) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.draftWorkspacePath,
            onValueChange = model::updateDraftWorkspacePath,
            label = { Text(state.tx("路径", "Path")) },
            placeholder = { Text("/home/me/src/app") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(
            onClick = model::submitWorkspaceCreate,
            enabled = state.workspaceCreateMode != "busy",
            modifier = Modifier.fillMaxWidth(),
        ) { Text(actionLabel(state.workspaceCreateMode, state.tx("新建", "Create"), state.englishUi)) }
        if (state.workspaceCreateMode == "lookup") {
            TextButton(onClick = model::startDifferentWorkspaceCreate) {
                Text(state.tx("换一条新命令（新的幂等键）", "Start a different command (new idempotency key)"))
            }
        }
    }
}

@Composable
private fun SettingsScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text(state.tx("返回", "Back")) }
        Banner(state.banner)
        OutlinedTextField(
            value = state.httpBase,
            onValueChange = model::updateHttpBase,
            label = { Text(state.tx("中继 HTTP 地址", "Relay HTTP URL")) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text(wsPreview(state.httpBase, state.englishUi), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = model::updateDeviceName,
            label = { Text(state.tx("设备名称", "Device name")) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(onClick = model::saveRelay, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text(state.tx("保存中继地址", "Save relay URL"))
        }
        if (state.paired) {
            state.deviceId?.let { Text("${state.tx("设备", "Device")} $it", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            state.expiresAt?.let {
                val whenText = DateFormat.getDateTimeInstance().format(Date(it))
                Text(
                    state.tx(
                        "设备令牌到期（不是配对码）：$whenText",
                        "Device token expires (not the pair code): $whenText",
                    ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(onClick = model::refreshToken, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Text(state.tx("刷新设备令牌", "Refresh device token"))
            }
            TextButton(onClick = { model.forget() }) { Text(state.tx("忘记这台手机", "Forget this phone")) }
        }
        Text(
            state.tx(
                "默认主机 relay.mengfei.tech 只是占位。请指向中继，不要填 ThinkBook 上的 127.0.0.1。模拟器访问电脑上的中继用 http://10.0.2.2:8787。",
                "The default host is a placeholder for relay.mengfei.tech. Point this at the relay, not at 127.0.0.1 on the ThinkBook. An emulator reaches a relay on the computer at http://10.0.2.2:8787.",
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ScrollColumn(padding: PaddingValues, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = { content() },
    )
}

@Composable
private fun Banner(text: String?) {
    if (text.isNullOrBlank()) return
    Text(text, color = MaterialTheme.colorScheme.primary)
}

private fun UiState.tx(zh: String, en: String): String = if (englishUi) en else zh

private fun connectionLabel(connection: String, english: Boolean): String = when (connection) {
    "online" -> if (english) "Connected" else "已连接"
    "connecting" -> if (english) "Connecting" else "连接中"
    "reconnecting" -> if (english) "Reconnecting" else "正在重连"
    else -> if (english) "Not connected" else "未连接"
}

private fun actionLabel(mode: String, send: String, english: Boolean): String = when (mode) {
    "busy" -> if (english) "Waiting" else "等待中"
    "lookup" -> if (english) "Check stored result" else "查看已保存的结果"
    "reuse" -> if (english) "$send again" else "$send 再试一次"
    else -> send
}

private fun wsPreview(httpBase: String, english: Boolean): String = try {
    "WebSocket ${deriveWsUrl(httpBase)}"
} catch (error: RelayFormatException) {
    localize(english, error.message ?: "relay URL is invalid")
}
