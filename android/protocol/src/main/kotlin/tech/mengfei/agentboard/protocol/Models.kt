package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject

class RelayFormatException(message: String) : IllegalArgumentException(message)

data class Envelope(
    val v: Int,
    val id: String,
    val type: String,
    val ts: Long,
    val payload: JsonObject,
)

data class PairResponse(
    val deviceId: String,
    val deviceToken: String,
    val role: String,
    val boardIds: List<String>,
    val expiresAt: Long,
)

data class HealthStatus(val boardsOnline: Long)

sealed interface PairGate {
    data object OpenSocket : PairGate
    data class Hold(val message: String) : PairGate
}

sealed interface Validated<out T> {
    data class Ok<T>(val value: T) : Validated<T>
    data class Invalid(val reason: String) : Validated<Nothing>
}

enum class Retry {
    None,
    ReuseSameKey,
    LookupOnly,
}

data class CommandInterpretation(
    val summary: String,
    val retry: Retry,
    val task: RelayTask? = null,
    val settled: Boolean,
)

sealed interface CommandAction {
    data object Wait : CommandAction
    data object Settle : CommandAction
    data object SendLookup : CommandAction
}

sealed interface SubmitPlan {
    data object Busy : SubmitPlan
    data class Lookup(val idempotencyKey: String, val cmd: String) : SubmitPlan
    data class Send(val idempotencyKey: String) : SubmitPlan
}

data class OutstandingCommand(
    val cmd: String,
    val boardId: String,
    val idempotencyKey: String,
    val polls: Int = 0,
)

sealed interface Recovery {
    data class Clear(val summary: String, val interpreted: CommandInterpretation?) : Recovery
    data class Lookup(val command: OutstandingCommand) : Recovery
    data class Poll(val command: OutstandingCommand) : Recovery
}

data class RelayTask(
    val id: String,
    val title: String,
    val status: String,
    val updatedAt: Long,
    val agent: String? = null,
)

data class ThinWorkspace(
    val id: String,
    val name: String,
    val path: String,
    val isGit: Boolean,
)

data class BoardInfo(
    val boardId: String,
    val label: String?,
    val online: Boolean,
    val generation: Long?,
)

data class LogLine(
    val eventId: String,
    val stream: String,
    val line: String,
    val seq: Long,
)

data class DoneNotice(
    val eventId: String,
    val boardId: String,
    val taskId: String,
    val status: String,
    val title: String?,
    val summary: String?,
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

sealed interface ApplyOutcome {
    val view: BoardView

    data class Applied(override val view: BoardView, val notice: DoneNotice? = null) : ApplyOutcome
    data class Ignored(override val view: BoardView) : ApplyOutcome
    data class Resync(override val view: BoardView, val reason: String) : ApplyOutcome
}

internal data class GapMark(val generation: Long?, val expectedSeq: Long)

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

    fun disconnect(): WorktreeSession = copy(checked = false, online = false, eligibilityFresh = false)

    fun gap(): WorktreeSession = copy(checked = false, needsResync = true, eligibilityFresh = false)

    fun switchBoard(): WorktreeSession = copy(
        workspaces = emptyList(),
        checked = false,
        needsResync = false,
        eligibilityFresh = false,
    )

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
