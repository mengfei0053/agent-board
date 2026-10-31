package tech.mengfei.agentboard.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import tech.mengfei.agentboard.protocol.DEFAULT_RELAY_HTTP
import tech.mengfei.agentboard.protocol.PairResponse
import tech.mengfei.agentboard.protocol.deriveWsUrl

data class SavedSession(
    val httpBase: String,
    val wsUrl: String,
    val deviceName: String,
    val deviceToken: String?,
    val deviceId: String?,
    val expiresAt: Long?,
    val secure: Boolean,
)

/**
 * Device token stays in EncryptedSharedPreferences. Relay URL and the device name are not secrets.
 * If the keystore cannot open, the token is not written to plain preferences.
 */
class SessionStore(context: Context) {
    private val plain = context.applicationContext.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE)
    private val secret: SharedPreferences? = openSecret(context.applicationContext)
    val secure: Boolean = secret != null

    fun read(): SavedSession {
        val base = plain.getString(KEY_HTTP, null) ?: DEFAULT_RELAY_HTTP
        val ws = plain.getString(KEY_WS, null) ?: deriveWsUrl(base)
        val expires = secret?.getLong(KEY_EXPIRES, 0L) ?: 0L
        return SavedSession(
            httpBase = base,
            wsUrl = ws,
            deviceName = plain.getString(KEY_NAME, null) ?: "Android phone",
            deviceToken = secret?.getString(KEY_TOKEN, null)?.takeIf { it.isNotBlank() },
            deviceId = secret?.getString(KEY_DEVICE, null),
            expiresAt = expires.takeIf { it > 0L },
            secure = secure,
        )
    }

    fun saveRelay(httpBase: String, wsUrl: String, deviceName: String) {
        plain.edit()
            .putString(KEY_HTTP, httpBase)
            .putString(KEY_WS, wsUrl)
            .putString(KEY_NAME, deviceName.ifBlank { "Android phone" })
            .apply()
    }

    fun saveToken(paired: PairResponse): Boolean {
        val prefs = secret ?: return false
        return prefs.edit()
            .putString(KEY_TOKEN, paired.deviceToken)
            .putString(KEY_DEVICE, paired.deviceId)
            .putLong(KEY_EXPIRES, paired.expiresAt)
            .commit()
    }

    fun clearToken() {
        secret?.edit()?.remove(KEY_TOKEN)?.remove(KEY_DEVICE)?.remove(KEY_EXPIRES)?.commit()
    }

    /** Phone-local workspace selection, same role as the web board's localStorage key. `""` is 「未分配」. */
    fun selectedWorkspace(boardId: String): String? = plain.getString(workspaceKey(boardId), null)

    fun saveSelectedWorkspace(boardId: String, workspaceId: String?) {
        val edit = plain.edit()
        if (workspaceId == null) edit.remove(workspaceKey(boardId)) else edit.putString(workspaceKey(boardId), workspaceId)
        edit.apply()
    }

    private fun openSecret(context: Context): SharedPreferences? {
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

    private companion object {
        const val SETTINGS = "agent_board_settings"
        const val SECRET_FILE = "agent_board_secrets"
        const val KEY_HTTP = "http_base"
        const val KEY_WS = "ws_url"
        const val KEY_NAME = "device_name"
        const val KEY_TOKEN = "device_token"
        const val KEY_DEVICE = "device_id"
        const val KEY_EXPIRES = "expires_at"

        fun workspaceKey(boardId: String) = "ws_$boardId"
    }
}
