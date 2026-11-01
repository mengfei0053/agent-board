package tech.mengfei.agentboard.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
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
import tech.mengfei.agentboard.protocol.BoardPickPath
import tech.mengfei.agentboard.protocol.detailRounds
import tech.mengfei.agentboard.protocol.turnHeading
import tech.mengfei.agentboard.protocol.resumeCommandLabel
import tech.mengfei.agentboard.protocol.statusLabel
import tech.mengfei.agentboard.protocol.renderedHotList
import tech.mengfei.agentboard.protocol.taskListEmptyCopy
import tech.mengfei.agentboard.protocol.workspaceBanner
import tech.mengfei.agentboard.protocol.workspaceDisplayName
import tech.mengfei.agentboard.protocol.workspaceSwitchItems
import java.text.DateFormat
import java.util.Date

@Composable
fun RootScreen(state: UiState, model: BoardViewModel) {
    val messages = remember { SnackbarHostState() }
    LaunchedEffect(state.banner) {
        state.banner?.takeIf { it.isNotBlank() }?.let { messages.showSnackbar(it) }
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.systemBars,
        snackbarHost = { SnackbarHost(messages) },
        floatingActionButton = {
            if (state.screen == Screen.Tasks && state.chip != TaskChip.ARCHIVE && state.writesAllowed) {
                FloatingActionButton(
                    onClick = model::openCreate,
                    modifier = Modifier.height(52.dp),
                    shape = RoundedCornerShape(18.dp),
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ) {
                    Row(Modifier.padding(start = 16.dp, end = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        BoardGlyph(BoardIcon.Plus, Modifier.size(24.dp))
                        Text(stringResource(R.string.new_task), style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
        },
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                if (state.screen == Screen.Tasks) TaskAppBar(state, model) else PageAppBar(state, model)
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
private fun TaskAppBar(state: UiState, model: BoardViewModel) {
    var switcher by remember(state.activeSessionId) { mutableStateOf(false) }
    val active = state.sessions.find { it.sessionId == state.activeSessionId }
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 18.dp, top = 12.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text("ThinkBook", style = MaterialTheme.typography.headlineSmall, letterSpacing = (-.52).sp)
            Box {
                Row(
                    Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = state.sessions.isNotEmpty()) { switcher = true }
                        .padding(top = 2.dp, bottom = 2.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(active?.displayName ?: stringResource(R.string.title_tasks),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 13.sp, lineHeight = 19.sp, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    BoardGlyph(BoardIcon.Chevron, Modifier.size(16.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(expanded = switcher, onDismissRequest = { switcher = false },
                    containerColor = SurfaceHighest, shape = RoundedCornerShape(16.dp)) {
                    state.sessions.forEach { row ->
                        DropdownMenuItem(
                            text = { Text(row.displayName, maxLines = 2) },
                            onClick = { switcher = false; model.activateSession(row.sessionId, BoardPickPath.TopSwitcher) },
                        )
                    }
                }
            }
            ConnectionPill(state.connection.ifBlank { stringResource(R.string.not_connected) }, Modifier.padding(top = 4.dp))
            state.pillDetail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            BoardIconButton(BoardIcon.Boards, stringResource(R.string.my_boards), onClick = model::openMyBoards)
            BoardIconButton(BoardIcon.Workspace, stringResource(R.string.title_workspace_settings),
                enabled = !state.selectedWorkspaceId.isNullOrEmpty(), onClick = model::openWorkspaceSettings)
            BoardIconButton(BoardIcon.Settings, stringResource(R.string.title_board_settings), onClick = model::openBoardSettings)
        }
    }
}

@Composable
private fun PageAppBar(state: UiState, model: BoardViewModel) {
    val title = when (state.screen) {
        Screen.Pair -> stringResource(R.string.title_pair)
        Screen.Reading -> stringResource(R.string.title_reading)
        Screen.MyBoards -> stringResource(R.string.title_my_boards)
        Screen.AddBoard -> stringResource(if (state.repairSessionId == null) R.string.title_add_board else R.string.title_repair)
        is Screen.Detail -> stringResource(R.string.title_detail)
        is Screen.Create -> stringResource(R.string.title_new_task)
        is Screen.WorkspaceCreate -> stringResource(R.string.title_new_workspace)
        Screen.WorkspaceSettings -> stringResource(R.string.title_workspace_settings)
        Screen.BoardSettings -> stringResource(R.string.title_board_settings)
        Screen.Tasks -> stringResource(R.string.title_tasks)
    }
    val editing = state.screen is Screen.Create || state.screen is Screen.WorkspaceCreate ||
        state.screen == Screen.WorkspaceSettings || state.screen == Screen.BoardSettings || state.screen == Screen.AddBoard
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).heightIn(min = 58.dp)) {
        if (state.canPop) {
            TextButton(model::pop, Modifier.align(Alignment.CenterStart), contentPadding = PaddingValues(horizontal = 10.dp)) {
                if (state.screen !is Screen.Create) BoardGlyph(BoardIcon.Back, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                Text(stringResource(if (editing) R.string.cancel else R.string.back), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.align(Alignment.Center))
        val action: Pair<String, () -> Unit>? = when (state.screen) {
            Screen.MyBoards -> stringResource(R.string.add) to model::openAddBoard
            Screen.AddBoard, Screen.Pair -> stringResource(R.string.pair_action) to model::pair
            Screen.WorkspaceSettings -> stringResource(R.string.save) to model::saveWorkspaceSettings
            Screen.BoardSettings -> stringResource(R.string.save) to model::saveBoardSettings
            is Screen.Create -> actionLabel(state.createMode, stringResource(R.string.start_task)) to model::submitCreate
            else -> null
        }
        val enabled = when (state.screen) {
            Screen.AddBoard, Screen.Pair -> pairSubmitAllowed(state.pairCode, state.httpBase, state.secureStore, state.busy)
            Screen.WorkspaceSettings -> state.writesAllowed && state.workspaceForm != null && state.settingsBlocked == null
            Screen.BoardSettings -> state.writesAllowed && state.settingsLoaded && state.settingsBlocked == null
            is Screen.Create -> state.createMode != "busy"
            else -> true
        }
        if (action != null) TextButton(action.second, Modifier.align(Alignment.CenterEnd), enabled = enabled) { Text(action.first) }
    }
}

@Composable
private fun PairScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    PairingForm(state, model, padding, firstPair = true)
}

@Composable
private fun PairingForm(state: UiState, model: BoardViewModel, padding: PaddingValues, firstPair: Boolean) {
    val clipboard = LocalClipboardManager.current
    val issue = inspectPairCode(state.pairCode)
    ScrollColumn(padding) {
        SectionCard(stringResource(R.string.pair_card_title), stringResource(R.string.pair_intro)) {
            if (state.repairSessionId == null) MakeField(state.displayName, model::updateDisplayName,
                stringResource(R.string.board_display_name), stringResource(R.string.board_name_placeholder))
            MakeField(state.httpBase, model::updateHttpBase, stringResource(R.string.relay_http),
                "https://relay.example.com", enabled = state.repairSessionId == null)
            if (firstPair) Text(wsPreview(state.httpBase, state.englishUi),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            MakeField(state.pairCode, model::updatePairCode, stringResource(R.string.pair_code),
                "pc_…", minLines = 2, transformation = PasswordVisualTransformation())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("${trimOuter(state.pairCode).length}/$PAIR_CODE_LENGTH", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { clipboard.getText()?.text?.let(model::pastePairCode) }) { Text(stringResource(R.string.paste)) }
            }
            if (issue != null && state.pairCode.isNotBlank()) Text(pairIssueMessage(issue, state.englishUi),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            if (firstPair) MakeField(state.deviceName, model::updateDeviceName, stringResource(R.string.device_name))
            if (firstPair) MakeAction(stringResource(R.string.check_relay), model::checkRelay,
                modifier = Modifier.fillMaxWidth(), enabled = !state.busy)
        }
        SectionCard(stringResource(R.string.instructions), stringResource(R.string.add_board_note)) { }
    }
}

@Composable
private fun ReadingScreen(padding: PaddingValues, state: UiState) {
    Column(Modifier.fillMaxSize().padding(padding).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.reading_boards))
    }
}

@Composable
private fun MyBoardsScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (state.sessions.size == 1) item {
            Text(stringResource(R.string.keep_one_board), style = MaterialTheme.typography.bodyMedium,
                color = androidx.compose.ui.graphics.Color(0xFFFFE082),
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = .18f)).padding(horizontal = 14.dp, vertical = 12.dp))
        }
        if (state.sessions.isEmpty()) item { Text(stringResource(R.string.no_paired_board), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(state.sessions, key = { it.sessionId }) { row -> BoardCard(state, model, row) }
    }
}

@Composable
private fun BoardCard(state: UiState, model: BoardViewModel, row: tech.mengfei.agentboard.SessionRow) {
    var optionsOpen by remember(row.sessionId) { mutableStateOf(false) }
    val primary = MaterialTheme.colorScheme.primary
    val cardColor = if (row.active) androidx.compose.ui.graphics.lerp(MaterialTheme.colorScheme.surface, primary, .08f)
        else MaterialTheme.colorScheme.surface
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(cardColor)
        .border(1.dp, if (row.active) primary.copy(alpha = .45f) else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(16.dp))
        .padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(row.displayName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(row.subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (row.relayUrl.isNotBlank()) Text(stringResource(R.string.relay_line, row.relayUrl),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(stringResource(R.string.session_saved), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box {
                ConnectionPill(row.pill, Modifier.clip(CircleShape).clickable { optionsOpen = true }.padding(vertical = 3.dp))
                DropdownMenu(optionsOpen, { optionsOpen = false }, containerColor = SurfaceHighest) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.repair_board)) },
                        onClick = { optionsOpen = false; model.openRepair(row.sessionId) })
                    DropdownMenuItem(text = { Text(stringResource(R.string.refresh_token)) },
                        onClick = { optionsOpen = false; model.refreshCredential(row.sessionId) })
                }
            }
        }
        row.expiresAt?.let { Text(stringResource(R.string.sign_in_expires, DateFormat.getDateTimeInstance().format(Date(it))),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MakeAction(stringResource(if (row.active) R.string.current_board else R.string.switch_to_board),
                { model.activateSession(row.sessionId, BoardPickPath.MyBoards) }, Modifier.weight(1f), primary = true, enabled = !row.active)
            MakeAction(stringResource(R.string.forget_board), { model.requestForget(row.sessionId) },
                Modifier.weight(1f), danger = true, enabled = state.forgetEnabled)
        }
        if (state.sessions.size == 1) Text(stringResource(R.string.last_board_forget),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.confirmForgetId == row.sessionId) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.error.copy(alpha = .16f)).padding(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.forget_board_body, row.displayName), style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MakeAction(stringResource(R.string.forget_confirm), model::confirmForget, danger = true)
                    MakeAction(stringResource(R.string.cancel), model::cancelForget)
                }
            }
        }
    }
}

@Composable
private fun AddBoardScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    PairingForm(state, model, padding, firstPair = false)
}

@Composable
private fun TaskScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
        state.cacheSentence?.let {
            Text(it, modifier = Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Banner(state.formError)
        state.createdHidden?.let { Text(it, modifier = Modifier.padding(horizontal = 20.dp)) }
        TaskToolbar(state, model)
        if (state.chip == TaskChip.ARCHIVE) {
            ArchiveList(state, model)
        } else {
            val rendered = renderedHotList(state.tasks, state.workspaces, state.selectedWorkspaceId,
                state.chip, state.searchQuery, state.sawSnapshot)
            if (rendered.cards.isEmpty()) {
                Text(state.filterEmpty ?: taskListEmptyCopy(rendered.empty).orEmpty(),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 48.dp),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            } else {
                LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 88.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(rendered.cards, key = { it.id }) { task ->
                        TaskRow(task, englishNow()) { model.openTask(task.id) }
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
private fun TaskToolbar(state: UiState, model: BoardViewModel) {
    var workspacesOpen by remember(state.activeSessionId) { mutableStateOf(false) }
    val banner = workspaceBanner(state.selectedWorkspaceId, state.workspaces, englishNow())
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 8.dp)) {
        ToolbarLabel(stringResource(R.string.workspace))
        Box {
            Surface(onClick = { workspacesOpen = true }, color = SurfaceHigh,
                shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, OutlineVariant)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 66.dp).padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(banner.title, fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold)
                        banner.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    }
                    BoardGlyph(BoardIcon.Chevron, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            DropdownMenu(expanded = workspacesOpen, onDismissRequest = { workspacesOpen = false },
                modifier = Modifier.fillMaxWidth(.9f).heightIn(max = 360.dp),
                containerColor = SurfaceHighest, shape = RoundedCornerShape(16.dp)) {
                workspaceSwitchItems(state.tasks, state.workspaces, englishNow()).forEach { workspace ->
                    DropdownMenuItem(text = {
                        Column {
                            Text(workspace.label, style = MaterialTheme.typography.labelLarge)
                            state.workspaces.find { it.id == workspace.id }?.path?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }, onClick = { workspacesOpen = false; model.selectWorkspace(workspace.id) })
                }
                HorizontalDivider(color = OutlineVariant)
                DropdownMenuItem(text = { Text(stringResource(R.string.new_workspace)) },
                    onClick = { workspacesOpen = false; model.openWorkspaceCreate() })
                DropdownMenuItem(text = { Text(stringResource(R.string.delete_workspace_title), color = MaterialTheme.colorScheme.error) },
                    enabled = state.workspaces.any { it.id == state.selectedWorkspaceId },
                    onClick = { workspacesOpen = false; model.requestDeleteWorkspace() })
            }
        }
        if (state.workspaceDeleteMode == "lookup") TextButton(model::startDifferentWorkspaceDelete) { Text(stringResource(R.string.delete_new_key)) }
        Spacer(Modifier.height(14.dp))
        ToolbarLabel(stringResource(R.string.status_filter))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(TaskChip.ALL to R.string.chip_all, TaskChip.TODO to R.string.chip_todo,
                TaskChip.RUNNING to R.string.chip_running, TaskChip.DONE to R.string.chip_done,
                TaskChip.ARCHIVE to R.string.chip_archive).forEach { (chip, label) ->
                MakeChip(stringResource(label), state.chip == chip) { model.selectChip(chip) }
            }
        }
        Spacer(Modifier.height(14.dp))
        ToolbarLabel(stringResource(R.string.task_search_label))
        val searchLabel = stringResource(R.string.task_search)
        BasicTextField(state.searchQuery, model::updateSearch,
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp).semantics { contentDescription = searchLabel }, singleLine = true,
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface),
            decorationBox = { input ->
                Row(Modifier.clip(RoundedCornerShape(12.dp)).background(SurfaceHighest)
                    .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .35f), RoundedCornerShape(12.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    BoardGlyph(BoardIcon.Search, Modifier.size(18.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                    Box(Modifier.weight(1f)) {
                        if (state.searchQuery.isEmpty()) Text(stringResource(R.string.task_search_placeholder),
                            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        input()
                    }
                    if (state.searchQuery.isNotEmpty()) {
                        BoardIconButton(BoardIcon.Close, stringResource(R.string.clear_search), modifier = Modifier.size(22.dp)) { model.updateSearch("") }
                    }
                }
            })
    }
}

@Composable
private fun ToolbarLabel(label: String) {
    Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(bottom = 6.dp))
}

@Composable
private fun ColumnScope.ArchiveList(state: UiState, model: BoardViewModel) {
    val blocked = state.sawSnapshot && state.selectedWorkspaceId == null
    if (!blocked && state.archiveVisible.isNotEmpty()) {
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 88.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(state.archiveVisible, key = { it.id }) { task ->
                TaskRow(task, englishNow()) {
                    model.openArchiveTask(task.id)
                }
            }
            item { ArchiveFooter(state, model) }
        }
    } else {
        Text(
            state.filterEmpty ?: stringResource(R.string.no_archived),
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        if (state.archiveInScope) ArchiveFooter(state, model)
    }
}

@Composable
private fun ArchiveFooter(state: UiState, model: BoardViewModel) {
    state.archiveError?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 20.dp)) }
    if (state.archiveStale) {
        Text(stringResource(R.string.archive_stale), modifier = Modifier.padding(horizontal = 20.dp))
    }
    if (state.archiveInScope && state.archiveNextCursor != null) {
        TextButton(onClick = model::loadMoreArchive, enabled = !state.archiveBusy, modifier = Modifier.padding(horizontal = 12.dp)) {
            Text(if (state.archiveBusy) stringResource(R.string.loading) else stringResource(R.string.load_more))
        }
    }
}

@Composable
internal fun TaskRow(task: RelayTask, english: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(horizontal = 17.dp, vertical = 15.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(task.title, fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusBadge(task.status, english)
                Text(listOfNotNull(task.agent, task.iteration?.takeIf { it > 1 }?.let { stringResource(R.string.iteration_line, it) }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun DetailScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    val task = if (state.detailArchived) state.archiveDetail ?: state.archiveTasks.find { it.id == state.selectedTaskId }
        else state.tasks.find { it.id == state.selectedTaskId }
    val english = englishNow()
    ScrollColumn(padding) {
        if (task == null) {
            Text(stringResource(R.string.task_missing))
            return@ScrollColumn
        }
        Column(Modifier.padding(horizontal = 4.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(task.title, style = MaterialTheme.typography.titleLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusBadge(task.status, english)
                val board = state.sessions.find { it.sessionId == state.activeSessionId }
                board?.let { MetaPill(it.displayName) }
                MetaPill(workspaceDisplayName(task.workspaceId, state.workspaces, english))
                Text(listOfNotNull(task.agent, task.model).joinToString(" · "), modifier = Modifier.align(Alignment.CenterVertically),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Banner(state.commandNote)
        Banner(state.formError)
        if (task.status == ARCHIVED_STATUS) {
            Text(stringResource(R.string.archive_readonly), style = MaterialTheme.typography.bodySmall,
                color = statusColor(ARCHIVED_STATUS), modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                    .background(statusColor(ARCHIVED_STATUS).copy(alpha = .14f)).padding(horizontal = 12.dp, vertical = 8.dp))
        } else {
            DetailActions(state, model, task)
        }
        ConversationCard(task, english)
        TaskInfoCard(state, task, english)
        SectionCard(stringResource(R.string.raw_logs)) {
            if (state.logs.isEmpty()) {
                Text(stringResource(R.string.no_logs), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                SelectionContainer {
                    Column(Modifier.fillMaxWidth().heightIn(max = 220.dp).clip(RoundedCornerShape(10.dp))
                        .background(SurfaceDim).border(1.dp, OutlineVariant, RoundedCornerShape(10.dp))
                        .verticalScroll(rememberScrollState()).padding(12.dp)) {
                        state.logs.forEach { line ->
                            Text("${line.stream}: ${line.line}", fontFamily = FontFamily.Monospace,
                                style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.5.sp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailActions(state: UiState, model: BoardViewModel, task: RelayTask) {
    SectionCard(stringResource(R.string.task_actions)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MakeAction(stringResource(R.string.continue_task), model::openContinue, Modifier.weight(1f),
                primary = true, enabled = canContinueStatus(task.status) && state.writesAllowed && !state.continueOpen)
            MakeAction(actionLabel(state.stopMode, stringResource(R.string.stop)), model::submitStop, Modifier.weight(1f),
                danger = true, enabled = (canStopStatus(task.status) || state.stopMode != "send") && state.stopMode != "busy" && state.writesAllowed)
            if (state.archiveWrite) MakeAction(stringResource(R.string.archive_task), model::submitArchive, Modifier.weight(1f),
                enabled = state.writesAllowed && task.status in listOf("succeeded", "failed", "stopped"))
        }
        if (state.continueOpen && canContinueStatus(task.status)) {
            Text(continueHint(task, englishNow()), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            QuickFill(state) { model.updateContinuePrompt(it) }
            MakeField(state.continuePrompt, model::updateContinuePrompt, stringResource(R.string.continue_prompt_label),
                stringResource(R.string.describe_task), minLines = 3)
            MakeAction(actionLabel(state.continueMode, stringResource(R.string.continue_task)), model::submitContinue,
                Modifier.fillMaxWidth(), primary = true,
                enabled = state.continuePrompt.trim().isNotEmpty() && state.continueMode != "busy" && state.writesAllowed)
        }
        if (state.stopResend) TextButton(model::resendStop) { Text(stringResource(R.string.resend_stop)) }
        if (state.continueResend) TextButton(model::resendContinue) { Text(stringResource(R.string.resend_continue)) }
    }
}

@Composable
private fun ConversationCard(task: RelayTask, english: Boolean) {
    SectionCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
            Text(stringResource(R.string.conversation_rounds), style = MaterialTheme.typography.titleSmall)
            turnHeading(task, english)?.let { Text(it, style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f),
                textAlign = androidx.compose.ui.text.style.TextAlign.End) }
        }
        detailError(task, english)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        val rounds = detailRounds(task, english)
        if (rounds.isEmpty()) {
            Text(when (task.status) {
                "running" -> stringResource(R.string.waiting_reply)
                "queued" -> stringResource(R.string.queued_no_reply)
                "paused" -> stringResource(R.string.paused_no_reply)
                else -> stringResource(R.string.no_reply)
            }, modifier = Modifier.fillMaxWidth().padding(20.dp), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        rounds.forEach { round ->
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(SurfaceDim)
                .border(1.dp, if (round.pending) statusColor("running").copy(alpha = .45f) else OutlineVariant, RoundedCornerShape(16.dp))
                .padding(13.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    val at = task.turns?.find { it.iteration == round.iteration }?.at
                    Text(stringResource(R.string.round_line, round.iteration, round.kindLabel) +
                        (at?.let { " · " + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it)) } ?: ""),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (round.pending) Text(stringResource(R.string.round_live).trim(' ', '·'),
                        style = MaterialTheme.typography.labelSmall, color = statusColor("running"))
                }
                val promptShape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp, bottomEnd = 12.dp, bottomStart = 4.dp)
                Column(Modifier.fillMaxWidth().clip(promptShape)
                    .background(androidx.compose.ui.graphics.lerp(MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.primary, .12f))
                    .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = .22f), promptShape)
                    .padding(horizontal = 12.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(stringResource(R.string.user_prompt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    SelectionContainer { Text(round.prompt ?: stringResource(R.string.no_record), style = MaterialTheme.typography.bodyMedium.copy(
                        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None))) }
                }
                Text(stringResource(R.string.agent_reply), style = MaterialTheme.typography.labelSmall, color = Success)
                val replyShape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp, bottomEnd = 4.dp, bottomStart = 12.dp)
                SelectionContainer {
                    Text(round.output?.takeIf { it.isNotBlank() } ?: stringResource(if (round.pending) R.string.reply_pending else R.string.no_round_reply),
                        modifier = Modifier.fillMaxWidth().clip(replyShape).background(SurfaceHigh)
                            .border(1.dp, OutlineVariant, replyShape).padding(horizontal = 12.dp, vertical = 11.dp),
                        style = MaterialTheme.typography.bodyMedium.copy(
                            lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)))
                }
            }
        }
        if (task.promptTruncated) Text(stringResource(R.string.prompt_truncated), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (task.outputTruncated) Text(stringResource(R.string.reply_truncated), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (!task.sideJobs.isNullOrEmpty()) {
            Text(stringResource(R.string.side_jobs), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                task.sideJobs.orEmpty().forEach { job -> MetaPill(job.toolName?.ifBlank { job.title } ?: job.title) }
            }
        }
    }
}

@Composable
private fun TaskInfoCard(state: UiState, task: RelayTask, english: Boolean) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(task.id) { mutableStateOf(false) }
    SectionCard(stringResource(R.string.detail_info)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            Text(stringResource(R.string.task_id), modifier = Modifier.width(88.dp), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).clickable {
                clipboard.setText(AnnotatedString(task.id)); copied = true
            }, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(task.id, modifier = Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                BoardGlyph(BoardIcon.Copy, Modifier.size(14.dp), MaterialTheme.colorScheme.primary)
                Text(stringResource(if (copied) R.string.copied else R.string.copy_task_id), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            }
        }
        state.sessions.find { it.sessionId == state.activeSessionId }?.let { MetaLine(stringResource(R.string.board_settings), it.displayName) }
        MetaLine(stringResource(R.string.status), statusLabel(task.status, english))
        MetaLine(stringResource(R.string.iteration), (task.iteration ?: 1).toString())
        MetaLine(stringResource(R.string.started), epochLabel(task.startedAt))
        MetaLine(stringResource(R.string.ended), epochLabel(task.endedAt))
        MetaLine("Agent", task.agent ?: "—")
        MetaLine(stringResource(R.string.model), task.model ?: "—")
        MetaLine("PID", task.pid?.toString() ?: "—")
        MetaLine(stringResource(R.string.exit_code), task.exitCode?.toString() ?: "—")
        MetaLine(stringResource(R.string.session), task.sessionId ?: "—")
        MetaLine(stringResource(R.string.resume_label), resumeCommandLabel(task, english))
        task.resumeCommand?.let { command -> TextButton({ clipboard.setText(AnnotatedString(command)) }) { Text(stringResource(R.string.copy_resume)) } }
        MetaLine(stringResource(R.string.workspace), workspaceDisplayName(task.workspaceId, state.workspaces, english))
        MetaLine(stringResource(R.string.cwd), task.cwd ?: "—")
        task.worktreeBranch?.takeIf { it.isNotBlank() }?.let { MetaLine(stringResource(R.string.git_branch), it) }
    }
}

@Composable
private fun MetaPill(label: String) {
    Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.clip(CircleShape).background(SurfaceHigh).padding(horizontal = 10.dp, vertical = 4.dp))
}

@Composable
private fun MetaLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, modifier = Modifier.width(88.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer(Modifier.weight(1f)) { Text(value, style = MaterialTheme.typography.bodyMedium) }
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
    var agentOpen by remember { mutableStateOf(false) }
    ScrollColumn(padding) {
        Banner(state.commandNote)
        Banner(state.formError)
        SectionCard {
            MakeField(state.draftTitle, model::updateDraftTitle, stringResource(R.string.title))
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Agent", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Box {
                    Surface(onClick = { agentOpen = true }, color = SurfaceDim,
                        shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, OutlineVariant)) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 11.dp),
                            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text(state.draftAgent, style = MaterialTheme.typography.bodyMedium)
                            BoardGlyph(BoardIcon.Chevron, Modifier.size(18.dp))
                        }
                    }
                    DropdownMenu(expanded = agentOpen, onDismissRequest = { agentOpen = false }, containerColor = SurfaceHighest) {
                        AGENT_KINDS.forEach { agent -> DropdownMenuItem(text = { Text(agent) },
                            onClick = { agentOpen = false; model.updateDraftAgent(agent) }) }
                    }
                }
            }
            MakeField(state.draftPrompt, model::updateDraftPrompt, "Prompt", stringResource(R.string.describe_task), minLines = 6)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(stringResource(R.string.worktree), style = MaterialTheme.typography.labelLarge)
                    Text(stringResource(if (state.worktreeEnabled) R.string.worktree_on else R.string.worktree_off),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(checked = state.draftUseGitWorktree && state.worktreeEnabled,
                    onCheckedChange = model::setUseGitWorktree, enabled = state.worktreeEnabled)
            }
        }
        if (state.quickPrompts.isNotEmpty()) SectionCard(stringResource(R.string.quick_fill)) {
            QuickFill(state, model::updateDraftPrompt)
        }
        SectionCard(stringResource(R.string.workspace)) {
            state.workspaces.find { it.id == state.selectedWorkspaceId }?.let {
                Text(it.name, style = MaterialTheme.typography.labelLarge)
            }
            MakeField(state.draftCwd, model::updateDraftCwd, stringResource(R.string.cwd), "/home/me/src/app")
        }
        if (state.createMode == "lookup") TextButton(model::startDifferentCreate) { Text(stringResource(R.string.new_command)) }
    }
}

@Composable
private fun QuickFill(state: UiState, onFill: (String) -> Unit) {
    if (state.quickPrompts.isEmpty()) return
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        state.quickPrompts.forEach { prompt -> MakeChip(prompt.label) { onFill(prompt.content) } }
    }
}

@Composable
private fun WorkspaceCreateScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        Banner(state.commandNote)
        Banner(state.formError)
        SectionCard(stringResource(R.string.basic_info), stringResource(R.string.workspace_create_hint)) {
            MakeField(state.draftWorkspaceName, model::updateDraftWorkspaceName, stringResource(R.string.name))
            MakeField(state.draftWorkspacePath, model::updateDraftWorkspacePath, stringResource(R.string.path), "/home/me/src/app")
            MakeAction(actionLabel(state.workspaceCreateMode, stringResource(R.string.create)), model::submitWorkspaceCreate,
                Modifier.fillMaxWidth(), primary = true, enabled = state.workspaceCreateMode != "busy")
            if (state.workspaceCreateMode == "lookup") TextButton(model::startDifferentWorkspaceCreate) { Text(stringResource(R.string.new_command)) }
        }
    }
}

@Composable
private fun WorkspaceSettingsScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    ScrollColumn(padding) {
        Banner(state.formError)
        if (state.settingsBlocked != null) {
            SectionCard(description = state.settingsBlocked) { }
            return@ScrollColumn
        }
        val form = state.workspaceForm
        if (form == null) {
            Text(stringResource(R.string.loading))
            return@ScrollColumn
        }
        SectionCard(stringResource(R.string.basic_info), stringResource(R.string.workspace_basic_hint)) {
            MakeField(form.name, { model.updateWorkspaceField(name = it) }, stringResource(R.string.name))
            MakeField(form.path, { model.updateWorkspaceField(path = it) }, stringResource(R.string.path))
            Text(stringResource(R.string.path_keeps_cwd), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        SectionCard(stringResource(R.string.space_instructions), stringResource(R.string.space_instructions_hint)) {
            MakeField(form.systemPrompt, { model.updateWorkspaceField(prompt = it) }, stringResource(R.string.first_run_prompt), minLines = 4)
        }
        SectionCard(stringResource(R.string.skills), stringResource(R.string.skills_hint)) {
            MakeField(form.skills, { model.updateWorkspaceField(skills = it) }, stringResource(R.string.skills), minLines = 3)
        }
        SectionCard("MCP", stringResource(R.string.mcp_hint)) {
            MakeField(form.mcp, { model.updateWorkspaceField(mcp = it) }, stringResource(R.string.mcp_note), minLines = 4)
        }
        form.git?.let { git ->
            SectionCard(stringResource(R.string.git_status), stringResource(R.string.git_readonly)) {
                val error = git.error
                if (error != null) Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                else Text(listOfNotNull(git.branch, stringResource(if (git.dirty) R.string.git_dirty else R.string.git_clean),
                    stringResource(R.string.git_repos, git.repoCount)).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = Success,
                    modifier = Modifier.clip(CircleShape).background(SurfaceDim).padding(horizontal = 12.dp, vertical = 6.dp))
            }
        }
    }
}

@Composable
private fun BoardSettingsScreen(state: UiState, model: BoardViewModel, padding: PaddingValues) {
    var adding by remember(state.activeSessionId) { mutableStateOf(false) }
    var label by remember(state.activeSessionId) { mutableStateOf("") }
    var content by remember(state.activeSessionId) { mutableStateOf("") }
    ScrollColumn(padding) {
        Banner(state.formError)
        if (state.settingsBlocked != null) {
            SectionCard(description = state.settingsBlocked) { }
            return@ScrollColumn
        }
        if (!state.settingsLoaded) {
            Text(stringResource(R.string.loading))
            return@ScrollColumn
        }
        SectionCard(stringResource(R.string.quick_prompts), stringResource(R.string.quick_prompts_hint)) {
            state.quickPrompts.forEach { prompt ->
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(SurfaceDim)
                    .border(1.dp, OutlineVariant, RoundedCornerShape(12.dp)).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        BasicTextField(prompt.label, { model.updateQuickPrompt(prompt.id, label = it) },
                            modifier = Modifier.weight(1f), singleLine = true,
                            textStyle = MaterialTheme.typography.labelLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary))
                        BoardIconButton(BoardIcon.Close, stringResource(R.string.delete)) { model.removeQuickPrompt(prompt.id) }
                    }
                    BasicTextField(prompt.content, { model.updateQuickPrompt(prompt.id, content = it) },
                        modifier = Modifier.fillMaxWidth(), minLines = 2,
                        textStyle = MaterialTheme.typography.bodySmall.copy(color = MaterialTheme.colorScheme.onSurfaceVariant),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary))
                }
            }
            if (adding) {
                MakeField(label, { label = it }, stringResource(R.string.name))
                MakeField(content, { content = it }, stringResource(R.string.prompt), minLines = 2)
                MakeAction(stringResource(R.string.add), {
                    model.addQuickPrompt(label, content)
                    label = ""; content = ""; adding = false
                }, Modifier.fillMaxWidth(), enabled = label.isNotBlank() && content.isNotBlank())
            } else {
                MakeAction("＋ " + stringResource(R.string.add_quick_prompt), { adding = true }, Modifier.fillMaxWidth())
            }
        }
        state.boardForm?.let { form ->
            tech.mengfei.agentboard.protocol.BOARD_AGENT_KEYS.forEach { key ->
                val agent = form.agents.getValue(key)
                SectionCard("Agent · " + if (key == "agent") "Cursor" else key.replaceFirstChar { it.uppercase() },
                    stringResource(R.string.agent_settings_hint)) {
                    MakeField(agent.cliPath, { model.updateAgentSettings(key, cliPath = it) },
                        stringResource(R.string.cli_path), stringResource(R.string.cli_default, agent.defaultPath))
                    Text(if (agent.cliPath.isNotBlank()) stringResource(R.string.cli_check_after_save)
                        else agent.resolved ?: stringResource(R.string.cli_not_found),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (agent.resolved == null) MaterialTheme.colorScheme.onSurfaceVariant else Success)
                    tech.mengfei.agentboard.protocol.BOARD_PROXY_KEYS.forEach { proxy ->
                        MakeField(agent.proxies.getValue(proxy), { model.updateAgentSettings(key, proxyKey = proxy, proxyValue = it) },
                            proxy, stringResource(R.string.proxy_placeholder))
                    }
                    if (key == "codex") Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.codex_sandbox), style = MaterialTheme.typography.labelLarge)
                            Text(stringResource(R.string.codex_sandbox_hint), style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Switch(form.codexSandbox, model::updateCodexSandbox)
                    }
                }
            }
        }
        SectionCard(stringResource(R.string.instructions), stringResource(R.string.default_model_sentence)) { }
    }
}

@Composable
private fun ScrollColumn(padding: PaddingValues, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
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
