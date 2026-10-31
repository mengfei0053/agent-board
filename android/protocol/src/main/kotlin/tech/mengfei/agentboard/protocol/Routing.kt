package tech.mengfei.agentboard.protocol

data class RefRecord(
    val ref: String,
    val sessionId: String,
    val credentialId: String,
    val boardId: String,
    val command: String,
    val taskId: String?,
    val socketEpoch: Long,
)

data class LogBinding(
    val credentialId: String,
    val boardId: String,
    val taskId: String,
    val socketEpoch: Long,
)

enum class FrameKind { ACK, SNAPSHOT, TASK, GAP, LOG, DONE, OTHER }

data class RouteInput(
    val kind: FrameKind,
    val credentialId: String,
    val socketEpoch: Long,
    val currentEpoch: Long,
    val boardId: String?,
    val ref: String?,
    val taskId: String?,
    val refs: Map<String, RefRecord>,
    val sessions: List<PhoneSession>,
    val helloBoardIds: Set<String>,
    val subscribedBoardIds: Set<String>,
    val logBinding: LogBinding?,
)

sealed interface RouteResult {
    data object Drop : RouteResult
    data class ToSession(val sessionId: String, val ref: RefRecord?) : RouteResult
}

fun routeFrame(input: RouteInput): RouteResult {
    if (input.kind == FrameKind.ACK) return routeAck(input)
    if (input.kind == FrameKind.LOG) return routeLog(input)
    val boardId = input.boardId
    if (boardId.isNullOrBlank()) return routeMissingBoard(input)
    val session = sessionFor(input, boardId) ?: return RouteResult.Drop
    if (boardId !in input.helloBoardIds) return RouteResult.Drop
    if (boardId !in input.subscribedBoardIds) return RouteResult.Drop
    if (input.socketEpoch != input.currentEpoch) return RouteResult.Drop
    return RouteResult.ToSession(session.sessionId, null)
}

private fun routeAck(input: RouteInput): RouteResult {
    val record = input.ref?.let { input.refs[it] } ?: return RouteResult.Drop
    if (record.credentialId != input.credentialId || record.socketEpoch != input.socketEpoch) return RouteResult.Drop
    if (input.socketEpoch != input.currentEpoch) return RouteResult.Drop
    val session = input.sessions.find { it.sessionId == record.sessionId } ?: return RouteResult.Drop
    if (session.credentialId != input.credentialId || session.boardId != record.boardId) return RouteResult.Drop
    if (!input.boardId.isNullOrBlank() && input.boardId != record.boardId) return RouteResult.Drop
    return RouteResult.ToSession(session.sessionId, record)
}

private fun routeLog(input: RouteInput): RouteResult {
    val binding = input.logBinding ?: return RouteResult.Drop
    if (binding.credentialId != input.credentialId || binding.socketEpoch != input.socketEpoch) return RouteResult.Drop
    if (input.socketEpoch != input.currentEpoch) return RouteResult.Drop
    val boardId = input.boardId
    val taskId = input.taskId
    if (boardId.isNullOrBlank() || taskId.isNullOrBlank()) {
        val only = onlySession(input) ?: return RouteResult.Drop
        if (binding.boardId != only.boardId || binding.taskId != taskId) return RouteResult.Drop
        if (taskId.isNullOrBlank()) return RouteResult.Drop
        return RouteResult.ToSession(only.sessionId, null)
    }
    if (binding.boardId != boardId || binding.taskId != taskId) return RouteResult.Drop
    val session = sessionFor(input, boardId) ?: return RouteResult.Drop
    if (boardId !in input.helloBoardIds || boardId !in input.subscribedBoardIds) return RouteResult.Drop
    return RouteResult.ToSession(session.sessionId, null)
}

private fun routeMissingBoard(input: RouteInput): RouteResult {
    if (input.socketEpoch != input.currentEpoch) return RouteResult.Drop
    val only = onlySession(input) ?: return RouteResult.Drop
    if (only.boardId !in input.subscribedBoardIds) return RouteResult.Drop
    if (only.boardId !in input.helloBoardIds) return RouteResult.Drop
    return RouteResult.ToSession(only.sessionId, null)
}

private fun sessionFor(input: RouteInput, boardId: String): PhoneSession? {
    return input.sessions.find { it.credentialId == input.credentialId && it.boardId == boardId }
}

private fun onlySession(input: RouteInput): PhoneSession? {
    val mine = input.sessions.filter { it.credentialId == input.credentialId }
    return mine.singleOrNull()
}

/** Do not send sub.logs without a task id. A missing task id subscribes to every log. */
fun shouldSendLogSubscribe(taskId: String?): Boolean = !taskId.isNullOrBlank()

fun subscriptionsAfterHello(boardIds: List<String>): List<String> = boardIds.map { "sub.tasks:$it" }

data class DoneClaim(val notify: Boolean, val claimed: Boolean, val sessionId: String?)

/**
 * Claim the event id only after a live session still binds this credential and board.
 * A forgotten session does not consume the id, so the token that still owns the board can notify.
 */
fun claimDone(
    deduper: EventIdDeduper,
    eventId: String,
    sessionId: String?,
): DoneClaim {
    if (sessionId == null) return DoneClaim(notify = false, claimed = false, sessionId = null)
    val claimed = deduper.claim(eventId)
    return DoneClaim(notify = claimed, claimed = claimed, sessionId = sessionId)
}

fun notificationTarget(sessions: List<PhoneSession>, sessionId: String?, taskId: String?): PhoneSession? {
    if (sessionId.isNullOrBlank() || taskId.isNullOrBlank()) return null
    return sessions.find { it.sessionId == sessionId }
}

data class CompletionGate(
    val openDetail: Boolean,
    val taskId: String?,
    val toastSaved: Boolean,
)

fun completionForSession(
    activeSessionId: String?,
    commandSessionId: String,
    cmd: String,
    taskId: String?,
    settled: Boolean,
): CompletionGate {
    if (!settled || activeSessionId == null || activeSessionId != commandSessionId) {
        return CompletionGate(openDetail = false, taskId = null, toastSaved = false)
    }
    if (cmd == "cmd.create" && !taskId.isNullOrBlank()) {
        return CompletionGate(openDetail = true, taskId = taskId, toastSaved = false)
    }
    if ((cmd == "cmd.settings.put" || cmd == "cmd.workspace.update") && settled) {
        return CompletionGate(openDetail = false, taskId = null, toastSaved = true)
    }
    return CompletionGate(openDetail = false, taskId = null, toastSaved = false)
}
