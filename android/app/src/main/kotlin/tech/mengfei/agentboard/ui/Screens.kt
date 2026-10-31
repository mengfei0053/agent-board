package tech.mengfei.agentboard.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import tech.mengfei.agentboard.BoardViewModel
import tech.mengfei.agentboard.Screen
import tech.mengfei.agentboard.UiState
import tech.mengfei.agentboard.protocol.AGENT_KINDS
import tech.mengfei.agentboard.protocol.RelayTask

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RootScreen(state: UiState, model: BoardViewModel) {
    val title = when (state.screen) {
        Screen.Pair -> "Pair this phone"
        Screen.Boards -> "Boards"
        Screen.Settings -> "Relay"
        Screen.Create -> "New task"
        Screen.Tasks -> state.selectedBoardId ?: "Tasks"
        Screen.Detail -> state.selectedTaskId ?: "Task"
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (state.canPop) {
                        TextButton(onClick = model::back) { Text("Back") }
                    }
                },
                actions = {
                    if (state.screen == Screen.Boards || state.screen == Screen.Tasks) {
                        TextButton(onClick = model::openSettings) { Text("Relay") }
                    }
                    if (state.screen == Screen.Tasks) {
                        TextButton(
                            onClick = model::openCreate,
                            enabled = state.connection == "online",
                        ) { Text("New") }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            state.banner?.let { Banner(it) }
            state.commandNote?.let { Banner(it) }
            if (state.needsResync && state.screen != Screen.Pair) {
                Banner("Task list is stale")
            }
            when (state.screen) {
                Screen.Pair -> PairScreen(state, model, Modifier.weight(1f))
                Screen.Settings -> SettingsScreen(state, model, Modifier.weight(1f))
                Screen.Boards -> BoardScreen(state, model, Modifier.weight(1f))
                Screen.Tasks -> TaskScreen(state, model, Modifier.weight(1f))
                Screen.Detail -> DetailScreen(state, model, Modifier.weight(1f))
                Screen.Create -> CreateScreen(state, model, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun PairScreen(state: UiState, model: BoardViewModel, modifier: Modifier = Modifier) {
    ScrollColumn(modifier) {
        Text(
            "This phone talks only to the relay. It never dials the ThinkBook board. Ask for a one-time pair code, then enter it here.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = state.httpBase,
            onValueChange = model::onHttpBase,
            label = { Text("Relay HTTP URL") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = model::onDeviceName,
            label = { Text("Device name") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.pairCode,
            onValueChange = model::onPairCode,
            label = { Text("Pair code") },
            modifier = Modifier.fillMaxWidth(),
        )
        state.formError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = model::pair, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text(if (state.busy) "Working" else "Pair")
        }
        TextButton(onClick = model::checkRelay) { Text("Check relay") }
    }
}

@Composable
private fun SettingsScreen(state: UiState, model: BoardViewModel, modifier: Modifier = Modifier) {
    ScrollColumn(modifier) {
        Text(
            "The default host is a placeholder for relay.mengfei.tech. Point this at the relay, not at 127.0.0.1 on the ThinkBook. An emulator reaches a relay on the computer at http://10.0.2.2",
            style = MaterialTheme.typography.bodyMedium,
        )
        Text("Relay settings", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = state.httpBase,
            onValueChange = model::onHttpBase,
            label = { Text("Relay HTTP URL") },
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Socket ${state.wsUrl}", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = model::onDeviceName,
            label = { Text("Device name") },
            modifier = Modifier.fillMaxWidth(),
        )
        state.formError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = model::saveRelay, modifier = Modifier.fillMaxWidth()) { Text("Save relay URL") }
        TextButton(onClick = model::checkRelay) { Text("Check relay") }
        if (state.paired) {
            TextButton(onClick = { model.forget() }) { Text("Sign out") }
        }
        if (!state.secureStore) {
            Text("Device token storage is not encrypted on this device.")
        }
    }
}

@Composable
private fun BoardScreen(state: UiState, model: BoardViewModel, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::checkRelay, enabled = true) { Text(state.connection) }
        }
        if (state.boards.isEmpty()) {
            Text(
                "No boards on this token yet. The connector has to register with the relay before a board appears.",
                modifier = Modifier.padding(20.dp),
            )
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(state.boards, key = { it.boardId }) { board ->
                    TextButton(onClick = { model.selectBoard(board.boardId) }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth()) {
                            Text(board.label ?: board.boardId, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${board.boardId} · ${if (board.online) "online" else "offline"}",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskScreen(state: UiState, model: BoardViewModel, modifier: Modifier = Modifier) {
    if (state.tasks.isEmpty()) {
        Text("No tasks in the latest snapshot.", modifier = modifier.padding(20.dp))
        return
    }
    LazyColumn(modifier.fillMaxSize()) {
        items(state.tasks, key = { it.id }) { task ->
            TaskRow(task) { model.selectTask(task.id) }
        }
    }
}

@Composable
private fun TaskRow(task: RelayTask, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth()) {
            Text(task.title, style = MaterialTheme.typography.titleMedium)
            Text(
                "${task.status} · ${task.agent ?: "agent"}",
                color = statusColor(task.status),
            )
        }
    }
}

@Composable
private fun DetailScreen(state: UiState, model: BoardViewModel, modifier: Modifier = Modifier) {
    val task = state.tasks.find { it.id == state.selectedTaskId }
    ScrollColumn(modifier) {
        if (task == null) {
            Text("This task is not in the current snapshot.")
            return@ScrollColumn
        }
        Text(task.title, style = MaterialTheme.typography.headlineSmall)
        Text(task.status, color = statusColor(task.status))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = model::stop) { Text("Stop") }
            Button(onClick = model::continueTask) { Text("Continue") }
        }
        TextButton(onClick = model::stop) { Text("Send a new stop") }
        TextButton(onClick = model::continueTask) { Text("Send a new continue") }
        if (state.logs.isEmpty()) {
            Text("No log lines yet.")
        } else {
            state.logs.takeLast(80).forEach { line ->
                Text("${line.stream}: ${line.line}", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun CreateScreen(state: UiState, model: BoardViewModel, modifier: Modifier = Modifier) {
    ScrollColumn(modifier) {
        Text(
            "The connector needs an agent and a local working directory. A path that is not a workspace root still runs, and the board may file it under the default workspace.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = state.draftTitle,
            onValueChange = model::onDraftTitle,
            label = { Text("Title") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = state.draftPrompt,
            onValueChange = model::onDraftPrompt,
            label = { Text("Prompt") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 3,
        )
        Text("Agent", style = MaterialTheme.typography.labelLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            AGENT_KINDS.forEach { kind ->
                TextButton(onClick = { model.onDraftAgent(kind) }) {
                    Text(if (kind == state.draftAgent) "[$kind]" else kind)
                }
            }
        }
        OutlinedTextField(
            value = state.draftCwd,
            onValueChange = model::onDraftCwd,
            label = { Text("Working directory") },
            modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(
                checked = state.draftUseGitWorktree && state.worktreeEnabled,
                onCheckedChange = model::onUseGitWorktree,
                enabled = state.worktreeEnabled,
            )
            Text("Start in a git worktree")
        }
        Text(
            if (state.worktreeEnabled) {
                "Off by default. This cwd matches a git workspace root in the current snapshot."
            } else {
                "Off by default. It stays disabled until this cwd matches a git workspace root in a current snapshot, while the relay is connected and the task list is not stale."
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.formError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = model::submitCreate, enabled = state.connection == "online", modifier = Modifier.fillMaxWidth()) {
            Text("Create")
        }
    }
}

@Composable
private fun Banner(text: String) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        color = MaterialTheme.colorScheme.primary,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun ScrollColumn(modifier: Modifier, content: @Composable () -> Unit) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        content()
    }
}
