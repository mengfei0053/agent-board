package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

val TASK_STATUSES = setOf("queued", "running", "paused", "succeeded", "failed", "stopped")
val TERMINAL_STATUSES = setOf("succeeded", "failed", "stopped")

data class RelayTurn(
    val iteration: Int,
    val prompt: String? = null,
    val output: String? = null,
    val at: Long? = null,
)

data class RelaySideJob(
    val id: String,
    val kind: String,
    val title: String,
    val status: String,
    val summary: String? = null,
    val toolName: String? = null,
)

data class RelayTask(
    val id: String,
    val title: String,
    val status: String,
    val updatedAt: Long,
    val agent: String? = null,
    val workspaceId: String? = null,
    val iteration: Int? = null,
    val cwd: String? = null,
    val model: String? = null,
    val sessionId: String? = null,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val exitCode: Int? = null,
    val pid: Int? = null,
    val error: String? = null,
    val prompt: String? = null,
    val output: String? = null,
    val promptPreview: String? = null,
    val outputPreview: String? = null,
    val resumeCommand: String? = null,
    val worktreeBranch: String? = null,
    val promptTruncated: Boolean = false,
    val outputTruncated: Boolean = false,
    val detailFull: Boolean = false,
    val turns: List<RelayTurn>? = null,
    val sideJobs: List<RelaySideJob>? = null,
)

data class DetailRound(
    val iteration: Int,
    val kindLabel: String,
    val prompt: String?,
    val output: String?,
    val pending: Boolean,
)

data class LogLine(
    val eventId: String,
    val stream: String,
    val line: String,
    val seq: Long,
)

data class BoardInfo(
    val boardId: String,
    val label: String?,
    val online: Boolean,
    val generation: Long?,
)

data class ThinWorkspace(
    val id: String,
    val name: String,
    val path: String,
    val isGit: Boolean,
)

data class BoardView(
    val boardId: String,
    val tasks: List<RelayTask> = emptyList(),
    val logs: Map<String, List<LogLine>> = emptyMap(),
    val workspaces: List<ThinWorkspace> = emptyList(),
    val generation: Long? = null,
    val seq: Long? = null,
    val needsResync: Boolean = false,
)

data class DoneNotice(
    val eventId: String,
    val boardId: String,
    val taskId: String,
    val status: String,
    val title: String?,
    val summary: String?,
)

sealed interface ApplyOutcome {
    val view: BoardView

    data class Applied(override val view: BoardView, val notice: DoneNotice? = null) : ApplyOutcome
    data class Resync(override val view: BoardView, val reason: String) : ApplyOutcome
    data class Ignored(override val view: BoardView) : ApplyOutcome
}

/**
 * Applies relay events for one selected board.
 * evt.task.done notifications are deduped by eventId for the current generation.
 * Snapshots always apply, including a resync of a snapshot the phone already saw.
 * Log lines are deduped by eventId so a replay does not double the tail.
 */
class BoardReducer(
    private val doneDedupe: EventIdDeduper = EventIdDeduper(),
    private val logDedupe: EventIdDeduper = EventIdDeduper(),
    private val logTail: Int = 200,
) {
    /** Set by evt.gap. A later snapshot clears it only when the cursor moves past the hole. */
    private var gapMark: GapMark? = null
    fun apply(view: BoardView, message: Envelope): ApplyOutcome {
        val payload = message.payload
        val eventBoard = payload.text("boardId")
        return when (message.type) {
            "evt.snapshot" -> applySnapshot(view, payload, eventBoard)
            "evt.task" -> applyTask(view, payload, eventBoard)
            "evt.log" -> applyLog(view, payload, eventBoard)
            "evt.task.done" -> applyDone(view, payload, eventBoard)
            "evt.gap" -> applyGap(view, payload, eventBoard)
            else -> ApplyOutcome.Ignored(view)
        }
    }

    private fun applySnapshot(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Ignored(view)
        val generation = payload.longValue("generation")
        val generationChanged = generation != null && view.generation != null && generation != view.generation
        if (generationChanged) logDedupe.clear()
        val tasks = readTaskList(payload["tasks"])
        val seq = payload.longValue("seq") ?: payload.longValue("version")
        val stale = snapshotStillStale(generation, seq)
        return ApplyOutcome.Applied(view.copy(
            tasks = tasks.sortedByDescending { it.updatedAt },
            logs = if (generationChanged) emptyMap() else view.logs,
            workspaces = readWorkspaces(payload),
            generation = generation ?: view.generation,
            seq = seq ?: view.seq,
            needsResync = stale,
        ))
    }

    private fun applyTask(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Ignored(view)
        val task = payload.obj("task")?.let(::readTask) ?: return ApplyOutcome.Ignored(view)
        val generation = payload.longValue("generation")
        val seq = payload.longValue("seq")
        return ApplyOutcome.Applied(view.copy(
            tasks = upsert(view.tasks, task),
            generation = generation ?: view.generation,
            seq = seq ?: view.seq,
            needsResync = gapOpen(),
        ))
    }

    private fun applyLog(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Ignored(view)
        val eventId = payload.text("eventId").orEmpty()
        if (!logDedupe.claim(eventId)) return ApplyOutcome.Ignored(view)
        val taskId = payload.text("taskId") ?: return ApplyOutcome.Ignored(view)
        val line = payload.text("line") ?: return ApplyOutcome.Ignored(view)
        val entry = LogLine(
            eventId = eventId,
            stream = payload.text("stream") ?: "system",
            line = line,
            seq = payload.longValue("seq") ?: 0,
        )
        val appended = (view.logs[taskId].orEmpty() + entry).takeLast(logTail)
        val generation = payload.longValue("generation")
        val seq = payload.longValue("seq")
        return ApplyOutcome.Applied(view.copy(
            logs = view.logs + (taskId to appended),
            generation = generation ?: view.generation,
            seq = seq ?: view.seq,
            needsResync = gapOpen(),
        ))
    }

    private fun applyDone(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        val eventId = payload.text("eventId").orEmpty()
        if (!doneDedupe.claim(eventId)) return ApplyOutcome.Ignored(view)
        val taskId = payload.text("taskId") ?: return ApplyOutcome.Ignored(view)
        val status = payload.text("status") ?: return ApplyOutcome.Ignored(view)
        if (status !in TERMINAL_STATUSES) return ApplyOutcome.Ignored(view)
        val title = payload.text("title")
        val notice = DoneNotice(
            eventId = eventId,
            boardId = eventBoard ?: view.boardId,
            taskId = taskId,
            status = status,
            title = title,
            summary = payload.text("summary"),
        )
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Applied(view, notice)
        val existing = view.tasks.find { it.id == taskId }
        val updated = when {
            existing != null -> existing.copy(status = status, title = title ?: existing.title)
            title != null -> RelayTask(taskId, title, status, payload.longValue("seq") ?: 0)
            else -> null
        }
        val generation = payload.longValue("generation")
        val seq = payload.longValue("seq")
        return ApplyOutcome.Applied(view.copy(
            tasks = if (updated != null) upsert(view.tasks, updated) else view.tasks,
            generation = generation ?: view.generation,
            seq = seq ?: view.seq,
            needsResync = gapOpen(),
        ), notice)
    }

    private fun applyGap(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Ignored(view)
        val reason = payload.text("reason") ?: "seq_gap"
        gapMark = GapMark(
            generation = payload.longValue("generation") ?: view.generation,
            expectedSeq = payload.longValue("expectedSeq") ?: ((view.seq ?: 0L) + 1L),
        )
        return ApplyOutcome.Resync(view.copy(needsResync = true), reason)
    }

    /** Incremental events never close a gap. Only a recovery snapshot does. */
    private fun gapOpen(): Boolean = gapMark != null

    /**
     * The snapshot replayed with evt.gap is the cached pre-gap list.
     * Close the gap only when this snapshot's seq covers the hole, or the board generation changed.
     */
    private fun snapshotStillStale(generation: Long?, seq: Long?): Boolean {
        val mark = gapMark ?: return false
        val newGeneration = generation != null && mark.generation != null && generation != mark.generation
        val coversGap = seq != null && seq >= mark.expectedSeq
        if (newGeneration || coversGap) {
            gapMark = null
            return false
        }
        return true
    }

    private fun sameBoard(view: BoardView, eventBoard: String?): Boolean {
        if (eventBoard == null || view.boardId.isEmpty()) return true
        return eventBoard == view.boardId
    }
}

class EventIdDeduper(private val capacity: Int = 500) {
    private val seen = LinkedHashSet<String>()

    fun claim(eventId: String): Boolean {
        if (eventId.isBlank()) return false
        if (!seen.add(eventId)) return false
        while (seen.size > capacity) {
            val oldest = seen.iterator().next()
            seen.remove(oldest)
        }
        return true
    }

    fun clear() {
        seen.clear()
    }

    fun size(): Int = seen.size
}

/** Empty id is the phone-local「未分配」bucket. It is not a board workspace id. */
const val UNASSIGNED_WORKSPACE_ID = ""
const val UNASSIGNED_LABEL = "未分配"

private val workspaceIdPattern = Regex("^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$")

fun isWorkspaceId(value: String): Boolean = workspaceIdPattern.matches(value)

data class WorkspaceSwitchItem(
    val id: String,
    val label: String,
    val path: String?,
)

data class WorkspaceBanner(
    val title: String,
    val detail: String?,
)

fun readTask(obj: JsonObject): RelayTask? {
    val id = obj.text("id") ?: return null
    val title = obj.text("title") ?: return null
    val status = obj.text("status") ?: return null
    if (status !in TASK_STATUSES) return null
    val updatedAt = obj.longValue("updatedAt") ?: return null
    return RelayTask(
        id = id,
        title = title,
        status = status,
        updatedAt = updatedAt,
        agent = obj.text("agent"),
        workspaceId = readWorkspaceId(obj),
        iteration = obj.intValue("iteration"),
        cwd = obj.text("cwd"),
        model = obj.text("model"),
        sessionId = obj.text("sessionId"),
        startedAt = obj.longValue("startedAt"),
        endedAt = obj.longValue("endedAt"),
        exitCode = obj.intValue("exitCode"),
        pid = obj.intValue("pid"),
        error = obj.text("error"),
        prompt = obj.text("prompt"),
        output = obj.text("output"),
        promptPreview = obj.text("promptPreview"),
        outputPreview = obj.text("outputPreview"),
        resumeCommand = obj.text("resumeCommand"),
        worktreeBranch = obj.text("worktreeBranch"),
        promptTruncated = obj.bool("promptTruncated") == true,
        outputTruncated = obj.bool("outputTruncated") == true,
        detailFull = obj.text("detail") == "full",
        turns = readTurns(obj),
        sideJobs = readSideJobs(obj),
    )
}

/**
 * A snapshot row omits `detail: "full"`. Keep the richer card already loaded
 * for this task. A full frame replaces prompts, replies, and side jobs.
 */
fun mergeRelayTask(previous: RelayTask?, incoming: RelayTask): RelayTask {
    if (previous == null || previous.id != incoming.id) return incoming
    if (incoming.detailFull) {
        return incoming.copy(
            promptPreview = incoming.promptPreview ?: previous.promptPreview,
            outputPreview = incoming.outputPreview ?: previous.outputPreview,
        )
    }
    return incoming.copy(
        prompt = previous.prompt,
        output = previous.output,
        turns = previous.turns,
        sideJobs = previous.sideJobs,
        detailFull = previous.detailFull,
        promptTruncated = previous.promptTruncated || incoming.promptTruncated,
        outputTruncated = previous.outputTruncated || incoming.outputTruncated,
    )
}

fun statusLabel(status: String): String = when (status) {
    "queued" -> "Todo"
    "running" -> "进行中"
    "paused" -> "等待确认"
    "succeeded" -> "成功"
    "failed" -> "失败"
    "stopped" -> "已停止"
    else -> status
}

fun canStopStatus(status: String): Boolean = status == "queued" || status == "running" || status == "paused"

/** Web continue is hidden for draft and disabled while queued or running. Paused (blocked) can continue. */
fun canContinueStatus(status: String): Boolean = status != "queued" && status != "running"

fun continueHint(task: RelayTask): String {
    if (!canContinueStatus(task.status)) return "任务运行中，请先停止再继续"
    val session = task.sessionId
    return if (!session.isNullOrBlank()) "将续会话 $session" else "无 sessionId 时将尝试 CLI continue（同目录最近会话）"
}

fun resumeCommandLabel(task: RelayTask): String {
    val command = task.resumeCommand
    if (!command.isNullOrBlank()) return command
    return if (task.sessionId.isNullOrBlank()) "尚无会话" else "—"
}

fun detailPrompt(task: RelayTask): String? = task.prompt ?: task.promptPreview

fun detailRounds(task: RelayTask): List<DetailRound> {
    val turns = task.turns
    if (!turns.isNullOrEmpty()) {
        val live = task.status == "queued" || task.status == "running" || task.status == "paused"
        val current = task.iteration
        return turns.map { turn ->
            DetailRound(
                iteration = turn.iteration,
                kindLabel = if (turn.iteration <= 1) "初始" else "继续",
                prompt = turn.prompt,
                output = turn.output,
                pending = live && turn.iteration == current && turn.output.isNullOrBlank(),
            )
        }
    }
    val prompt = detailPrompt(task)
    val output = task.output ?: task.outputPreview
    if (prompt.isNullOrBlank() && output.isNullOrBlank()) return emptyList()
    val iteration = task.iteration ?: 1
    val live = task.status == "queued" || task.status == "running" || task.status == "paused"
    return listOf(DetailRound(iteration, if (iteration <= 1) "初始" else "继续", prompt, output, live && output.isNullOrBlank()))
}

fun detailError(task: RelayTask): String? {
    val hasOutput = !task.output.isNullOrBlank() || !task.outputPreview.isNullOrBlank() ||
        task.turns?.any { !it.output.isNullOrBlank() } == true
    if (task.status != "failed" && !(task.status == "stopped" && !hasOutput)) return null
    val bits = mutableListOf<String>()
    if (!task.error.isNullOrBlank()) bits.add(task.error)
    if (task.exitCode != null && task.exitCode != 0) bits.add("退出码 ${task.exitCode}")
    if (bits.isEmpty()) bits.add(if (task.status == "stopped") "已由用户停止" else "任务失败")
    return bits.joinToString("\n")
}

private fun readTurns(obj: JsonObject): List<RelayTurn>? {
    if ("turns" !in obj) return null
    val array = obj.array("turns") ?: return null
    return array.mapNotNull { item ->
        val row = item as? JsonObject ?: return@mapNotNull null
        val iteration = row.intValue("iteration") ?: return@mapNotNull null
        RelayTurn(iteration, row.text("prompt"), row.text("output"), row.longValue("at"))
    }
}

private fun readSideJobs(obj: JsonObject): List<RelaySideJob>? {
    if ("sideJobs" !in obj) return null
    val array = obj.array("sideJobs") ?: return null
    return array.mapNotNull { item ->
        val row = item as? JsonObject ?: return@mapNotNull null
        val id = row.text("id") ?: return@mapNotNull null
        val title = row.text("title") ?: return@mapNotNull null
        val status = row.text("status") ?: return@mapNotNull null
        RelaySideJob(id, row.text("kind") ?: "other", title, status, row.text("summary"), row.text("toolName"))
    }
}

/**
 * A missing or unusable `workspaceId` is unassigned.
 * An omitted field and a malformed field both parse; the task is not dropped.
 */
fun readWorkspaceId(obj: JsonObject): String? {
    if ("workspaceId" !in obj) return null
    val id = obj.text("workspaceId") ?: return null
    if (!isWorkspaceId(id)) return null
    return id
}

fun readThinWorkspace(obj: JsonObject): ThinWorkspace? {
    val id = obj.text("id") ?: return null
    val name = obj.text("name") ?: return null
    val path = obj.text("path") ?: return null
    val isGit = obj.bool("isGit") ?: return null
    if (!isWorkspaceId(id) || name.isBlank() || path.isBlank() || "://" in path) return null
    return ThinWorkspace(id, name, path, isGit)
}

fun unassignedTasks(tasks: List<RelayTask>, workspaces: List<ThinWorkspace>): List<RelayTask> {
    val known = workspaces.mapTo(HashSet()) { it.id }
    return tasks.filter { task ->
        val id = task.workspaceId
        id.isNullOrBlank() || id !in known
    }
}

/** Tasks for the web-style selected workspace. `null` shows nothing. `""` is 「未分配」. */
fun visibleTasks(tasks: List<RelayTask>, workspaces: List<ThinWorkspace>, selectedId: String?): List<RelayTask> {
    if (selectedId == null) return emptyList()
    if (selectedId == UNASSIGNED_WORKSPACE_ID) return unassignedTasks(tasks, workspaces)
    return tasks.filter { it.workspaceId == selectedId }
}

fun workspaceSwitchItems(tasks: List<RelayTask>, workspaces: List<ThinWorkspace>): List<WorkspaceSwitchItem> {
    val items = workspaces.map { WorkspaceSwitchItem(it.id, it.name, it.path) }
    if (unassignedTasks(tasks, workspaces).isEmpty()) return items
    return items + WorkspaceSwitchItem(UNASSIGNED_WORKSPACE_ID, UNASSIGNED_LABEL, null)
}

/**
 * Keep an explicit selection when it still exists.
 * A missing selection prefers the first workspace that has tasks, then 「未分配」,
 * then the first workspace. That matches the web board's single-workspace view
 * without hiding every task in an empty workspace.
 */
fun resolveWorkspaceSelection(
    current: String?,
    workspaces: List<ThinWorkspace>,
    tasks: List<RelayTask>,
): String? {
    if (current == UNASSIGNED_WORKSPACE_ID && unassignedTasks(tasks, workspaces).isNotEmpty()) {
        return UNASSIGNED_WORKSPACE_ID
    }
    if (current != null && workspaces.any { it.id == current }) return current
    val withTasks = workspaces.firstOrNull { workspace -> tasks.any { it.workspaceId == workspace.id } }
    if (withTasks != null) return withTasks.id
    if (unassignedTasks(tasks, workspaces).isNotEmpty()) return UNASSIGNED_WORKSPACE_ID
    if (workspaces.isNotEmpty()) return workspaces.first().id
    return null
}

fun workspaceBanner(selectedId: String?, workspaces: List<ThinWorkspace>): WorkspaceBanner {
    if (selectedId == null) return WorkspaceBanner("未选择工作区", "请新建或选择工作区")
    if (selectedId == UNASSIGNED_WORKSPACE_ID) return WorkspaceBanner(UNASSIGNED_LABEL, "这些任务没有对应的工作区")
    val workspace = workspaces.find { it.id == selectedId } ?: return WorkspaceBanner("未选择工作区", "请新建或选择工作区")
    return WorkspaceBanner(workspace.name, workspace.path)
}

/** Web detail uses the workspace name. A missing id is 「未分配」. */
fun workspaceDisplayName(workspaceId: String?, workspaces: List<ThinWorkspace>): String {
    if (workspaceId.isNullOrBlank()) return UNASSIGNED_LABEL
    return workspaces.find { it.id == workspaceId }?.name ?: UNASSIGNED_LABEL
}

/** Opening New task copies the selected workspace path unless the user already typed another cwd. */
fun cwdForNewTask(currentCwd: String, selectedPath: String?, workspacePaths: Collection<String>): String {
    if (selectedPath == null) return currentCwd
    val trimmed = currentCwd.trim()
    if (trimmed.isEmpty() || trimmed in workspacePaths) return selectedPath
    return currentCwd
}

/** Send `workspaceId` only while cwd is still that workspace path, matching web create. */
fun workspaceIdForCreate(cwd: String, selectedId: String?, selectedPath: String?): String? {
    if (selectedId.isNullOrEmpty() || selectedPath == null) return null
    if (cwd.trim() != selectedPath) return null
    return selectedId
}

fun worktreeAllowed(cwd: String, workspaces: List<ThinWorkspace>): Boolean {
    if (cwd.isEmpty()) return false
    return workspaces.any { it.isGit && it.path == cwd }
}

/**
 * Workspace eligibility is usable only from a non-stale snapshot while the phone is online.
 * Disconnect and evt.gap both make the last isGit bit unusable.
 */
fun worktreeAllowedFresh(
    cwd: String,
    workspaces: List<ThinWorkspace>,
    online: Boolean,
    needsResync: Boolean,
    eligibilityFresh: Boolean,
): Boolean {
    if (!online || needsResync || !eligibilityFresh) return false
    return worktreeAllowed(cwd, workspaces)
}

/**
 * Phone-side worktree checkbox. Checked state is cleared whenever eligibility is not fresh.
 */
data class WorktreeSession(
    val cwd: String,
    val workspaces: List<ThinWorkspace> = emptyList(),
    val checked: Boolean = false,
    val online: Boolean = false,
    val needsResync: Boolean = false,
    val eligibilityFresh: Boolean = false,
) {
    val allowed: Boolean
        get() = worktreeAllowedFresh(cwd, workspaces, online, needsResync, eligibilityFresh)

    fun check(): WorktreeSession = copy(checked = allowed)

    fun disconnect(): WorktreeSession = copy(online = false, eligibilityFresh = false, checked = false)

    fun gap(): WorktreeSession = copy(needsResync = true, eligibilityFresh = false, checked = false)

    fun switchBoard(): WorktreeSession = copy(
        workspaces = emptyList(),
        checked = false,
        needsResync = false,
        eligibilityFresh = false,
    )

    /** The socket is authenticated again. The previous workspace list is still stale. */
    fun hello(): WorktreeSession = copy(online = true)

    fun snapshot(next: List<ThinWorkspace>, stillStale: Boolean): WorktreeSession {
        val updated = copy(
            workspaces = next,
            needsResync = stillStale,
            eligibilityFresh = online && !stillStale,
        )
        return updated.copy(checked = updated.checked && updated.allowed)
    }
}

fun workspaceListKey(workspaces: List<ThinWorkspace>): String {
    return workspaces.joinToString("\n") { "${it.id}\u0000${it.path}\u0000${it.isGit}" }
}

/** A workspace-list change or a cwd that is not a git root forces the checkbox off. */
fun keptWorktreeChoice(checked: Boolean, cwd: String, workspaces: List<ThinWorkspace>, previousKey: String): Boolean {
    if (workspaceListKey(workspaces) != previousKey) return false
    return checked && worktreeAllowed(cwd, workspaces)
}

fun readWorkspaces(payload: JsonObject): List<ThinWorkspace> {
    if ("workspaces" !in payload) return emptyList()
    val array = payload.array("workspaces") ?: return emptyList()
    if (array.size > 50) return emptyList()
    val rows = ArrayList<ThinWorkspace>(array.size)
    for (item in array) {
        val obj = item as? JsonObject ?: return emptyList()
        val id = obj.text("id") ?: return emptyList()
        val name = obj.text("name") ?: return emptyList()
        val path = obj.text("path") ?: return emptyList()
        val isGit = obj.bool("isGit") ?: return emptyList()
        if (id.isBlank() || name.isBlank() || path.isBlank() || "://" in path) return emptyList()
        rows.add(ThinWorkspace(id, name, path, isGit))
    }
    return rows
}

fun readTaskList(element: JsonElement?): List<RelayTask> {
    val array = element as? JsonArray ?: return emptyList()
    return array.mapNotNull { (it as? JsonObject)?.let(::readTask) }
}

fun parseBoardList(payload: JsonObject): List<BoardInfo>? {
    if ("boards" !in payload) return null
    val array = payload.array("boards") ?: return emptyList()
    return array.mapNotNull { item ->
        val obj = item as? JsonObject ?: return@mapNotNull null
        val boardId = obj.text("boardId") ?: return@mapNotNull null
        val online = obj.bool("online") ?: return@mapNotNull null
        BoardInfo(boardId, obj.text("label"), online, obj.longValue("generation"))
    }
}

fun BoardView.withLocalTask(task: RelayTask): BoardView {
    return copy(tasks = upsert(tasks, task))
}

fun BoardView.withWorkspace(workspace: ThinWorkspace): BoardView {
    val index = workspaces.indexOfFirst { it.id == workspace.id }
    if (index < 0) return copy(workspaces = workspaces + workspace)
    val next = workspaces.toMutableList()
    next[index] = workspace
    return copy(workspaces = next)
}

fun BoardView.withoutWorkspace(id: String): BoardView {
    return copy(workspaces = workspaces.filterNot { it.id == id })
}

private fun upsert(tasks: List<RelayTask>, task: RelayTask): List<RelayTask> {
    val merged = mergeRelayTask(tasks.find { it.id == task.id }, task)
    return (tasks.filterNot { it.id == task.id } + merged).sortedByDescending { it.updatedAt }
}

fun sessionRejected(message: Envelope): Boolean {
    if (message.type != "err") return false
    return message.payload.text("code") in setOf("unauthorized", "revoked")
}

private data class GapMark(val generation: Long?, val expectedSeq: Long)

/**
 * Arms one delayed resubscribe after evt.gap.
 * The caller must cancel that only when a snapshot is actually past the gap.
 * The cached snapshot replayed with the gap does not count.
 */
class ResyncScheduler {
    private var armed = false

    fun onGap(): Boolean {
        if (armed) return false
        armed = true
        return true
    }

    fun onSnapshot() {
        armed = false
    }

    fun consumeIfStillNeeded(): Boolean {
        if (!armed) return false
        armed = false
        return true
    }
}
