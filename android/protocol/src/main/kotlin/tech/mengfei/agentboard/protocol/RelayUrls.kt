package tech.mengfei.agentboard.protocol

import java.net.URI
import java.util.Locale

const val DEFAULT_RELAY_HTTP = "https://relay.mengfei.tech"

fun normalizeHttpBase(input: String): String {
    val uri = parseRelayUri(input)
    val scheme = uri.scheme.lowercase(Locale.ROOT)
    if (scheme != "http" && scheme != "https") {
        throw RelayFormatException("relay HTTP URL must be http or https")
    }
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return "$scheme://${uri.host}$port"
}

fun deriveWsUrl(httpBase: String): String {
    val uri = parseRelayUri(httpBase)
    val raw = uri.scheme.lowercase(Locale.ROOT)
    val scheme = when (raw) {
        "http" -> "ws"
        "https" -> "wss"
        "ws", "wss" -> raw
        else -> throw RelayFormatException("relay URL must be http or https")
    }
    val path = uri.rawPath ?: ""
    val wsPath = if (path.endsWith("/v1/ws")) path else "/v1/ws"
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return "$scheme://${uri.host}$port$wsPath"
}

private fun parseRelayUri(input: String): URI {
    val trimmed = input.trim().trimEnd('/')
    if (trimmed.isEmpty()) throw RelayFormatException("relay URL is required")
    val uri = try {
        URI(trimmed)
    } catch (e: Exception) {
        throw RelayFormatException("relay URL is invalid")
    }
    val scheme = uri.scheme
    if (scheme.isNullOrBlank()) throw RelayFormatException("relay URL needs a scheme")
    if (uri.host.isNullOrBlank()) throw RelayFormatException("relay URL needs a host")
    return uri
}
