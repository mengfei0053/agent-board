package tech.mengfei.agentboard.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import tech.mengfei.agentboard.BoardViewModel
import tech.mengfei.agentboard.Screen
import tech.mengfei.agentboard.UiState
import tech.mengfei.agentboard.protocol.AGENT_KINDS
import tech.mengfei.agentboard.protocol.RelayFormatException
import tech.mengfei.agentboard.protocol.RelayTask
import tech.mengfei.agentboard.protocol.deriveWsUrl
import java.text.DateFormat
import java.util.Date

@Composable
fun RootScreen(state: UiState, model: BoardViewModel) {
    val title = when (val screen = state.screen) {
        Screen.Pair -> "Pair this phone"
        Screen.Boards -> "Boards"
        Screen.Settings -> "Relay"
        is Screen.Tasks -> state.boards.find { it.boardId == screen.boardId }?.label ?: screen.boardId
        is Screen.Detail -> state.tasks.find { it.id == screen.taskId }?.title ?: screen.taskId
        is Screen.Create -> "New task"
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
                Text(title, style = MaterialTheme.typography.headlineSmall)
                Text(connectionLabel(state.connection), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
        }
    }
}

@Composable
private fun PairScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        Text(
            "This phone talks only to the relay. It never dials the ThinkBook board. Ask for a one-time pair code, then enter it here.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Banner(state.banner)
        OutlinedTextField(
            value = state.httpBase,
            onValueChange = model::updateHttpBase,
            label = { Text("Relay HTTP URL") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text(wsPreview(state.httpBase), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = state.pairCode,
            onValueChange = model::updatePairCode,
            label = { Text("Pair code") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = model::updateDeviceName,
            label = { Text("Device name") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(
            onClick = model::pair,
            enabled = !state.busy && state.secureStore,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (state.busy) "Working" else "Pair") }
        OutlinedButton(onClick = model::checkRelay, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text("Check relay")
        }
        TextButton(onClick = model::openSettings) { Text("Relay settings") }
    }
}

@Composable
private fun BoardScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding)) {
        Banner(state.banner)
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::refreshBoards, enabled = state.connection == "online") { Text("Refresh") }
            TextButton(onClick = model::openSettings) { Text("Settings") }
        }
        if (state.boards.isEmpty()) {
            Text(
                "No boards on this token yet. The connector has to register with the relay before a board appears.",
                modifier = Modifier.padding(20.dp),
            )
        } else {
            LazyColumn(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp)) {
                items(state.boards, key = { it.boardId }) { board ->
                    TextButton(onClick = { model.openBoard(board.boardId) }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth()) {
                            Text(board.label ?: board.boardId, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${board.boardId} · ${if (board.online) "online" else "offline"}",
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
                "This board is offline. The relay will not queue a command.",
                modifier = Modifier.padding(horizontal = 20.dp),
                color = MaterialTheme.colorScheme.error,
            )
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = model::pop) { Text("Boards") }
            TextButton(onClick = model::openCreate) { Text("New task") }
        }
        if (state.tasks.isEmpty()) {
            Text("No tasks in the latest snapshot.", modifier = Modifier.padding(20.dp))
        } else {
            LazyColumn(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)) {
                items(state.tasks, key = { it.id }) { task ->
                    TaskRow(task) { model.openTask(task.id) }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: RelayTask, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Text(task.title, style = MaterialTheme.typography.titleMedium)
            Text(
                "${task.status}${task.agent?.let { " · $it" } ?: ""}",
                color = statusColor(task.status),
            )
        }
    }
}

@Composable
private fun DetailScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    val task = state.tasks.find { it.id == state.selectedTaskId }
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text("Tasks") }
        if (task == null) {
            Text("This task is not in the current snapshot.")
        } else {
            Text(task.status, color = statusColor(task.status), style = MaterialTheme.typography.titleMedium)
            Text(task.agent ?: "No agent", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Banner(state.commandNote)
        Banner(state.formError)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = model::submitStop, enabled = state.stopMode != "busy") {
                Text(actionLabel(state.stopMode, "Stop"))
            }
            OutlinedButton(onClick = model::submitContinue, enabled = state.continueMode != "busy") {
                Text(actionLabel(state.continueMode, "Continue"))
            }
        }
        if (state.stopResend) {
            TextButton(onClick = model::resendStop) { Text("Send a new stop") }
        }
        if (state.continueResend) {
            TextButton(onClick = model::resendContinue) { Text("Send a new continue") }
        }
        Text("Log", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
        if (state.logs.isEmpty()) {
            Text("No log lines yet. Lines show up here while this phone is subscribed.")
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
private fun CreateScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text("Tasks") }
        Text("The connector needs an agent and a local working directory. A path that is not a workspace root still runs, and the board may file it under the default workspace.")
        Banner(state.banner)
        Banner(state.commandNote)
        Banner(state.formError)
        OutlinedTextField(
            value = state.draftTitle,
            onValueChange = model::updateDraftTitle,
            label = { Text("Title") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = state.draftPrompt,
            onValueChange = model::updateDraftPrompt,
            label = { Text("Prompt") },
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
            label = { Text("Working directory") },
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
        Button(
            onClick = model::submitCreate,
            enabled = state.createMode != "busy",
            modifier = Modifier.fillMaxWidth(),
        ) { Text(actionLabel(state.createMode, "Create")) }
        if (state.createMode == "lookup") {
            TextButton(onClick = model::startDifferentCreate) {
                Text("Start a different command (new idempotency key)")
            }
        }
    }
}

@Composable
private fun SettingsScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        TextButton(onClick = model::pop) { Text("Back") }
        Banner(state.banner)
        OutlinedTextField(
            value = state.httpBase,
            onValueChange = model::updateHttpBase,
            label = { Text("Relay HTTP URL") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text(wsPreview(state.httpBase), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = state.deviceName,
            onValueChange = model::updateDeviceName,
            label = { Text("Device name") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Button(onClick = model::saveRelay, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
            Text("Save relay URL")
        }
        if (state.paired) {
            state.deviceId?.let { Text("Device $it", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            state.expiresAt?.let {
                Text(
                    "Token expires ${DateFormat.getDateTimeInstance().format(Date(it))}",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(onClick = model::refreshToken, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                Text("Refresh device token")
            }
            TextButton(onClick = { model.forget() }) { Text("Forget this phone") }
        }
        Text(
            "The default host is a placeholder for relay.mengfei.tech. Point this at the relay, not at 127.0.0.1 on the ThinkBook. An emulator reaches a relay on the computer at http://10.0.2.2:8787.",
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

private fun connectionLabel(connection: String): String = when (connection) {
    "online" -> "Connected"
    "connecting" -> "Connecting"
    "reconnecting" -> "Reconnecting"
    else -> "Not connected"
}

private fun actionLabel(mode: String, send: String): String = when (mode) {
    "busy" -> "Waiting"
    "lookup" -> "Check stored result"
    "reuse" -> "$send again"
    else -> send
}

private fun wsPreview(httpBase: String): String = try {
    "WebSocket ${deriveWsUrl(httpBase)}"
} catch (error: RelayFormatException) {
    error.message ?: "Enter an http or https relay URL"
}
