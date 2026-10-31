package tech.mengfei.agentboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import tech.mengfei.agentboard.data.RelayApi
import tech.mengfei.agentboard.data.SessionStore
import tech.mengfei.agentboard.data.SocketListener
import tech.mengfei.agentboard.notify.DoneNotifier
import tech.mengfei.agentboard.protocol.ARCHIVE_CAPABILITY
import tech.mengfei.agentboard.protocol.ARCHIVED_STATUS
import tech.mengfei.agentboard.protocol.ArchiveRequest
import tech.mengfei.agentboard.protocol.BoardInfo
import tech.mengfei.agentboard.protocol.BoardReducer
import tech.mengfei.agentboard.protocol.BoardView
import tech.mengfei.agentboard.protocol.DetailRequest
import tech.mengfei.agentboard.protocol.CommandAction
import tech.mengfei.agentboard.protocol.CommandInterpretation
import tech.mengfei.agentboard.protocol.EventIdDeduper
import tech.mengfei.agentboard.protocol.OutstandingCommand
import tech.mengfei.agentboard.protocol.PairGate
import tech.mengfei.agentboard.protocol.Recovery
import tech.mengfei.agentboard.protocol.Envelope
import tech.mengfei.agentboard.protocol.LogLine
import tech.mengfei.agentboard.protocol.RelayFormatException
import tech.mengfei.agentboard.protocol.RelayTask
import tech.mengfei.agentboard.protocol.ResyncScheduler
import tech.mengfei.agentboard.protocol.Retry
import tech.mengfei.agentboard.protocol.SubmitPlan
import tech.mengfei.agentboard.protocol.Validated
import tech.mengfei.agentboard.protocol.boardListEnvelope
import tech.mengfei.agentboard.protocol.deriveWsUrl
import tech.mengfei.agentboard.protocol.encodeEnvelope
import tech.mengfei.agentboard.protocol.text
import tech.mengfei.agentboard.protocol.encodePairBody
import tech.mengfei.agentboard.protocol.encodeRefreshBody
import tech.mengfei.agentboard.protocol.explicitResendAllowed
import tech.mengfei.agentboard.protocol.helloEnvelope
import tech.mengfei.agentboard.protocol.interpretCommand
import tech.mengfei.agentboard.protocol.lookupEnvelope
import tech.mengfei.agentboard.protocol.lookupSendFailed
import tech.mengfei.agentboard.protocol.newIdempotencyKey
import tech.mengfei.agentboard.protocol.newMessageId
import tech.mengfei.agentboard.protocol.nextCommandAction
import tech.mengfei.agentboard.protocol.normalizeHttpBase
import tech.mengfei.agentboard.protocol.parseBoardList
import tech.mengfei.agentboard.protocol.parseEnvelope
import tech.mengfei.agentboard.protocol.parseHealth
import tech.mengfei.agentboard.protocol.parsePairResponse
import tech.mengfei.agentboard.protocol.parseRelayError
import tech.mengfei.agentboard.protocol.persistThenConnect
import tech.mengfei.agentboard.protocol.planSubmit
import tech.mengfei.agentboard.protocol.recoverAfterHello
import tech.mengfei.agentboard.protocol.recoverFromLookup
import tech.mengfei.agentboard.protocol.sessionRejected
import tech.mengfei.agentboard.protocol.subLogsEnvelope
import tech.mengfei.agentboard.protocol.subTasksEnvelope
import tech.mengfei.agentboard.protocol.validateContinue
import tech.mengfei.agentboard.protocol.validateDetail
import tech.mengfei.agentboard.protocol.ThinWorkspace
import tech.mengfei.agentboard.protocol.cwdForNewTask
import tech.mengfei.agentboard.protocol.activeDetailTask
import tech.mengfei.agentboard.protocol.archiveReplySettled
import tech.mengfei.agentboard.protocol.archivedDetailTask
import tech.mengfei.agentboard.protocol.detailReplySettled
import tech.mengfei.agentboard.protocol.inspectPairCode
import tech.mengfei.agentboard.protocol.mergeArchivePages
import tech.mengfei.agentboard.protocol.pairHttpFailure
import tech.mengfei.agentboard.protocol.pairIssueMessage
import tech.mengfei.agentboard.protocol.pairSubmitAllowed
import tech.mengfei.agentboard.protocol.readArchivePage
import tech.mengfei.agentboard.protocol.tasksAfterBoardSwitch
import tech.mengfei.agentboard.protocol.trimOuter
import tech.mengfei.agentboard.protocol.validateArchiveList
import tech.mengfei.agentboard.protocol.nextWorkspaceSelection
import tech.mengfei.agentboard.protocol.validateCreate
import tech.mengfei.agentboard.protocol.validateStop
import tech.mengfei.agentboard.protocol.validateWorkspaceCreate
import tech.mengfei.agentboard.protocol.validateWorkspaceDelete
import tech.mengfei.agentboard.protocol.withLocalTask
import tech.mengfei.agentboard.protocol.withWorkspace
import tech.mengfei.agentboard.protocol.withoutWorkspace
import tech.mengfei.agentboard.protocol.workspaceIdForCreate
import tech.mengfei.agentboard.protocol.workspaceListKey
import tech.mengfei.agentboard.ui.localize
import tech.mengfei.agentboard.protocol.worktreeAllowedFresh
import java.io.IOException

sealed interface Screen {
    data object Pair : Screen
    data object Boards : Screen
    data object Settings : Screen
    data class Tasks(val boardId: String) : Screen
    data class Detail(val boardId: String, val taskId: String) : Screen
    data class Create(val boardId: String) : Screen
    data class WorkspaceCreate(val boardId: String) : Screen
}

data class UiState(
    val screen: Screen = Screen.Pair,
    val httpBase: String = "",
    val wsUrl: String = "",
    val deviceName: String = "Android phone",
    val pairCode: String = "",
    val paired: Boolean = false,
    val secureStore: Boolean = true,
    val deviceId: String? = null,
    val expiresAt: Long? = null,
    val connection: String = "signed out",
    val boards: List<BoardInfo> = emptyList(),
    val tasks: List<RelayTask> = emptyList(),
    val logs: List<LogLine> = emptyList(),
    val selectedBoardId: String? = null,
    val selectedTaskId: String? = null,
    val selectedOnline: Boolean? = null,
    val needsResync: Boolean = false,
    val banner: String? = null,
    val commandNote: String? = null,
    val formError: String? = null,
    val busy: Boolean = false,
    val createMode: String = "send",
    val stopMode: String = "send",
    val continueMode: String = "send",
    val stopResend: Boolean = false,
    val continueResend: Boolean = false,
    val draftTitle: String = "",
    val draftPrompt: String = "",
    val draftAgent: String = "cursor",
    val draftCwd: String = "",
    val draftUseGitWorktree: Boolean = false,
    val worktreeEnabled: Boolean = false,
    val workspaces: List<ThinWorkspace> = emptyList(),
    val selectedWorkspaceId: String? = null,
    val draftWorkspaceName: String = "",
    val draftWorkspacePath: String = "",
    val workspaceCreateMode: String = "send",
    val workspaceDeleteMode: String = "send",
    val confirmDeleteWorkspace: Boolean = false,
    val continuePrompt: String = "",
    val canPop: Boolean = false,
    val englishUi: Boolean = false,
    val sawSnapshot: Boolean = false,
    val lane: String = "active",
    val archiveTasks: List<RelayTask> = emptyList(),
    val archiveNextCursor: String? = null,
    val archiveLoaded: Boolean = false,
    val archiveStale: Boolean = false,
    val archiveBusy: Boolean = false,
    val archiveError: String? = null,
    val archiveSupported: Boolean = false,
    val detailArchived: Boolean = false,
    val archiveDetail: RelayTask? = null,
)

class BoardViewModel(
    private val store: SessionStore,
    private val relay: RelayApi,
    private val notifier: DoneNotifier,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val ids: () -> String = { newMessageId() },
    private val keys: () -> String = { newIdempotencyKey() },
    private val englishUi: Boolean = false,
) : ViewModel() {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var token: String? = null
    private var wantConnection = false
    private var refreshInFlight = false
    private var socketGeneration = 0
    private var generationClosed = false
    private var backoffMs = 1_000L
    private var reconnectJob: Job? = null
    private var resyncJob: Job? = null
    private var pendingHello: String? = null
    private var pendingList: String? = null
    private var boardEpoch = 0
    private var pendingDetail: DetailRequest? = null
    private var pendingArchive: ArchiveRequest? = null
    private var archiveTasks: List<RelayTask> = emptyList()
    private var archiveNextCursor: String? = null
    private var archiveLoaded = false
    private var archiveStale = false
    private var archiveBusy = false
    private var archiveError: String? = null
    private var lane = "active"
    private var detailArchived = false
    private var archiveDetail: RelayTask? = null
    private val doneDedupe = EventIdDeduper()
    private var reducer = BoardReducer(doneDedupe = doneDedupe)
    private var view = BoardView("")
    private val resync = ResyncScheduler()
    private var pollJob: Job? = null
    private var workspaceKey: String = ""
    private val selectedByBoard = mutableMapOf<String, String>()
    /** True only after a snapshot that is not waiting on a sequence gap, while this socket is online. */
    private var eligibilityFresh: Boolean = false
    private val backStack = ArrayDeque<Screen>()
    private var inflight: Inflight? = null
    private val settledByAction = mutableMapOf<String, Settled>()
    private var boards: List<BoardInfo> = emptyList()
    private var connection = "signed out"
    private var banner: String? = null
    private var commandNote: String? = null
    private var formError: String? = null
    private var busy = false

    init {
        val saved = store.read()
        token = saved.deviceToken
        connection = if (token.isNullOrBlank()) "signed out" else "connecting"
        banner = if (saved.secure) null else say("Secure storage is unavailable, so this phone cannot keep a device token.")
        _state.value = UiState(
            screen = if (token.isNullOrBlank()) Screen.Pair else Screen.Boards,
            httpBase = saved.httpBase,
            wsUrl = saved.wsUrl,
            deviceName = saved.deviceName,
            paired = !token.isNullOrBlank(),
            secureStore = saved.secure,
            deviceId = saved.deviceId,
            expiresAt = saved.expiresAt,
            connection = connection,
            banner = banner,
            englishUi = englishUi,
        )
        if (!token.isNullOrBlank()) connect()
    }

    fun updatePairCode(value: String) = _state.updateCopy { copy(pairCode = value) }
    fun updateDeviceName(value: String) = _state.updateCopy { copy(deviceName = value) }
    fun updateHttpBase(value: String) = _state.updateCopy { copy(httpBase = value) }
    fun updateDraftTitle(value: String) = _state.updateCopy { copy(draftTitle = value) }
    fun updateDraftPrompt(value: String) = _state.updateCopy { copy(draftPrompt = value) }
    fun updateDraftAgent(value: String) = _state.updateCopy { copy(draftAgent = value) }
    fun updateDraftCwd(value: String) = _state.updateCopy { copy(draftCwd = value, draftUseGitWorktree = false) }
    fun updateDraftWorkspaceName(value: String) = _state.updateCopy { copy(draftWorkspaceName = value) }
    fun updateDraftWorkspacePath(value: String) = _state.updateCopy { copy(draftWorkspacePath = value) }
    fun updateContinuePrompt(value: String) = _state.updateCopy { copy(continuePrompt = value) }

    fun setUseGitWorktree(value: Boolean) {
        val current = _state.value
        _state.updateCopy {
            copy(draftUseGitWorktree = value && freshWorktree(current.draftCwd, current.workspaces, current.needsResync))
        }
    }

    fun openSettings() = push(Screen.Settings)
    fun openCreate() {
        val boardId = _state.value.selectedBoardId ?: return
        val current = _state.value
        val selectedPath = current.workspaces.find { it.id == current.selectedWorkspaceId }?.path
        val nextCwd = cwdForNewTask(current.draftCwd, selectedPath, current.workspaces.map { it.path })
        _state.updateCopy { copy(draftUseGitWorktree = false, draftCwd = nextCwd) }
        push(Screen.Create(boardId))
    }

    fun openWorkspaceCreate() {
        val boardId = _state.value.selectedBoardId ?: return
        _state.updateCopy { copy(draftWorkspaceName = "", draftWorkspacePath = "", formError = null) }
        push(Screen.WorkspaceCreate(boardId))
    }

    fun selectWorkspace(id: String) {
        val boardId = _state.value.selectedBoardId ?: return
        if (id.isNotEmpty() && view.workspaces.none { it.id == id }) return
        selectedByBoard[boardId] = id
        store.saveSelectedWorkspace(boardId, id)
        render()
    }

    fun requestDeleteWorkspace() {
        val id = _state.value.selectedWorkspaceId
        if (id.isNullOrEmpty() || _state.value.workspaces.none { it.id == id }) return
        _state.updateCopy { copy(confirmDeleteWorkspace = true) }
    }

    fun cancelDeleteWorkspace() = _state.updateCopy { copy(confirmDeleteWorkspace = false) }

    fun confirmDeleteWorkspace() {
        val current = _state.value
        val boardId = current.selectedBoardId ?: return
        val workspaceId = current.selectedWorkspaceId ?: return
        if (workspaceId.isEmpty()) return
        _state.updateCopy { copy(confirmDeleteWorkspace = false) }
        val action = actionKey("cmd.workspace.delete", boardId, workspaceId)
        if (settledByAction[action]?.interpretation?.retry == Retry.ReuseSameKey) {
            settledByAction.remove(action)
        }
        submit("cmd.workspace.delete", boardId, workspaceId)
    }

    fun submitWorkspaceCreate() {
        val boardId = _state.value.selectedBoardId ?: return
        val action = actionKey("cmd.workspace.create", boardId, null)
        if (settledByAction[action]?.interpretation?.retry == Retry.ReuseSameKey) {
            settledByAction.remove(action)
        }
        submit("cmd.workspace.create", boardId, null)
    }

    fun pop() {
        val previous = backStack.removeLastOrNull() ?: return
        _state.updateCopy {
            copy(screen = previous, canPop = backStack.isNotEmpty(), formError = null, confirmDeleteWorkspace = false)
        }
    }

    fun pastePairCode(raw: String) {
        _state.updateCopy { copy(pairCode = trimOuter(raw)) }
    }

    fun showActive() {
        lane = "active"
        render()
    }

    fun showArchive() {
        lane = "archive"
        if (!archiveSupportedNow()) {
            archiveError = say("This board cannot list archived tasks yet.")
            render()
            return
        }
        archiveError = null
        render()
        if (!archiveLoaded || archiveStale) loadArchive(reset = true)
    }

    fun loadMoreArchive() {
        if (archiveBusy || archiveNextCursor == null) return
        loadArchive(reset = false)
    }

    fun pair() {
        if (!store.secure) {
            banner = say("Secure storage is unavailable, so this phone cannot store a device token.")
            render()
            return
        }
        val issue = inspectPairCode(_state.value.pairCode)
        if (issue != null || !pairSubmitAllowed(_state.value.pairCode, _state.value.httpBase, secure = true, busy = false)) {
            banner = issue?.let { pairIssueMessage(it, englishUi) } ?: say("Enter an http or https relay URL.")
            render()
            return
        }
        val code = trimOuter(_state.value.pairCode)
        val name = _state.value.deviceName.trim().ifBlank { "Android phone" }
        viewModelScope.launch {
            busy = true
            banner = null
            render()
            try {
                val base = normalizeHttpBase(_state.value.httpBase)
                val ws = deriveWsUrl(base)
                store.saveRelay(base, ws, name)
                _state.updateCopy { copy(httpBase = base, wsUrl = ws, deviceName = name) }
                val result = relay.request("POST", "$base/auth/pair", encodePairBody(code, name))
                if (result.code !in 200..299) {
                    busy = false
                    banner = pairHttpFailure(result.code, result.body, englishUi)
                    render()
                    return@launch
                }
                val paired = parsePairResponse(result.body)
                when (val gate = persistThenConnect(store.saveToken(paired))) {
                    is PairGate.Hold -> {
                        busy = false
                        token = null
                        banner = say(gate.message)
                        render()
                        return@launch
                    }
                    PairGate.OpenSocket -> {
                        token = paired.deviceToken
                        busy = false
                        banner = null
                        backStack.clear()
                        _state.updateCopy {
                            copy(
                                paired = true,
                                secureStore = true,
                                deviceId = paired.deviceId,
                                expiresAt = paired.expiresAt,
                                screen = Screen.Boards,
                                canPop = false,
                                pairCode = "",
                            )
                        }
                        connect()
                    }
                }
            } catch (error: RelayFormatException) {
                busy = false
                banner = say(error.message ?: "relay URL is invalid")
                render()
            } catch (error: IOException) {
                busy = false
                banner = say("Could not reach the relay.")
                render()
            }
        }
    }

    fun checkRelay() {
        viewModelScope.launch {
            busy = true
            render()
            try {
                val base = normalizeHttpBase(_state.value.httpBase)
                val ws = deriveWsUrl(base)
                _state.updateCopy { copy(httpBase = base, wsUrl = ws) }
                val result = relay.request("GET", "$base/health", null)
                busy = false
                banner = if (result.code in 200..299) {
                    val health = parseHealth(result.body)
                    if (health == null) say("The relay answered, but /health was not recognized.")
                    else if (englishUi) "Relay is up. Boards online: ${health.boardsOnline}."
                    else "中继正常。在线看板：${health.boardsOnline}。"
                } else {
                    say(parseRelayError(result.body))
                }
                render()
            } catch (error: RelayFormatException) {
                busy = false
                banner = say(error.message ?: "relay URL is invalid")
                render()
            } catch (error: IOException) {
                busy = false
                banner = say("Could not reach the relay.")
                render()
            }
        }
    }

    fun saveRelay() {
        try {
            val base = normalizeHttpBase(_state.value.httpBase)
            val ws = deriveWsUrl(base)
            val name = _state.value.deviceName.trim().ifBlank { "Android phone" }
            store.saveRelay(base, ws, name)
            banner = say("Relay URL saved.")
            _state.updateCopy { copy(httpBase = base, wsUrl = ws, deviceName = name) }
            if (!token.isNullOrBlank()) connect() else render()
        } catch (error: RelayFormatException) {
            banner = say(error.message ?: "relay URL is invalid")
            render()
        }
    }

    fun refreshToken() {
        val current = token ?: return
        viewModelScope.launch {
            refreshInFlight = true
            busy = true
            render()
            var reconnectAfter = false
            try {
                val base = _state.value.httpBase.trimEnd('/')
                val result = relay.request("POST", "$base/auth/refresh", encodeRefreshBody(current))
                if (result.code == 401 || result.code == 403) {
                    forget("The relay rejected this device token.")
                    return@launch
                }
                if (result.code !in 200..299) {
                    banner = say(parseRelayError(result.body))
                    reconnectAfter = true
                } else {
                    val paired = parsePairResponse(result.body)
                    val saved = store.saveToken(paired)
                    token = paired.deviceToken
                    banner = say(if (saved) {
                        "Device token refreshed. Reconnecting."
                    } else {
                        "Token refreshed but could not be stored on this phone. Reconnecting for this session."
                    })
                    _state.updateCopy { copy(deviceId = paired.deviceId, expiresAt = paired.expiresAt) }
                    reconnectAfter = true
                }
            } catch (error: RelayFormatException) {
                banner = say(error.message ?: "relay URL is invalid")
                reconnectAfter = true
            } catch (error: IOException) {
                banner = say("Could not reach the relay.")
                reconnectAfter = true
            } finally {
                refreshInFlight = false
                busy = false
                render()
                if (reconnectAfter && !token.isNullOrBlank() && _state.value.paired) connect()
            }
        }
    }

    fun forget(message: String = "This phone is signed out. Pair again to connect.") {
        wantConnection = false
        refreshInFlight = false
        socketGeneration += 1
        reconnectJob?.cancel()
        resyncJob?.cancel()
        relay.closeSocket()
        store.clearToken()
        token = null
        inflight = null
        eligibilityFresh = false
        pollJob?.cancel()
        settledByAction.clear()
        doneDedupe.clear()
        reducer = BoardReducer(doneDedupe = doneDedupe)
        view = BoardView("")
        boards = emptyList()
        connection = "signed out"
        backStack.clear()
        clearArchive()
        boardEpoch += 1
        pendingDetail = null
        banner = say(message)
        commandNote = null
        _state.updateCopy {
            copy(
                screen = Screen.Pair,
                paired = false,
                deviceId = null,
                expiresAt = null,
                boards = emptyList(),
                tasks = emptyList(),
                logs = emptyList(),
                selectedBoardId = null,
                selectedTaskId = null,
                canPop = false,
                connection = connection,
            )
        }
    }

    fun refreshBoards() {
        if (connection != "online") return
        val listId = ids()
        pendingList = listId
        send(boardListEnvelope(listId, clock()))
    }

    fun openBoard(boardId: String) {
        boardEpoch += 1
        pendingDetail = null
        pendingArchive = null
        clearArchive()
        lane = "active"
        detailArchived = false
        archiveDetail = null
        reducer = BoardReducer(doneDedupe = doneDedupe)
        view = BoardView(boardId)
        eligibilityFresh = false
        resyncJob?.cancel()
        commandNote = null
        formError = null
        val saved = store.selectedWorkspace(boardId)
        if (saved == null) selectedByBoard.remove(boardId) else selectedByBoard[boardId] = saved
        _state.updateCopy {
            copy(
                selectedBoardId = boardId,
                selectedTaskId = null,
                tasks = emptyList(),
                logs = emptyList(),
                archiveTasks = emptyList(),
                archiveDetail = null,
                detailArchived = false,
                lane = "active",
                sawSnapshot = false,
                draftUseGitWorktree = false,
                confirmDeleteWorkspace = false,
            )
        }
        push(Screen.Tasks(boardId))
        if (connection == "online") resubscribe(boardId)
        render()
    }

    fun openTask(taskId: String) = openCard(taskId, archived = false)

    fun openArchiveTask(taskId: String) = openCard(taskId, archived = true)

    private fun openCard(taskId: String, archived: Boolean) {
        val boardId = _state.value.selectedBoardId ?: return
        detailArchived = archived
        archiveDetail = if (archived) archiveTasks.find { it.id == taskId } else null
        _state.updateCopy { copy(selectedTaskId = taskId, formError = null, detailArchived = archived, archiveDetail = archiveDetail) }
        push(Screen.Detail(boardId, taskId))
        requestDetail(boardId, taskId)
        render()
    }

    fun submitCreate() = submit("cmd.create", _state.value.selectedBoardId, null)
    fun submitStop() = submit("cmd.stop", _state.value.selectedBoardId, _state.value.selectedTaskId)
    fun submitContinue() = submit("cmd.continue", _state.value.selectedBoardId, _state.value.selectedTaskId)

    fun startDifferentCreate() {
        val boardId = _state.value.selectedBoardId ?: return
        if (inflight != null) return
        settledByAction.remove(actionKey("cmd.create", boardId, null))
        commandNote = say("The next create uses a new idempotency key.")
        _state.updateCopy { copy(draftUseGitWorktree = false) }
        render()
    }

    fun startDifferentWorkspaceCreate() {
        val boardId = _state.value.selectedBoardId ?: return
        if (inflight != null) return
        settledByAction.remove(actionKey("cmd.workspace.create", boardId, null))
        commandNote = say("The next workspace create uses a new idempotency key.")
        render()
    }

    fun startDifferentWorkspaceDelete() {
        val boardId = _state.value.selectedBoardId ?: return
        val workspaceId = _state.value.selectedWorkspaceId ?: return
        if (inflight != null || workspaceId.isEmpty()) return
        settledByAction.remove(actionKey("cmd.workspace.delete", boardId, workspaceId))
        commandNote = say("The next workspace delete uses a new idempotency key.")
        render()
    }

    fun resendStop() = resend("cmd.stop")
    fun resendContinue() = resend("cmd.continue")

    private fun resend(cmd: String) {
        val boardId = _state.value.selectedBoardId ?: return
        val taskId = _state.value.selectedTaskId ?: return
        val action = actionKey(cmd, boardId, taskId)
        if (!explicitResendAllowed(cmd, settledByAction[action]?.interpretation)) return
        settledByAction.remove(action)
        submit(cmd, boardId, taskId)
    }

    private fun submit(cmd: String, boardId: String?, taskId: String?) {
        if (boardId.isNullOrBlank()) return
        when (cmd) {
            "cmd.create", "cmd.workspace.create" -> Unit
            "cmd.stop", "cmd.continue", "cmd.workspace.delete" -> if (taskId.isNullOrBlank()) return
            else -> return
        }
        val action = actionKey(cmd, boardId, taskId)
        val settled = settledByAction[action]
        when (val plan = planSubmit(cmd, inflight != null, settled?.interpretation, settled?.key, keys)) {
            SubmitPlan.Busy -> return
            is SubmitPlan.Lookup -> {
                commandNote = say("Checking the stored result. This command will not be sent again.")
                formError = null
                beginLookup(Inflight(action, cmd, boardId, taskId, plan.idempotencyKey, requestId = "pending"))
                render()
            }
            is SubmitPlan.Send -> sendCommand(action, cmd, boardId, taskId, plan.idempotencyKey, settled?.interpretation?.retry == Retry.ReuseSameKey)
        }
    }

    private fun sendCommand(
        action: String,
        cmd: String,
        boardId: String,
        taskId: String?,
        key: String,
        reused: Boolean,
    ) {
        val requestId = ids()
        val ts = clock()
        val draft = _state.value
        val selected = draft.workspaces.find { it.id == draft.selectedWorkspaceId }
        val built = when (cmd) {
            "cmd.create" -> validateCreate(
                requestId,
                ts,
                boardId,
                draft.draftTitle,
                draft.draftPrompt,
                draft.draftAgent,
                draft.draftCwd,
                key,
                useGitWorktree = draft.draftUseGitWorktree && freshWorktree(draft.draftCwd, draft.workspaces, draft.needsResync),
                workspaceId = workspaceIdForCreate(draft.draftCwd, selected?.id, selected?.path),
            )
            "cmd.workspace.create" -> validateWorkspaceCreate(
                requestId,
                ts,
                boardId,
                draft.draftWorkspaceName,
                draft.draftWorkspacePath,
                key,
            )
            "cmd.workspace.delete" -> validateWorkspaceDelete(requestId, ts, boardId, taskId ?: return, key)
            "cmd.stop" -> validateStop(requestId, ts, boardId, taskId ?: return, key)
            else -> validateContinue(requestId, ts, boardId, taskId ?: return, key, draft.continuePrompt)
        }
        when (built) {
            is Validated.Invalid -> {
                formError = say(built.message)
                render()
            }
            is Validated.Ok -> {
                if (!send(built.value)) {
                    commandNote = say("Not connected to the relay.")
                    render()
                    return
                }
                inflight = Inflight(action, cmd, boardId, taskId, key, requestId)
                settledByAction.remove(action)
                formError = null
                commandNote = if (reused) {
                    say("Sending again with the same idempotency key.")
                } else if (englishUi) {
                    "Sending $cmd."
                } else {
                    "正在发送 $cmd。"
                }
                render()
            }
        }
    }

    private fun connect() {
        val current = token
        val wsUrl = _state.value.wsUrl
        if (current.isNullOrBlank() || wsUrl.isBlank()) return
        reconnectJob?.cancel()
        pollJob?.cancel()
        generationClosed = false
        val generation = ++socketGeneration
        wantConnection = true
        connection = if (connection == "online") "reconnecting" else "connecting"
        render()
        relay.openSocket(wsUrl, object : SocketListener {
            override fun onOpen() {
                viewModelScope.launch {
                    if (generation != socketGeneration) return@launch
                    val helloId = ids()
                    pendingHello = helloId
                    val name = _state.value.deviceName.ifBlank { "Android phone" }
                    if (!send(helloEnvelope(helloId, clock(), current, name))) {
                        connection = "reconnecting"
                        render()
                    }
                }
            }

            override fun onMessage(text: String) {
                viewModelScope.launch {
                    if (generation != socketGeneration) return@launch
                    onFrame(text)
                }
            }

            override fun onClosed(reason: String) {
                viewModelScope.launch {
                    if (generation != socketGeneration || generationClosed) return@launch
                    generationClosed = true
                    onSocketClosed()
                }
            }
        })
    }

    private fun onFrame(text: String) {
        val message = try {
            parseEnvelope(text)
        } catch (error: RelayFormatException) {
            return
        }
        if (sessionRejected(message) && message.text("ref") != inflight?.requestId) {
            forget("The relay rejected this phone. Pair again.")
            return
        }
        val ref = message.text("ref")
        if (ref != null && ref == pendingHello) {
            onHello(message)
            return
        }
        val listed = if (message.type == "ack") parseBoardList(message.payload) else null
        if (ref != null && ref == pendingList && listed != null) {
            boards = listed
            render()
            if (lane == "archive" && archiveSupportedNow() && (!archiveLoaded || archiveStale)) {
                loadArchive(reset = true)
            }
            return
        }
        val detail = pendingDetail
        if (detail != null && ref != null && ref == detail.requestId) {
            if (!detailReplySettled(message)) return
            pendingDetail = null
            val interpreted = interpretCommand(message)
            val task = interpreted?.task
            val active = activeDetailTask(detail, boardEpoch, view.boardId, ref, task)
            val archived = archivedDetailTask(detail, boardEpoch, view.boardId, ref, task)
            if (active != null && active.status != ARCHIVED_STATUS) {
                view = view.withLocalTask(active)
            } else if (archived != null) {
                archiveDetail = archived
                detailArchived = true
            } else if (message.type == "err" || message.text("stage") in setOf("failed", "timeout", "unknown")) {
                if (interpreted != null && detail.epoch == boardEpoch && detail.boardId == view.boardId) {
                    formError = say(interpreted.summary)
                }
            }
            render()
            return
        }
        val archive = pendingArchive
        if (archive != null && ref != null && ref == archive.requestId) {
            if (!archiveReplySettled(message)) return
            if (archive.epoch != boardEpoch || archive.boardId != view.boardId) {
                pendingArchive = null
                archiveBusy = false
                render()
                return
            }
            pendingArchive = null
            archiveBusy = false
            val code = message.text("code")
            val stage = message.text("stage")
            if (message.type == "err" || stage in setOf("failed", "timeout", "unknown")) {
                archiveError = when (code) {
                    "unsupported", "bad_type" -> say("Archive is not available on this relay.")
                    "board_offline" -> say("This board is offline. The relay will not queue a command.")
                    else -> say("Could not load the archive.")
                }
            } else if (stage == "executed") {
                val page = readArchivePage(message.payload)
                if (page == null) {
                    archiveError = say("Could not read the archive page.")
                } else {
                    archiveTasks = if (archive.reset) page.tasks else mergeArchivePages(archiveTasks, page.tasks)
                    archiveNextCursor = page.nextCursor
                    archiveLoaded = true
                    archiveStale = false
                    archiveError = null
                }
            }
            render()
            return
        }
        val current = inflight
        if (current != null && ref != null && (ref == current.requestId || ref == current.lookupId)) {
            onCommand(message, current)
            return
        }
        when (val outcome = reducer.apply(view, message)) {
            is tech.mengfei.agentboard.protocol.ApplyOutcome.Resync -> {
                view = outcome.view
                eligibilityFresh = false
                banner = if (englishUi) {
                    "Missed events (${outcome.reason}). Refreshing from a snapshot."
                } else {
                    "漏收了事件（${outcome.reason}）。正在用快照刷新。"
                }
                armResync()
                render()
            }
            is tech.mengfei.agentboard.protocol.ApplyOutcome.Applied -> {
                val freshSnapshot = message.type == "evt.snapshot" && !outcome.view.needsResync
                val staleSnapshot = message.type == "evt.snapshot" && outcome.view.needsResync
                if (message.type == "evt.snapshot") {
                    eligibilityFresh = connection == "online" && freshSnapshot
                    val previous = view.tasks.map { it.id }.toSet()
                    val next = outcome.view.tasks.map { it.id }.toSet()
                    if (previous.any { it !in next }) {
                        archiveStale = true
                        if (lane == "archive" && archiveSupportedNow()) loadArchive(reset = true)
                    }
                }
                if (freshSnapshot) {
                    resync.onSnapshot()
                    resyncJob?.cancel()
                    if (banner?.startsWith("Missed events") == true || banner?.startsWith("漏收了事件") == true ||
                        banner?.startsWith("Task list is stale") == true || banner?.startsWith("出现缺口后") == true
                    ) {
                        banner = null
                    }
                }
                if (staleSnapshot) {
                    banner = say("Task list is stale after a gap. Refreshing again.")
                    armResync()
                }
                view = outcome.view
                outcome.notice?.let(notifier::post)
                render()
            }
            is tech.mengfei.agentboard.protocol.ApplyOutcome.Ignored -> Unit
        }
    }

    private fun onHello(message: Envelope) {
        pendingHello = null
        if (message.type == "err" || message.text("stage") != "executed") {
            if (sessionRejected(message)) {
                forget("The relay rejected this phone. Pair again.")
            } else {
                banner = message.text("message")?.let { say(it) } ?: say("The relay did not accept this phone.")
                render()
            }
            return
        }
        backoffMs = 1_000
        connection = "online"
        if (banner?.startsWith("Device token refreshed") == true || banner?.startsWith("设备令牌已刷新") == true) banner = null
        recoverInflight()
        val listId = ids()
        pendingList = listId
        send(boardListEnvelope(listId, clock()))
        _state.value.selectedBoardId?.let(::resubscribe)
        render()
    }

    private fun recoverInflight() {
        val current = inflight ?: return
        val outstanding = OutstandingCommand(current.cmd, current.boardId, current.key, current.polls)
        when (val step = recoverAfterHello(outstanding)) {
            null -> Unit
            is Recovery.Lookup -> {
                commandNote = say("Reconnected. Checking the stored result. The command will not be sent again.")
                if (!dispatchLookup(current, step.command)) releaseInflight(lookupSendFailed())
            }
            is Recovery.Poll -> {
                if (!dispatchLookup(current, step.command)) releaseInflight(lookupSendFailed())
            }
            is Recovery.Clear -> releaseInflight(step)
        }
    }

    private fun onCommand(message: Envelope, current: Inflight) {
        if (sessionRejected(message)) {
            forget("The relay rejected this phone. Pair again.")
            return
        }
        val ref = message.text("ref")
        if (ref != null && ref == current.lookupId) {
            onLookupReply(message, current)
            return
        }
        val interpreted = interpretCommand(message) ?: return
        when (nextCommandAction(current.lookupId != null, interpreted)) {
            CommandAction.Wait -> {
                commandNote = say(interpreted.summary)
                render()
            }
            CommandAction.SendLookup -> {
                commandNote = say("Timed out. Checking the stored result instead of sending the command again.")
                beginLookup(current)
                render()
            }
            CommandAction.Settle -> releaseInflight(Recovery.Clear(interpreted.summary, interpreted))
        }
    }

    private fun onLookupReply(message: Envelope, current: Inflight) {
        val command = OutstandingCommand(current.cmd, current.boardId, current.key, current.polls)
        when (val step = recoverFromLookup(command, message)) {
            is Recovery.Poll -> {
                commandNote = say("The command is still in flight. Checking again without sending it.")
                inflight = current.copy(polls = step.command.polls)
                pollJob?.cancel()
                pollJob = viewModelScope.launch {
                    delay(1_000)
                    val latest = inflight ?: return@launch
                    if (latest.polls != step.command.polls) return@launch
                    if (!dispatchLookup(latest, step.command)) releaseInflight(lookupSendFailed())
                    render()
                }
                render()
            }
            is Recovery.Lookup -> {
                if (!dispatchLookup(current, step.command)) releaseInflight(lookupSendFailed())
                render()
            }
            is Recovery.Clear -> releaseInflight(step)
        }
    }

    private fun beginLookup(current: Inflight) {
        val command = OutstandingCommand(current.cmd, current.boardId, current.key, current.polls)
        if (!dispatchLookup(current, command)) releaseInflight(lookupSendFailed())
    }

    private fun dispatchLookup(current: Inflight, command: OutstandingCommand): Boolean {
        val lookupId = ids()
        val envelope = lookupEnvelope(lookupId, clock(), command.boardId, command.idempotencyKey, command.cmd)
        if (!send(envelope)) return false
        inflight = current.copy(
            lookupId = lookupId,
            key = command.idempotencyKey,
            cmd = command.cmd,
            polls = command.polls,
        )
        return true
    }

    private fun releaseInflight(step: Recovery.Clear) {
        val current = inflight
        inflight = null
        pollJob?.cancel()
        val interpreted = step.interpretation
        if (current != null && interpreted != null) {
            settledByAction[current.action] = Settled(interpreted, current.key)
        }
        commandNote = say(step.summary)
        val task = interpreted?.task
        if (current != null && task != null && current.boardId == view.boardId) view = view.withLocalTask(task)
        val workspace = interpreted?.workspace
        if (current != null && workspace != null && current.boardId == view.boardId) {
            view = view.withWorkspace(workspace)
            selectedByBoard[current.boardId] = workspace.id
            store.saveSelectedWorkspace(current.boardId, workspace.id)
        }
        val deleted = interpreted?.deletedWorkspaceId
        if (current != null && deleted != null && current.boardId == view.boardId) {
            view = view.withoutWorkspace(deleted)
            if (selectedByBoard[current.boardId] == deleted) {
                selectedByBoard.remove(current.boardId)
                store.saveSelectedWorkspace(current.boardId, null)
            }
        }
        if (current != null && task != null && current.cmd == "cmd.create" && interpreted?.retry == Retry.None) {
            _state.updateCopy { copy(selectedTaskId = task.id, selectedBoardId = current.boardId) }
            if (_state.value.screen !is Screen.Detail) push(Screen.Detail(current.boardId, task.id))
        }
        if (current != null && workspace != null && current.cmd == "cmd.workspace.create" && interpreted?.retry == Retry.None) {
            if (_state.value.screen is Screen.WorkspaceCreate) pop()
        }
        render()
    }

    private fun requestDetail(boardId: String, taskId: String) {
        if (connection != "online") return
        val requestId = ids()
        val built = validateDetail(requestId, clock(), boardId, taskId, keys())
        if (built is Validated.Ok && send(built.value)) {
            pendingDetail = DetailRequest(requestId, boardId, taskId, boardEpoch)
        }
    }

    private fun resubscribe(boardId: String) {
        send(subTasksEnvelope(ids(), clock(), boardId))
        send(subLogsEnvelope(ids(), clock(), boardId))
    }

    private fun armResync() {
        if (!resync.onGap()) return
        resyncJob?.cancel()
        resyncJob = viewModelScope.launch {
            delay(400)
            if (resync.consumeIfStillNeeded() && connection == "online") {
                _state.value.selectedBoardId?.let(::resubscribe)
            }
            render()
        }
    }

    private fun onSocketClosed() {
        pollJob?.cancel()
        eligibilityFresh = false
        if (!wantConnection || refreshInFlight) return
        connection = "reconnecting"
        render()
        val wait = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(15_000)
        reconnectJob?.cancel()
        reconnectJob = viewModelScope.launch {
            delay(wait)
            if (wantConnection && !refreshInFlight) connect()
        }
    }

    private fun send(message: Envelope): Boolean {
        if (token.isNullOrBlank()) return false
        return relay.send(encodeEnvelope(message))
    }

    private fun push(screen: Screen) {
        val current = _state.value.screen
        if (current != screen) backStack.addLast(current)
        _state.updateCopy { copy(screen = screen, canPop = backStack.isNotEmpty()) }
    }

    private fun render() {
        val snapshot = _state.value
        val boardId = snapshot.selectedBoardId
        val taskId = snapshot.selectedTaskId
        val sameBoard = !boardId.isNullOrEmpty() && view.boardId == boardId
        val spaces = if (sameBoard) view.workspaces else emptyList()
        val taskRows = tasksAfterBoardSwitch(view.boardId, boardId, view.tasks)
        val sawSnapshot = sameBoard && view.sawSnapshot
        val selectedWorkspaceId = resolvedWorkspaceId(boardId, spaces, taskRows, sawSnapshot)
        val nextKey = workspaceListKey(spaces)
        val listChanged = nextKey != workspaceKey
        workspaceKey = nextKey
        val worktreeOn = !listChanged && snapshot.draftUseGitWorktree &&
            freshWorktree(snapshot.draftCwd, spaces, view.needsResync)
        _state.value = snapshot.copy(
            connection = connection,
            boards = boards,
            tasks = taskRows,
            logs = if (!sameBoard || taskId == null) emptyList() else view.logs[taskId].orEmpty(),
            sawSnapshot = sawSnapshot,
            lane = lane,
            archiveTasks = if (sameBoard) archiveTasks else emptyList(),
            archiveNextCursor = if (sameBoard) archiveNextCursor else null,
            archiveLoaded = sameBoard && archiveLoaded,
            archiveStale = sameBoard && archiveStale,
            archiveBusy = sameBoard && archiveBusy,
            archiveError = if (sameBoard) archiveError else null,
            archiveSupported = archiveSupportedNow(),
            detailArchived = detailArchived,
            archiveDetail = archiveDetail,
            selectedOnline = boards.find { it.boardId == boardId }?.online,
            needsResync = view.needsResync,
            banner = banner,
            commandNote = commandNote,
            formError = formError,
            busy = busy,
            createMode = modeFor("cmd.create", boardId, null),
            stopMode = modeFor("cmd.stop", boardId, taskId),
            continueMode = modeFor("cmd.continue", boardId, taskId),
            stopResend = explicitResendAllowed("cmd.stop", settled(boardId, "cmd.stop", taskId)),
            continueResend = explicitResendAllowed("cmd.continue", settled(boardId, "cmd.continue", taskId)),
            workspaces = spaces,
            selectedWorkspaceId = selectedWorkspaceId,
            workspaceCreateMode = modeFor("cmd.workspace.create", boardId, null),
            workspaceDeleteMode = modeFor("cmd.workspace.delete", boardId, selectedWorkspaceId),
            worktreeEnabled = freshWorktree(snapshot.draftCwd, spaces, view.needsResync),
            draftUseGitWorktree = worktreeOn,
        )
    }

    private fun modeFor(cmd: String, boardId: String?, taskId: String?): String {
        if (inflight != null) return "busy"
        if (boardId.isNullOrBlank()) return "send"
        return when (settled(boardId, cmd, taskId)?.retry) {
            Retry.LookupOnly -> "lookup"
            Retry.ReuseSameKey -> "reuse"
            else -> "send"
        }
    }

    private fun settled(boardId: String?, cmd: String, taskId: String?): CommandInterpretation? {
        if (boardId.isNullOrBlank()) return null
        return settledByAction[actionKey(cmd, boardId, taskId)]?.interpretation
    }

    private fun resolvedWorkspaceId(
        boardId: String?,
        spaces: List<ThinWorkspace>,
        tasks: List<RelayTask>,
        sawSnapshot: Boolean,
    ): String? {
        if (boardId.isNullOrBlank() || view.boardId != boardId) return _state.value.selectedWorkspaceId
        val remembered = selectedByBoard[boardId] ?: store.selectedWorkspace(boardId)?.also { selectedByBoard[boardId] = it }
        val update = nextWorkspaceSelection(remembered, spaces, tasks, sawSnapshot)
        val selectedId = update.selectedId
        if (update.persist) {
            if (selectedId == null) {
                selectedByBoard.remove(boardId)
                store.saveSelectedWorkspace(boardId, null)
            } else {
                selectedByBoard[boardId] = selectedId
                store.saveSelectedWorkspace(boardId, selectedId)
            }
        }
        return selectedId
    }

    private fun freshWorktree(cwd: String, spaces: List<ThinWorkspace>, needsResync: Boolean): Boolean {
        return worktreeAllowedFresh(cwd, spaces, connection == "online", needsResync, eligibilityFresh)
    }

    private fun actionKey(cmd: String, boardId: String, taskId: String?): String {
        return "$cmd\u0000$boardId\u0000${taskId.orEmpty()}"
    }

    override fun onCleared() {
        wantConnection = false
        reconnectJob?.cancel()
        resyncJob?.cancel()
        pollJob?.cancel()
        relay.closeSocket()
    }

    private fun say(text: String): String = localize(englishUi, text)

    private fun archiveSupportedNow(): Boolean {
        val boardId = _state.value.selectedBoardId ?: return false
        val board = boards.find { it.boardId == boardId } ?: return false
        return board.online && board.capabilities.contains(ARCHIVE_CAPABILITY)
    }

    private fun clearArchive() {
        pendingArchive = null
        archiveTasks = emptyList()
        archiveNextCursor = null
        archiveLoaded = false
        archiveStale = false
        archiveBusy = false
        archiveError = null
    }

    private fun loadArchive(reset: Boolean) {
        val boardId = _state.value.selectedBoardId ?: return
        if (!archiveSupportedNow() || view.boardId != boardId) {
            archiveError = say("This board cannot list archived tasks yet.")
            archiveBusy = false
            render()
            return
        }
        if (archiveBusy) return
        val cursor = if (reset) null else archiveNextCursor
        if (!reset && cursor == null) return
        val requestId = ids()
        val built = validateArchiveList(requestId, clock(), boardId, keys(), cursor, 20)
        if (built is Validated.Invalid) {
            archiveError = say(built.message)
            render()
            return
        }
        if (built is Validated.Ok && send(built.value)) {
            pendingArchive = ArchiveRequest(requestId, boardId, boardEpoch, reset)
            archiveBusy = true
            archiveError = null
        } else {
            archiveError = say("Not connected to the relay.")
        }
        render()
    }

    private fun MutableStateFlow<UiState>.updateCopy(block: UiState.() -> UiState) {
        value = value.block()
    }

    private data class Inflight(
        val action: String,
        val cmd: String,
        val boardId: String,
        val taskId: String?,
        val key: String,
        val requestId: String,
        val lookupId: String? = null,
        val polls: Int = 0,
    )

    private data class Settled(val interpretation: CommandInterpretation, val key: String)
}

class BoardViewModelFactory(private val app: AgentBoardApp) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        val english = tech.mengfei.agentboard.ui.prefersEnglish(java.util.Locale.getDefault().language)
        return BoardViewModel(app.store, app.relay, app.notifier, englishUi = english) as T
    }
}
