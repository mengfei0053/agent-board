package tech.mengfei.agentboard.protocol

const val PROOF_TTL_MS = 60_000L
const val LIST_POLL_MS = 15_000L

enum class SocketPhase { CONNECTING, AUTHENTICATED, RECONNECTING, CLOSED, UNAUTHORIZED }

enum class PillKind { CONNECTED, OFFLINE, WEAK }

enum class PillDetail { NONE, UPDATED, SYNCING, CONNECTING, REPAIR }

enum class CacheKind { NONE, OFFLINE, UNSTABLE, NO_DATA, NO_WORKSPACES }

data class BoardProof(
    val online: Boolean,
    val listedGeneration: Long?,
    val at: Long,
    val epoch: Long,
)

data class LinkInput(
    val phase: SocketPhase,
    val currentEpoch: Long,
    val proof: BoardProof?,
    val appliedGeneration: Long?,
    val needsResync: Boolean,
    val sawSnapshot: Boolean,
    val snapshotAt: Long?,
    val workspaceCount: Int,
    val unassignedCount: Int,
    val suppressConnected: Boolean,
    val now: Long,
)

data class LinkPill(
    val kind: PillKind,
    val detail: PillDetail,
    val proofAt: Long?,
    val writesAllowed: Boolean,
    val cache: CacheKind,
)

data class PillCopy(val primary: String, val extra: String?, val updated: String?)

fun proofFresh(proof: BoardProof?, now: Long, epoch: Long): Boolean {
    if (proof == null || proof.epoch != epoch) return false
    return now - proof.at <= PROOF_TTL_MS
}

/**
 * 已连接 requires a matching list inside 60s, online, and a snapshot of that generation
 * with needsResync clear. A clock move with no frame is enough to demote it.
 */
fun linkPill(input: LinkInput): LinkPill {
    val fresh = proofFresh(input.proof, input.now, input.currentEpoch)
    val generationLive = input.sawSnapshot &&
        !input.needsResync &&
        input.proof != null &&
        (input.proof.listedGeneration == null || input.proof.listedGeneration == input.appliedGeneration) &&
        input.appliedGeneration != null
    val authed = input.phase == SocketPhase.AUTHENTICATED
    val repair = input.phase == SocketPhase.UNAUTHORIZED
    val connected = authed && fresh && input.proof?.online == true && generationLive && !input.suppressConnected
    val offline = authed && fresh && input.proof?.online == false && !repair
    val kind = when {
        repair -> PillKind.OFFLINE
        connected -> PillKind.CONNECTED
        offline -> PillKind.OFFLINE
        else -> PillKind.WEAK
    }
    val detail = when {
        repair -> PillDetail.REPAIR
        kind == PillKind.CONNECTED -> PillDetail.NONE
        kind == PillKind.OFFLINE -> PillDetail.NONE
        !input.sawSnapshot && input.proof == null && input.phase == SocketPhase.CONNECTING -> PillDetail.CONNECTING
        input.proof?.online == true && (!generationLive || input.suppressConnected) && fresh -> PillDetail.SYNCING
        input.proof != null -> PillDetail.UPDATED
        input.phase == SocketPhase.CONNECTING || input.phase == SocketPhase.RECONNECTING -> PillDetail.CONNECTING
        else -> PillDetail.UPDATED
    }
    val writesAllowed = authed && fresh && input.proof?.online == true && !repair
    val cache = cacheKind(kind, input)
    return LinkPill(kind, detail, input.proof?.at, writesAllowed, cache)
}

private fun cacheKind(kind: PillKind, input: LinkInput): CacheKind {
    if (input.sawSnapshot && input.workspaceCount == 0 && input.unassignedCount == 0) return CacheKind.NO_WORKSPACES
    if (kind == PillKind.CONNECTED) return CacheKind.NONE
    if (!input.sawSnapshot) return CacheKind.NO_DATA
    return if (kind == PillKind.OFFLINE) CacheKind.OFFLINE else CacheKind.UNSTABLE
}

fun pillCopy(pill: LinkPill, snapshotAt: Long? = null, english: Boolean = false): PillCopy {
    val primary = when (pill.detail) {
        PillDetail.CONNECTING -> if (english) "Connecting" else "正在连接"
        PillDetail.SYNCING -> if (english) "Syncing" else "正在同步"
        else -> when (pill.kind) {
            PillKind.CONNECTED -> if (english) "Connected" else "已连接"
            PillKind.OFFLINE -> if (english) "Offline" else "离线"
            PillKind.WEAK -> if (english) "Unstable" else "弱连接"
        }
    }
    val extra = when (pill.cache) {
        CacheKind.NONE -> null
        CacheKind.NO_WORKSPACES -> if (english) "This board has no workspaces yet." else NO_WORKSPACE_COPY
        CacheKind.NO_DATA -> if (english) "Could not load. No offline data." else "无法加载，暂无离线数据"
        CacheKind.OFFLINE -> cacheLine("看板离线", snapshotAt, english)
        CacheKind.UNSTABLE -> cacheLine("连接不稳定", snapshotAt, english)
    }
    val updated = if (pill.detail == PillDetail.UPDATED && pill.proofAt != null) {
        if (english) "Updated at ${pill.proofAt}" else "状态更新于 ${pill.proofAt}"
    } else {
        null
    }
    return PillCopy(primary, extra, updated)
}

private fun cacheLine(prefix: String, snapshotAt: Long?, english: Boolean): String {
    val time = snapshotAt?.let { " · $it" }.orEmpty()
    return if (english) {
        "$prefix · showing the local cache · may be stale$time"
    } else {
        "$prefix · 显示本地缓存 · 可能已过期$time"
    }
}

fun resyncAfterList(
    appliedGeneration: Long?,
    listedGeneration: Long?,
    snapshotNeedsResync: Boolean,
    sawSnapshot: Boolean,
): Boolean {
    if (!sawSnapshot) return true
    if (listedGeneration != null && listedGeneration != appliedGeneration) return true
    return snapshotNeedsResync
}

fun acceptBoardList(outstandingRef: String?, frameRef: String?, frameEpoch: Long, currentEpoch: Long): Boolean {
    return frameRef != null && frameRef == outstandingRef && frameEpoch == currentEpoch
}

data class ResumeDecision(val suppressConnected: Boolean, val sendList: Boolean, val connect: Boolean)

fun resumeDecision(phase: SocketPhase): ResumeDecision = when (phase) {
    SocketPhase.AUTHENTICATED -> ResumeDecision(suppressConnected = true, sendList = true, connect = false)
    else -> ResumeDecision(suppressConnected = true, sendList = false, connect = true)
}

fun pollArmed(foreground: Boolean, authenticated: Boolean): Boolean = foreground && authenticated

fun proofDeadline(proofAt: Long?, foreground: Boolean, connected: Boolean): Long? {
    if (!foreground || !connected || proofAt == null) return null
    return proofAt + PROOF_TTL_MS
}

/** A command error names one board. Other sessions on the credential keep their proof. */
fun proofAfterDisconnect(now: Long, epoch: Long, listedGeneration: Long?): BoardProof {
    return BoardProof(online = false, listedGeneration = listedGeneration, at = now, epoch = epoch)
}
