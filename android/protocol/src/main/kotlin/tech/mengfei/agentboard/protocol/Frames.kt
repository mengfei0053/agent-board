package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

private val visibleKey = Regex("^[\\x21-\\x7E]{8,80}$")
private val boardIdPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

val AGENT_KINDS = listOf("pi", "claude", "cursor", "devin", "codex")

fun newMessageId(): String = "m" + UUID.randomUUID().toString().replace("-", "")

fun newIdempotencyKey(): String = "ph" + UUID.randomUUID().toString().replace("-", "")

fun helloEnvelope(id: String, ts: Long, token: String, name: String): Envelope = frame(
    id, ts, "client.hello", buildJsonObject {
        put("token", token)
        put("name", name)
    },
)

fun boardListEnvelope(id: String, ts: Long): Envelope = frame(id, ts, "board.list", JsonObject(emptyMap()))

fun subTasksEnvelope(id: String, ts: Long, boardId: String): Envelope = frame(
    id, ts, "sub.tasks", buildJsonObject { put("boardId", boardId) },
)

fun subLogsEnvelope(id: String, ts: Long, boardId: String, taskId: String? = null): Envelope = frame(
    id, ts, "sub.logs", buildJsonObject {
        put("boardId", boardId)
        if (!taskId.isNullOrBlank()) put("taskId", taskId)
    },
)

fun lookupEnvelope(id: String, ts: Long, boardId: String, idempotencyKey: String, cmd: String): Envelope = frame(
    id, ts, "cmd.lookup", buildJsonObject {
        put("boardId", boardId)
        put("idempotencyKey", idempotencyKey)
        put("cmd", cmd)
    },
)

sealed interface Validated<out T> {
    data class Ok<T>(val value: T) : Validated<T>
    data class Invalid(val message: String) : Validated<Nothing>
}

fun validateCreate(
    id: String,
    ts: Long,
    boardId: String,
    title: String,
    prompt: String,
    agent: String,
    cwd: String,
    idempotencyKey: String,
    useGitWorktree: Boolean = false,
): Validated<Envelope> {
    if (!boardIdPattern.matches(boardId)) {
        return Validated.Invalid("boardId must be 1-64 letters, digits, '.', '_' or '-'")
    }
    val cleanTitle = title.trim()
    if (cleanTitle.isEmpty() || cleanTitle.length > 200) {
        return Validated.Invalid("title is required, up to 200 characters")
    }
    val cleanPrompt = prompt.trim()
    if (cleanPrompt.isEmpty() || cleanPrompt.length > 20_000) {
        return Validated.Invalid("prompt is required, up to 20000 characters")
    }
    if (agent !in AGENT_KINDS) {
        return Validated.Invalid("agent must be one of ${AGENT_KINDS.joinToString(", ")}")
    }
    if (!isLocalPath(cwd)) {
        return Validated.Invalid("cwd is required and must be a local path")
    }
    if (!visibleKey.matches(idempotencyKey)) {
        return Validated.Invalid("idempotencyKey must be 8-80 visible ASCII characters")
    }
    return Validated.Ok(frame(id, ts, "cmd.create", buildJsonObject {
        put("boardId", boardId)
        put("idempotencyKey", idempotencyKey)
        put("title", cleanTitle)
        put("prompt", cleanPrompt)
        put("agent", agent)
        put("cwd", cwd)
        if (useGitWorktree) put("useGitWorktree", true)
    }))
}

fun validateContinue(
    id: String,
    ts: Long,
    boardId: String,
    taskId: String,
    idempotencyKey: String,
): Validated<Envelope> = validateTaskCommand("cmd.continue", id, ts, boardId, taskId, idempotencyKey, null)

fun validateStop(
    id: String,
    ts: Long,
    boardId: String,
    taskId: String,
    idempotencyKey: String,
    reason: String = "user tapped stop",
): Validated<Envelope> = validateTaskCommand("cmd.stop", id, ts, boardId, taskId, idempotencyKey, reason)

private fun validateTaskCommand(
    type: String,
    id: String,
    ts: Long,
    boardId: String,
    taskId: String,
    idempotencyKey: String,
    reason: String?,
): Validated<Envelope> {
    if (!boardIdPattern.matches(boardId)) return Validated.Invalid("boardId is invalid")
    if (!boardIdPattern.matches(taskId)) return Validated.Invalid("taskId is invalid")
    if (!visibleKey.matches(idempotencyKey)) {
        return Validated.Invalid("idempotencyKey must be 8-80 visible ASCII characters")
    }
    return Validated.Ok(frame(id, ts, type, buildJsonObject {
        put("boardId", boardId)
        put("taskId", taskId)
        put("idempotencyKey", idempotencyKey)
        if (!reason.isNullOrBlank()) put("reason", reason.take(500))
    }))
}

fun isLocalPath(value: String): Boolean {
    if (value.isBlank() || value.length > 1024) return false
    if (value.any { it.code in 0..31 || it.code == 127 }) return false
    if ("://" in value) return false
    return true
}

private fun frame(id: String, ts: Long, type: String, payload: JsonObject): Envelope {
    return Envelope(v = 1, id = id, type = type, ts = ts, payload = payload)
}
