package tech.mengfei.agentboard.data

import android.content.Context
import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

data class DiagnosticTarget(
    val credentialId: String,
    val deviceId: String,
    val httpBase: String,
    val deviceToken: String,
    val connected: Boolean,
) {
    override fun toString() = "DiagnosticTarget(connected=$connected)"
}

// Append only: the event, operation and reason ordinals are part of the queue format.
enum class DiagnosticEvent(
    internal val level: String,
) {
    APP_STARTED("info"),
    RELAY_CONNECTED("info"),
    SNAPSHOT_SYNCED("info"),
    COMMAND_SENT("info"),
    COMMAND_EXECUTED("info"),
    RELAY_DISCONNECTED("error"),
    AUTH_REJECTED("error"),
    SYNC_GAP("error"),
    COMMAND_FAILED("error"),
    COMMAND_TIMEOUT("error"),
    BOARD_ONLINE("info"),
    SYNC_WAITING("info"),
    SYNC_RECOVERED("info"),
    RECONNECTING("info"),
    LOOKUP_RESULT("info"),
    BOARD_OFFLINE("error"),
    BOARD_UNAVAILABLE("error"),
    NETWORK_FAILED("error"),
    PROTOCOL_INVALID("error"),
    PAIR_FAILED("error"),
    STORAGE_FAILED("error"),
    ATTACHMENT_FAILED("error"),
    APP_EXIT_ABNORMAL("error"),
    NOTIFICATION_FAILED("error"),
    ;

    internal val localOnly get() = this == APP_EXIT_ABNORMAL || this == NOTIFICATION_FAILED
}

enum class DiagnosticOperation {
    CREATE,
    CONTINUE,
    STOP,
    STEER,
    LOOKUP,
    DETAIL,
    ARCHIVE,
    ARCHIVE_LIST,
    WORKSPACE_CREATE,
    WORKSPACE_DELETE,
    WORKSPACE_GET,
    WORKSPACE_UPDATE,
    SETTINGS_GET,
    SETTINGS_PUT,
    PAIR,
    REFRESH,
    HEALTH,
    CONNECT,
    BOARD_LIST,
    SUBSCRIBE,
}

enum class DiagnosticReason {
    DNS,
    TLS,
    TIMEOUT,
    NETWORK,
    UNAUTHORIZED,
    FORBIDDEN,
    UNSUPPORTED,
    BOARD_OFFLINE,
    BAD_REQUEST,
    RATE_LIMITED,
    NOT_FOUND,
    DISCONNECTED,
    UNKNOWN,
    ACCEPTED,
    EXECUTED,
    FAILED,
    INVALID,
    STORAGE,
    TOO_LARGE,
    EMPTY,
    UNREADABLE,
    LIMIT,
    CRASH,
    ANR,
    LOW_MEMORY,
    PERMISSION,
}

enum class DiagnosticWaitReason {
    LOADING,
    BUSY,
    USER_ACTIVE,
    OFFLINE,
    BAD_REQUEST,
    UNAUTHORIZED,
    FORBIDDEN,
    RATE_LIMITED,
    HTTP_CLIENT,
    HTTP_SERVER,
    DNS,
    TLS,
    TIMEOUT,
    NETWORK,
    INVALID_ACK,
    STORAGE,
}

data class DiagnosticError(
    val timestampMs: Long,
    val event: DiagnosticEvent,
    val operation: DiagnosticOperation?,
    val reason: DiagnosticReason?,
    val count: Int,
)

/** Device-wide and identifier-free. Pending counts uploadable rows, info/error count occurrences committed locally. */
data class DiagnosticStatus(
    val pendingCount: Int = 0,
    val lastAckAtMs: Long? = null,
    val waitReason: DiagnosticWaitReason? = DiagnosticWaitReason.LOADING,
    val recentErrors: List<DiagnosticError> = emptyList(),
    val infoCount: Long = 0,
    val errorCount: Long = 0,
)

class AppDiagnostics(
    context: Context,
) {
    private val engine = shared(context)
    val status: StateFlow<DiagnosticStatus> get() = engine.status

    fun updateTargets(
        targets: List<DiagnosticTarget>,
        busy: Boolean,
    ) = engine.updateTargets(targets, busy)

    fun record(
        credentialId: String,
        event: DiagnosticEvent,
        operation: DiagnosticOperation? = null,
        reason: DiagnosticReason? = null,
    ) = engine.record(credentialId, event, operation, reason)

    fun recordLocal(
        event: DiagnosticEvent,
        operation: DiagnosticOperation? = null,
        reason: DiagnosticReason? = null,
    ) = engine.recordLocal(event, operation, reason)

    fun onUserInteraction() = engine.onUserInteraction()

    private companion object {
        private var instance: DiagnosticEngine? = null

        @Synchronized fun shared(context: Context): DiagnosticEngine =
            instance ?: run {
                val app = context.applicationContext
                val engine = DiagnosticEngine({ File(app.noBackupFilesDir, "diag-v1") }, SystemClock::elapsedRealtime, DiagnosticHttp::post)
                // Exactly one recurring job per process. No Runnable/coroutine per input, even if HTTP stalls.
                Executors
                    .newSingleThreadScheduledExecutor { r -> Thread(r, "app-diagnostics").apply { isDaemon = true } }
                    .scheduleWithFixedDelay(engine::tick, 1, 3, TimeUnit.SECONDS)
                engine.also { instance = it }
            }
    }
}

internal class DiagnosticEngine(
    directory: () -> File,
    private val elapsed: () -> Long,
    private val post: (DiagnosticTarget, List<DiagnosticRow>) -> Set<String>,
) {
    private data class Route(
        val key: DiagnosticKey,
        val target: DiagnosticTarget,
    )

    private data class Input(
        val key: DiagnosticKey?,
        val event: DiagnosticEvent,
        val operation: DiagnosticOperation?,
        val reason: DiagnosticReason?,
    )

    private data class Group(
        val input: Input,
        val ts: Long = System.currentTimeMillis(),
        val count: Int = 1,
    )

    private data class Retry(
        val until: Long,
        val delay: Long,
        val reason: DiagnosticWaitReason,
    )

    private var routes = emptyMap<String, Route>()
    private var busy = true

    @Volatile private var lastInteraction = elapsed()
    private val inbox = ArrayDeque<Group>()
    private val mutableStatus = MutableStateFlow(DiagnosticStatus())
    val status = mutableStatus.asStateFlow()

    // Worker-confined; in particular, resolving Context.noBackupFilesDir and reading happen here only.
    private val store by lazy { DiagnosticStore(directory()) }
    private val retries = mutableMapOf<String, Retry>()

    @Synchronized fun updateTargets(
        targets: List<DiagnosticTarget>,
        busy: Boolean,
    ) {
        this.busy = busy
        routes =
            targets
                .groupBy { it.credentialId }
                .mapNotNull { (id, group) ->
                    val first = group.first()
                    // Multiple boards may share a credential. Fail closed on an ambiguous identity or token.
                    if (id.isBlank() || id.length > 256 || first.deviceId.isBlank() || first.deviceId.length > 256 ||
                        first.httpBase.isBlank() || first.httpBase.length > 2048 ||
                        group.any {
                            it.deviceId != first.deviceId || it.httpBase != first.httpBase || it.deviceToken != first.deviceToken
                        }
                    ) {
                        return@mapNotNull null
                    }
                    id to Route(DiagnosticKey(id, first.deviceId, first.httpBase), group.firstOrNull { it.connected } ?: first)
                }.toMap()
    }

    fun onUserInteraction() {
        lastInteraction = elapsed()
    }

    @Synchronized fun record(
        credentialId: String,
        event: DiagnosticEvent,
        operation: DiagnosticOperation? = null,
        reason: DiagnosticReason? = null,
    ) {
        val key = if (event.localOnly) null else routes[credentialId]?.key ?: return // Never guess a target later.
        enqueue(Input(key, event, operation, reason))
    }

    @Synchronized fun recordLocal(
        event: DiagnosticEvent,
        operation: DiagnosticOperation? = null,
        reason: DiagnosticReason? = null,
    ) = enqueue(Input(null, event, operation, reason))

    private fun enqueue(input: Input) {
        // Only unpublished inputs are mutable. Move the group to the newest position for FIFO eviction and history.
        val index = inbox.indexOfLast { it.input == input && it.count < 65535 }
        val count = if (index < 0) 1 else inbox.removeAt(index).count + 1
        if (inbox.size == INBOX_LIMIT) inbox.removeFirst()
        inbox.addLast(Group(input, count = count))
    }

    @Synchronized private fun drain() = inbox.toList().also { inbox.clear() }

    @Synchronized private fun gateReason() =
        when {
            busy -> DiagnosticWaitReason.BUSY
            elapsed() - lastInteraction < IDLE_MS -> DiagnosticWaitReason.USER_ACTIVE
            else -> null
        }

    @Synchronized private fun eligible() =
        if (gateReason() != null) emptyList() else routes.values.filter { it.target.connected && it.target.deviceToken.isNotBlank() }

    // Serial timer. The first tick hydrates local history even without inputs, targets or a network.
    fun tick() {
        try {
            val inputs = drain()
            if (inputs.isNotEmpty()) {
                store.append(
                    inputs.map { (input, ts, count) ->
                        DiagnosticRow(
                            input.key?.digest ?: DiagnosticStore.LOCAL_ONLY,
                            UUID.randomUUID(),
                            ts,
                            input.event,
                            input.operation,
                            input.reason,
                            count,
                        )
                    },
                )
                if (retries.isNotEmpty()) retries.keys.retainAll(store.rows.mapTo(mutableSetOf()) { it.owner })
            }
            uploadIfEligible()
        } catch (_: Exception) {
            mutableStatus.value = mutableStatus.value.copy(waitReason = DiagnosticWaitReason.STORAGE)
        }
    }

    private fun uploadIfEligible() {
        val summary = store.status
        if (summary.pendingCount == 0) {
            retries.clear()
            mutableStatus.value = summary
            return
        }
        val owners = eligible().associateBy { it.key.digest }
        if (owners.isEmpty()) {
            mutableStatus.value = summary.copy(waitReason = gateReason() ?: DiagnosticWaitReason.OFFLINE)
            return
        }
        val first = store.rows.firstOrNull { it.owner in owners && elapsed() >= (retries[it.owner]?.until ?: Long.MIN_VALUE) }
        if (first == null) {
            val retry = retries.filterKeys { it in owners }.values.minByOrNull { it.until }
            mutableStatus.value = summary.copy(waitReason = retry?.reason ?: gateReason() ?: DiagnosticWaitReason.OFFLINE)
            return
        }
        val owner = first.owner
        val batch = store.rows.filter { it.owner == owner }.take(50)
        mutableStatus.value = summary.copy(waitReason = retries[owner]?.reason)
        // Recheck identity, token and idle gates immediately before dispatch.
        val target = eligible().firstOrNull { it.key == owners.getValue(owner).key }?.target ?: return
        val acked =
            try {
                post(target, batch)
            } catch (e: Exception) {
                backoff(
                    owner,
                    when (e) {
                        is DiagnosticHttpFailure -> e.reason
                        is UnknownHostException -> DiagnosticWaitReason.DNS
                        is SSLException -> DiagnosticWaitReason.TLS
                        is InterruptedIOException -> DiagnosticWaitReason.TIMEOUT
                        is IOException -> DiagnosticWaitReason.NETWORK
                        else -> DiagnosticWaitReason.INVALID_ACK
                    },
                )
                return
            }
        val accepted = batch.filter { it.id.toString() in acked }.map { it.id }.toSet()
        if (accepted.isNotEmpty()) {
            try {
                store.ack(owner, accepted, System.currentTimeMillis())
            } catch (_: IOException) {
                // The relay may already have accepted these IDs. Keep their payload intact and do not hammer it on a full disk.
                backoff(owner, DiagnosticWaitReason.STORAGE)
                return
            }
        }
        if (accepted.size == batch.size) {
            retries.remove(owner)
            mutableStatus.value = store.status
        } else {
            backoff(owner, DiagnosticWaitReason.INVALID_ACK)
        }
    }

    private fun backoff(
        owner: String,
        reason: DiagnosticWaitReason,
    ) {
        // Old relays may reject the extended schema. Never drop or rewrite a submitted row,
        // and never enqueue an upload failure as a new diagnostics event.
        val delay =
            when (reason) {
                DiagnosticWaitReason.BAD_REQUEST, DiagnosticWaitReason.UNAUTHORIZED, DiagnosticWaitReason.FORBIDDEN,
                DiagnosticWaitReason.HTTP_CLIENT,
                -> MAX_DELAY

                else -> ((retries[owner]?.delay ?: 5_000L) * 2).coerceAtMost(MAX_DELAY)
            }
        retries[owner] = Retry(elapsed() + delay, delay, reason)
        mutableStatus.value = store.status.copy(waitReason = reason)
    }

    companion object {
        const val INBOX_LIMIT = 256
        const val IDLE_MS = 30_000L
        private const val MAX_DELAY = 5 * 60_000L
    }
}
