package tech.mengfei.agentboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import tech.mengfei.agentboard.data.SocketListener
import tech.mengfei.agentboard.protocol.ApplyOutcome
import tech.mengfei.agentboard.protocol.BoardReducer
import tech.mengfei.agentboard.protocol.BoardView
import tech.mengfei.agentboard.protocol.PairGate
import tech.mengfei.agentboard.protocol.Validated
import tech.mengfei.agentboard.protocol.WorktreeSession
import tech.mengfei.agentboard.protocol.boardListEnvelope
import tech.mengfei.agentboard.protocol.deriveWsUrl
import tech.mengfei.agentboard.protocol.encodeEnvelope
import tech.mengfei.agentboard.protocol.encodePairBody
import tech.mengfei.agentboard.protocol.helloEnvelope
import tech.mengfei.agentboard.protocol.newIdempotencyKey
import tech.mengfei.agentboard.protocol.newMessageId
import tech.mengfei.agentboard.protocol.normalizeHttpBase
import tech.mengfei.agentboard.protocol.parseBoardList
import tech.mengfei.agentboard.protocol.parseEnvelope
import tech.mengfei.agentboard.protocol.parseHealth
import tech.mengfei.agentboard.protocol.persistThenConnect
import tech.mengfei.agentboard.protocol.parsePairResponse
import tech.mengfei.agentboard.protocol.parseRelayError
import tech.mengfei.agentboard.protocol.sessionRejected
import tech.mengfei.agentboard.protocol.subLogsEnvelope
import tech.mengfei.agentboard.protocol.subTasksEnvelope
import tech.mengfei.agentboard.protocol.validateContinue
import tech.mengfei.agentboard.protocol.validateCreate
import tech.mengfei.agentboard.protocol.validateStop
import tech.mengfei.agentboard.protocol.worktreeAllowedFresh

class BoardViewModel(private val app: AgentBoardApp) : ViewModel() {
    private val reducer = BoardReducer()
    private var board = BoardView("")
    private var worktree = WorktreeSession("")
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val socketListener = object : SocketListener {
        override fun onOpen() {
            _state.update { it.copy(connection = "online", banner = null) }
            worktree = worktree.hello()
            publishWorktree()
            val saved = app.session.read()
            val token = saved.deviceToken ?: return
            send(
                helloEnvelope(
                    id = newMessageId(),
                    ts = System.currentTimeMillis(),
                    token = token,
                    name = saved.deviceName,
                ),
            )
            send(boardListEnvelope(newMessageId(), System.currentTimeMillis()))
        }

        override fun onMessage(text: String) {
            val message = try {
                parseEnvelope(text)
            } catch (e: Exception) {
                _state.update { it.copy(banner = e.message ?: "Bad relay frame") }
                return
            }
            if (sessionRejected(message)) {
                forget("The relay rejected this phone. Pair again.")
                return
            }
            parseBoardList(message.payload)?.let { boards ->
                _state.update { it.copy(boards = boards, banner = null) }
            }
            val selected = _state.value.selectedBoardId
            if (selected != null && board.boardId == selected) {
                when (val outcome = reducer.apply(board, message)) {
                    is ApplyOutcome.Ignored -> Unit
                    is ApplyOutcome.Applied -> {
                        board = outcome.view
                        worktree = worktree.snapshot(board.workspaces, board.needsResync)
                        publishBoard()
                        outcome.notice?.let { notice ->
                            app.notifier.post(notice)
                            _state.update { it.copy(banner = notice.summary ?: "Task ${notice.status}") }
                        }
                    }
                    is ApplyOutcome.Resync -> {
                        board = outcome.view
                        worktree = worktree.gap().snapshot(board.workspaces, true)
                        publishBoard()
                        _state.update { it.copy(banner = "Task list is stale after a gap. Refreshing again.") }
                        send(subTasksEnvelope(newMessageId(), System.currentTimeMillis(), selected))
                    }
                }
            }
        }

        override fun onClosed(reason: String) {
            worktree = worktree.disconnect()
            publishWorktree()
            _state.update { it.copy(connection = "offline", banner = reason.ifBlank { "Not connected to the relay." }) }
        }
    }

    init {
        val saved = app.session.read()
        val paired = !saved.deviceToken.isNullOrBlank()
        _state.value = UiState(
            screen = if (paired) Screen.Boards else Screen.Pair,
            httpBase = saved.httpBase,
            wsUrl = saved.wsUrl,
            deviceName = saved.deviceName,
            paired = paired,
            secureStore = saved.secure,
            canPop = false,
        )
        if (paired) connect()
    }

    fun onHttpBase(value: String) = _state.update { it.copy(httpBase = value) }
    fun onDeviceName(value: String) = _state.update { it.copy(deviceName = value) }
    fun onPairCode(value: String) = _state.update { it.copy(pairCode = value) }
    fun onDraftTitle(value: String) = _state.update { it.copy(draftTitle = value, formError = null) }
    fun onDraftPrompt(value: String) = _state.update { it.copy(draftPrompt = value, formError = null) }
    fun onDraftAgent(value: String) = _state.update { it.copy(draftAgent = value) }
    fun onDraftCwd(value: String) {
        worktree = worktree.copy(cwd = value, checked = false)
        _state.update { it.copy(draftCwd = value, draftUseGitWorktree = false, formError = null) }
        publishWorktree()
    }

    fun onUseGitWorktree(checked: Boolean) {
        if (!_state.value.worktreeEnabled) return
        worktree = worktree.copy(checked = checked)
        _state.update { it.copy(draftUseGitWorktree = checked && worktree.allowed) }
    }

    fun openSettings() = _state.update { it.copy(screen = Screen.Settings, canPop = true, formError = null) }

    fun openCreate() {
        worktree = worktree.copy(cwd = _state.value.draftCwd, checked = false)
        publishWorktree()
        _state.update {
            it.copy(screen = Screen.Create, canPop = true, formError = null, draftUseGitWorktree = false)
        }
    }

    fun back() {
        val current = _state.value
        val previous = when (current.screen) {
            Screen.Settings, Screen.Create -> if (current.selectedBoardId == null) Screen.Boards else Screen.Tasks
            Screen.Detail -> Screen.Tasks
            Screen.Tasks -> Screen.Boards
            else -> current.screen
        }
        _state.update {
            it.copy(
                screen = previous,
                canPop = previous != Screen.Pair && previous != Screen.Boards,
                formError = null,
            )
        }
    }

    fun selectBoard(boardId: String) {
        val online = _state.value.boards.find { it.boardId == boardId }?.online
        board = BoardView(boardId)
        worktree = worktree.switchBoard()
        _state.update {
            it.copy(
                screen = Screen.Tasks,
                selectedBoardId = boardId,
                selectedTaskId = null,
                tasks = emptyList(),
                logs = emptyList(),
                canPop = true,
                banner = if (online == false) "This board is offline. The relay will not queue a command." else it.banner,
            )
        }
        publishWorktree()
        if (_state.value.connection == "online") {
            send(subTasksEnvelope(newMessageId(), System.currentTimeMillis(), boardId))
        }
    }

    fun selectTask(taskId: String) {
        val boardId = _state.value.selectedBoardId ?: return
        _state.update {
            it.copy(
                screen = Screen.Detail,
                selectedTaskId = taskId,
                logs = board.logs[taskId].orEmpty(),
                canPop = true,
            )
        }
        if (_state.value.connection == "online") {
            send(subLogsEnvelope(newMessageId(), System.currentTimeMillis(), boardId, taskId))
        }
    }

    fun saveRelay() {
        val current = _state.value
        val base = try {
            normalizeHttpBase(current.httpBase)
        } catch (e: Exception) {
            _state.update { it.copy(formError = e.message ?: "Enter an http or https relay URL") }
            return
        }
        val ws = deriveWsUrl(base)
        app.session.saveRelay(base, ws, current.deviceName)
        _state.update { it.copy(httpBase = base, wsUrl = ws, formError = null, banner = "Relay URL saved.") }
    }

    fun pair() {
        val current = _state.value
        if (current.pairCode.isBlank()) {
            _state.update { it.copy(formError = "Enter the pair code from the relay.") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(busy = true, formError = null) }
            val base = try {
                normalizeHttpBase(current.httpBase)
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, formError = e.message) }
                return@launch
            }
            val ws = deriveWsUrl(base)
            app.session.saveRelay(base, ws, current.deviceName.ifBlank { "Android phone" })
            val result = try {
                app.relay.request(
                    "POST",
                    "$base/auth/pair",
                    encodePairBody(current.pairCode.trim(), current.deviceName.ifBlank { "Android phone" }),
                )
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, formError = "Could not reach the relay.") }
                return@launch
            }
            if (result.code !in 200..299) {
                _state.update { it.copy(busy = false, formError = parseRelayError(result.body)) }
                return@launch
            }
            val paired = try {
                parsePairResponse(result.body)
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, formError = e.message ?: "The relay did not accept this phone.") }
                return@launch
            }
            when (val gate = persistThenConnect(app.session.saveToken(paired))) {
                PairGate.OpenSocket -> {
                    _state.update {
                        it.copy(
                            busy = false,
                            paired = true,
                            secureStore = app.session.secure,
                            httpBase = base,
                            wsUrl = ws,
                            screen = Screen.Boards,
                            pairCode = "",
                            banner = null,
                        )
                    }
                    connect()
                }
                is PairGate.Hold -> _state.update { it.copy(busy = false, formError = gate.message) }
            }
        }
    }

    fun checkRelay() {
        viewModelScope.launch {
            val base = _state.value.httpBase.trimEnd('/')
            val result = try {
                app.relay.request("GET", "$base/health", null)
            } catch (e: Exception) {
                _state.update { it.copy(banner = "Could not reach the relay.") }
                return@launch
            }
            val health = parseHealth(result.body)
            _state.update {
                it.copy(
                    banner = if (health == null) {
                        "The relay answered, but /health was not recognized."
                    } else {
                        "Relay is up. Boards online: ${health.boardsOnline}"
                    },
                )
            }
        }
    }

    fun forget(message: String = "This phone is signed out. Pair again to connect.") {
        app.relay.closeSocket()
        app.session.clearToken()
        board = BoardView("")
        worktree = WorktreeSession("")
        _state.update {
            it.copy(
                screen = Screen.Pair,
                paired = false,
                connection = "offline",
                boards = emptyList(),
                tasks = emptyList(),
                logs = emptyList(),
                selectedBoardId = null,
                selectedTaskId = null,
                canPop = false,
                banner = message,
                worktreeEnabled = false,
                draftUseGitWorktree = false,
            )
        }
    }

    fun submitCreate() {
        val current = _state.value
        val boardId = current.selectedBoardId ?: return
        if (current.boards.find { it.boardId == boardId }?.online == false) {
            _state.update { it.copy(formError = "This board is offline. The relay will not queue a command.") }
            return
        }
        val useWorktree = current.draftUseGitWorktree && current.worktreeEnabled
        when (
            val validated = validateCreate(
                id = newMessageId(),
                ts = System.currentTimeMillis(),
                boardId = boardId,
                title = current.draftTitle,
                prompt = current.draftPrompt,
                agent = current.draftAgent,
                cwd = current.draftCwd,
                idempotencyKey = newIdempotencyKey(),
                useGitWorktree = useWorktree,
            )
        ) {
            is Validated.Invalid -> _state.update { it.copy(formError = validated.reason) }
            is Validated.Ok -> {
                if (!send(validated.value)) {
                    _state.update { it.copy(formError = "Not connected to the relay.") }
                    return
                }
                _state.update {
                    it.copy(
                        screen = Screen.Tasks,
                        formError = null,
                        commandNote = if (useWorktree) "Create sent with a git worktree." else "Create sent.",
                        draftTitle = "",
                        draftPrompt = "",
                        draftUseGitWorktree = false,
                    )
                }
            }
        }
    }

    fun stop() = sendTaskCommand("stop")
    fun continueTask() = sendTaskCommand("continue")

    private fun sendTaskCommand(kind: String) {
        val current = _state.value
        val boardId = current.selectedBoardId ?: return
        val taskId = current.selectedTaskId ?: return
        if (current.boards.find { it.boardId == boardId }?.online == false) {
            _state.update { it.copy(banner = "This board is offline. The relay will not queue a command.") }
            return
        }
        val validated = if (kind == "stop") {
            validateStop(newMessageId(), System.currentTimeMillis(), boardId, taskId, newIdempotencyKey())
        } else {
            validateContinue(newMessageId(), System.currentTimeMillis(), boardId, taskId, newIdempotencyKey())
        }
        when (validated) {
            is Validated.Invalid -> _state.update { it.copy(banner = validated.reason) }
            is Validated.Ok -> {
                if (!send(validated.value)) {
                    _state.update { it.copy(banner = "Not connected to the relay.") }
                } else {
                    _state.update {
                        it.copy(commandNote = if (kind == "stop") "Stop sent." else "Continue sent.")
                    }
                }
            }
        }
    }

    private fun connect() {
        val saved = app.session.read()
        _state.update { it.copy(connection = "connecting", wsUrl = saved.wsUrl) }
        try {
            app.relay.openSocket(saved.wsUrl, socketListener)
        } catch (e: Exception) {
            _state.update { it.copy(connection = "offline", banner = e.message ?: "Could not reach the relay.") }
        }
    }

    private fun send(message: tech.mengfei.agentboard.protocol.Envelope): Boolean =
        app.relay.send(encodeEnvelope(message))

    private fun publishBoard() {
        val taskId = _state.value.selectedTaskId
        _state.update {
            it.copy(
                tasks = board.tasks,
                logs = if (taskId == null) emptyList() else board.logs[taskId].orEmpty(),
                workspaces = board.workspaces,
                needsResync = board.needsResync,
                banner = if (board.needsResync) "Task list is stale" else it.banner,
            )
        }
        publishWorktree()
    }

    private fun publishWorktree() {
        val enabled = worktreeAllowedFresh(
            cwd = worktree.cwd,
            workspaces = worktree.workspaces,
            online = _state.value.connection == "online" && worktree.online,
            needsResync = worktree.needsResync || board.needsResync,
            eligibilityFresh = worktree.eligibilityFresh && !board.needsResync,
        )
        _state.update {
            it.copy(
                worktreeEnabled = enabled,
                workspaces = worktree.workspaces,
                draftUseGitWorktree = it.draftUseGitWorktree && enabled,
            )
        }
    }

    override fun onCleared() {
        app.relay.closeSocket()
    }
}

class BoardViewModelFactory(private val app: AgentBoardApp) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(BoardViewModel::class.java)) {
            @Suppress("UNCHECKED_CAST")
            return BoardViewModel(app) as T
        }
        throw IllegalArgumentException("Unknown ViewModel $modelClass")
    }
}
