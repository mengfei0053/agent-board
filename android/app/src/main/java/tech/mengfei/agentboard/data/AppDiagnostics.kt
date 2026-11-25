package tech.mengfei.agentboard.data

import android.content.Context
import android.os.SystemClock
import java.io.File
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class DiagnosticTarget(
    val credentialId: String,
    val deviceId: String,
    val httpBase: String,
    val deviceToken: String,
    val connected: Boolean,
) {
    override fun toString() = "DiagnosticTarget(connected=$connected)"
}

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
}

class AppDiagnostics(
    context: Context,
) {
    private val engine = shared(context)

    fun updateTargets(
        targets: List<DiagnosticTarget>,
        busy: Boolean,
    ) = engine.updateTargets(targets, busy)

    fun record(
        credentialId: String,
        event: DiagnosticEvent,
    ) = engine.record(credentialId, event)

    fun recordLocal(event: DiagnosticEvent) = engine.recordLocal(event)

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
        val ts: Long,
        val event: DiagnosticEvent,
    )

    private data class Retry(
        val until: Long,
        val delay: Long,
    )

    private var routes = emptyMap<String, Route>()
    private var busy = true

    @Volatile private var lastInteraction = elapsed()
    private val inbox = ArrayDeque<Input>()

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
                    val key = DiagnosticKey(id, first.deviceId, first.httpBase)
                    id to Route(key, group.firstOrNull { it.connected } ?: first)
                }.toMap()
    }

    fun onUserInteraction() {
        lastInteraction = elapsed()
    }

    @Synchronized fun record(
        credentialId: String,
        event: DiagnosticEvent,
    ) {
        val key = routes[credentialId]?.key ?: return // Never guess a target later.
        enqueue(key, event)
    }

    @Synchronized fun recordLocal(event: DiagnosticEvent) = enqueue(null, event)

    private fun enqueue(
        key: DiagnosticKey?,
        event: DiagnosticEvent,
    ) {
        if (inbox.size == INBOX_LIMIT) inbox.removeFirst()
        inbox.addLast(Input(key, System.currentTimeMillis(), event))
    }

    @Synchronized private fun drain() = inbox.toList().also { inbox.clear() }

    @Synchronized private fun eligible() =
        if (busy || elapsed() - lastInteraction < IDLE_MS) {
            emptyList()
        } else {
            routes.values.filter { it.target.connected && it.target.deviceToken.isNotBlank() }
        }

    // Called serially by the timer. A failed upload, bad file, or full disk must not stop the timer or the app.
    fun tick() {
        try {
            val inputs = drain()
            if (inputs.isNotEmpty()) {
                store.append(
                    inputs.map { DiagnosticRow(it.key?.digest ?: LOCAL_ONLY, UUID.randomUUID(), it.ts, it.event) },
                )
            }
            val candidates = eligible()
            if (candidates.isEmpty()) return
            val owners = candidates.associateBy { it.key.digest }
            retries.keys.retainAll(owners.keys)
            val first = store.rows.firstOrNull { it.owner in owners && elapsed() >= (retries[it.owner]?.until ?: Long.MIN_VALUE) } ?: return
            val owner = first.owner
            val batch = store.rows.filter { it.owner == owner }.take(50)
            // Disk I/O above may have taken time. Re-check both identity and idle gates at dispatch,
            // and take the current token. An already dispatched request may finish after a state change.
            val target = eligible().firstOrNull { it.key == owners.getValue(owner).key }?.target ?: return
            try {
                val acked = post(target, batch)
                val accepted = batch.filter { it.id.toString() in acked }.map { it.id }.toSet()
                if (accepted.isNotEmpty()) store.ack(owner, accepted)
                if (accepted.size == batch.size) retries.remove(owner) else backoff(owner)
            } catch (_: Exception) {
                backoff(owner)
            }
        } catch (_: Exception) {
            // Best effort; never log payloads or credentials.
        }
    }

    private fun backoff(owner: String) {
        val delay = ((retries[owner]?.delay ?: 5_000L) * 2).coerceAtMost(5 * 60_000L)
        retries[owner] = Retry(elapsed() + delay, delay)
    }

    companion object {
        // Same width as a digest, but ':' is outside the Base64 alphabet and can never match a target.
        private val LOCAL_ONLY = ":".repeat(43)
        const val INBOX_LIMIT = 256
        const val IDLE_MS = 30_000L
    }
}
