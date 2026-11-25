package tech.mengfei.agentboard.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

internal object DiagnosticHttp {
    private val http by lazy {
        OkHttpClient
            .Builder()
            .callTimeout(10, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build()
    }

    fun post(
        target: DiagnosticTarget,
        rows: List<DiagnosticRow>,
    ): Set<String> {
        val url = target.httpBase.toHttpUrl()
        require(url.username.isEmpty() && url.password.isEmpty() && url.encodedPath == "/" && url.query == null && url.fragment == null)
        val body =
            buildJsonObject {
                putJsonArray("entries") {
                    for (row in rows) {
                        addJsonObject {
                            put("id", row.id.toString())
                            put("ts", row.ts)
                            put("level", row.event.level)
                            put("event", row.event.name.lowercase())
                        }
                    }
                }
            }
        val request =
            Request
                .Builder()
                .url(url.newBuilder().encodedPath("/api/device/logs").build())
                .header("Authorization", "Bearer ${target.deviceToken}")
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()
        return http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return emptySet()
            // Bound decoded bytes too (chunked/gzip/incorrect Content-Length).
            val source = response.body?.source() ?: return emptySet()
            if (source.request(8193)) return emptySet()
            val obj = Json.parseToJsonElement(source.readUtf8()) as? JsonObject ?: return emptySet()
            val ids = obj["acked"] as? JsonArray ?: return emptySet()
            ids.map { (it as? JsonPrimitive)?.takeIf { id -> id.isString }?.content ?: return emptySet() }.toSet()
        }
    }
}
