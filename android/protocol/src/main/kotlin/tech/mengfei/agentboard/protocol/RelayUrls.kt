package tech.mengfei.agentboard.protocol

import java.net.URI

const val DEFAULT_RELAY_HTTP = "https://relay.mengfei.tech"

fun normalizeHttpBase(input: String): String {
    val uri = parseRelayUri(input)
    val scheme = uri.scheme.lowercase()
    if (scheme != "http" && scheme != "https") {
        throw RelayFormatException("relay HTTP URL must be http or https")
    }
    val port = if (uri.port == -1) "" else ":${uri.port}"
    return "$scheme://${uri.host}$port"
}

fun deriveWsUrl(httpBase: String): String {
    val uri = parseRelayUri(httpBase)
    val scheme = when (val raw = uri.scheme.lowercase()) {
        "https" -> "wss"
        "http" -> "ws"
        "wss", "ws" -> raw
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
    } catch (error: Exception) {
        throw RelayFormatException("relay URL is invalid")
    }
    if (uri.scheme.isNullOrBlank()) throw RelayFormatException("relay URL needs a scheme")
    if (uri.host.isNullOrBlank()) throw RelayFormatException("relay URL needs a host")
    return uri
}
