package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class PairResponse(
    val deviceId: String,
    val deviceToken: String,
    val role: String,
    val boardIds: List<String>,
    val expiresAt: Long,
)

fun encodePairBody(pairCode: String, deviceName: String): String = buildJsonObject {
    put("pairCode", pairCode)
    put("deviceName", deviceName)
}.toString()

fun encodeRefreshBody(deviceToken: String): String = buildJsonObject {
    put("deviceToken", deviceToken)
}.toString()

fun parsePairResponse(text: String): PairResponse {
    val root = try {
        relayJson.parseToJsonElement(text)
    } catch (error: Exception) {
        throw RelayFormatException("pair response is not JSON")
    } as? JsonObject ?: throw RelayFormatException("pair response must be an object")
    val deviceId = root.text("deviceId")?.takeIf { it.isNotBlank() }
        ?: throw RelayFormatException("deviceId is required")
    val deviceToken = root.text("deviceToken")?.takeIf { it.isNotBlank() }
        ?: throw RelayFormatException("deviceToken is required")
    val role = root.text("role") ?: throw RelayFormatException("role is required")
    if (role != "phone") throw RelayFormatException("role must be phone")
    val boardIds = root.array("boardIds") ?: throw RelayFormatException("boardIds is required")
    val ids = boardIds.map { item ->
        val primitive = item as? JsonPrimitive
        if (primitive == null || !primitive.isString || primitive.content.isBlank()) {
            throw RelayFormatException("boardIds must be strings")
        }
        primitive.content
    }
    val expiresAt = root.longValue("expiresAt") ?: throw RelayFormatException("expiresAt is required")
    return PairResponse(deviceId, deviceToken, role, ids, expiresAt)
}

fun parseRelayError(text: String): String {
    val root = try {
        relayJson.parseToJsonElement(text) as? JsonObject
    } catch (error: Exception) {
        null
    }
    val error = root?.obj("error")
    val code = error?.text("code")
    val message = error?.text("message")
    return when {
        code != null && message != null -> "$code: $message"
        message != null -> message
        text.isBlank() -> "relay request failed"
        else -> text.take(300)
    }
}

fun parseHealth(text: String): HealthStatus? {
    val root = try {
        relayJson.parseToJsonElement(text) as? JsonObject
    } catch (error: Exception) {
        return null
    } ?: return null
    if (root.bool("ok") != true) return null
    return HealthStatus(boardsOnline = root.longValue("boardsOnline") ?: 0)
}

data class HealthStatus(val boardsOnline: Long)

fun interface DeviceTokenStore {
    fun saveToken(response: PairResponse): Boolean
}

/** Test double for a secure store whose commit() can fail without throwing. */
class FakeDeviceTokenStore(var commitSucceeds: Boolean = true) : DeviceTokenStore {
    var stored: PairResponse? = null
        private set

    override fun saveToken(response: PairResponse): Boolean {
        if (!commitSucceeds) return false
        stored = response
        return true
    }
}

sealed interface PairGate {
    data object OpenSocket : PairGate
    data class Hold(val message: String) : PairGate
}

fun persistThenConnect(saved: Boolean): PairGate = if (saved) {
    PairGate.OpenSocket
} else {
    PairGate.Hold("Could not store the device token. Not connecting.")
}
