package tech.mengfei.agentboard.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.Locale

/** Phone policy. The relay's 20 is a per-token board-id cap, not this limit. */
const val PHONE_SESSION_CAP = 20

const val MIGRATION_READING = "正在读取已配对看板"
const val NO_WORKSPACE_COPY = "此看板暂无工作区"
const val NO_MATCH_COPY = "无匹配工作区"
const val FILTER_EMPTY_COPY = "此筛选下暂无任务"
const val KEEP_ONE_BOARD = "这台手机至少保留一块已配对看板。要更换，请先添加新看板再忘记这一块。"
const val SWITCHED_PREFIX = "已切换到 "
const val CODE_CONSUMED_NO_ROOM = "配对码已被使用，但这台手机放不下这次返回的全部看板。请先忘记一块看板，再获取新的配对码。"
const val CODE_CONSUMED_REPAIR = "配对码已被使用。重新配对只能更新这一块看板，这次返回了其他看板，没有保存。"
const val CODE_CONSUMED_SAVE = "配对码已被使用，但没有保存成功。请重新获取配对码。"
const val AT_CAP_BEFORE_POST = "已有 20 块看板。请先忘记一块，再用新的配对码添加。"
const val CREATED_HIDDEN = "已创建，当前筛选里看不到"
const val UNSUPPORTED_COPY = "当前中继或看板还不支持这项操作。"
const val SAVED_COPY = "已保存"
const val PROMPTS_SAVED_COPY = "快捷提示词已保存"
const val ARCHIVE_SCOPE_UNSUPPORTED = "归档还不能按当前工作区筛选。在中继按工作区转发之前，这里不显示未筛选的归档。"

/**
 * The public relay rebuilds `cmd.archive.list` and drops `workspaceId`.
 * A phone page is scoped only when that forward exists. Until then the archive
 * chip must not present an unscoped page as this workspace.
 */
const val ARCHIVE_LIST_FORWARDS_WORKSPACE = false
const val SECURE_STORAGE_BANNER = "Secure storage is unavailable, so this phone cannot keep a device token."

enum class MigrationState { PENDING, COMMITTED }

enum class TaskChip { ALL, TODO, RUNNING, DONE, ARCHIVE }

enum class LaunchPhase { UNPAIRED, MIGRATING, READY }

data class CredentialSecret(
    val credentialId: String,
    val deviceToken: String,
    val deviceId: String,
    val expiresAt: Long,
    val httpBase: String,
    val wsUrl: String,
    val boardIds: List<String>,
)

data class PhoneSession(
    val sessionId: String,
    val credentialId: String,
    val boardId: String,
    val displayName: String,
    val createdAt: Long,
)

data class LegacyToken(
    val httpBase: String,
    val wsUrl: String,
    val deviceName: String,
    val deviceToken: String,
    val deviceId: String,
    val expiresAt: Long,
)

data class CatalogDocument(
    val catalogVersion: Int,
    val migrationState: MigrationState,
    val order: List<String>,
    val sessions: List<PhoneSession>,
    val activeSessionId: String?,
    val migrationCredentialId: String?,
) {
    val commitState: String = "committed"

    fun session(id: String): PhoneSession? = sessions.find { it.sessionId == id }

    fun ordered(): List<PhoneSession> = order.mapNotNull(::session)
}

data class PhoneDisk(
    val secretsReadable: Boolean = true,
    val credentials: Map<String, CredentialSecret> = emptyMap(),
    val catalog: CatalogDocument? = null,
    val legacy: LegacyToken? = null,
    val workspaces: Map<String, String> = emptyMap(),
    val drafts: Map<String, String> = emptyMap(),
    val archiveCursors: Map<String, String> = emptyMap(),
    val deviceName: String = "Android phone",
    val defaultHttpBase: String = DEFAULT_RELAY_HTTP,
)

sealed interface DiskOp {
    data class PutCredential(val secret: CredentialSecret) : DiskOp
    data class DeleteCredential(val credentialId: String) : DiskOp
    data class PutCatalog(
        val catalog: CatalogDocument,
        val workspacePuts: Map<String, String> = emptyMap(),
    ) : DiskOp
    data object DeleteLegacy : DiskOp
    data class ClearLocals(val sessionId: String) : DiskOp
    data class PutWorkspace(val sessionId: String, val workspaceId: String?) : DiskOp
}

data class Transaction(
    val steps: List<DiskOp>,
    /** Index of the catalog commit. Steps before it do not change the active session. */
    val cutoverIndex: Int,
    val stagedCredentialIds: Set<String> = emptySet(),
)

data class SimResult(
    val disk: PhoneDisk,
    val openSockets: Set<String>,
    val activeSessionId: String?,
    val cutover: Boolean,
)

data class LaunchView(
    val phase: LaunchPhase,
    val banner: String?,
    val sessions: List<PhoneSession>,
    val activeSessionId: String?,
    val cleanup: List<DiskOp>,
    val migrationCredentialId: String?,
    val readingCopy: String?,
)

sealed interface PairPrecheck {
    data object Post : PairPrecheck
    data class Refuse(val message: String) : PairPrecheck
}

data class PairRequest(
    val displayName: String,
    val httpBase: String,
    val response: PairResponse,
    val now: Long,
    val newCredentialId: String,
    val newSessionIds: List<String>,
    /** Non-null when the user opened 重新配对 on that card. */
    val repairSessionId: String? = null,
)

sealed interface PairOutcome {
    val consumedCode: Boolean

    data class Reject(
        override val consumedCode: Boolean,
        val message: String,
        val rollback: Transaction? = null,
    ) : PairOutcome
    data class Proceed(
        val tx: Transaction,
        val activeSessionId: String,
        val toastName: String,
        override val consumedCode: Boolean = true,
    ) : PairOutcome
}

private val catalogJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }

@Serializable
private data class SessionWire(
    val sessionId: String,
    val credentialId: String,
    val boardId: String,
    val displayName: String,
    val createdAt: Long,
)

@Serializable
private data class CatalogWire(
    val catalogVersion: Int,
    val commitState: String,
    val migrationState: String,
    val order: List<String>,
    val sessions: List<SessionWire>,
    val activeSessionId: String? = null,
    val migrationCredentialId: String? = null,
)

@Serializable
data class CredentialWire(
    val credentialId: String,
    val deviceToken: String,
    val deviceId: String,
    val expiresAt: Long,
    val httpBase: String,
    val wsUrl: String,
    val boardIds: List<String>,
)

fun encodeCatalog(document: CatalogDocument): String = catalogJson.encodeToString(
    CatalogWire.serializer(),
    CatalogWire(
        catalogVersion = document.catalogVersion,
        commitState = "committed",
        migrationState = document.migrationState.name.lowercase(),
        order = document.order,
        sessions = document.sessions.map {
            SessionWire(it.sessionId, it.credentialId, it.boardId, it.displayName, it.createdAt)
        },
        activeSessionId = document.activeSessionId,
        migrationCredentialId = document.migrationCredentialId,
    ),
)

fun decodeCatalog(text: String): CatalogDocument? {
    val wire = try {
        catalogJson.decodeFromString(CatalogWire.serializer(), text)
    } catch (error: Exception) {
        return null
    }
    if (wire.commitState != "committed") return null
    val migration = when (wire.migrationState) {
        "pending" -> MigrationState.PENDING
        "committed" -> MigrationState.COMMITTED
        else -> return null
    }
    if (wire.order.toSet().size != wire.order.size) return null
    if (wire.sessions.map { it.sessionId }.toSet() != wire.order.toSet()) return null
    val sessions = wire.sessions.map {
        if (it.sessionId.isBlank() || it.credentialId.isBlank() || it.boardId.isBlank()) return null
        PhoneSession(it.sessionId, it.credentialId, it.boardId, it.displayName, it.createdAt)
    }
    val byId = sessions.associateBy { it.sessionId }
    val ordered = wire.order.map { byId[it] ?: return null }
    if (migration == MigrationState.PENDING) {
        if (wire.activeSessionId != null) return null
        if (wire.migrationCredentialId.isNullOrBlank()) return null
    } else if (ordered.isNotEmpty()) {
        if (wire.activeSessionId == null || wire.activeSessionId !in byId) return null
    } else if (wire.activeSessionId != null) {
        return null
    }
    return CatalogDocument(
        catalogVersion = wire.catalogVersion,
        migrationState = migration,
        order = wire.order,
        sessions = ordered,
        activeSessionId = wire.activeSessionId,
        migrationCredentialId = wire.migrationCredentialId,
    )
}

fun encodeCredential(secret: CredentialSecret): String = catalogJson.encodeToString(
    CredentialWire.serializer(),
    CredentialWire(
        secret.credentialId,
        secret.deviceToken,
        secret.deviceId,
        secret.expiresAt,
        secret.httpBase,
        secret.wsUrl,
        secret.boardIds,
    ),
)

fun decodeCredential(text: String): CredentialSecret? {
    val wire = try {
        catalogJson.decodeFromString(CredentialWire.serializer(), text)
    } catch (error: Exception) {
        return null
    }
    if (wire.credentialId.isBlank() || wire.deviceToken.isBlank()) return null
    return CredentialSecret(
        wire.credentialId,
        wire.deviceToken,
        wire.deviceId,
        wire.expiresAt,
        wire.httpBase,
        wire.wsUrl,
        wire.boardIds,
    )
}

fun workspacePrefId(sessionId: String): String = sessionId

fun readableSessions(disk: PhoneDisk): List<PhoneSession> {
    if (!disk.secretsReadable) return emptyList()
    val catalog = disk.catalog ?: return emptyList()
    if (catalog.migrationState != MigrationState.COMMITTED) return emptyList()
    return catalog.ordered().filter { disk.credentials[it.credentialId] != null }
}

fun referencedCredentialIds(disk: PhoneDisk): Set<String> {
    val catalog = disk.catalog ?: return emptySet()
    val ids = catalog.sessions.map { it.credentialId }.toMutableSet()
    if (catalog.migrationState == MigrationState.PENDING) {
        catalog.migrationCredentialId?.let(ids::add)
    }
    return ids
}

fun reduceDisk(disk: PhoneDisk, op: DiskOp): PhoneDisk = when (op) {
    is DiskOp.PutCredential -> disk.copy(credentials = disk.credentials + (op.secret.credentialId to op.secret))
    is DiskOp.DeleteCredential -> disk.copy(credentials = disk.credentials - op.credentialId)
    is DiskOp.PutCatalog -> disk.copy(
        catalog = op.catalog,
        workspaces = disk.workspaces + op.workspacePuts,
    )
    DiskOp.DeleteLegacy -> disk.copy(legacy = null)
    is DiskOp.ClearLocals -> disk.copy(
        workspaces = disk.workspaces - op.sessionId,
        drafts = disk.drafts - op.sessionId,
        archiveCursors = disk.archiveCursors - op.sessionId,
    )
    is DiskOp.PutWorkspace -> if (op.workspaceId == null) {
        disk.copy(workspaces = disk.workspaces - op.sessionId)
    } else {
        disk.copy(workspaces = disk.workspaces + (op.sessionId to op.workspaceId))
    }
}

fun applyOps(disk: PhoneDisk, ops: List<DiskOp>): PhoneDisk = ops.fold(disk, ::reduceDisk)

/**
 * Applies [tx] until [failAt] (that step is not written).
 * A failure at or before the catalog cutover leaves the previous active id and the previous sockets.
 * The staged secret is removed when the rollback commit succeeds.
 * After the cutover, sockets close only for credentials the new catalog does not name.
 */
fun simulate(
    disk: PhoneDisk,
    openSockets: Set<String>,
    tx: Transaction,
    failAt: Int? = null,
    rollbackCommitFails: Boolean = false,
): SimResult {
    var current = disk
    var cutover = false
    tx.steps.forEachIndexed { index, op ->
        if (failAt != null && index == failAt) return finishEarly(disk, current, openSockets, tx, cutover, rollbackCommitFails)
        current = reduceDisk(current, op)
        if (index == tx.cutoverIndex) cutover = true
    }
    return finish(disk, current, openSockets, cutover)
}

private fun finishEarly(
    start: PhoneDisk,
    current: PhoneDisk,
    openSockets: Set<String>,
    tx: Transaction,
    cutover: Boolean,
    rollbackCommitFails: Boolean,
): SimResult {
    if (cutover) return finish(start, current, openSockets, cutover = true)
    var rolled = current
    if (!rollbackCommitFails) {
        tx.stagedCredentialIds.forEach { id ->
            rolled = reduceDisk(rolled, DiskOp.DeleteCredential(id))
        }
    }
    return SimResult(
        disk = rolled,
        openSockets = openSockets,
        activeSessionId = start.catalog?.activeSessionId,
        cutover = false,
    )
}

private fun finish(start: PhoneDisk, current: PhoneDisk, openSockets: Set<String>, cutover: Boolean): SimResult {
    if (!cutover) {
        return SimResult(current, openSockets, start.catalog?.activeSessionId, cutover = false)
    }
    val referenced = referencedCredentialIds(current)
    return SimResult(
        disk = current,
        openSockets = openSockets.filter { it in referenced }.toSet(),
        activeSessionId = current.catalog?.activeSessionId,
        cutover = true,
    )
}

fun recoverLaunch(disk: PhoneDisk): LaunchView {
    if (!disk.secretsReadable) {
        return LaunchView(
            phase = LaunchPhase.UNPAIRED,
            banner = SECURE_STORAGE_BANNER,
            sessions = emptyList(),
            activeSessionId = null,
            cleanup = emptyList(),
            migrationCredentialId = null,
            readingCopy = null,
        )
    }
    val catalog = disk.catalog
    if (catalog == null) {
        val legacy = disk.legacy
        if (legacy != null) {
            val staged = disk.credentials.values.find { it.deviceToken == legacy.deviceToken }
            val orphans = disk.credentials.keys.filter { it != staged?.credentialId }.map { DiskOp.DeleteCredential(it) }
            return LaunchView(
                phase = LaunchPhase.MIGRATING,
                banner = null,
                sessions = emptyList(),
                activeSessionId = null,
                cleanup = orphans,
                migrationCredentialId = staged?.credentialId,
                readingCopy = MIGRATION_READING,
            )
        }
        val orphans = disk.credentials.keys.map { DiskOp.DeleteCredential(it) }
        return LaunchView(
            phase = LaunchPhase.UNPAIRED,
            banner = null,
            sessions = emptyList(),
            activeSessionId = null,
            cleanup = orphans,
            migrationCredentialId = null,
            readingCopy = null,
        )
    }
    val referenced = referencedCredentialIds(disk)
    val dropSecrets = disk.credentials.keys.filter { it !in referenced }.map { DiskOp.DeleteCredential(it) }
    if (catalog.migrationState == MigrationState.PENDING) {
        val credentialId = catalog.migrationCredentialId
        val readable = credentialId != null && disk.credentials[credentialId] != null
        if (!readable) {
            return LaunchView(
                phase = LaunchPhase.UNPAIRED,
                banner = SECURE_STORAGE_BANNER,
                sessions = emptyList(),
                activeSessionId = null,
                cleanup = emptyList(),
                migrationCredentialId = null,
                readingCopy = null,
            )
        }
        return LaunchView(
            phase = LaunchPhase.MIGRATING,
            banner = null,
            sessions = emptyList(),
            activeSessionId = null,
            cleanup = dropSecrets,
            migrationCredentialId = credentialId,
            readingCopy = MIGRATION_READING,
        )
    }
    val ordered = catalog.ordered()
    val readable = ordered.filter { disk.credentials[it.credentialId] != null }
    val liveIds = ordered.map { it.sessionId }.toSet()
    val orphanLocals = (disk.workspaces.keys + disk.drafts.keys + disk.archiveCursors.keys)
        .filter { it !in liveIds }
        .map { DiskOp.ClearLocals(it) }
    val dropLegacy = if (disk.legacy != null) listOf(DiskOp.DeleteLegacy) else emptyList()
    if (ordered.isNotEmpty() && readable.isEmpty()) {
        return LaunchView(
            phase = LaunchPhase.UNPAIRED,
            banner = SECURE_STORAGE_BANNER,
            sessions = emptyList(),
            activeSessionId = null,
            cleanup = dropSecrets + dropLegacy + orphanLocals,
            migrationCredentialId = null,
            readingCopy = null,
        )
    }
    val active = catalog.activeSessionId?.takeIf { id -> readable.any { it.sessionId == id } }
        ?: readable.firstOrNull()?.sessionId
    return LaunchView(
        phase = if (readable.isEmpty()) LaunchPhase.UNPAIRED else LaunchPhase.READY,
        banner = null,
        sessions = readable,
        activeSessionId = active,
        cleanup = dropSecrets + dropLegacy + orphanLocals,
        migrationCredentialId = null,
        readingCopy = null,
    )
}

fun needsMigrationStart(disk: PhoneDisk): Boolean {
    if (!disk.secretsReadable || disk.legacy == null) return false
    return disk.catalog == null
}

fun planMigrationStart(disk: PhoneDisk, newCredentialId: String): Transaction? {
    val legacy = disk.legacy ?: return null
    if (disk.catalog != null) return null
    val existing = disk.credentials.values.find { it.deviceToken == legacy.deviceToken }
    val secret = existing ?: CredentialSecret(
        credentialId = newCredentialId,
        deviceToken = legacy.deviceToken,
        deviceId = legacy.deviceId,
        expiresAt = legacy.expiresAt,
        httpBase = legacy.httpBase,
        wsUrl = legacy.wsUrl,
        boardIds = emptyList(),
    )
    val catalog = CatalogDocument(
        catalogVersion = 1,
        migrationState = MigrationState.PENDING,
        order = emptyList(),
        sessions = emptyList(),
        activeSessionId = null,
        migrationCredentialId = secret.credentialId,
    )
    val steps = buildList {
        if (existing == null) add(DiskOp.PutCredential(secret))
        add(DiskOp.PutCatalog(catalog))
    }
    return Transaction(
        steps = steps,
        cutoverIndex = steps.lastIndex,
        stagedCredentialIds = if (existing == null) setOf(secret.credentialId) else emptySet(),
    )
}

data class BoardListRow(val boardId: String, val online: Boolean, val generation: Long?)

fun planMigrationList(
    disk: PhoneDisk,
    rows: List<BoardListRow>,
    newSessionIds: List<String>,
    now: Long,
): Transaction? {
    val catalog = disk.catalog ?: return null
    if (catalog.migrationState != MigrationState.PENDING) return null
    val credentialId = catalog.migrationCredentialId ?: return null
    val secret = disk.credentials[credentialId] ?: return null
    if (rows.isEmpty()) return null
    val counts = rows.groupingBy { it.boardId }.eachCount()
    var minted = 0
    val sessions = rows.map { row ->
        val prior = catalog.sessions.find { it.credentialId == credentialId && it.boardId == row.boardId }
        if (prior != null) {
            prior
        } else {
            val id = newSessionIds.getOrNull(minted) ?: error("session id missing")
            minted += 1
            PhoneSession(id, credentialId, row.boardId, row.boardId, now)
        }
    }
    val puts = mutableMapOf<String, String>()
    sessions.forEach { session ->
        if (counts[session.boardId] == 1) {
            val legacyWorkspace = disk.workspaces[session.boardId]
            if (legacyWorkspace != null && session.sessionId !in disk.workspaces) {
                puts[session.sessionId] = legacyWorkspace
            }
        }
    }
    val next = CatalogDocument(
        catalogVersion = catalog.catalogVersion + 1,
        migrationState = MigrationState.COMMITTED,
        order = sessions.map { it.sessionId },
        sessions = sessions,
        activeSessionId = sessions.firstOrNull()?.sessionId,
        migrationCredentialId = null,
    )
    val updatedSecret = secret.copy(boardIds = rows.map { it.boardId }.distinct())
    return Transaction(
        steps = listOf(
            DiskOp.PutCredential(updatedSecret),
            DiskOp.PutCatalog(next, puts),
            DiskOp.DeleteLegacy,
        ),
        cutoverIndex = 1,
        stagedCredentialIds = emptySet(),
    )
}

fun validateDisplayName(raw: String): String? {
    val name = raw.trim()
    if (name.isEmpty() || name.length > 40) return null
    if (name.any { it.code in 0..31 || it.code == 127 }) return null
    return name
}

fun pairPrecheck(sessionCount: Int, repair: Boolean): PairPrecheck {
    if (sessionCount >= PHONE_SESSION_CAP && !repair) return PairPrecheck.Refuse(AT_CAP_BEFORE_POST)
    return PairPrecheck.Post
}

fun forgetEnabled(sessionCount: Int): Boolean = sessionCount > 1

fun planPair(disk: PhoneDisk, request: PairRequest): PairOutcome {
    val name = validateDisplayName(request.displayName) ?: return consumedReject(CODE_CONSUMED_SAVE, request, null, null)
    val origin = try {
        normalizeHttpBase(request.httpBase)
    } catch (error: RelayFormatException) {
        return consumedReject(CODE_CONSUMED_SAVE, request, null, null)
    }
    val ws = try {
        deriveWsUrl(origin)
    } catch (error: RelayFormatException) {
        return consumedReject(CODE_CONSUMED_SAVE, request, origin, null)
    }
    val ids = request.response.boardIds
    if (ids.isEmpty() || ids.size > PHONE_SESSION_CAP || ids.toSet().size != ids.size) {
        return consumedReject(CODE_CONSUMED_SAVE, request, origin, ws)
    }
    val catalog = disk.catalog?.takeIf { it.migrationState == MigrationState.COMMITTED }
    val current = catalog?.ordered().orEmpty()
    val repair = request.repairSessionId?.let { id -> current.find { it.sessionId == id } }
    if (request.repairSessionId != null && repair == null) {
        return consumedReject(CODE_CONSUMED_REPAIR, request, origin, ws)
    }
    if (repair != null) {
        val repairOrigin = disk.credentials[repair.credentialId]?.httpBase
        if (ids != listOf(repair.boardId) || repairOrigin != origin) {
            return consumedReject(CODE_CONSUMED_REPAIR, request, origin, ws)
        }
    }
    data class Slot(val boardId: String, val existing: PhoneSession?)
    val slots = ids.map { boardId ->
        Slot(boardId, current.find { it.boardId == boardId && disk.credentials[it.credentialId]?.httpBase == origin })
    }
    val netNew = slots.count { it.existing == null }
    if (current.size + netNew > PHONE_SESSION_CAP) {
        return consumedReject(CODE_CONSUMED_NO_ROOM, request, origin, ws)
    }
    var fresh = 0
    val rebound = mutableListOf<PhoneSession>()
    val created = mutableListOf<PhoneSession>()
    slots.forEach { slot ->
        val existing = slot.existing
        if (existing != null) {
            rebound += existing.copy(credentialId = request.newCredentialId)
        } else {
            val sessionId = request.newSessionIds.getOrNull(fresh) ?: return consumedReject(CODE_CONSUMED_SAVE, request, origin, ws)
            fresh += 1
            created += PhoneSession(sessionId, request.newCredentialId, slot.boardId, name, request.now)
        }
    }
    val kept = current.map { session -> rebound.find { it.sessionId == session.sessionId } ?: session }
    val nextSessions = kept + created
    val active = nextSessions.first { it.boardId == ids.first() && it.credentialId == request.newCredentialId }
    val next = CatalogDocument(
        catalogVersion = (catalog?.catalogVersion ?: 0) + 1,
        migrationState = MigrationState.COMMITTED,
        order = nextSessions.map { it.sessionId },
        sessions = nextSessions,
        activeSessionId = active.sessionId,
        migrationCredentialId = null,
    )
    val secret = CredentialSecret(
        credentialId = request.newCredentialId,
        deviceToken = request.response.deviceToken,
        deviceId = request.response.deviceId,
        expiresAt = request.response.expiresAt,
        httpBase = origin,
        wsUrl = ws,
        boardIds = ids,
    )
    val unreferenced = referencedBefore(current, nextSessions)
    val steps = buildList {
        add(DiskOp.PutCredential(secret))
        add(DiskOp.PutCatalog(next))
        unreferenced.forEach { add(DiskOp.DeleteCredential(it)) }
    }
    return PairOutcome.Proceed(
        tx = Transaction(steps, cutoverIndex = 1, stagedCredentialIds = setOf(secret.credentialId)),
        activeSessionId = active.sessionId,
        toastName = active.displayName,
    )
}

private fun consumedReject(message: String, request: PairRequest, origin: String?, ws: String?): PairOutcome.Reject {
    if (origin == null || ws == null) return PairOutcome.Reject(consumedCode = true, message = message)
    val secret = CredentialSecret(
        credentialId = request.newCredentialId,
        deviceToken = request.response.deviceToken,
        deviceId = request.response.deviceId,
        expiresAt = request.response.expiresAt,
        httpBase = origin,
        wsUrl = ws,
        boardIds = request.response.boardIds,
    )
    val rollback = Transaction(
        steps = listOf(DiskOp.PutCredential(secret), DiskOp.DeleteCredential(secret.credentialId)),
        cutoverIndex = Int.MAX_VALUE,
        stagedCredentialIds = setOf(secret.credentialId),
    )
    return PairOutcome.Reject(consumedCode = true, message = message, rollback = rollback)
}

private fun referencedBefore(before: List<PhoneSession>, after: List<PhoneSession>): Set<String> {
    val still = after.map { it.credentialId }.toSet()
    return before.map { it.credentialId }.filter { it !in still }.toSet()
}

data class ForgetOutcome(
    val allowed: Boolean,
    val message: String?,
    val tx: Transaction?,
    val nextActiveId: String?,
    val clearedSessionId: String?,
)

fun planForget(disk: PhoneDisk, sessionId: String): ForgetOutcome {
    val catalog = disk.catalog ?: return ForgetOutcome(false, KEEP_ONE_BOARD, null, null, null)
    if (catalog.migrationState != MigrationState.COMMITTED) {
        return ForgetOutcome(false, KEEP_ONE_BOARD, null, null, null)
    }
    val sessions = catalog.ordered()
    if (sessions.size <= 1 || sessions.none { it.sessionId == sessionId }) {
        return ForgetOutcome(false, KEEP_ONE_BOARD, null, catalog.activeSessionId, null)
    }
    val remaining = sessions.filter { it.sessionId != sessionId }
    val nextActive = if (catalog.activeSessionId == sessionId) remaining.first().sessionId else catalog.activeSessionId
    val next = catalog.copy(
        catalogVersion = catalog.catalogVersion + 1,
        order = remaining.map { it.sessionId },
        sessions = remaining,
        activeSessionId = nextActive,
    )
    val forgotten = sessions.first { it.sessionId == sessionId }
    val stillUsed = remaining.any { it.credentialId == forgotten.credentialId }
    val steps = buildList {
        add(DiskOp.PutCatalog(next))
        add(DiskOp.ClearLocals(sessionId))
        if (!stillUsed) add(DiskOp.DeleteCredential(forgotten.credentialId))
    }
    return ForgetOutcome(
        allowed = true,
        message = null,
        tx = Transaction(steps, cutoverIndex = 0),
        nextActiveId = nextActive,
        clearedSessionId = sessionId,
    )
}

fun planRefresh(disk: PhoneDisk, credentialId: String, response: PairResponse): Transaction? {
    val current = disk.credentials[credentialId] ?: return null
    val secret = current.copy(
        deviceToken = response.deviceToken,
        deviceId = response.deviceId,
        expiresAt = response.expiresAt,
        boardIds = response.boardIds,
    )
    return Transaction(listOf(DiskOp.PutCredential(secret)), cutoverIndex = Int.MAX_VALUE)
}

fun planActivate(disk: PhoneDisk, sessionId: String): Transaction? {
    val catalog = disk.catalog ?: return null
    if (catalog.session(sessionId) == null) return null
    if (catalog.activeSessionId == sessionId) return Transaction(emptyList(), cutoverIndex = -1)
    val next = catalog.copy(catalogVersion = catalog.catalogVersion + 1, activeSessionId = sessionId)
    return Transaction(listOf(DiskOp.PutCatalog(next)), cutoverIndex = 0)
}

data class ListChrome(
    val sessionId: String?,
    val chip: TaskChip,
    val search: String,
    val detailTaskId: String?,
    val continuePrompt: String,
    val continueOpen: Boolean,
    val screen: String,
    val toast: String?,
)

fun activateChrome(chrome: ListChrome, target: PhoneSession, toast: Boolean): ListChrome = chrome.copy(
    sessionId = target.sessionId,
    search = "",
    detailTaskId = null,
    continuePrompt = "",
    continueOpen = false,
    screen = "tasks",
    toast = if (toast) SWITCHED_PREFIX + target.displayName else chrome.toast,
)

fun workspaceAfterSwitch(
    remembered: String?,
    full: List<ThinWorkspace>,
    tasks: List<RelayTask>,
    sawSnapshot: Boolean,
): String? = nextWorkspaceSelection(remembered, full, tasks, sawSnapshot).selectedId

fun filterWorkspaces(query: String, items: List<WorkspaceSwitchItem>): List<WorkspaceSwitchItem> {
    val needle = query.trim().lowercase(Locale.ROOT)
    if (needle.isEmpty()) return items
    return items.filter { item ->
        val name = item.label.lowercase(Locale.ROOT)
        val path = item.path?.lowercase(Locale.ROOT)
        name.contains(needle) || (path != null && path.contains(needle))
    }
}

data class WorkspaceMenu(val rows: List<WorkspaceSwitchItem>, val emptyCopy: String?)

fun workspaceMenu(
    query: String,
    workspaces: List<ThinWorkspace>,
    tasks: List<RelayTask>,
    sawSnapshot: Boolean,
    english: Boolean = false,
): WorkspaceMenu {
    if (!sawSnapshot) return WorkspaceMenu(emptyList(), null)
    val all = workspaceSwitchItems(tasks, workspaces, english)
    if (workspaces.isEmpty() && all.none { it.id == UNASSIGNED_WORKSPACE_ID }) {
        return WorkspaceMenu(emptyList(), if (english) "This board has no workspaces yet." else NO_WORKSPACE_COPY)
    }
    val rows = filterWorkspaces(query, all)
    if (rows.isEmpty()) {
        return WorkspaceMenu(emptyList(), if (english) "No matching workspace" else NO_MATCH_COPY)
    }
    return WorkspaceMenu(rows, null)
}

fun tasksForChip(tasks: List<RelayTask>, chip: TaskChip): List<RelayTask> = tasks.filter { task ->
    when (chip) {
        TaskChip.ALL -> task.status != ARCHIVED_STATUS
        TaskChip.TODO -> task.status == "queued"
        TaskChip.RUNNING -> task.status == "running" || task.status == "paused"
        TaskChip.DONE -> task.status in TERMINAL_STATUSES
        TaskChip.ARCHIVE -> false
    }
}

fun chipEmptyCopy(chip: TaskChip, english: Boolean = false): String = if (english) {
    "No tasks in this filter"
} else {
    FILTER_EMPTY_COPY
}

fun tasksAfterSessionSwitch(viewSessionId: String, activeSessionId: String?, tasks: List<RelayTask>): List<RelayTask> {
    if (activeSessionId.isNullOrEmpty() || viewSessionId != activeSessionId) return emptyList()
    return tasks.filter { it.status != ARCHIVED_STATUS }
}

fun switchedToast(displayName: String): String = SWITCHED_PREFIX + displayName

fun createKeepsChip(chip: TaskChip): TaskChip = chip

fun createHiddenBanner(chip: TaskChip): String? = if (chip == TaskChip.DONE || chip == TaskChip.ARCHIVE) CREATED_HIDDEN else null

data class SettingsAckEffect(
    val toastSaved: Boolean,
    val fillForm: Boolean,
    val markLoaded: Boolean,
    val toast: String? = null,
)

fun settingsAckEffect(
    activeSessionId: String?,
    commandSessionId: String,
    command: String,
    executed: Boolean,
    documentOk: Boolean,
): SettingsAckEffect {
    val same = executed && activeSessionId != null && activeSessionId == commandSessionId && documentOk
    if (!same) return SettingsAckEffect(toastSaved = false, fillForm = false, markLoaded = false)
    return when (command) {
        "cmd.workspace.update" -> SettingsAckEffect(true, fillForm = true, markLoaded = false, toast = SAVED_COPY)
        "cmd.settings.put" -> SettingsAckEffect(true, fillForm = true, markLoaded = true, toast = PROMPTS_SAVED_COPY)
        "cmd.workspace.get" -> SettingsAckEffect(false, fillForm = true, markLoaded = false)
        "cmd.settings.get" -> SettingsAckEffect(false, fillForm = true, markLoaded = true)
        else -> SettingsAckEffect(false, fillForm = false, markLoaded = false)
    }
}

data class PairBodyOutcome(
    val consumedCode: Boolean,
    val clearPairCode: Boolean,
    val insertCatalog: Boolean,
    val message: String?,
)

/** A 2xx body that does not parse already consumed the one-use code. Nothing is inserted. */
fun pairBodyOutcome(httpOk: Boolean, parsed: Boolean): PairBodyOutcome {
    if (!httpOk) return PairBodyOutcome(consumedCode = false, clearPairCode = false, insertCatalog = false, message = null)
    if (!parsed) {
        return PairBodyOutcome(consumedCode = true, clearPairCode = true, insertCatalog = false, message = CODE_CONSUMED_SAVE)
    }
    return PairBodyOutcome(consumedCode = true, clearPairCode = true, insertCatalog = true, message = null)
}

sealed interface ApplyVerdict {
    val disk: PhoneDisk
    val openSockets: Set<String>
    val activeSessionId: String?

    data class RolledBack(
        override val disk: PhoneDisk,
        override val openSockets: Set<String>,
        override val activeSessionId: String?,
    ) : ApplyVerdict

    data class InForce(
        override val disk: PhoneDisk,
        override val openSockets: Set<String>,
        override val activeSessionId: String?,
        val cleanupPending: Boolean,
    ) : ApplyVerdict
}

/** A failed step after the catalog commit leaves that catalog in force. It does not roll pairing back. */
fun failedStepKeepsCatalog(cutoverIndex: Int, failedIndex: Int): Boolean = failedIndex > cutoverIndex

fun applyVerdict(
    disk: PhoneDisk,
    openSockets: Set<String>,
    tx: Transaction,
    failAt: Int? = null,
    rollbackCommitFails: Boolean = false,
): ApplyVerdict {
    val sim = simulate(disk, openSockets, tx, failAt, rollbackCommitFails)
    if (!sim.cutover) {
        return ApplyVerdict.RolledBack(sim.disk, sim.openSockets, sim.activeSessionId)
    }
    return ApplyVerdict.InForce(
        disk = sim.disk,
        openSockets = sim.openSockets,
        activeSessionId = sim.activeSessionId,
        cleanupPending = failAt != null && failedStepKeepsCatalog(tx.cutoverIndex, failAt),
    )
}

sealed interface ArchiveQuery {
    data class Scoped(val workspaceId: String) : ArchiveQuery
    data class Unsupported(val message: String) : ArchiveQuery
}

fun archiveQuery(
    selectedWorkspaceId: String?,
    forwardsWorkspaceId: Boolean = ARCHIVE_LIST_FORWARDS_WORKSPACE,
): ArchiveQuery {
    if (!forwardsWorkspaceId || selectedWorkspaceId.isNullOrEmpty()) {
        return ArchiveQuery.Unsupported(ARCHIVE_SCOPE_UNSUPPORTED)
    }
    return ArchiveQuery.Scoped(selectedWorkspaceId)
}

fun archivePageHonorsScope(tasks: List<RelayTask>, workspaceId: String): Boolean {
    return tasks.all { it.workspaceId == workspaceId }
}

fun capabilityListed(capabilities: List<String>, name: String): Boolean = name in capabilities

const val CAP_WORKSPACE_SETTINGS = "workspace.settings"
const val CAP_BOARD_SETTINGS = "board.settings"
const val CAP_ARCHIVE_WRITE = "archive.write"

fun settingsEntry(capabilities: List<String>, capability: String): String? {
    if (capability !in capabilities) return UNSUPPORTED_COPY
    return null
}

data class ContinuePlan(val send: Boolean, val prompt: String?)

/** The phone never omits prompt. A blank composer does not build cmd.continue. */
fun planPhoneContinue(status: String, prompt: String, activeSessionId: String?, composerSessionId: String?): ContinuePlan {
    if (activeSessionId == null || activeSessionId != composerSessionId) return ContinuePlan(false, null)
    if (!canContinueStatus(status)) return ContinuePlan(false, null)
    val clean = prompt.trim()
    if (clean.isEmpty()) return ContinuePlan(false, null)
    return ContinuePlan(true, clean)
}

fun continueResult(
    activeSessionId: String?,
    commandSessionId: String,
    prompt: String,
    success: Boolean,
): Pair<String, Boolean> {
    if (activeSessionId != commandSessionId) return prompt to false
    return if (success) "" to true else prompt to false
}

data class RateNote(val count: Int, val detail: String)

/** Diagnostic counter only. The body is not stored, so a token or pair code cannot land in the note. */
fun recordRateLimit(count: Int): RateNote = RateNote(count + 1, "rate_limited")

fun relayHost(httpBase: String): String = try {
    java.net.URI(httpBase).host ?: httpBase
} catch (error: Exception) {
    httpBase
}

fun cardSubtitle(httpBase: String, boardId: String): String = "${relayHost(httpBase)} · $boardId"

fun expiryCopy(expiresAt: Long, formatted: String, english: Boolean = false): String = if (english) {
    "Sign-in expires at $formatted"
} else {
    "登录将于 $formatted 失效"
}
