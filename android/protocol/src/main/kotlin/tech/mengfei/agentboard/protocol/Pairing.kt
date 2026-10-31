package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun encodePairBody(pairCode: String, deviceName: String): String = buildJsonObject {
    put("pairCode", pairCode)
    put("deviceName", deviceName)
}.toString()

fun encodeRefreshBody(deviceToken: String): String = buildJsonObject {
    put("deviceToken", deviceToken)
}.toString()

fun parsePairResponse(text: String): PairResponse {
    val root = try {
        relayJson.parseToJsonElement(text) as? JsonObject
            ?: throw RelayFormatException("pair response must be an object")
    } catch (e: RelayFormatException) {
        throw e
    } catch (e: Exception) {
        throw RelayFormatException("pair response is not JSON")
    }
    val deviceId = root.text("deviceId")?.takeUnless { it.isBlank() }
        ?: throw RelayFormatException("deviceId is required")
    val deviceToken = root.text("deviceToken")?.takeUnless { it.isBlank() }
        ?: throw RelayFormatException("deviceToken is required")
    val role = root.text("role") ?: throw RelayFormatException("role is required")
    if (role != "phone") throw RelayFormatException("role must be phone")
    val ids = root.array("boardIds") ?: throw RelayFormatException("boardIds is required")
    val boardIds = ids.map { element ->
        val primitive = element as? JsonPrimitive
        if (primitive == null || !primitive.isString || primitive.content.isBlank()) {
            throw RelayFormatException("boardIds must be strings")
        }
        primitive.content
    }
    val expiresAt = root.longValue("expiresAt") ?: throw RelayFormatException("expiresAt is required")
    return PairResponse(deviceId, deviceToken, role, boardIds, expiresAt)
}

fun parseRelayError(text: String): String {
    val root = try {
        relayJson.parseToJsonElement(text) as? JsonObject
    } catch (e: Exception) {
        null
    }
    val error = root?.obj("error")
    val code = error?.text("code")
    val message = error?.text("message")
    if (code != null && message != null) return "$code: $message"
    if (message != null) return message
    return if (text.isBlank()) "relay request failed" else text.take(300)
}

fun parseHealth(text: String): HealthStatus? = try {
    val root = relayJson.parseToJsonElement(text) as? JsonObject
    if (root == null || root.bool("ok") != true) {
        null
    } else {
        HealthStatus(root.longValue("boardsOnline") ?: 0L)
    }
} catch (e: Exception) {
    null
}

fun persistThenConnect(saved: Boolean): PairGate = if (saved) {
    PairGate.OpenSocket
} else {
    PairGate.Hold("Could not store the device token. Not connecting.")
}
