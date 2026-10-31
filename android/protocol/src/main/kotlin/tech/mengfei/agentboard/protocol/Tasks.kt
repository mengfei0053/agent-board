package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

val TASK_STATUSES = setOf("queued", "running", "paused", "succeeded", "failed", "stopped")
val TERMINAL_STATUSES = setOf("succeeded", "failed", "stopped")

data class RelayTask(
    val id: String,
    val title: String,
    val status: String,
    val updatedAt: Long,
    val agent: String? = null,
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

fun readTask(obj: JsonObject): RelayTask? {
    val id = obj.text("id") ?: return null
    val title = obj.text("title") ?: return null
    val status = obj.text("status") ?: return null
    if (status !in TASK_STATUSES) return null
    val updatedAt = obj.longValue("updatedAt") ?: return null
    return RelayTask(id, title, status, updatedAt, obj.text("agent"))
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

private fun upsert(tasks: List<RelayTask>, task: RelayTask): List<RelayTask> {
    return (tasks.filterNot { it.id == task.id } + task).sortedByDescending { it.updatedAt }
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
