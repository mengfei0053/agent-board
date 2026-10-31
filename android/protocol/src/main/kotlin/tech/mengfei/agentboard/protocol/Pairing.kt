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

const val PAIR_CODE_LENGTH = 46

private val pairSuffix = Regex("^[A-Za-z0-9_-]{43}$")

enum class PairIssue {
    Empty,
    Prefix,
    Alphabet,
    Short,
    Long,
}

/** Outer whitespace only. Internal characters stay so the user can correct them. */
fun trimOuter(value: String): String = value.trim()

fun inspectPairCode(raw: String): PairIssue? {
    val code = trimOuter(raw)
    if (code.isEmpty()) return PairIssue.Empty
    if (code.length > PAIR_CODE_LENGTH) return PairIssue.Long
    if (!code.startsWith("pc_")) return PairIssue.Prefix
    if (code.length < PAIR_CODE_LENGTH) return PairIssue.Short
    if (!pairSuffix.matches(code.substring(3))) return PairIssue.Alphabet
    return null
}

fun pairSubmitAllowed(raw: String, httpBase: String, secure: Boolean, busy: Boolean): Boolean {
    if (!secure || busy) return false
    if (inspectPairCode(raw) != null) return false
    return try {
        deriveWsUrl(normalizeHttpBase(httpBase))
        true
    } catch (error: RelayFormatException) {
        false
    }
}

fun pairIssueMessage(issue: PairIssue, english: Boolean): String = when (issue) {
    PairIssue.Empty -> if (english) "Enter the pair code from the relay." else "请输入配对码。"
    PairIssue.Prefix -> if (english) "Pair codes start with pc_." else "配对码应以 pc_ 开头。"
    PairIssue.Alphabet -> if (english) "The pair code contains a character that is not allowed." else "配对码含有无效字符。"
    PairIssue.Short -> if (english) "The pair code is incomplete. A pc_ code is 46 characters." else "配对码不完整。完整的 pc_ 码是 46 位。"
    PairIssue.Long -> if (english) {
        "The pair code is longer than 46 characters and was not shortened."
    } else {
        "配对码超过 46 位，没有自动截断。请删掉多余内容。"
    }
}

/**
 * Unknown, expired, and already-used codes share one sentence.
 * Rate limiting stays distinct. The relay body is not shown.
 */
fun pairHttpFailure(httpCode: Int, body: String, english: Boolean): String {
    val code = relayErrorCode(body)
    if (httpCode == 429 || code == "rate_limited") {
        return if (english) {
            "Too many pair attempts. Wait and try again. This phone will not retry automatically."
        } else {
            "请求过于频繁，请稍后再试。不会自动重试。"
        }
    }
    if (httpCode == 401 || code == "unauthorized") {
        return if (english) {
            "Invalid or expired. Ask for a new pair code. It may be expired, already used, or mistyped — paste the full code."
        } else {
            "无效或已过期，请重新获取配对码。可能已过期、已使用或输入错误，请重新生成并粘贴完整配对码。"
        }
    }
    if (httpCode in 500..599) {
        return if (english) "The relay is unavailable. Try again later." else "中继暂不可用，请稍后重试。"
    }
    return if (english) "Could not pair with the relay." else "无法完成配对，请检查网络后再试。"
}

private fun relayErrorCode(text: String): String? {
    val root = try {
        relayJson.parseToJsonElement(text) as? JsonObject
    } catch (error: Exception) {
        null
    }
    return root?.obj("error")?.text("code")
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
