package tech.mengfei.agentboard.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import tech.mengfei.agentboard.protocol.CatalogDocument
import tech.mengfei.agentboard.protocol.CredentialSecret
import tech.mengfei.agentboard.protocol.DEFAULT_RELAY_HTTP
import tech.mengfei.agentboard.protocol.DiskOp
import tech.mengfei.agentboard.protocol.LegacyToken
import tech.mengfei.agentboard.protocol.PhoneDisk
import tech.mengfei.agentboard.protocol.decodeCatalog
import tech.mengfei.agentboard.protocol.decodeCredential
import tech.mengfei.agentboard.protocol.deriveWsUrl
import tech.mengfei.agentboard.protocol.encodeCatalog
import tech.mengfei.agentboard.protocol.encodeCredential
import tech.mengfei.agentboard.protocol.reduceDisk

/**
 * Tokens stay in EncryptedSharedPreferences. The plain catalog is a separate commit.
 * A crash between those commits is recovered by [tech.mengfei.agentboard.protocol.recoverLaunch].
 */
class SessionStore internal constructor(
    private val plain: SharedPreferences,
    private val secret: SharedPreferences?,
) {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE),
        openSecret(context.applicationContext),
    )

    val secure: Boolean = secret != null
    private var cache: PhoneDisk = load()

    fun readDisk(): PhoneDisk = cache

    fun apply(op: DiskOp): Boolean {
        if (!write(op)) return false
        cache = reduceDisk(cache, op)
        return true
    }

    fun applyAll(ops: List<DiskOp>): Boolean {
        ops.forEach { if (!apply(it)) return false }
        return true
    }

    fun saveIdentity(httpBase: String, deviceName: String) {
        if (!plain.edit().putString(KEY_HTTP, httpBase).putString(KEY_NAME, deviceName).commit()) return
        cache = cache.copy(defaultHttpBase = httpBase, deviceName = deviceName.ifBlank { "Android phone" })
    }

    private fun load(): PhoneDisk {
        val http = plain.getString(KEY_HTTP, null) ?: DEFAULT_RELAY_HTTP
        val name = plain.getString(KEY_NAME, null) ?: "Android phone"
        val workspaces = mutableMapOf<String, String>()
        val drafts = mutableMapOf<String, String>()
        val cursors = mutableMapOf<String, String>()
        plain.all.forEach { (key, value) ->
            val text = value as? String ?: return@forEach
            when {
                key.startsWith(WS_PREFIX) && key != KEY_WS -> workspaces[key.removePrefix(WS_PREFIX)] = text
                key.startsWith(DRAFT_PREFIX) -> drafts[key.removePrefix(DRAFT_PREFIX)] = text
                key.startsWith(CURSOR_PREFIX) -> cursors[key.removePrefix(CURSOR_PREFIX)] = text
            }
        }
        val catalog = plain.getString(KEY_CATALOG, null)?.let { decodeCatalog(it) }
        if (!secure || secret == null) {
            return PhoneDisk(
                secretsReadable = false,
                catalog = catalog,
                workspaces = workspaces,
                drafts = drafts,
                archiveCursors = cursors,
                deviceName = name,
                defaultHttpBase = http,
            )
        }
        val credentials = mutableMapOf<String, CredentialSecret>()
        secret.all.forEach { (key, value) ->
            if (!key.startsWith(CRED_PREFIX)) return@forEach
            val text = value as? String ?: return@forEach
            val decoded = decodeCredential(text) ?: return@forEach
            credentials[decoded.credentialId] = decoded
        }
        val token = secret.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() }
        val legacy = if (token == null) {
            null
        } else {
            val ws = plain.getString(KEY_WS, null) ?: try {
                deriveWsUrl(http)
            } catch (error: Exception) {
                ""
            }
            LegacyToken(
                httpBase = http,
                wsUrl = ws,
                deviceName = name,
                deviceToken = token,
                deviceId = secret.getString(KEY_DEVICE, null).orEmpty(),
                expiresAt = secret.getLong(KEY_EXPIRES, 0L),
            )
        }
        return PhoneDisk(
            secretsReadable = true,
            credentials = credentials,
            catalog = catalog,
            legacy = legacy,
            workspaces = workspaces,
            drafts = drafts,
            archiveCursors = cursors,
            deviceName = name,
            defaultHttpBase = http,
        )
    }

    private fun write(op: DiskOp): Boolean = when (op) {
        is DiskOp.PutCredential -> {
            val prefs = secret ?: return false
            prefs.edit().putString(CRED_PREFIX + op.secret.credentialId, encodeCredential(op.secret)).commit()
        }
        is DiskOp.DeleteCredential -> {
            val prefs = secret ?: return false
            prefs.edit().remove(CRED_PREFIX + op.credentialId).commit()
        }
        is DiskOp.PutCatalog -> {
            val edit = plain.edit().putString(KEY_CATALOG, encodeCatalog(op.catalog))
            op.workspacePuts.forEach { (id, value) -> edit.putString(WS_PREFIX + id, value) }
            edit.commit()
        }
        DiskOp.DeleteLegacy -> {
            val prefs = secret ?: return false
            prefs.edit().remove(KEY_TOKEN).remove(KEY_DEVICE).remove(KEY_EXPIRES).commit()
        }
        is DiskOp.ClearLocals -> plain.edit()
            .remove(WS_PREFIX + op.sessionId)
            .remove(DRAFT_PREFIX + op.sessionId)
            .remove(CURSOR_PREFIX + op.sessionId)
            .commit()
        is DiskOp.PutWorkspace -> {
            val edit = plain.edit()
            if (op.workspaceId == null) edit.remove(WS_PREFIX + op.sessionId) else edit.putString(WS_PREFIX + op.sessionId, op.workspaceId)
            edit.commit()
        }
    }

    private companion object {
        fun openSecret(context: Context): SharedPreferences? {
            return try {
                val masterKey = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
                EncryptedSharedPreferences.create(
                    SECRET_FILE,
                    masterKey,
                    context,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )
            } catch (error: Exception) {
                null
            }
        }

        const val SETTINGS = "agent_board_settings"
        const val SECRET_FILE = "agent_board_secrets"
        const val KEY_HTTP = "http_base"
        const val KEY_WS = "ws_url"
        const val KEY_NAME = "device_name"
        const val KEY_TOKEN = "device_token"
        const val KEY_DEVICE = "device_id"
        const val KEY_EXPIRES = "expires_at"
        const val KEY_CATALOG = "catalog"
        const val CRED_PREFIX = "cred_"
        const val WS_PREFIX = "ws_"
        const val DRAFT_PREFIX = "draft_"
        const val CURSOR_PREFIX = "arc_"
    }
}
