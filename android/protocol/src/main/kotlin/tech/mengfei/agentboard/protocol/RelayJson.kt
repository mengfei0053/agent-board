package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

val relayJson: Json = Json { ignoreUnknownKeys = true }

internal fun JsonObject.text(key: String): String? {
    val element = this[key] ?: return null
    if (element is JsonNull) return null
    val primitive = element as? JsonPrimitive ?: return null
    return if (primitive.isString) primitive.content else null
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
    val root = try {
        relayJson.parseToJsonElement(text) as? JsonObject
            ?: throw RelayFormatException("message must be an object")
    } catch (e: RelayFormatException) {
        throw e
    } catch (e: Exception) {
        throw RelayFormatException("message is not JSON")
    }
    val version = root.longValue("v") ?: throw RelayFormatException("v is required")
    if (version != 1L) throw RelayFormatException("unsupported protocol version")
    val id = root.text("id") ?: throw RelayFormatException("id is required")
    if (id.isEmpty() || id.length > 100 || id.any { it < '!' || it.code > 126 }) {
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
