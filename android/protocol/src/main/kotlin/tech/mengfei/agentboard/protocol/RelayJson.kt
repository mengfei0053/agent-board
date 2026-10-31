package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

class RelayFormatException(message: String) : IllegalArgumentException(message)

internal val relayJson = Json { ignoreUnknownKeys = true }

internal fun JsonObject.text(key: String): String? {
    val value = this[key] ?: return null
    if (value is JsonNull) return null
    val primitive = value as? JsonPrimitive ?: return null
    if (!primitive.isString) return null
    return primitive.content
}

internal fun JsonObject.longValue(key: String): Long? {
    val primitive = this[key] as? JsonPrimitive ?: return null
    if (primitive.isString) return null
    return primitive.longOrNull
}

internal fun JsonObject.bool(key: String): Boolean? {
    val primitive = this[key] as? JsonPrimitive ?: return null
    return primitive.booleanOrNull
}

internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

internal fun JsonObject.array(key: String): JsonArray? = this[key] as? JsonArray

fun parseEnvelope(text: String): Envelope {
    val element = try {
        relayJson.parseToJsonElement(text)
    } catch (error: Exception) {
        throw RelayFormatException("message is not JSON")
    }
    val root = element as? JsonObject ?: throw RelayFormatException("message must be an object")
    val version = root.longValue("v") ?: throw RelayFormatException("v is required")
    if (version != 1L) throw RelayFormatException("unsupported protocol version")
    val id = root.text("id") ?: throw RelayFormatException("id is required")
    if (id.isEmpty() || id.length > 100 || id.any { it.code !in 0x21..0x7E }) {
        throw RelayFormatException("id must be 1-100 visible ASCII characters")
    }
    val type = root.text("type") ?: throw RelayFormatException("type is required")
    val ts = root.longValue("ts") ?: throw RelayFormatException("ts is required")
    val payload = root.obj("payload") ?: JsonObject(emptyMap())
    return Envelope(v = 1, id = id, type = type, ts = ts, payload = payload)
}

fun encodeEnvelope(message: Envelope): String = buildJsonObject {
    put("v", message.v)
    put("id", message.id)
    put("type", message.type)
    put("ts", message.ts)
    put("payload", message.payload)
}.toString()

data class Envelope(
    val v: Int,
    val id: String,
    val type: String,
    val ts: Long,
    val payload: JsonObject,
)

fun Envelope.text(key: String): String? = payload.text(key)
