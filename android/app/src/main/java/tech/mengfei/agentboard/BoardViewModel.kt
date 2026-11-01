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
import tech.mengfei.agentboard.protocol.ARCHIVE_SCOPE_UNSUPPORTED
import tech.mengfei.agentboard.protocol.ApplyOutcome
import tech.mengfei.agentboard.protocol.ApplyVerdict
import tech.mengfei.agentboard.protocol.ArchiveQuery
import tech.mengfei.agentboard.protocol.EpochSlot
import tech.mengfei.agentboard.protocol.PROMPTS_SAVED_COPY
import tech.mengfei.agentboard.protocol.SAVED_COPY
import tech.mengfei.agentboard.protocol.archiveQuery
import tech.mengfei.agentboard.protocol.failedStepKeepsCatalog
import tech.mengfei.agentboard.protocol.invalidateSnapshotForNewEpoch
import tech.mengfei.agentboard.protocol.pairBodyOutcome
import tech.mengfei.agentboard.protocol.planActivate
import tech.mengfei.agentboard.protocol.committedSessionCount
import tech.mengfei.agentboard.protocol.proofRedrawDelay
import tech.mengfei.agentboard.protocol.settingsDocumentOk
import tech.mengfei.agentboard.protocol.readableSessions
import tech.mengfei.agentboard.protocol.BoardProof
import tech.mengfei.agentboard.protocol.BoardReducer
import tech.mengfei.agentboard.protocol.BoardView
import tech.mengfei.agentboard.protocol.CAP_ARCHIVE_WRITE
import tech.mengfei.agentboard.protocol.CAP_BOARD_SETTINGS
import tech.mengfei.agentboard.protocol.CAP_WORKSPACE_SETTINGS
import tech.mengfei.agentboard.protocol.CODE_CONSUMED_SAVE
import tech.mengfei.agentboard.protocol.CommandAction
import tech.mengfei.agentboard.protocol.CommandInterpretation
import tech.mengfei.agentboard.protocol.DiskOp
import tech.mengfei.agentboard.protocol.EventIdDeduper
import tech.mengfei.agentboard.protocol.FrameKind
import tech.mengfei.agentboard.protocol.LaunchPhase
import tech.mengfei.agentboard.protocol.LinkInput
import tech.mengfei.agentboard.protocol.LinkPill
import tech.mengfei.agentboard.protocol.LogBinding
import tech.mengfei.agentboard.protocol.LogLine
import tech.mengfei.agentboard.protocol.MIGRATION_READING
import tech.mengfei.agentboard.protocol.NO_WORKSPACE_COPY
import tech.mengfei.agentboard.protocol.OutstandingCommand
import tech.mengfei.agentboard.protocol.PairOutcome
import tech.mengfei.agentboard.protocol.PairPrecheck
import tech.mengfei.agentboard.protocol.PairRequest
import tech.mengfei.agentboard.protocol.PhoneDisk
import tech.mengfei.agentboard.protocol.PhoneSession
import tech.mengfei.agentboard.protocol.PillKind
import tech.mengfei.agentboard.protocol.QuickPromptChip
import tech.mengfei.agentboard.protocol.Recovery
import tech.mengfei.agentboard.protocol.RefRecord
import tech.mengfei.agentboard.protocol.RelayFormatException
import tech.mengfei.agentboard.protocol.RelayTask
import tech.mengfei.agentboard.protocol.ResyncScheduler
import tech.mengfei.agentboard.protocol.Retry
import tech.mengfei.agentboard.protocol.RouteInput
import tech.mengfei.agentboard.protocol.RouteResult
import tech.mengfei.agentboard.protocol.SECURE_STORAGE_BANNER
import tech.mengfei.agentboard.protocol.SocketPhase
import tech.mengfei.agentboard.protocol.SubmitPlan
import tech.mengfei.agentboard.protocol.TaskChip
import tech.mengfei.agentboard.protocol.ThinWorkspace
import tech.mengfei.agentboard.protocol.Transaction
import tech.mengfei.agentboard.protocol.UNASSIGNED_WORKSPACE_ID
import tech.mengfei.agentboard.protocol.UNSUPPORTED_COPY
import tech.mengfei.agentboard.protocol.Validated
import tech.mengfei.agentboard.protocol.WorkspaceSettingsForm
import tech.mengfei.agentboard.protocol.acceptBoardList
import tech.mengfei.agentboard.protocol.activeDetailTask
import tech.mengfei.agentboard.protocol.applyArchivePage
import tech.mengfei.agentboard.protocol.archiveReplySettled
import tech.mengfei.agentboard.protocol.archiveWriteEnvelope
import tech.mengfei.agentboard.protocol.archivedDetailTask
import tech.mengfei.agentboard.protocol.boardListEnvelope
import tech.mengfei.agentboard.protocol.canContinueStatus
import tech.mengfei.agentboard.protocol.cardSubtitle
import tech.mengfei.agentboard.protocol.completionForSession
import tech.mengfei.agentboard.protocol.createHiddenBanner
import tech.mengfei.agentboard.protocol.cwdForNewTask
import tech.mengfei.agentboard.protocol.deriveWsUrl
import tech.mengfei.agentboard.protocol.detailReplySettled
import tech.mengfei.agentboard.protocol.encodeEnvelope
import tech.mengfei.agentboard.protocol.encodePairBody
import tech.mengfei.agentboard.protocol.encodeRefreshBody
import tech.mengfei.agentboard.protocol.explicitResendAllowed
import tech.mengfei.agentboard.protocol.forgetEnabled
import tech.mengfei.agentboard.protocol.helloEnvelope
import tech.mengfei.agentboard.protocol.inspectPairCode
import tech.mengfei.agentboard.protocol.interpretCommand
import tech.mengfei.agentboard.protocol.linkPill
import tech.mengfei.agentboard.protocol.lookupEnvelope
import tech.mengfei.agentboard.protocol.lookupSendFailed
import tech.mengfei.agentboard.protocol.needsMigrationStart
import tech.mengfei.agentboard.protocol.newIdempotencyKey
import tech.mengfei.agentboard.protocol.newMessageId
import tech.mengfei.agentboard.protocol.nextCommandAction
import tech.mengfei.agentboard.protocol.nextWorkspaceSelection
import tech.mengfei.agentboard.protocol.normalizeHttpBase
import tech.mengfei.agentboard.protocol.notificationTarget
import tech.mengfei.agentboard.protocol.pairHttpFailure
import tech.mengfei.agentboard.protocol.pairIssueMessage
import tech.mengfei.agentboard.protocol.pairPrecheck
import tech.mengfei.agentboard.protocol.pairSubmitAllowed
import tech.mengfei.agentboard.protocol.parseBoardList
import tech.mengfei.agentboard.protocol.parseEnvelope
import tech.mengfei.agentboard.protocol.parseHealth
import tech.mengfei.agentboard.protocol.parsePairResponse
import tech.mengfei.agentboard.protocol.parseRelayError
import tech.mengfei.agentboard.protocol.pillCopy
import tech.mengfei.agentboard.protocol.planForget
import tech.mengfei.agentboard.protocol.planMigrationList
import tech.mengfei.agentboard.protocol.planMigrationStart
import tech.mengfei.agentboard.protocol.planPair
import tech.mengfei.agentboard.protocol.planPhoneContinue
import tech.mengfei.agentboard.protocol.planRefresh
import tech.mengfei.agentboard.protocol.planSubmit
import tech.mengfei.agentboard.protocol.pollArmed
import tech.mengfei.agentboard.protocol.proofAfterDisconnect
import tech.mengfei.agentboard.protocol.proofDeadline
import tech.mengfei.agentboard.protocol.readArchivePage
import tech.mengfei.agentboard.protocol.readQuickPrompts
import tech.mengfei.agentboard.protocol.readWorkspaceSettingsForm
import tech.mengfei.agentboard.protocol.recordRateLimit
import tech.mengfei.agentboard.protocol.recoverAfterHello
import tech.mengfei.agentboard.protocol.recoverFromLookup
import tech.mengfei.agentboard.protocol.recoverLaunch
import tech.mengfei.agentboard.protocol.referencedCredentialIds
import tech.mengfei.agentboard.protocol.resyncAfterList
import tech.mengfei.agentboard.protocol.resumeDecision
import tech.mengfei.agentboard.protocol.routeFrame
import tech.mengfei.agentboard.protocol.sessionRejected
import tech.mengfei.agentboard.protocol.settingsAckEffect
import tech.mengfei.agentboard.protocol.settingsEntry
import tech.mengfei.agentboard.protocol.settingsGetEnvelope
import tech.mengfei.agentboard.protocol.settingsPutPromptsEnvelope
import tech.mengfei.agentboard.protocol.shouldSendLogSubscribe
import tech.mengfei.agentboard.protocol.subLogsEnvelope
import tech.mengfei.agentboard.protocol.subTasksEnvelope
import tech.mengfei.agentboard.protocol.ArchiveLoadScope
import tech.mengfei.agentboard.protocol.BoardPickPath
import tech.mengfei.agentboard.protocol.ForgetDestination
import tech.mengfei.agentboard.protocol.ForgetMemory
import tech.mengfei.agentboard.protocol.ListChrome
import tech.mengfei.agentboard.protocol.LiveLog
import tech.mengfei.agentboard.protocol.FORGET_CLEANUP_INCOMPLETE
import tech.mengfei.agentboard.protocol.ForgetReport
import tech.mengfei.agentboard.protocol.PairContext
import tech.mengfei.agentboard.protocol.PairDeparture
import tech.mengfei.agentboard.protocol.TaskListQuery
import tech.mengfei.agentboard.protocol.acceptArchivePage
import tech.mengfei.agentboard.protocol.archiveReplyMatches
import tech.mengfei.agentboard.protocol.archiveRowsForQuery
import tech.mengfei.agentboard.protocol.confirmedArchiveTasks
import tech.mengfei.agentboard.protocol.deferredPairSuccess
import tech.mengfei.agentboard.protocol.forgetCleanupDisposition
import tech.mengfei.agentboard.protocol.forgetDestination
import tech.mengfei.agentboard.protocol.forgetMemoryEffect
import tech.mengfei.agentboard.protocol.forgetSuccessToast
import tech.mengfei.agentboard.protocol.pairAttemptStillCurrent
import tech.mengfei.agentboard.protocol.pairContextAfterDeparture
import tech.mengfei.agentboard.protocol.pickBoard
import tech.mengfei.agentboard.protocol.renderedHotList
import tech.mengfei.agentboard.protocol.selectWorkspaceChrome
import tech.mengfei.agentboard.protocol.taskListEmpty
import tech.mengfei.agentboard.protocol.taskListEmptyCopy
import tech.mengfei.agentboard.protocol.tasksAfterSessionSwitch
import tech.mengfei.agentboard.protocol.tasksForChip
import tech.mengfei.agentboard.protocol.text
import tech.mengfei.agentboard.protocol.trimOuter
import tech.mengfei.agentboard.protocol.unassignedTasks
import tech.mengfei.agentboard.protocol.validateArchiveList
import tech.mengfei.agentboard.protocol.validateContinue
import tech.mengfei.agentboard.protocol.validateCreate
import tech.mengfei.agentboard.protocol.validateDetail
import tech.mengfei.agentboard.protocol.validateDisplayName
import tech.mengfei.agentboard.protocol.validatePhoneContinue
import tech.mengfei.agentboard.protocol.validateStop
import tech.mengfei.agentboard.protocol.validateWorkspaceCreate
import tech.mengfei.agentboard.protocol.validateWorkspaceDelete
import tech.mengfei.agentboard.protocol.visibleTasks
import tech.mengfei.agentboard.protocol.withLocalTask
import tech.mengfei.agentboard.protocol.withWorkspace
import tech.mengfei.agentboard.protocol.withoutWorkspace
import tech.mengfei.agentboard.protocol.workspaceGetEnvelope
import tech.mengfei.agentboard.protocol.workspaceIdForCreate
import tech.mengfei.agentboard.protocol.workspaceListKey
import tech.mengfei.agentboard.protocol.workspaceUpdateEnvelope
import tech.mengfei.agentboard.protocol.worktreeAllowedFresh
import tech.mengfei.agentboard.ui.localize
import tech.mengfei.agentboard.protocol.BoardListRow
import java.io.IOException
import java.util.UUID

sealed interface Screen {
    data object Pair : Screen
    data object Reading : Screen
    data object Tasks : Screen
    data object MyBoards : Screen
    data object AddBoard : Screen
    data class Detail(val sessionId: String, val taskId: String) : Screen
    data class Create(val sessionId: String) : Screen
    data class WorkspaceCreate(val sessionId: String) : Screen
    data object WorkspaceSettings : Screen
    data object BoardSettings : Screen
}

data class SessionRow(
    val sessionId: String,
    val displayName: String,
    val subtitle: String,
    val relayUrl: String = "",
    val pill: String,
    val expiresAt: Long?,
    val active: Boolean,
)

data class UiState(
    val screen: Screen = Screen.Pair,
    val httpBase: String = "",
    val deviceName: String = "Android phone",
    val displayName: String = "",
    val pairCode: String = "",
    val repairSessionId: String? = null,
    val paired: Boolean = false,
    val secureStore: Boolean = true,
    val expiresAt: Long? = null,
    val sessions: List<SessionRow> = emptyList(),
    val activeSessionId: String? = null,
    val connection: String = "",
    val pillDetail: String? = null,
    val cacheSentence: String? = null,
    val tasks: List<RelayTask> = emptyList(),
    val logs: List<LogLine> = emptyList(),
    val selectedTaskId: String? = null,
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
    val continueOpen: Boolean = false,
    val quickPrompts: List<QuickPromptChip> = emptyList(),
    val settingsLoaded: Boolean = false,
    val canPop: Boolean = false,
    val englishUi: Boolean = false,
    val sawSnapshot: Boolean = false,
    val chip: TaskChip = TaskChip.ALL,
    val searchQuery: String = "",
    val filterEmpty: String? = null,
    val archiveTasks: List<RelayTask> = emptyList(),
    val archiveVisible: List<RelayTask> = emptyList(),
    val archiveInScope: Boolean = false,
    val archiveNextCursor: String? = null,
    val archiveLoaded: Boolean = false,
    val archiveStale: Boolean = false,
    val archiveBusy: Boolean = false,
    val archiveError: String? = null,
    val archiveSupported: Boolean = false,
    val archiveWrite: Boolean = false,
    val detailArchived: Boolean = false,
    val archiveDetail: RelayTask? = null,
    val forgetEnabled: Boolean = false,
    val confirmForgetId: String? = null,
    val writesAllowed: Boolean = false,
    val settingsBlocked: String? = null,
    val workspaceForm: WorkspaceSettingsForm? = null,
    val createdHidden: String? = null,
    val reading: Boolean = false,
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
    private val _state = MutableStateFlow(UiState(englishUi = englishUi))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var disk: PhoneDisk = store.readDisk()
    private var activeId: String? = null
    private var chip: TaskChip = TaskChip.ALL
    private var searchQuery: String = ""
    private var pairEpoch: Int = 0
    private var banner: String? = null
    private var commandNote: String? = null
    private var formError: String? = null
    private var busy = false
    private var foreground = true
    private var rateLimited = 0
    private val backStack = ArrayDeque<Screen>()
    private val slots = mutableMapOf<String, Slot>()
    private val lives = mutableMapOf<String, LiveSocket>()
    private val refs = mutableMapOf<String, RefRecord>()
    private val doneDedupe = EventIdDeduper()
    private var pollJob: Job? = null
    private val proofJobs = mutableMapOf<String, Job>()
    private var screen: Screen = Screen.Pair

    init {
        boot()
    }

    fun updatePairCode(value: String) = _state.updateCopy { copy(pairCode = value) }
    fun updateDeviceName(value: String) = _state.updateCopy { copy(deviceName = value) }
    fun updateHttpBase(value: String) = _state.updateCopy { copy(httpBase = value) }
    fun updateDisplayName(value: String) = _state.updateCopy { copy(displayName = value) }
    fun updateDraftTitle(value: String) = _state.updateCopy { copy(draftTitle = value) }
    fun updateDraftPrompt(value: String) = _state.updateCopy { copy(draftPrompt = value) }
    fun updateDraftAgent(value: String) = _state.updateCopy { copy(draftAgent = value) }
    fun updateDraftCwd(value: String) = _state.updateCopy { copy(draftCwd = value, draftUseGitWorktree = false) }
    fun updateDraftWorkspaceName(value: String) = _state.updateCopy { copy(draftWorkspaceName = value) }
    fun updateDraftWorkspacePath(value: String) = _state.updateCopy { copy(draftWorkspacePath = value) }
    fun updateSearch(value: String) {
        searchQuery = value
        render()
    }

    fun updateContinuePrompt(value: String) {
        slot(activeId)?.continuePrompt = value
        _state.updateCopy { copy(continuePrompt = value) }
    }

    fun updateWorkspaceField(name: String? = null, path: String? = null, prompt: String? = null, skills: String? = null, mcp: String? = null) {
        val current = slot(activeId) ?: return
        val form = current.workspaceForm ?: return
        current.workspaceForm = form.copy(
            name = name ?: form.name,
            path = path ?: form.path,
            systemPrompt = prompt ?: form.systemPrompt,
            skills = skills ?: form.skills,
            mcp = mcp ?: form.mcp,
        )
        current.workspaceDirty = true
        render()
    }

    fun selectChip(next: TaskChip) {
        chip = next
        if (next == TaskChip.ARCHIVE) showArchive() else render()
    }

    fun openMyBoards() = push(Screen.MyBoards)
    fun openAddBoard() {
        _state.updateCopy { copy(displayName = "", pairCode = "", repairSessionId = null, formError = null) }
        push(Screen.AddBoard)
    }

    fun openRepair(sessionId: String) {
        val session = session(sessionId) ?: return
        val secret = disk.credentials[session.credentialId] ?: return
        _state.updateCopy {
            copy(
                repairSessionId = sessionId,
                displayName = session.displayName,
                httpBase = secret.httpBase,
                pairCode = "",
                formError = null,
            )
        }
        push(Screen.AddBoard)
    }

    fun requestForget(sessionId: String) {
        if (!forgetEnabled(sessionCount())) return
        _state.updateCopy { copy(confirmForgetId = sessionId) }
    }

    fun cancelForget() = _state.updateCopy { copy(confirmForgetId = null) }

    fun confirmForget() {
        invalidatePendingPair(PairDeparture.Forget)
        val sessionId = _state.value.confirmForgetId ?: return
        val forgotten = session(sessionId)
        val forgotActive = sessionId == activeId
        _state.updateCopy { copy(confirmForgetId = null) }
        val outcome = planForget(disk, sessionId)
        val tx = outcome.tx
        if (!outcome.allowed || tx == null) {
            banner = outcome.message
            render()
            return
        }
        when (val applied = applyTx(tx)) {
            is ApplyVerdict.RolledBack -> {
                banner = zh("没有忘记成功。", "Could not forget that board.")
                render()
            }
            is ApplyVerdict.InForce -> {
                val finished: ApplyVerdict.InForce =
                    if (applied.cleanupPending) retryPendingCleanup(applied.pendingCleanup) else applied
                val report = forgetCleanupDisposition(finished.cleanupPending)
                dropSessionMemory(sessionId, forgotten?.credentialId, forgotten?.boardId)
                val next = finished.activeSessionId
                if (report == ForgetReport.CleanupIncomplete) {
                    banner = zh(FORGET_CLEANUP_INCOMPLETE, "The board was removed from this phone, but some local data could not be cleared.")
                    if (forgotActive && next != null) landOn(next, toast = false) else render()
                    return
                }
                when (forgetDestination(allowed = true, forgotActive = forgotActive, rolledBack = false)) {
                    ForgetDestination.TaskList -> if (next != null && forgetSuccessToast(report)) landOn(next, toast = true) else render()
                    ForgetDestination.MyBoards, ForgetDestination.Unchanged -> render()
                }
            }
        }
    }

    fun activateSession(sessionId: String, path: BoardPickPath = BoardPickPath.TopSwitcher) {
        invalidatePendingPair(PairDeparture.BoardSwitch)
        if (session(sessionId) == null) return
        if (sessionId == activeId) {
            searchQuery = ""
            screen = Screen.Tasks
            backStack.clear()
            render()
            return
        }
        val previous = activeId
        if (!persistActive(sessionId)) return
        discardSettings(previous)
        landOn(sessionId, toast = true, path = path)
    }

    fun openNotification(sessionId: String?, taskId: String?) {
        val target = notificationTarget(sessions(), sessionId, taskId) ?: return
        if (target.sessionId != activeId && !persistActive(target.sessionId)) return
        if (target.sessionId != activeId) landOn(target.sessionId, toast = false)
        openTask(taskId ?: return)
    }

    fun onForeground() {
        foreground = true
        lives.values.forEach { live ->
            if (live.phase == SocketPhase.AUTHENTICATED) live.suppressConnected = true
        }
        render()
        referencedCredentialIds(disk).forEach { id ->
            val live = lives[id]
            when (live?.phase) {
                SocketPhase.AUTHENTICATED -> sendList(id)
                SocketPhase.CONNECTING -> Unit
                else -> connect(id)
            }
        }
        armPoll()
    }

    fun onBackground() {
        foreground = false
        pollJob?.cancel()
        proofJobs.values.forEach { it.cancel() }
    }

    fun pastePairCode(raw: String) = _state.updateCopy { copy(pairCode = trimOuter(raw)) }

    fun setUseGitWorktree(value: Boolean) {
        val current = _state.value
        _state.updateCopy {
            copy(draftUseGitWorktree = value && freshWorktree(current.draftCwd, current.workspaces, currentPillNeedsResync()))
        }
    }

    fun openCreate() {
        val session = session(activeId) ?: return
        if (_state.value.workspaces.isEmpty()) {
            banner = NO_WORKSPACE_COPY
            render()
            return
        }
        val current = _state.value
        val selectedPath = current.workspaces.find { it.id == current.selectedWorkspaceId }?.path
        val nextCwd = cwdForNewTask(current.draftCwd, selectedPath, current.workspaces.map { it.path })
        _state.updateCopy { copy(draftUseGitWorktree = false, draftCwd = nextCwd) }
        push(Screen.Create(session.sessionId))
    }

    fun openWorkspaceCreate() {
        val session = session(activeId) ?: return
        _state.updateCopy { copy(draftWorkspaceName = "", draftWorkspacePath = "", formError = null) }
        push(Screen.WorkspaceCreate(session.sessionId))
    }

    fun openContinue() {
        val task = activeTask() ?: return
        if (!canContinueStatus(task.status)) return
        slot(activeId)?.continueOpen = true
        render()
    }

    fun selectWorkspace(id: String) {
        val sessionId = activeId ?: return
        val view = slot(sessionId)?.view ?: return
        if (id.isNotEmpty() && view.workspaces.none { it.id == id }) return
        val cleared = selectWorkspaceChrome(ListChrome(sessionId, chip, searchQuery, null, "", false, "tasks", null))
        searchQuery = cleared.search
        chip = cleared.chip
        store.apply(DiskOp.PutWorkspace(sessionId, id))
        disk = store.readDisk()
        if (chip == TaskChip.ARCHIVE) loadArchive(reset = true, workspaceId = id) else render()
    }

    fun requestDeleteWorkspace() {
        val id = _state.value.selectedWorkspaceId
        if (id.isNullOrEmpty() || _state.value.workspaces.none { it.id == id }) return
        _state.updateCopy { copy(confirmDeleteWorkspace = true) }
    }

    fun cancelDeleteWorkspace() = _state.updateCopy { copy(confirmDeleteWorkspace = false) }

    fun confirmDeleteWorkspace() {
        val session = session(activeId) ?: return
        val workspaceId = _state.value.selectedWorkspaceId ?: return
        if (workspaceId.isEmpty()) return
        _state.updateCopy { copy(confirmDeleteWorkspace = false) }
        submit("cmd.workspace.delete", session, workspaceId)
    }

    fun submitWorkspaceCreate() {
        val session = session(activeId) ?: return
        submit("cmd.workspace.create", session, null)
    }

    fun pop() {
        val leavingAdd = screen == Screen.AddBoard
        val previous = backStack.removeLastOrNull() ?: return
        screen = previous
        if (leavingAdd) invalidatePendingPair(PairDeparture.Back)
        if (screen !is Screen.Detail) clearLogBinding(activeId)
        render()
    }

    fun openTask(taskId: String) = openCard(taskId, archived = false)
    fun openArchiveTask(taskId: String) = openCard(taskId, archived = true)

    fun submitCreate() {
        val session = session(activeId) ?: return
        submit("cmd.create", session, null)
    }

    fun submitStop() {
        val session = session(activeId) ?: return
        submit("cmd.stop", session, _state.value.selectedTaskId)
    }

    fun submitContinue() {
        val session = session(activeId) ?: return
        val task = activeTask() ?: return
        val plan = planPhoneContinue(task.status, slot(session.sessionId)?.continuePrompt.orEmpty(), activeId, session.sessionId)
        if (!plan.send) return
        submit("cmd.continue", session, task.id)
    }

    fun submitArchive() {
        val session = session(activeId) ?: return
        val task = activeTask() ?: return
        if (task.status !in setOf("succeeded", "failed", "stopped")) return
        if (CAP_ARCHIVE_WRITE !in capabilities(session)) {
            banner = UNSUPPORTED_COPY
            render()
            return
        }
        submit("cmd.archive", session, task.id)
    }

    fun openWorkspaceSettings() {
        val session = session(activeId) ?: return
        if (_state.value.selectedWorkspaceId.isNullOrEmpty()) {
            banner = NO_WORKSPACE_COPY
            render()
            return
        }
        val blocked = settingsEntry(capabilities(session), CAP_WORKSPACE_SETTINGS)
        slot(session.sessionId)?.settingsBlocked = blocked
        push(Screen.WorkspaceSettings)
        if (blocked == null) requestWorkspaceSettings(session)
        else render()
    }

    fun openBoardSettings() {
        val session = session(activeId) ?: return
        val blocked = settingsEntry(capabilities(session), CAP_BOARD_SETTINGS)
        slot(session.sessionId)?.settingsBlocked = blocked
        push(Screen.BoardSettings)
        if (blocked == null) requestBoardSettings(session) else render()
    }

    fun saveWorkspaceSettings() {
        val session = session(activeId) ?: return
        if (settingsEntry(capabilities(session), CAP_WORKSPACE_SETTINGS) != null) {
            banner = UNSUPPORTED_COPY
            render()
            return
        }
        val form = slot(session.sessionId)?.workspaceForm ?: return
        val workspaceId = _state.value.selectedWorkspaceId ?: return
        if (workspaceId.isEmpty() || !writesOk(session)) return
        sendCommand(session, "cmd.workspace.update", workspaceId, keys()) { id, ts, key ->
            workspaceUpdateEnvelope(id, ts, session.boardId, form, workspaceId, key)
        }
    }

    fun addQuickPrompt(label: String, content: String) {
        val holder = activeId?.let { slots[it] } ?: return
        val cleanLabel = label.trim()
        val cleanContent = content.trim()
        if (cleanLabel.isEmpty() || cleanContent.isEmpty()) return
        holder.quickPrompts = holder.quickPrompts + QuickPromptChip(newLocalId("q").take(32), cleanLabel.take(40), cleanContent)
        render()
    }

    fun removeQuickPrompt(id: String) {
        val holder = activeId?.let { slots[it] } ?: return
        holder.quickPrompts = holder.quickPrompts.filterNot { it.id == id }
        render()
    }

    fun saveBoardSettings() {
        val session = session(activeId) ?: return
        val prompts = slot(session.sessionId)?.quickPrompts ?: return
        if (!writesOk(session)) return
        if (settingsEntry(capabilities(session), CAP_BOARD_SETTINGS) != null) {
            banner = UNSUPPORTED_COPY
            render()
            return
        }
        val key = keys()
        sendRaw(session, "cmd.settings.put", null, key, settingsPutPromptsEnvelope(ids(), clock(), session.boardId, prompts, key))
    }

    fun startDifferentCreate() = clearSettled("cmd.create", null)
    fun startDifferentWorkspaceCreate() = clearSettled("cmd.workspace.create", null)
    fun startDifferentWorkspaceDelete() = clearSettled("cmd.workspace.delete", _state.value.selectedWorkspaceId)
    fun resendStop() = resend("cmd.stop")
    fun resendContinue() = resend("cmd.continue")

    fun pair() {
        if (busy) return
        if (!store.secure) {
            banner = say(SECURE_STORAGE_BANNER)
            render()
            return
        }
        val repairId = _state.value.repairSessionId
        when (val pre = pairPrecheck(committedSessionCount(disk), repairId != null)) {
            is PairPrecheck.Refuse -> {
                banner = pre.message
                render()
                return
            }
            PairPrecheck.Post -> Unit
        }
        val issue = inspectPairCode(_state.value.pairCode)
        if (issue != null || !pairSubmitAllowed(_state.value.pairCode, _state.value.httpBase, secure = true, busy = false)) {
            banner = issue?.let { pairIssueMessage(it, englishUi) } ?: say("Enter an http or https relay URL.")
            render()
            return
        }
        val repair = repairId?.let { session(it) }
        val name = validateDisplayName(if (repair != null) repair.displayName else _state.value.displayName)
        if (name == null) {
            banner = zh("显示名需要 1 到 40 个字。", "The display name must be 1 to 40 characters.")
            render()
            return
        }
        val code = trimOuter(_state.value.pairCode)
        val phoneName = _state.value.deviceName.trim().ifBlank { "Android phone" }
        val epoch = ++pairEpoch
        val attempt = PairContext(epoch, activeId)
        busy = true
        banner = null
        render()
        viewModelScope.launch {
            try {
                val base = normalizeHttpBase(if (repair != null) disk.credentials[repair.credentialId]?.httpBase ?: _state.value.httpBase else _state.value.httpBase)
                store.saveIdentity(base, phoneName)
                disk = store.readDisk()
                val result = relay.request("POST", "$base/auth/pair", encodePairBody(code, phoneName))
                if (leaveStalePair(attempt)) return@launch
                if (result.code !in 200..299) {
                    busy = false
                    banner = pairHttpFailure(result.code, result.body, englishUi)
                    render()
                    return@launch
                }
                val paired = try {
                    parsePairResponse(result.body)
                } catch (error: RelayFormatException) {
                    val ux = pairBodyOutcome(httpOk = true, parsed = false)
                    busy = false
                    if (ux.clearPairCode) _state.updateCopy { copy(pairCode = "") }
                    banner = ux.message
                    render()
                    return@launch
                }
                if (leaveStalePair(attempt)) return@launch
                val outcome = planPair(
                    disk,
                    PairRequest(
                        displayName = name,
                        httpBase = base,
                        response = paired,
                        now = clock(),
                        newCredentialId = newLocalId("c"),
                        newSessionIds = paired.boardIds.map { newLocalId("s") },
                        repairSessionId = repairId,
                    ),
                )
                busy = false
                if (leaveStalePair(attempt)) return@launch
                when (outcome) {
                    is PairOutcome.Reject -> {
                        outcome.rollback?.let { applyTx(it) }
                        banner = outcome.message
                        render()
                    }
                    is PairOutcome.Proceed -> {
                        val effect = deferredPairSuccess(attempt, PairContext(pairEpoch, activeId), outcome.activeSessionId)
                        if (!effect.applyTransaction) {
                            render()
                            return@launch
                        }
                        when (val applied = applyTx(outcome.tx)) {
                            is ApplyVerdict.RolledBack -> {
                                banner = CODE_CONSUMED_SAVE
                                render()
                                return@launch
                            }
                            is ApplyVerdict.InForce -> {
                                if (!effect.successToast || !pairAttemptStillCurrent(attempt, PairContext(pairEpoch, activeId))) {
                                    render()
                                    return@launch
                                }
                                _state.updateCopy { copy(pairCode = "", displayName = "") }
                                backStack.clear()
                                landOn(applied.activeSessionId ?: effect.activeSessionId ?: outcome.activeSessionId, toast = true)
                                connectNewCredentials()
                            }
                        }
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

    fun refreshCredential(sessionId: String) {
        val session = session(sessionId) ?: return
        val secret = disk.credentials[session.credentialId] ?: return
        viewModelScope.launch {
            busy = true
            render()
            try {
                val result = relay.request("POST", "${secret.httpBase}/auth/refresh", encodeRefreshBody(secret.deviceToken))
                if (result.code == 401 || result.code == 403) {
                    markRepair(session.credentialId, zh("需要重新配对", "This board needs to be paired again."))
                    return@launch
                }
                if (result.code !in 200..299) {
                    banner = say(parseRelayError(result.body))
                } else {
                    val tx = planRefresh(disk, session.credentialId, parsePairResponse(result.body))
                    if (tx != null && applyTx(tx) is ApplyVerdict.InForce) {
                        banner = zh("登录已更新，正在重新连接。", "Sign-in refreshed. Reconnecting.")
                        connect(session.credentialId)
                    } else {
                        banner = zh("新的登录没有保存，其他看板仍保持连接。", "The new sign-in was not stored. Other boards stay connected.")
                    }
                }
            } catch (error: IOException) {
                banner = say("Could not reach the relay.")
            } finally {
                busy = false
                render()
            }
        }
    }

    fun loadMoreArchive() {
        val slot = slot(activeId) ?: return
        if (slot.archiveBusy || slot.archiveCursor == null) return
        loadArchive(reset = false)
    }

    private fun boot() {
        disk = store.readDisk()
        if (needsMigrationStart(disk)) {
            planMigrationStart(disk, newLocalId("c"))?.let { applyTx(it) }
            disk = store.readDisk()
        }
        store.applyAll(recoverLaunch(disk).cleanup)
        disk = store.readDisk()
        val launch = recoverLaunch(disk)
        banner = launch.banner?.let { say(it) }
        when (launch.phase) {
            LaunchPhase.UNPAIRED -> {
                screen = Screen.Pair
                activeId = null
            }
            LaunchPhase.MIGRATING -> {
                screen = Screen.Reading
                activeId = null
                launch.migrationCredentialId?.let { connect(it) }
            }
            LaunchPhase.READY -> {
                activeId = launch.activeSessionId
                screen = Screen.Tasks
                launch.sessions.map { it.credentialId }.distinct().forEach { connect(it) }
            }
        }
        render()
    }

    private fun landOn(sessionId: String, toast: Boolean, path: BoardPickPath = BoardPickPath.TopSwitcher) {
        val target = session(sessionId) ?: return
        val previous = activeId
        if (previous != null && previous != sessionId) clearLogBinding(previous)
        val holder = slot(sessionId)
        val picked = pickBoard(
            path,
            ListChrome(
                sessionId,
                chip,
                searchQuery,
                (screen as? Screen.Detail)?.taskId,
                holder.continuePrompt,
                holder.continueOpen,
                "tasks",
                null,
            ),
            target,
            disk.workspaces[sessionId],
            holder.view.workspaces,
            holder.view.tasks,
            holder.view.sawSnapshot,
        )
        activeId = picked.chrome.sessionId ?: sessionId
        searchQuery = picked.chrome.search
        chip = picked.chrome.chip
        holder.pendingDetail = null
        holder.continuePrompt = picked.chrome.continuePrompt
        holder.continueOpen = picked.chrome.continueOpen
        holder.detailArchived = false
        holder.archiveDetail = null
        clearLogBinding(sessionId)
        screen = Screen.Tasks
        backStack.clear()
        if (toast) banner = picked.chrome.toast
        render()
        if (chip == TaskChip.ARCHIVE) loadArchive(reset = true, workspaceId = _state.value.selectedWorkspaceId)
    }

    private fun persistActive(sessionId: String): Boolean {
        val tx = planActivate(disk, sessionId) ?: return false
        if (tx.steps.isEmpty()) return true
        return when (val applied = applyTx(tx)) {
            is ApplyVerdict.RolledBack -> {
                banner = zh("没有切换成功。", "Could not switch boards.")
                render()
                false
            }
            is ApplyVerdict.InForce -> applied.activeSessionId == sessionId || disk.catalog?.activeSessionId == sessionId
        }
    }

    private fun applyTx(tx: Transaction): ApplyVerdict {
        if (tx.steps.isEmpty()) {
            return ApplyVerdict.InForce(disk, openSocketIds(), disk.catalog?.activeSessionId, cleanupPending = false)
        }
        var cutover = false
        tx.steps.forEachIndexed { index, op ->
            if (!store.apply(op)) {
                if (!failedStepKeepsCatalog(tx.cutoverIndex, index)) {
                    tx.stagedCredentialIds.forEach { id ->
                        if (id !in referencedCredentialIds(store.readDisk())) store.apply(DiskOp.DeleteCredential(id))
                    }
                    disk = store.readDisk()
                    return ApplyVerdict.RolledBack(disk, openSocketIds(), disk.catalog?.activeSessionId)
                }
                disk = store.readDisk()
                closeUnreferenced()
                return ApplyVerdict.InForce(
                    disk,
                    openSocketIds(),
                    disk.catalog?.activeSessionId,
                    cleanupPending = true,
                    pendingCleanup = tx.steps.drop(index),
                )
            }
            if (index == tx.cutoverIndex) cutover = true
        }
        disk = store.readDisk()
        closeUnreferenced()
        return ApplyVerdict.InForce(disk, openSocketIds(), disk.catalog?.activeSessionId, cleanupPending = false)
    }

    /** Re-apply ClearLocals and any later forget step that did not commit. */
    private fun retryPendingCleanup(ops: List<DiskOp>): ApplyVerdict.InForce {
        val stillPending = ArrayList<DiskOp>()
        var failed = false
        for (op in ops) {
            if (failed || !store.apply(op)) {
                failed = true
                stillPending.add(op)
            }
        }
        disk = store.readDisk()
        if (!failed) closeUnreferenced()
        return ApplyVerdict.InForce(
            disk,
            openSocketIds(),
            disk.catalog?.activeSessionId,
            cleanupPending = failed,
            pendingCleanup = stillPending,
        )
    }

    private fun invalidatePendingPair(departure: PairDeparture) {
        pairEpoch = pairContextAfterDeparture(PairContext(pairEpoch, activeId), departure).epoch
        if (busy) busy = false
    }

    /** Stale Add responses must not write the catalog or announce success. */
    private fun leaveStalePair(attempt: PairContext): Boolean {
        if (pairAttemptStillCurrent(attempt, PairContext(pairEpoch, activeId))) return false
        render()
        return true
    }

    private fun openSocketIds(): Set<String> = lives.keys.filter { lives[it]?.phase != SocketPhase.CLOSED }.toSet()

    private fun connectNewCredentials() {
        referencedCredentialIds(disk).forEach { id ->
            if (lives[id]?.phase != SocketPhase.AUTHENTICATED) connect(id)
        }
    }

    private fun connect(credentialId: String) {
        val secret = disk.credentials[credentialId] ?: return
        val live = lives.getOrPut(credentialId) { LiveSocket() }
        live.job?.cancel()
        val epoch = live.epoch + 1
        live.epoch = epoch
        sessionsOn(credentialId).forEach { session ->
            val holder = slots[session.sessionId] ?: return@forEach
            val invalidated = invalidateSnapshotForNewEpoch(
                EpochSlot(holder.appliedGeneration, holder.view.needsResync, holder.view.sawSnapshot),
            )
            holder.appliedGeneration = invalidated.appliedGeneration
            holder.view = holder.view.copy(needsResync = invalidated.needsResync)
            holder.eligibilityFresh = false
        }
        live.phase = if (live.phase == SocketPhase.AUTHENTICATED || live.phase == SocketPhase.RECONNECTING) {
            SocketPhase.RECONNECTING
        } else {
            SocketPhase.CONNECTING
        }
        live.subscribed = emptySet()
        live.log = null
        live.listRef = null
        live.helloRef = null
        render()
        relay.openSocket(credentialId, secret.wsUrl, object : SocketListener {
            override fun onOpen() {
                viewModelScope.launch {
                    if (live.epoch != epoch) return@launch
                    val helloId = ids()
                    live.helloRef = helloId
                    val token = disk.credentials[credentialId]?.deviceToken ?: return@launch
                    relay.send(credentialId, encodeEnvelope(helloEnvelope(helloId, clock(), token, disk.deviceName)))
                }
            }

            override fun onMessage(text: String) {
                viewModelScope.launch {
                    if (live.epoch != epoch) return@launch
                    onFrame(credentialId, epoch, text)
                }
            }

            override fun onClosed(reason: String) {
                viewModelScope.launch {
                    if (live.epoch != epoch) return@launch
                    live.phase = SocketPhase.CLOSED
                    render()
                    val wait = live.backoff
                    live.backoff = (live.backoff * 2).coerceAtMost(15_000)
                    live.job = viewModelScope.launch {
                        delay(wait)
                        if (live.epoch == epoch && referencedCredentialIds(disk).contains(credentialId)) connect(credentialId)
                    }
                }
            }
        })
    }

    private fun onFrame(credentialId: String, epoch: Long, text: String) {
        val live = lives[credentialId] ?: return
        if (live.epoch != epoch) return
        val message = try {
            parseEnvelope(text)
        } catch (error: RelayFormatException) {
            return
        }
        if (sessionRejected(message)) {
            markRepair(credentialId, zh("需要重新配对", "This board needs to be paired again."))
            return
        }
        val ref = message.text("ref")
        if (ref != null && ref == live.helloRef) {
            onHello(credentialId, live, message)
            return
        }
        if (message.type == "ack" && acceptBoardList(live.listRef, ref, epoch, live.epoch) && parseBoardList(message.payload) != null) {
            onList(credentialId, live, epoch, parseBoardList(message.payload).orEmpty())
            return
        }
        val code = message.text("code")
        if (code == "rate_limited") rateLimited = recordRateLimit(rateLimited).count
        if (code == "board_offline" || code == "board_disconnected") {
            val boardId = message.text("boardId") ?: ref?.let { refs[it]?.boardId }
            val session = sessionsOn(credentialId).find { it.boardId == boardId }
            if (session != null) {
                val holder = slot(session.sessionId)
                holder.proof = proofAfterDisconnect(clock(), epoch, holder.proof?.listedGeneration)
            }
            sendList(credentialId)
        }
        val kind = frameKind(message.type)
        val routed = routeFrame(routeInput(credentialId, epoch, live, message, kind))
        val target = routed as? RouteResult.ToSession ?: return
        val record = target.ref
        when (record?.command) {
            "cmd.detail" -> onDetail(target.sessionId, message)
            "cmd.archive.list" -> onArchive(target.sessionId, message)
            "cmd.workspace.get", "cmd.workspace.update", "cmd.settings.get", "cmd.settings.put" -> onSettings(target.sessionId, record.command, message)
            null -> onEvent(target.sessionId, message)
            else -> onCommand(target.sessionId, message)
        }
    }

    private fun onHello(credentialId: String, live: LiveSocket, message: tech.mengfei.agentboard.protocol.Envelope) {
        live.helloRef = null
        if (message.type == "err" || message.text("stage") != "executed") {
            banner = message.text("message")?.let { say(it) } ?: say("The relay did not accept this phone.")
            render()
            return
        }
        live.backoff = 1_000
        live.phase = SocketPhase.AUTHENTICATED
        live.suppressConnected = false
        live.helloBoardIds = disk.credentials[credentialId]?.boardIds?.toSet().orEmpty()
        sendList(credentialId)
        recoverInflight(credentialId)
        render()
    }

    private fun onList(credentialId: String, live: LiveSocket, epoch: Long, boards: List<tech.mengfei.agentboard.protocol.BoardInfo>) {
        live.listRef = null
        live.suppressConnected = false
        live.helloBoardIds = boards.map { it.boardId }.toSet()
        val now = clock()
        if (disk.catalog?.migrationState == tech.mengfei.agentboard.protocol.MigrationState.PENDING &&
            disk.catalog?.migrationCredentialId == credentialId
        ) {
            val rows = boards.map { BoardListRow(it.boardId, it.online, it.generation) }
            val tx = planMigrationList(disk, rows, rows.map { newLocalId("s") }, now)
            if (tx != null && applyTx(tx) is ApplyVerdict.InForce) {
                disk.catalog?.activeSessionId?.let { landOn(it, toast = false) }
            }
        }
        val mine = sessionsOn(credentialId)
        mine.forEach { session ->
            val info = boards.find { it.boardId == session.boardId } ?: return@forEach
            val holder = slot(session.sessionId)
            holder.proof = BoardProof(info.online, info.generation, now, epoch)
            holder.capabilities = info.capabilities
            holder.view = holder.view.copy(
                needsResync = resyncAfterList(holder.appliedGeneration, info.generation, holder.view.needsResync, holder.view.sawSnapshot),
            )
        }
        live.subscribed = mine.map { it.boardId }.toSet()
        mine.forEach { session ->
            relay.send(credentialId, encodeEnvelope(subTasksEnvelope(ids(), clock(), session.boardId)))
        }
        if (chip == TaskChip.ARCHIVE) {
            val active = session(activeId)
            if (active?.credentialId == credentialId) loadArchive(reset = true)
        }
        render()
    }

    private fun onEvent(sessionId: String, message: tech.mengfei.agentboard.protocol.Envelope) {
        val holder = slot(sessionId)
        when (val outcome = holder.reducer.apply(holder.view, message)) {
            is ApplyOutcome.Resync -> {
                holder.view = outcome.view
                holder.eligibilityFresh = false
                banner = if (englishUi) "Missed events (${outcome.reason}). Refreshing from a snapshot." else "漏收了事件（${outcome.reason}）。正在用快照刷新。"
                armResync(sessionId)
                render()
            }
            is ApplyOutcome.Applied -> {
                if (message.type == "evt.snapshot") {
                    holder.snapshotAt = clock()
                    if (!outcome.view.needsResync) holder.appliedGeneration = outcome.view.generation
                    holder.eligibilityFresh = lives[session(sessionId)?.credentialId]?.phase == SocketPhase.AUTHENTICATED && !outcome.view.needsResync
                    if (!outcome.view.needsResync && (banner?.startsWith("漏收了事件") == true || banner?.startsWith("Missed events") == true)) {
                        banner = null
                    }
                }
                holder.view = outcome.view
                outcome.notice?.let { notice ->
                    val name = session(sessionId)?.displayName
                    notifier.post(notice.copy(sessionId = sessionId, displayName = name))
                }
                render()
            }
            is ApplyOutcome.Ignored -> Unit
        }
    }

    private fun onDetail(sessionId: String, message: tech.mengfei.agentboard.protocol.Envelope) {
        val holder = slot(sessionId)
        if (!detailReplySettled(message)) return
        val request = holder.pendingDetail ?: return
        holder.pendingDetail = null
        val interpreted = interpretCommand(message)
        val task = interpreted?.task
        val active = activeDetailTask(request, holder.epoch, holder.view.boardId, message.text("ref"), task)
        val archived = archivedDetailTask(request, holder.epoch, holder.view.boardId, message.text("ref"), task)
        if (active != null && active.status != ARCHIVED_STATUS) holder.view = holder.view.withLocalTask(active)
        else if (archived != null) {
            holder.archiveDetail = archived
            holder.detailArchived = true
        } else if (sessionId == activeId && interpreted != null) {
            formError = say(interpreted.summary)
        }
        if (sessionId == activeId && active != null) {
            _state.updateCopy { copy(selectedTaskId = active.id) }
        }
        render()
    }

    private fun onArchive(sessionId: String, message: tech.mengfei.agentboard.protocol.Envelope) {
        val holder = slot(sessionId)
        val request = holder.pendingArchive ?: return
        if (!archiveReplyMatches(request.requestId, message.text("ref"))) return
        if (!archiveReplySettled(message)) return
        holder.pendingArchive = null
        holder.archiveBusy = false
        if (message.type == "err" || message.text("stage") in setOf("failed", "timeout", "unknown")) {
            holder.archiveError = say("Could not load the archive.")
        } else if (message.text("stage") == "executed") {
            val page = readArchivePage(message.payload)
            if (page == null) holder.archiveError = say("Could not read the archive page.")
            else if (!acceptArchivePage(request.requestId, message.text("ref"), page.tasks, request.workspaceId)) {
                clearArchivePresentation(holder)
                holder.archiveError = ARCHIVE_SCOPE_UNSUPPORTED
            } else {
                holder.archiveTasks = applyArchivePage(holder.archiveTasks, page, request.reset)
                holder.archiveCursor = page.nextCursor
                holder.archiveLoaded = true
                holder.archiveScopeSession = sessionId
                holder.archiveScopeWorkspace = request.workspaceId
                holder.archiveStale = false
                holder.archiveError = null
            }
        }
        render()
    }

    private fun onSettings(sessionId: String, command: String, message: tech.mengfei.agentboard.protocol.Envelope) {
        val holder = slot(sessionId)
        val executed = message.type == "ack" && message.text("stage") == "executed"
        val documentOk = settingsDocumentOk(command, message.payload)
        val effect = settingsAckEffect(activeId, sessionId, command, executed, documentOk)
        if (!executed || !documentOk) {
            if (sessionId == activeId) {
                if (!executed) {
                    formError = interpretCommand(message)?.summary?.let { say(it) } ?: UNSUPPORTED_COPY
                    if (message.text("code") == "unsupported" || message.text("code") == "bad_type") holder.settingsBlocked = UNSUPPORTED_COPY
                } else {
                    formError = zh("设置没有读全，没有保存。", "The settings document could not be read. Nothing was saved.")
                }
            }
            if (command == "cmd.settings.get" || command == "cmd.settings.put") holder.settingsLoaded = false
            render()
            return
        }
        when (command) {
            "cmd.workspace.get", "cmd.workspace.update" -> {
                val form = readWorkspaceSettingsForm(message.payload)
                if (form != null && effect.fillForm) {
                    holder.loadedWorkspace = form
                    holder.workspaceForm = form
                    holder.workspaceDirty = false
                }
            }
            "cmd.settings.get", "cmd.settings.put" -> {
                val prompts = readQuickPrompts(message.payload)
                if (prompts != null && effect.fillForm) holder.quickPrompts = prompts
                holder.settingsLoaded = effect.markLoaded
            }
        }
        if (effect.toastSaved) {
            banner = when (effect.toast) {
                PROMPTS_SAVED_COPY -> zh(PROMPTS_SAVED_COPY, "Shortcuts saved")
                SAVED_COPY -> zh(SAVED_COPY, "Saved")
                else -> null
            }
        }
        render()
    }

    private fun onCommand(sessionId: String, message: tech.mengfei.agentboard.protocol.Envelope) {
        val holder = slot(sessionId)
        val current = holder.inflight ?: return
        val ref = message.text("ref")
        if (ref != null && ref == current.lookupId) {
            onLookupReply(sessionId, message, current)
            return
        }
        val interpreted = interpretCommand(message) ?: return
        when (nextCommandAction(current.lookupId != null, interpreted)) {
            CommandAction.Wait -> {
                if (sessionId == activeId) commandNote = say(interpreted.summary)
                render()
            }
            CommandAction.SendLookup -> beginLookup(sessionId, current)
            CommandAction.Settle -> releaseInflight(sessionId, Recovery.Clear(interpreted.summary, interpreted))
        }
    }

    private fun submit(cmd: String, session: PhoneSession, taskId: String?) {
        if (!writesOk(session)) return
        val holder = slot(session.sessionId)
        val action = actionKey(session.sessionId, cmd, taskId)
        val settled = holder.settled[action]
        when (val plan = planSubmit(cmd, holder.inflight != null, settled?.interpretation, settled?.key, keys)) {
            SubmitPlan.Busy -> return
            is SubmitPlan.Lookup -> beginLookup(session.sessionId, Inflight(action, cmd, session, taskId, plan.idempotencyKey, "pending"))
            is SubmitPlan.Send -> sendBuilt(session, cmd, taskId, plan.idempotencyKey)
        }
    }

    private fun sendBuilt(session: PhoneSession, cmd: String, taskId: String?, key: String) {
        val draft = _state.value
        val requestId = ids()
        val ts = clock()
        val selected = draft.workspaces.find { it.id == draft.selectedWorkspaceId }
        val prompt = slot(session.sessionId).continuePrompt
        val built = when (cmd) {
            "cmd.create" -> validateCreate(
                requestId, ts, session.boardId, draft.draftTitle, draft.draftPrompt, draft.draftAgent, draft.draftCwd, key,
                useGitWorktree = draft.draftUseGitWorktree && freshWorktree(draft.draftCwd, draft.workspaces, currentPillNeedsResync()),
                workspaceId = workspaceIdForCreate(draft.draftCwd, selected?.id, selected?.path),
            )
            "cmd.workspace.create" -> validateWorkspaceCreate(requestId, ts, session.boardId, draft.draftWorkspaceName, draft.draftWorkspacePath, key)
            "cmd.workspace.delete" -> validateWorkspaceDelete(requestId, ts, session.boardId, taskId ?: return, key)
            "cmd.stop" -> validateStop(requestId, ts, session.boardId, taskId ?: return, key)
            "cmd.archive" -> archiveWriteEnvelope(requestId, ts, session.boardId, taskId ?: return, key)
            else -> {
                val phone = validatePhoneContinue(requestId, ts, session.boardId, taskId ?: return, key, prompt)
                if (phone is Validated.Invalid) phone else validateContinue(requestId, ts, session.boardId, taskId, key, prompt)
            }
        }
        when (built) {
            is Validated.Invalid -> {
                formError = say(built.message)
                render()
            }
            is Validated.Ok -> sendRaw(session, cmd, taskId, key, built.value)
        }
    }

    private fun sendRaw(session: PhoneSession, cmd: String, taskId: String?, key: String, message: tech.mengfei.agentboard.protocol.Envelope) {
        val live = lives[session.credentialId] ?: return
        val record = RefRecord(message.id, session.sessionId, session.credentialId, session.boardId, cmd, taskId, live.epoch)
        refs[message.id] = record
        if (!relay.send(session.credentialId, encodeEnvelope(message))) {
            refs.remove(message.id)
            if (session.sessionId == activeId) commandNote = say("Not connected to the relay.")
            render()
            return
        }
        val holder = slot(session.sessionId)
        val action = actionKey(session.sessionId, cmd, taskId)
        holder.inflight = Inflight(action, cmd, session, taskId, key, message.id)
        holder.settled.remove(action)
        if (session.sessionId == activeId) commandNote = if (englishUi) "Sending $cmd." else "正在发送 $cmd。"
        render()
    }

    private fun sendCommand(
        session: PhoneSession,
        cmd: String,
        taskId: String?,
        key: String,
        build: (String, Long, String) -> Validated<tech.mengfei.agentboard.protocol.Envelope>,
    ) {
        when (val built = build(ids(), clock(), key)) {
            is Validated.Invalid -> {
                formError = say(built.message)
                render()
            }
            is Validated.Ok -> sendRaw(session, cmd, taskId, key, built.value)
        }
    }

    private fun beginLookup(sessionId: String, current: Inflight) {
        val session = session(sessionId) ?: return
        val command = OutstandingCommand(current.cmd, session.boardId, current.key, current.polls)
        val lookupId = ids()
        val envelope = lookupEnvelope(lookupId, clock(), session.boardId, command.idempotencyKey, command.cmd)
        val live = lives[session.credentialId] ?: return
        refs[lookupId] = RefRecord(lookupId, sessionId, session.credentialId, session.boardId, command.cmd, current.taskId, live.epoch)
        if (!relay.send(session.credentialId, encodeEnvelope(envelope))) {
            releaseInflight(sessionId, lookupSendFailed())
            return
        }
        slot(sessionId).inflight = current.copy(lookupId = lookupId, polls = command.polls)
        if (sessionId == activeId) commandNote = say("Checking the stored result. This command will not be sent again.")
        render()
    }

    private fun onLookupReply(sessionId: String, message: tech.mengfei.agentboard.protocol.Envelope, current: Inflight) {
        val command = OutstandingCommand(current.cmd, session(sessionId)?.boardId.orEmpty(), current.key, current.polls)
        when (val step = recoverFromLookup(command, message)) {
            is Recovery.Poll -> {
                slot(sessionId).inflight = current.copy(polls = step.command.polls)
                viewModelScope.launch {
                    delay(1_000)
                    val latest = slot(sessionId).inflight ?: return@launch
                    if (latest.polls == step.command.polls) beginLookup(sessionId, latest)
                }
            }
            is Recovery.Lookup -> beginLookup(sessionId, current)
            is Recovery.Clear -> releaseInflight(sessionId, step)
        }
    }

    private fun recoverInflight(credentialId: String) {
        sessionsOn(credentialId).forEach { session ->
            val current = slot(session.sessionId).inflight ?: return@forEach
            when (val step = recoverAfterHello(OutstandingCommand(current.cmd, session.boardId, current.key, current.polls))) {
                null -> Unit
                is Recovery.Lookup -> beginLookup(session.sessionId, current)
                is Recovery.Poll -> beginLookup(session.sessionId, current.copy(polls = step.command.polls))
                is Recovery.Clear -> releaseInflight(session.sessionId, step)
            }
        }
    }

    private fun releaseInflight(sessionId: String, step: Recovery.Clear) {
        val holder = slot(sessionId)
        val current = holder.inflight
        holder.inflight = null
        val interpreted = step.interpretation
        if (current != null && interpreted != null) holder.settled[current.action] = Settled(interpreted, current.key)
        if (sessionId == activeId) commandNote = say(step.summary)
        val task = interpreted?.task
        if (task != null) holder.view = holder.view.withLocalTask(task)
        interpreted?.workspace?.let { workspace ->
            holder.view = holder.view.withWorkspace(workspace)
            store.apply(DiskOp.PutWorkspace(sessionId, workspace.id))
            disk = store.readDisk()
        }
        interpreted?.deletedWorkspaceId?.let { deleted ->
            holder.view = holder.view.withoutWorkspace(deleted)
            if (disk.workspaces[sessionId] == deleted) {
                store.apply(DiskOp.PutWorkspace(sessionId, null))
                disk = store.readDisk()
            }
        }
        if (current?.cmd == "cmd.continue") {
            val kept = if (interpreted?.retry == Retry.None && interpreted.settled) "" else holder.continuePrompt
            if (sessionId == activeId) holder.continuePrompt = kept
            if (kept.isEmpty()) holder.continueOpen = false
        }
        val gate = completionForSession(activeId, sessionId, current?.cmd.orEmpty(), task?.id, interpreted?.retry == Retry.None && interpreted.settled)
        val openedTask = gate.taskId
        if (gate.openDetail && openedTask != null && sessionId == activeId) {
            _state.updateCopy { copy(selectedTaskId = openedTask, createdHidden = createHiddenBanner(chip)) }
            banner = createHiddenBanner(chip) ?: banner
            push(Screen.Detail(sessionId, openedTask))
        }
        render()
    }

    private fun requestDetail(session: PhoneSession, taskId: String) {
        val live = lives[session.credentialId] ?: return
        if (live.phase != SocketPhase.AUTHENTICATED) return
        val requestId = ids()
        val built = validateDetail(requestId, clock(), session.boardId, taskId, keys())
        if (built is Validated.Ok && relay.send(session.credentialId, encodeEnvelope(built.value))) {
            refs[requestId] = RefRecord(requestId, session.sessionId, session.credentialId, session.boardId, "cmd.detail", taskId, live.epoch)
            val holder = slot(session.sessionId)
            holder.epoch += 1
            holder.pendingDetail = tech.mengfei.agentboard.protocol.DetailRequest(requestId, session.boardId, taskId, holder.epoch)
            if (shouldSendLogSubscribe(taskId)) {
                val logId = ids()
                live.log = LogBinding(session.credentialId, session.boardId, taskId, live.epoch)
                relay.send(session.credentialId, encodeEnvelope(subLogsEnvelope(logId, clock(), session.boardId, taskId)))
            }
        }
    }

    private fun requestWorkspaceSettings(session: PhoneSession) {
        val workspaceId = disk.workspaces[session.sessionId] ?: _state.value.selectedWorkspaceId ?: return
        if (workspaceId.isEmpty()) return
        sendCommand(session, "cmd.workspace.get", workspaceId, keys()) { id, ts, key ->
            workspaceGetEnvelope(id, ts, session.boardId, workspaceId, key)
        }
    }

    private fun requestBoardSettings(session: PhoneSession) {
        val key = keys()
        sendRaw(session, "cmd.settings.get", null, key, settingsGetEnvelope(ids(), clock(), session.boardId, key))
    }

    private fun loadArchive(reset: Boolean, workspaceId: String? = null) {
        val session = session(activeId) ?: return
        val holder = slot(session.sessionId)
        val selected = workspaceId ?: _state.value.selectedWorkspaceId
        if (ARCHIVE_CAPABILITY !in holder.capabilities) {
            holder.archiveError = say("This board cannot list archived tasks yet.")
            clearArchivePresentation(holder)
            holder.archiveBusy = false
            render()
            return
        }
        when (val query = archiveQuery(selected)) {
            is ArchiveQuery.Unsupported -> {
                clearArchivePresentation(holder)
                holder.archiveBusy = false
                holder.archiveError = query.message
                render()
                return
            }
            is ArchiveQuery.Scoped -> Unit
        }
        val scoped = (archiveQuery(selected) as ArchiveQuery.Scoped).workspaceId
        if (reset) clearArchivePresentation(holder)
        val cursor = if (reset) null else holder.archiveCursor
        val requestId = ids()
        val built = validateArchiveList(requestId, clock(), session.boardId, keys(), cursor, 20, scoped)
        if (built is Validated.Ok) {
            val live = lives[session.credentialId]
            if (live != null && relay.send(session.credentialId, encodeEnvelope(built.value))) {
                refs[requestId] = RefRecord(requestId, session.sessionId, session.credentialId, session.boardId, "cmd.archive.list", null, live.epoch)
                holder.pendingArchive = ArchiveHold(requestId, reset, scoped)
                holder.archiveBusy = true
            }
        }
        render()
    }

    private fun showArchive() {
        chip = TaskChip.ARCHIVE
        val session = session(activeId)
        if (session == null || ARCHIVE_CAPABILITY !in capabilities(session)) {
            val holder = slot(activeId)
            holder.archiveError = say("This board cannot list archived tasks yet.")
            clearArchivePresentation(holder)
            holder.archiveBusy = false
            render()
            return
        }
        loadArchive(reset = true)
    }

    private fun sendList(credentialId: String) {
        val live = lives[credentialId] ?: return
        if (live.phase != SocketPhase.AUTHENTICATED) return
        val listId = ids()
        live.listRef = listId
        relay.send(credentialId, encodeEnvelope(boardListEnvelope(listId, clock())))
    }

    private fun armPoll() {
        pollJob?.cancel()
        if (!pollArmed(foreground, lives.values.any { it.phase == SocketPhase.AUTHENTICATED })) return
        pollJob = viewModelScope.launch {
            while (foreground) {
                delay(15_000)
                if (!foreground) break
                referencedCredentialIds(disk).forEach { id ->
                    if (lives[id]?.phase == SocketPhase.AUTHENTICATED) sendList(id)
                }
            }
        }
    }

    private fun armProofs() {
        val keep = mutableSetOf<String>()
        sessions().forEach { session ->
            val holder = slots[session.sessionId] ?: return@forEach
            val at = holder.proof?.at ?: return@forEach
            val wait = proofRedrawDelay(pillFor(session).kind, at, clock(), foreground) ?: return@forEach
            if (wait == 0L) return@forEach
            val sessionId = session.sessionId
            keep += sessionId
            if (proofJobs[sessionId]?.isActive == true) return@forEach
            proofJobs[sessionId] = viewModelScope.launch {
                delay(wait)
                proofJobs.remove(sessionId)
                render()
                armProofs()
            }
        }
        proofJobs.keys.toList().filter { it !in keep }.forEach { id -> proofJobs.remove(id)?.cancel() }
    }

    private fun armResync(sessionId: String) {
        val holder = slot(sessionId)
        if (!holder.resync.onGap()) return
        val session = session(sessionId) ?: return
        viewModelScope.launch {
            delay(400)
            if (holder.resync.consumeIfStillNeeded()) {
                val live = lives[session.credentialId]
                if (live?.phase == SocketPhase.AUTHENTICATED) {
                    relay.send(session.credentialId, encodeEnvelope(subTasksEnvelope(ids(), clock(), session.boardId)))
                }
            }
        }
    }

    private fun markRepair(credentialId: String, message: String) {
        val live = lives[credentialId] ?: return
        live.phase = SocketPhase.UNAUTHORIZED
        live.epoch += 1
        relay.closeSocket(credentialId)
        banner = message
        busy = false
        render()
    }

    private fun closeUnreferenced() {
        val referenced = referencedCredentialIds(disk)
        lives.keys.toList().forEach { id ->
            if (id !in referenced) {
                lives.remove(id)?.job?.cancel()
                relay.closeSocket(id)
            }
        }
    }

    private fun dropSessionMemory(sessionId: String, credentialId: String?, boardId: String?) {
        val before = ForgetMemory(
            slotSessionIds = slots.keys.toSet(),
            refSessionIds = refs.values.map { it.sessionId }.toSet(),
            logs = lives.mapNotNull { (id, live) -> live.log?.let { LiveLog(id, it.boardId) } },
        )
        val after = forgetMemoryEffect(before, sessionId, credentialId, boardId)
        slots.keys.toList().filter { it !in after.slotSessionIds }.forEach { slots.remove(it) }
        refs.entries.removeAll { it.value.sessionId !in after.refSessionIds }
        val keptLogs = after.logs.map { it.credentialId to it.boardId }.toSet()
        lives.forEach { (id, live) ->
            val bound = live.log?.boardId
            if (bound != null && (id to bound) !in keptLogs) live.log = null
        }
        proofJobs.remove(sessionId)?.cancel()
    }

    private fun clearArchivePresentation(holder: Slot) {
        holder.archiveTasks = emptyList()
        holder.archiveCursor = null
        holder.archiveLoaded = false
        holder.archiveScopeSession = null
        holder.archiveScopeWorkspace = null
        holder.archiveStale = false
    }

    private fun discardSettings(sessionId: String?) {
        val holder = sessionId?.let { slots[it] } ?: return
        holder.workspaceForm = holder.loadedWorkspace
        holder.workspaceDirty = false
    }

    private fun clearLogBinding(sessionId: String?) {
        val credentialId = sessionId?.let { session(it)?.credentialId } ?: return
        val live = lives[credentialId] ?: return
        if (live.log?.boardId == session(sessionId)?.boardId) live.log = null
    }

    private fun openCard(taskId: String, archived: Boolean) {
        val session = session(activeId) ?: return
        val holder = slot(session.sessionId)
        holder.detailArchived = archived
        holder.archiveDetail = if (archived) holder.archiveTasks.find { it.id == taskId } else null
        push(Screen.Detail(session.sessionId, taskId))
        requestDetail(session, taskId)
        render()
    }

    private fun writesOk(session: PhoneSession): Boolean {
        val pill = pillFor(session)
        if (pill.writesAllowed) return true
        commandNote = pillCopy(pill, slot(session.sessionId).snapshotAt, englishUi).primary
        render()
        return false
    }

    private fun render() {
        val session = session(activeId)
        val holder = session?.let { slot(it.sessionId) }
        val pill = session?.let { pillFor(it) }
        val copy = pill?.let { pillCopy(it, holder?.snapshotAt, englishUi) }
        val view = holder?.view
        val rows = if (session == null || view == null) emptyList() else tasksAfterSessionSwitch(session.sessionId, activeId, view.tasks)
        val saw = view?.sawSnapshot == true
        val remembered = session?.let { disk.workspaces[it.sessionId] }
        val selection = if (view == null) null else nextWorkspaceSelection(remembered, view.workspaces, rows, saw)
        if (session != null && selection != null && selection.persist) {
            store.apply(DiskOp.PutWorkspace(session.sessionId, selection.selectedId))
            disk = store.readDisk()
        }
        val workspaces = view?.workspaces.orEmpty()
        val rendered = renderedHotList(rows, workspaces, selection?.selectedId, chip, searchQuery, saw)
        val base = visibleTasks(rows, workspaces, selection?.selectedId)
        val byChip = tasksForChip(base, chip)
        val confirmed = confirmedArchiveTasks(
            ArchiveLoadScope(
                tasks = holder?.archiveTasks.orEmpty(),
                loaded = holder?.archiveLoaded == true,
                sessionId = holder?.archiveScopeSession,
                workspaceId = holder?.archiveScopeWorkspace,
                activeSessionId = activeId,
                selectedWorkspaceId = selection?.selectedId,
            ),
        )
        val selectedId = selection?.selectedId
        val visibleArchive = if (selectedId == null) emptyList() else archiveRowsForQuery(confirmed, searchQuery)
        val archiveSupportedNow = session != null && ARCHIVE_CAPABILITY in capabilities(session)
        val scopeUnsupported = archiveSupportedNow &&
            selectedId != null &&
            archiveQuery(selectedId) is ArchiveQuery.Unsupported
        val archiveEmpty = taskListEmpty(
            TaskListQuery(
                    sawSnapshot = saw,
                    selectedWorkspaceId = selection?.selectedId,
                    workspaceCount = workspaces.size,
                    tasksInWorkspace = base.size,
                    chip = chip,
                    chipCount = byChip.size,
                    query = searchQuery,
                    matchedCount = if (chip == TaskChip.ARCHIVE) visibleArchive.size else rendered.cards.size,
                    archiveSupported = archiveSupportedNow,
                    archiveScopeUnsupported = scopeUnsupported,
                    archiveBusy = holder?.archiveBusy == true,
                    archiveLoadedInScope = confirmed != null,
                    archiveLoadedCount = confirmed?.size ?: 0,
                    archiveError = holder?.archiveError,
                ),
        )
        val filterEmpty = if (chip == TaskChip.ARCHIVE) {
            taskListEmptyCopy(archiveEmpty, englishUi, holder?.archiveError)
        } else {
            taskListEmptyCopy(rendered.empty, englishUi, holder?.archiveError)
        }
        val sessions = sessions().map { item ->
            val itemPill = pillCopy(pillFor(item), slot(item.sessionId).snapshotAt, englishUi).primary
            val secret = disk.credentials[item.credentialId]
            SessionRow(
                sessionId = item.sessionId,
                displayName = item.displayName,
                subtitle = secret?.let { cardSubtitle(it.httpBase, item.boardId) } ?: item.boardId,
                relayUrl = secret?.wsUrl.orEmpty(),
                pill = itemPill,
                expiresAt = secret?.expiresAt,
                active = item.sessionId == activeId,
            )
        }
        val taskId = (screen as? Screen.Detail)?.taskId
        _state.value = _state.value.copy(
            screen = screen,
            httpBase = _state.value.httpBase.ifBlank { disk.defaultHttpBase },
            deviceName = disk.deviceName,
            paired = sessions.isNotEmpty(),
            secureStore = disk.secretsReadable,
            expiresAt = session?.let { disk.credentials[it.credentialId]?.expiresAt },
            sessions = sessions,
            activeSessionId = activeId,
            connection = if (screen == Screen.Reading) zh(MIGRATION_READING, "Reading paired boards") else copy?.primary.orEmpty(),
            pillDetail = copy?.updated,
            cacheSentence = copy?.extra,
            tasks = rows,
            logs = if (holder == null || taskId == null) emptyList() else holder.view.logs[taskId].orEmpty(),
            selectedTaskId = (screen as? Screen.Detail)?.taskId,
            banner = banner,
            commandNote = commandNote,
            formError = formError,
            busy = busy,
            createMode = modeFor(session, "cmd.create", null),
            stopMode = modeFor(session, "cmd.stop", taskId),
            continueMode = modeFor(session, "cmd.continue", taskId),
            stopResend = explicitResendAllowed("cmd.stop", settled(session, "cmd.stop", taskId)),
            continueResend = explicitResendAllowed("cmd.continue", settled(session, "cmd.continue", taskId)),
            workspaces = view?.workspaces.orEmpty(),
            selectedWorkspaceId = selection?.selectedId,
            workspaceCreateMode = modeFor(session, "cmd.workspace.create", null),
            workspaceDeleteMode = modeFor(session, "cmd.workspace.delete", selection?.selectedId),
            worktreeEnabled = freshWorktree(_state.value.draftCwd, view?.workspaces.orEmpty(), holder?.view?.needsResync == true),
            continuePrompt = holder?.continuePrompt.orEmpty(),
            continueOpen = holder?.continueOpen == true,
            quickPrompts = if (session != null && CAP_BOARD_SETTINGS in capabilities(session)) holder?.quickPrompts.orEmpty() else emptyList(),
            settingsLoaded = holder?.settingsLoaded == true,
            canPop = backStack.isNotEmpty(),
            sawSnapshot = saw,
            chip = chip,
            searchQuery = searchQuery,
            filterEmpty = filterEmpty,
            archiveTasks = confirmed.orEmpty(),
            archiveVisible = visibleArchive,
            archiveInScope = confirmed != null,
            archiveNextCursor = holder?.archiveCursor,
            archiveLoaded = holder?.archiveLoaded == true,
            archiveStale = holder?.archiveStale == true,
            archiveBusy = holder?.archiveBusy == true,
            archiveError = holder?.archiveError,
            archiveSupported = archiveSupportedNow,
            archiveWrite = session != null && CAP_ARCHIVE_WRITE in capabilities(session),
            detailArchived = holder?.detailArchived == true,
            archiveDetail = holder?.archiveDetail,
            forgetEnabled = forgetEnabled(sessions.size),
            writesAllowed = session?.let { pillFor(it).writesAllowed } == true,
            settingsBlocked = holder?.settingsBlocked,
            workspaceForm = holder?.workspaceForm,
            reading = screen == Screen.Reading,
            createdHidden = _state.value.createdHidden,
        )
        armProofs()
    }

    private fun pillFor(session: PhoneSession): LinkPill {
        val holder = slot(session.sessionId)
        val live = lives[session.credentialId]
        val needs = resyncAfterList(holder.appliedGeneration, holder.proof?.listedGeneration, holder.view.needsResync, holder.view.sawSnapshot)
        return linkPill(
            LinkInput(
                phase = live?.phase ?: SocketPhase.CLOSED,
                currentEpoch = live?.epoch ?: 0,
                proof = holder.proof,
                appliedGeneration = holder.appliedGeneration,
                needsResync = needs,
                sawSnapshot = holder.view.sawSnapshot,
                snapshotAt = holder.snapshotAt,
                workspaceCount = holder.view.workspaces.size,
                unassignedCount = unassignedTasks(holder.view.tasks, holder.view.workspaces).size,
                suppressConnected = live?.suppressConnected == true,
                now = clock(),
            ),
        )
    }

    private fun freshWorktree(cwd: String, spaces: List<ThinWorkspace>, needsResync: Boolean): Boolean {
        val session = session(activeId) ?: return false
        val live = lives[session.credentialId]
        val online = live?.phase == SocketPhase.AUTHENTICATED && pillFor(session).writesAllowed
        return worktreeAllowedFresh(cwd, spaces, online, needsResync, slot(session.sessionId).eligibilityFresh)
    }

    private fun currentPillNeedsResync(): Boolean = activeId?.let { slot(it).view.needsResync } == true

    private fun modeFor(session: PhoneSession?, cmd: String, taskId: String?): String {
        if (session == null) return "send"
        if (slot(session.sessionId).inflight != null) return "busy"
        return when (settled(session, cmd, taskId)?.retry) {
            Retry.LookupOnly -> "lookup"
            Retry.ReuseSameKey -> "reuse"
            else -> "send"
        }
    }

    private fun settled(session: PhoneSession?, cmd: String, taskId: String?): CommandInterpretation? {
        if (session == null) return null
        return slot(session.sessionId).settled[actionKey(session.sessionId, cmd, taskId)]?.interpretation
    }

    private fun clearSettled(cmd: String, taskId: String?) {
        val session = session(activeId) ?: return
        if (slot(session.sessionId).inflight != null) return
        slot(session.sessionId).settled.remove(actionKey(session.sessionId, cmd, taskId))
        render()
    }

    private fun resend(cmd: String) {
        val session = session(activeId) ?: return
        val taskId = _state.value.selectedTaskId ?: return
        if (!explicitResendAllowed(cmd, settled(session, cmd, taskId))) return
        slot(session.sessionId).settled.remove(actionKey(session.sessionId, cmd, taskId))
        submit(cmd, session, taskId)
    }

    private fun capabilities(session: PhoneSession): List<String> = slot(session.sessionId).capabilities

    private fun activeTask(): RelayTask? {
        val id = _state.value.selectedTaskId ?: (screen as? Screen.Detail)?.taskId ?: return null
        return _state.value.tasks.find { it.id == id } ?: slot(activeId)?.view?.tasks?.find { it.id == id }
    }

    private fun routeInput(
        credentialId: String,
        epoch: Long,
        live: LiveSocket,
        message: tech.mengfei.agentboard.protocol.Envelope,
        kind: FrameKind,
    ) = RouteInput(
        kind = kind,
        credentialId = credentialId,
        socketEpoch = epoch,
        currentEpoch = live.epoch,
        boardId = message.text("boardId"),
        ref = message.text("ref"),
        taskId = message.text("taskId"),
        refs = refs,
        sessions = sessions(),
        helloBoardIds = live.helloBoardIds,
        subscribedBoardIds = live.subscribed,
        logBinding = live.log,
    )

    private fun frameKind(type: String): FrameKind = when (type) {
        "ack", "err" -> FrameKind.ACK
        "evt.snapshot" -> FrameKind.SNAPSHOT
        "evt.task" -> FrameKind.TASK
        "evt.gap" -> FrameKind.GAP
        "evt.log" -> FrameKind.LOG
        "evt.task.done" -> FrameKind.DONE
        else -> FrameKind.OTHER
    }

    private fun sessions(): List<PhoneSession> = readableSessions(disk)
    private fun sessionCount(): Int = sessions().size
    private fun session(id: String?): PhoneSession? = id?.let { disk.catalog?.session(it) }
    private fun sessionsOn(credentialId: String) = sessions().filter { it.credentialId == credentialId }

    private fun slot(sessionId: String?): Slot {
        val id = sessionId ?: ""
        return slots.getOrPut(id) {
            Slot(BoardReducer(doneDedupe = doneDedupe), BoardView(session(id)?.boardId.orEmpty()))
        }
    }

    private fun push(next: Screen) {
        if (screen != next) backStack.addLast(screen)
        screen = next
        render()
    }

    private fun actionKey(sessionId: String, cmd: String, taskId: String?) = "$sessionId\u0000$cmd\u0000${taskId.orEmpty()}"

    private fun say(text: String): String = localize(englishUi, text)
    private fun zh(chinese: String, english: String) = if (englishUi) english else chinese

    private fun newLocalId(prefix: String) = prefix + UUID.randomUUID().toString().replace("-", "").take(16)

    override fun onCleared() {
        pollJob?.cancel()
        proofJobs.values.forEach { it.cancel() }
        lives.values.forEach { it.job?.cancel() }
        relay.closeAll()
    }

    private fun MutableStateFlow<UiState>.updateCopy(block: UiState.() -> UiState) {
        value = value.block()
    }

    private class LiveSocket {
        var epoch: Long = 0
        var phase: SocketPhase = SocketPhase.CLOSED
        var backoff: Long = 1_000
        var listRef: String? = null
        var helloRef: String? = null
        var helloBoardIds: Set<String> = emptySet()
        var subscribed: Set<String> = emptySet()
        var log: LogBinding? = null
        var suppressConnected: Boolean = false
        var job: Job? = null
    }

    private class Slot(val reducer: BoardReducer, var view: BoardView) {
        var appliedGeneration: Long? = null
        var proof: BoardProof? = null
        var snapshotAt: Long? = null
        var capabilities: List<String> = emptyList()
        var eligibilityFresh: Boolean = false
        var epoch: Int = 0
        var pendingDetail: tech.mengfei.agentboard.protocol.DetailRequest? = null
        var pendingArchive: ArchiveHold? = null
        var archiveTasks: List<RelayTask> = emptyList()
        var archiveCursor: String? = null
        var archiveLoaded = false
        var archiveScopeSession: String? = null
        var archiveScopeWorkspace: String? = null
        var archiveStale = false
        var archiveBusy = false
        var archiveError: String? = null
        var archiveDetail: RelayTask? = null
        var detailArchived = false
        var continuePrompt: String = ""
        var continueOpen: Boolean = false
        var inflight: Inflight? = null
        val settled = mutableMapOf<String, Settled>()
        var workspaceForm: WorkspaceSettingsForm? = null
        var loadedWorkspace: WorkspaceSettingsForm? = null
        var workspaceDirty: Boolean = false
        var quickPrompts: List<QuickPromptChip> = emptyList()
        var settingsLoaded: Boolean = false
        var settingsBlocked: String? = null
        val resync = ResyncScheduler()
    }

    private data class ArchiveHold(val requestId: String, val reset: Boolean, val workspaceId: String)
    private data class Inflight(
        val action: String,
        val cmd: String,
        val session: PhoneSession,
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
