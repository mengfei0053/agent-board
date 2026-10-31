package tech.mengfei.agentboard.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

data class HttpResult(val code: Int, val body: String)

interface SocketListener {
    fun onOpen()
    fun onMessage(text: String)
    fun onClosed(reason: String)
}

interface RelayApi {
    suspend fun request(method: String, url: String, body: String?): HttpResult
    fun openSocket(url: String, listener: SocketListener)
    fun send(text: String): Boolean
    fun closeSocket()
}

class OkHttpRelay : RelayApi {
    private val json = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    private val socket = AtomicReference<WebSocket?>(null)

    override suspend fun request(method: String, url: String, body: String?): HttpResult = withContext(Dispatchers.IO) {
        val call = Request.Builder().url(url)
        val built = if (method == "GET") {
            call.get()
        } else {
            call.method(method, (body ?: "").toRequestBody(json))
        }.build()
        http.newCall(built).execute().use { response ->
            HttpResult(response.code, response.body?.string().orEmpty())
        }
    }

    override fun openSocket(url: String, listener: SocketListener) {
        closeSocket()
        val request = Request.Builder().url(url).build()
        val opened = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onClosed(reason.ifBlank { "socket closed" })
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onClosed(t.message ?: "socket failed")
            }
        })
        socket.set(opened)
    }

    override fun send(text: String): Boolean = socket.get()?.send(text) == true

    override fun closeSocket() {
        socket.getAndSet(null)?.close(1000, "bye")
    }
}
