package tech.mengfei.agentboard.protocol

import java.util.Locale

const val NO_TASK_MATCH_COPY = "无匹配任务"
const val NO_TASKS_COPY = "当前工作区暂无任务"
const val NO_WORKSPACE_SELECTED_COPY = "当前没有工作区。"
const val ARCHIVE_LOADING_COPY = "正在加载归档…"
const val ARCHIVE_EMPTY_COPY = "没有归档任务"
const val ARCHIVE_UNAVAILABLE_COPY = "此看板暂不支持归档浏览。需要更新后的中继和看板连接。"
const val ARCHIVE_FAILED_COPY = "归档没有加载成功。"
const val ARCHIVE_UNLOADED_COPY = "没有归档任务"
const val ARCHIVE_NO_MATCH_COPY = "已加载的归档中无匹配任务"
const val SESSION_SAVED_COPY = "本机会话已保存"

/**
 * Local task search. Matches whatever title, id, prompt, or promptPreview is already on the row.
 * Does not fetch detail. Empty or whitespace query keeps the list as given.
 */
fun filterTasks(query: String, tasks: List<RelayTask>): List<RelayTask> {
    val needle = query.trim().lowercase(Locale.ROOT)
    if (needle.isEmpty()) return tasks
    return tasks.filter { task -> taskMatches(task, needle) }
}

private fun taskMatches(task: RelayTask, needle: String): Boolean {
    if (task.title.lowercase(Locale.ROOT).contains(needle)) return true
    if (task.id.lowercase(Locale.ROOT).contains(needle)) return true
    val prompt = task.prompt
    if (prompt != null && prompt.lowercase(Locale.ROOT).contains(needle)) return true
    val preview = task.promptPreview
    return preview != null && preview.lowercase(Locale.ROOT).contains(needle)
}

/** Workspace chips on the task list ignore the task query. */
fun workspaceChipsForTaskSearch(items: List<WorkspaceSwitchItem>, taskQuery: String): List<WorkspaceSwitchItem> = items

/**
 * Hot list pipeline: selected workspace, then status chip, then task query.
 * The archive chip is not this list.
 */
fun tasksAfterChipAndQuery(
    tasks: List<RelayTask>,
    workspaces: List<ThinWorkspace>,
    selectedWorkspaceId: String?,
    chip: TaskChip,
    query: String,
): List<RelayTask> {
    if (chip == TaskChip.ARCHIVE) return emptyList()
    // No selection wins over every supplied row. Do not rely on a later filter to drop them.
    if (selectedWorkspaceId == null) return emptyList()
    val inWorkspace = visibleTasks(tasks, workspaces, selectedWorkspaceId)
    return filterTasks(query, tasksForChip(inWorkspace, chip))
}

data class RenderedHotList(val cards: List<RelayTask>, val empty: TaskListEmpty)

/**
 * What the task screen is allowed to paint. A missing workspace selection yields no cards
 * even when [tasks] is nonempty and the query would have matched those rows.
 */
fun renderedHotList(
    tasks: List<RelayTask>,
    workspaces: List<ThinWorkspace>,
    selectedWorkspaceId: String?,
    chip: TaskChip,
    query: String,
    sawSnapshot: Boolean,
): RenderedHotList {
    if (selectedWorkspaceId == null) {
        val kind = when {
            !sawSnapshot -> TaskListEmpty.Loading
            workspaces.isEmpty() -> TaskListEmpty.NoWorkspaceBoard
            else -> TaskListEmpty.NoWorkspace
        }
        return RenderedHotList(emptyList(), kind)
    }
    val cards = tasksAfterChipAndQuery(tasks, workspaces, selectedWorkspaceId, chip, query)
    if (!sawSnapshot) {
        return RenderedHotList(cards, if (cards.isEmpty()) TaskListEmpty.Loading else TaskListEmpty.None)
    }
    val inWorkspace = visibleTasks(tasks, workspaces, selectedWorkspaceId)
    val byChip = tasksForChip(inWorkspace, chip)
    val kind = taskListEmpty(
        TaskListQuery(
            sawSnapshot = true,
            selectedWorkspaceId = selectedWorkspaceId,
            workspaceCount = workspaces.size,
            tasksInWorkspace = inWorkspace.size,
            chip = chip,
            chipCount = byChip.size,
            query = query,
            matchedCount = cards.size,
        ),
    )
    if (kind == TaskListEmpty.NoWorkspace || kind == TaskListEmpty.NoWorkspaceBoard) {
        return RenderedHotList(emptyList(), kind)
    }
    return RenderedHotList(cards, if (cards.isEmpty()) kind else TaskListEmpty.None)
}

/**
 * Rows the archive loader has already accepted for one session and one workspace.
 * A null result is not a searched archive: the caller must not say 「无匹配任务」.
 */
data class ArchiveLoadScope(
    val tasks: List<RelayTask>,
    val loaded: Boolean,
    val sessionId: String?,
    val workspaceId: String?,
    val activeSessionId: String?,
    val selectedWorkspaceId: String?,
)

fun confirmedArchiveTasks(scope: ArchiveLoadScope): List<RelayTask>? {
    if (!scope.loaded) return null
    val sessionId = scope.sessionId
    if (sessionId.isNullOrEmpty() || sessionId != scope.activeSessionId) return null
    val workspaceId = scope.workspaceId
    val selected = scope.selectedWorkspaceId
    if (workspaceId.isNullOrEmpty() || selected.isNullOrEmpty() || workspaceId != selected) return null
    if (!archivePageHonorsScope(scope.tasks, workspaceId)) return null
    return scope.tasks
}

fun archiveRowsForQuery(confirmed: List<RelayTask>?, query: String): List<RelayTask> {
    if (confirmed == null) return emptyList()
    return filterTasks(query, confirmed)
}

enum class TaskListEmpty {
    None,
    Loading,
    NoWorkspace,
    NoWorkspaceBoard,
    NoTasks,
    ChipEmpty,
    NoMatch,
    ArchiveUnsupported,
    ArchiveLoading,
    ArchiveFailed,
    ArchiveUnloaded,
    ArchiveEmpty,
    ArchiveNoMatch,
}

data class TaskListQuery(
    val sawSnapshot: Boolean,
    val selectedWorkspaceId: String?,
    val workspaceCount: Int,
    val tasksInWorkspace: Int,
    val chip: TaskChip,
    val chipCount: Int,
    val query: String,
    val matchedCount: Int,
    val archiveSupported: Boolean = true,
    val archiveScopeUnsupported: Boolean = false,
    val archiveBusy: Boolean = false,
    val archiveLoadedInScope: Boolean = false,
    val archiveLoadedCount: Int = 0,
    val archiveError: String? = null,
)

/**
 * C5 priority. No workspace wins even when task rows were passed in.
 * A status chip with zero rows is not 「无匹配任务」 just because a query is set.
 * Archive unsupported, loading, failed, and unloaded keep their own copy.
 */
fun taskListEmpty(input: TaskListQuery): TaskListEmpty {
    if (input.chip == TaskChip.ARCHIVE) return archiveEmpty(input)
    if (!input.sawSnapshot) return TaskListEmpty.Loading
    if (input.selectedWorkspaceId == null) return noWorkspace(input.workspaceCount)
    if (input.tasksInWorkspace == 0) return TaskListEmpty.NoTasks
    if (input.chipCount == 0) return TaskListEmpty.ChipEmpty
    if (input.query.trim().isNotEmpty() && input.matchedCount == 0) return TaskListEmpty.NoMatch
    if (input.matchedCount == 0) return TaskListEmpty.ChipEmpty
    return TaskListEmpty.None
}

private fun archiveEmpty(input: TaskListQuery): TaskListEmpty {
    if (!input.sawSnapshot && input.selectedWorkspaceId == null) return TaskListEmpty.Loading
    if (input.selectedWorkspaceId == null) return noWorkspace(input.workspaceCount)
    if (!input.archiveSupported || input.archiveScopeUnsupported) return TaskListEmpty.ArchiveUnsupported
    if (!input.archiveLoadedInScope) {
        if (input.archiveBusy) return TaskListEmpty.ArchiveLoading
        if (!input.archiveError.isNullOrBlank()) return TaskListEmpty.ArchiveFailed
        return TaskListEmpty.ArchiveUnloaded
    }
    if (input.archiveLoadedCount == 0) return TaskListEmpty.ArchiveEmpty
    if (input.query.trim().isNotEmpty() && input.matchedCount == 0) return TaskListEmpty.ArchiveNoMatch
    if (input.matchedCount == 0) return TaskListEmpty.ArchiveEmpty
    return TaskListEmpty.None
}

private fun noWorkspace(workspaceCount: Int): TaskListEmpty {
    return if (workspaceCount == 0) TaskListEmpty.NoWorkspaceBoard else TaskListEmpty.NoWorkspace
}

fun taskListEmptyCopy(kind: TaskListEmpty, english: Boolean = false, archiveError: String? = null): String? = when (kind) {
    TaskListEmpty.None -> null
    TaskListEmpty.Loading -> if (english) "Loading tasks…" else "正在加载任务…"
    TaskListEmpty.NoWorkspace -> if (english) "No workspace yet." else NO_WORKSPACE_SELECTED_COPY
    TaskListEmpty.NoWorkspaceBoard -> if (english) "This board has no workspaces yet." else NO_WORKSPACE_COPY
    TaskListEmpty.NoTasks -> if (english) "No tasks in this workspace" else NO_TASKS_COPY
    TaskListEmpty.ChipEmpty -> chipEmptyCopy(TaskChip.DONE, english)
    TaskListEmpty.NoMatch -> if (english) "No matching tasks" else NO_TASK_MATCH_COPY
    TaskListEmpty.ArchiveUnsupported -> archiveError?.takeIf { it.isNotBlank() }
        ?: if (english) "This board cannot list archived tasks yet." else ARCHIVE_UNAVAILABLE_COPY
    TaskListEmpty.ArchiveLoading -> if (english) "Loading archive…" else ARCHIVE_LOADING_COPY
    TaskListEmpty.ArchiveFailed -> archiveError?.takeIf { it.isNotBlank() }
        ?: if (english) "Could not load the archive." else ARCHIVE_FAILED_COPY
    TaskListEmpty.ArchiveUnloaded -> if (english) "No archived tasks" else ARCHIVE_UNLOADED_COPY
    TaskListEmpty.ArchiveEmpty -> if (english) "No archived tasks" else ARCHIVE_EMPTY_COPY
    TaskListEmpty.ArchiveNoMatch -> if (english) "No matches in the loaded archive" else ARCHIVE_NO_MATCH_COPY
}

fun withTaskQuery(chrome: ListChrome, query: String): ListChrome = chrome.copy(search = query)

fun selectWorkspaceChrome(chrome: ListChrome): ListChrome = chrome.copy(search = "")

enum class BoardPickPath { TopSwitcher, MyBoards }

data class PickedBoard(val path: BoardPickPath, val chrome: ListChrome, val workspaceId: String?)

/** Top switcher and 我的看板 share one selection result. */
fun pickBoard(
    path: BoardPickPath,
    chrome: ListChrome,
    target: PhoneSession,
    rememberedWorkspace: String?,
    workspaces: List<ThinWorkspace>,
    tasks: List<RelayTask>,
    sawSnapshot: Boolean,
): PickedBoard {
    val next = activateChrome(chrome, target, toast = true)
    val workspaceId = workspaceAfterSwitch(rememberedWorkspace, workspaces, tasks, sawSnapshot)
    return PickedBoard(path, next, workspaceId)
}

enum class ForgetDestination { TaskList, MyBoards, Unchanged }

fun forgetDestination(allowed: Boolean, forgotActive: Boolean, rolledBack: Boolean): ForgetDestination {
    if (!allowed || rolledBack) return ForgetDestination.Unchanged
    return if (forgotActive) ForgetDestination.TaskList else ForgetDestination.MyBoards
}

enum class PairApply { Land, KeepSelection }

/** A failed or superseded pair must not move the active board. */
fun pairResultApply(requestEpoch: Int, currentEpoch: Int, succeeded: Boolean): PairApply {
    if (!succeeded || requestEpoch != currentEpoch) return PairApply.KeepSelection
    return PairApply.Land
}

enum class PairDeparture { Back, BoardSwitch, Forget, Notification, LeftAdd }

data class PairContext(
    val epoch: Int,
    val activeSessionId: String?,
    val navToken: Int = 0,
    /** Pairing screen captured when the attempt started: "add" or "pair". */
    val screen: String = "",
)

/** Any departure from the pairing screen invalidates the in-flight pair. */
fun pairContextAfterDeparture(context: PairContext, departure: PairDeparture): PairContext {
    return when (departure) {
        PairDeparture.Back,
        PairDeparture.BoardSwitch,
        PairDeparture.Forget,
        PairDeparture.Notification,
        PairDeparture.LeftAdd,
        -> context.copy(epoch = context.epoch + 1, navToken = context.navToken + 1)
    }
}

fun pairAttemptStillCurrent(attempt: PairContext, now: PairContext): Boolean {
    return attempt.epoch == now.epoch &&
        attempt.navToken == now.navToken &&
        attempt.activeSessionId == now.activeSessionId &&
        attempt.screen == now.screen
}

data class DeferredPairSuccess(
    val applyTransaction: Boolean,
    val activeSessionId: String?,
    val successToast: Boolean,
)

/**
 * Decide a successful pair response before any catalog write.
 * A departure keeps the active board the user already has and does not toast success.
 */
fun deferredPairSuccess(
    attempt: PairContext,
    now: PairContext,
    proposedActiveId: String,
): DeferredPairSuccess {
    if (!pairAttemptStillCurrent(attempt, now)) {
        return DeferredPairSuccess(
            applyTransaction = false,
            activeSessionId = now.activeSessionId,
            successToast = false,
        )
    }
    return DeferredPairSuccess(
        applyTransaction = true,
        activeSessionId = proposedActiveId,
        successToast = true,
    )
}

data class AddPairSnapshot(
    val disk: PhoneDisk,
    val openSockets: Set<String>,
    val activeSessionId: String?,
    val screen: String,
    val banner: String?,
    val epoch: Int,
    val navToken: Int,
)

data class DeferredPairResult(
    val snapshot: AddPairSnapshot,
    val applied: Boolean,
    val successToast: Boolean,
)

/**
 * Same-session notification: active board stays, and the screen leaves Add for that task.
 * This is the BoardViewModel.openNotification path that does not call landOn.
 */
fun openNotificationSameSession(snapshot: AddPairSnapshot, taskId: String): AddPairSnapshot {
    return leaveAddScreen(snapshot, "detail:$taskId", PairDeparture.Notification)
}

/** Back, board switch, notification, or any other navigation off the pairing screen. */
fun leaveAddScreen(snapshot: AddPairSnapshot, nextScreen: String, departure: PairDeparture): AddPairSnapshot {
    if ((snapshot.screen != "add" && snapshot.screen != "pair") || nextScreen == snapshot.screen) {
        return snapshot.copy(screen = nextScreen)
    }
    val next = pairContextAfterDeparture(
        PairContext(snapshot.epoch, snapshot.activeSessionId, snapshot.navToken, snapshot.screen),
        departure,
    )
    return snapshot.copy(epoch = next.epoch, navToken = next.navToken, screen = nextScreen)
}

/**
 * Caller for a deferred pair HTTP success. Writes the catalog only while the attempt's
 * pairing screen is still showing. Otherwise the disk, active board, screen, and banner stay.
 */
fun completeDeferredPair(
    snapshot: AddPairSnapshot,
    attempt: PairContext,
    outcome: PairOutcome,
): DeferredPairResult {
    val now = PairContext(snapshot.epoch, snapshot.activeSessionId, snapshot.navToken, snapshot.screen)
    val proposed = (outcome as? PairOutcome.Proceed)?.activeSessionId ?: snapshot.activeSessionId.orEmpty()
    val effect = deferredPairSuccess(attempt, now, proposed)
    if (!effect.applyTransaction || outcome !is PairOutcome.Proceed || snapshot.screen != attempt.screen) {
        return DeferredPairResult(snapshot, applied = false, successToast = false)
    }
    val applied = simulate(snapshot.disk, snapshot.openSockets, outcome.tx)
    return DeferredPairResult(
        snapshot = snapshot.copy(
            disk = applied.disk,
            openSockets = applied.openSockets,
            activeSessionId = applied.activeSessionId,
            screen = "tasks",
            banner = switchedToast(outcome.toastName),
        ),
        applied = true,
        successToast = true,
    )
}

const val FORGET_CLEANUP_INCOMPLETE = "看板已从这台手机的列表里去掉，但本地缓存没有清完。"

enum class ForgetReport { RolledBack, Cleaned, CleanupIncomplete }

fun forgetCleanupDisposition(cleanupStillPending: Boolean): ForgetReport {
    return if (cleanupStillPending) ForgetReport.CleanupIncomplete else ForgetReport.Cleaned
}

fun forgetSuccessToast(report: ForgetReport): Boolean = report == ForgetReport.Cleaned

data class ForgetFollowThrough(
    val report: ForgetReport,
    val successToast: Boolean,
    val dropMemory: Boolean,
    val disk: PhoneDisk,
    val activeSessionId: String?,
    val message: String?,
)

/**
 * Catalog cutover can succeed while ClearLocals or a later cleanup step fails.
 * Retry the uncommitted tail. If that retry also fails, say so and do not toast success.
 * Other sessions' locals and credentials stay.
 */
fun forgetFollowThrough(
    start: PhoneDisk,
    openSockets: Set<String>,
    tx: Transaction,
    failAt: Int?,
    retryAlsoFails: Boolean = false,
): ForgetFollowThrough {
    val verdict = applyVerdict(start, openSockets, tx, failAt)
    return when (verdict) {
        is ApplyVerdict.RolledBack -> ForgetFollowThrough(
            report = ForgetReport.RolledBack,
            successToast = false,
            dropMemory = false,
            disk = verdict.disk,
            activeSessionId = verdict.activeSessionId,
            message = null,
        )
        is ApplyVerdict.InForce -> {
            if (!verdict.cleanupPending || failAt == null) {
                ForgetFollowThrough(
                    report = ForgetReport.Cleaned,
                    successToast = true,
                    dropMemory = true,
                    disk = verdict.disk,
                    activeSessionId = verdict.activeSessionId,
                    message = null,
                )
            } else if (!retryAlsoFails) {
                val retried = applyOps(verdict.disk, tx.steps.drop(failAt))
                ForgetFollowThrough(
                    report = forgetCleanupDisposition(cleanupStillPending = false),
                    successToast = true,
                    dropMemory = true,
                    disk = retried,
                    activeSessionId = verdict.activeSessionId,
                    message = null,
                )
            } else {
                ForgetFollowThrough(
                    report = forgetCleanupDisposition(cleanupStillPending = true),
                    successToast = forgetSuccessToast(ForgetReport.CleanupIncomplete),
                    dropMemory = true,
                    disk = verdict.disk,
                    activeSessionId = verdict.activeSessionId,
                    message = FORGET_CLEANUP_INCOMPLETE,
                )
            }
        }
    }
}

fun archiveReplyMatches(pendingRequestId: String?, messageRef: String?): Boolean {
    return !pendingRequestId.isNullOrEmpty() && messageRef == pendingRequestId
}

/**
 * Store an archive page only for the request that is still pending, and only when every row
 * belongs to that request's workspace. A late ref must not clear or replace the new request.
 */
fun acceptArchivePage(
    pendingRequestId: String?,
    messageRef: String?,
    tasks: List<RelayTask>,
    requestWorkspaceId: String,
): Boolean {
    if (!archiveReplyMatches(pendingRequestId, messageRef)) return false
    return archivePageHonorsScope(tasks, requestWorkspaceId)
}

data class LiveLog(val credentialId: String, val boardId: String)

data class ForgetMemory(
    val slotSessionIds: Set<String>,
    val refSessionIds: Set<String>,
    val logs: List<LiveLog>,
)

/** In-memory companion to [planForget]'s ClearLocals. Other sessions' slots, refs, and logs stay. */
fun forgetMemoryEffect(
    before: ForgetMemory,
    forgottenSessionId: String,
    forgottenCredentialId: String?,
    forgottenBoardId: String?,
): ForgetMemory {
    val logs = before.logs.filterNot { log ->
        forgottenCredentialId != null &&
            forgottenBoardId != null &&
            log.credentialId == forgottenCredentialId &&
            log.boardId == forgottenBoardId
    }
    return ForgetMemory(
        slotSessionIds = before.slotSessionIds - forgottenSessionId,
        refSessionIds = before.refSessionIds - forgottenSessionId,
        logs = logs,
    )
}
