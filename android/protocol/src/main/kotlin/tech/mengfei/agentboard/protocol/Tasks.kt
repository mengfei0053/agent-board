package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

val TASK_STATUSES: Set<String> = setOf("queued", "running", "paused", "succeeded", "failed", "stopped")
val TERMINAL_STATUSES: Set<String> = setOf("succeeded", "failed", "stopped")

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

fun workspaceListKey(workspaces: List<ThinWorkspace>): String =
    workspaces.joinToString("\n") { "${it.id}\u0000${it.path}\u0000${it.isGit}" }

fun keptWorktreeChoice(
    checked: Boolean,
    cwd: String,
    workspaces: List<ThinWorkspace>,
    previousKey: String,
): Boolean = workspaceListKey(workspaces) == previousKey && checked && worktreeAllowed(cwd, workspaces)

fun readWorkspaces(payload: JsonObject): List<ThinWorkspace> {
    if (!payload.containsKey("workspaces")) return emptyList()
    val array = payload.array("workspaces") ?: return emptyList()
    if (array.size > 50) return emptyList()
    val rows = ArrayList<ThinWorkspace>(array.size)
    for (element in array) {
        val obj = element as? JsonObject ?: return emptyList()
        val id = obj.text("id") ?: return emptyList()
        val name = obj.text("name") ?: return emptyList()
        val path = obj.text("path") ?: return emptyList()
        val isGit = obj.bool("isGit") ?: return emptyList()
        if (id.isBlank() || name.isBlank() || path.isBlank() || path.contains("://")) return emptyList()
        rows.add(ThinWorkspace(id, name, path, isGit))
    }
    return rows
}

fun readTaskList(element: JsonElement?): List<RelayTask> {
    val array = element as? JsonArray ?: return emptyList()
    return array.mapNotNull { item ->
        val obj = item as? JsonObject ?: return@mapNotNull null
        readTask(obj)
    }
}

fun parseBoardList(payload: JsonObject): List<BoardInfo>? {
    if (!payload.containsKey("boards")) return null
    val array = payload.array("boards") ?: return emptyList()
    return array.mapNotNull { item ->
        val obj = item as? JsonObject ?: return@mapNotNull null
        val boardId = obj.text("boardId") ?: return@mapNotNull null
        val online = obj.bool("online") ?: return@mapNotNull null
        BoardInfo(boardId, obj.text("label"), online, obj.longValue("generation"))
    }
}

fun BoardView.withLocalTask(task: RelayTask): BoardView = copy(tasks = upsert(tasks, task))

internal fun upsert(tasks: List<RelayTask>, task: RelayTask): List<RelayTask> =
    (tasks.filterNot { it.id == task.id } + task).sortedByDescending { it.updatedAt }

fun sessionRejected(message: Envelope): Boolean {
    if (message.type != "err") return false
    return message.payload.text("code") in setOf("unauthorized", "revoked")
}

class EventIdDeduper(private val capacity: Int = 500) {
    private val seen = LinkedHashSet<String>()

    fun claim(eventId: String): Boolean {
        if (eventId.isBlank() || !seen.add(eventId)) return false
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

class BoardReducer(
    private val doneDedupe: EventIdDeduper = EventIdDeduper(),
    private val logDedupe: EventIdDeduper = EventIdDeduper(),
    private val logTail: Int = 200,
) {
    private var gapMark: GapMark? = null

    fun apply(view: BoardView, message: Envelope): ApplyOutcome {
        val payload = message.payload
        val eventBoard = payload.text("boardId")
        return when (message.type) {
            "evt.gap" -> applyGap(view, payload, eventBoard)
            "evt.log" -> applyLog(view, payload, eventBoard)
            "evt.task.done" -> applyDone(view, payload, eventBoard)
            "evt.snapshot" -> applySnapshot(view, payload, eventBoard)
            "evt.task" -> applyTask(view, payload, eventBoard)
            else -> ApplyOutcome.Ignored(view)
        }
    }

    private fun applySnapshot(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Ignored(view)
        val generation = payload.longValue("generation")
        val generationChanged = generation != null && view.generation != null && generation != view.generation
        if (generationChanged) logDedupe.clear()
        val tasks = readTaskList(payload["tasks"]).sortedByDescending { it.updatedAt }
        val seq = payload.longValue("seq") ?: payload.longValue("version")
        val stale = snapshotStillStale(generation, seq)
        return ApplyOutcome.Applied(
            view.copy(
                tasks = tasks,
                logs = if (generationChanged) emptyMap() else view.logs,
                workspaces = readWorkspaces(payload),
                generation = generation ?: view.generation,
                seq = seq ?: view.seq,
                needsResync = stale,
            ),
        )
    }

    private fun applyTask(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Ignored(view)
        val task = payload.obj("task")?.let { readTask(it) } ?: return ApplyOutcome.Ignored(view)
        val generation = payload.longValue("generation")
        val seq = payload.longValue("seq")
        return ApplyOutcome.Applied(
            view.copy(
                tasks = upsert(view.tasks, task),
                generation = generation ?: view.generation,
                seq = seq ?: view.seq,
                needsResync = gapOpen(),
            ),
        )
    }

    private fun applyLog(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Ignored(view)
        val eventId = payload.text("eventId") ?: ""
        if (!logDedupe.claim(eventId)) return ApplyOutcome.Ignored(view)
        val taskId = payload.text("taskId") ?: return ApplyOutcome.Ignored(view)
        val line = payload.text("line") ?: return ApplyOutcome.Ignored(view)
        val stream = payload.text("stream") ?: "system"
        val entry = LogLine(eventId, stream, line, payload.longValue("seq") ?: 0L)
        val existing = view.logs[taskId].orEmpty()
        val appended = (existing + entry).takeLast(logTail)
        val generation = payload.longValue("generation")
        val seq = payload.longValue("seq")
        return ApplyOutcome.Applied(
            view.copy(
                logs = view.logs + (taskId to appended),
                generation = generation ?: view.generation,
                seq = seq ?: view.seq,
                needsResync = gapOpen(),
            ),
        )
    }

    private fun applyDone(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        val eventId = payload.text("eventId") ?: ""
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
            existing != null -> existing.copy(title = title ?: existing.title, status = status)
            title != null -> RelayTask(taskId, title, status, payload.longValue("seq") ?: 0L, null)
            else -> null
        }
        val generation = payload.longValue("generation")
        val seq = payload.longValue("seq")
        val tasks = if (updated != null) upsert(view.tasks, updated) else view.tasks
        return ApplyOutcome.Applied(
            view.copy(
                tasks = tasks,
                generation = generation ?: view.generation,
                seq = seq ?: view.seq,
                needsResync = gapOpen(),
            ),
            notice,
        )
    }

    private fun applyGap(view: BoardView, payload: JsonObject, eventBoard: String?): ApplyOutcome {
        if (!sameBoard(view, eventBoard)) return ApplyOutcome.Ignored(view)
        val reason = payload.text("reason") ?: "seq_gap"
        val generation = payload.longValue("generation") ?: view.generation
        val expected = payload.longValue("expectedSeq") ?: ((view.seq ?: 0L) + 1L)
        gapMark = GapMark(generation, expected)
        return ApplyOutcome.Resync(view.copy(needsResync = true), reason)
    }

    private fun gapOpen(): Boolean = gapMark != null

    private fun snapshotStillStale(generation: Long?, seq: Long?): Boolean {
        val mark = gapMark ?: return false
        val newGeneration = generation != null && mark.generation != null && generation != mark.generation
        val coversGap = seq != null && seq >= mark.expectedSeq
        if (!newGeneration && !coversGap) return true
        gapMark = null
        return false
    }

    private fun sameBoard(view: BoardView, eventBoard: String?): Boolean {
        if (eventBoard == null || view.boardId.isEmpty()) return true
        return eventBoard == view.boardId
    }
}
