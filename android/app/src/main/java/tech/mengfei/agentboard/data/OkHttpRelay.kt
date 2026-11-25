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
import java.io.EOFException
import java.io.IOException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

data class HttpResult(val code: Int, val body: String)

internal fun networkReason(error: Throwable): DiagnosticReason = when (error) {
    is UnknownHostException -> DiagnosticReason.DNS
    is SSLException -> DiagnosticReason.TLS
    is SocketTimeoutException -> DiagnosticReason.TIMEOUT
    is java.net.ConnectException, is java.net.NoRouteToHostException -> DiagnosticReason.NETWORK
    is EOFException, is SocketException -> DiagnosticReason.DISCONNECTED
    is IOException -> DiagnosticReason.NETWORK
    else -> DiagnosticReason.UNKNOWN
}

internal fun httpReason(status: Int): DiagnosticReason = when (status) {
    400 -> DiagnosticReason.BAD_REQUEST
    401 -> DiagnosticReason.UNAUTHORIZED
    403 -> DiagnosticReason.FORBIDDEN
    404 -> DiagnosticReason.NOT_FOUND
    408, 504 -> DiagnosticReason.TIMEOUT
    413 -> DiagnosticReason.TOO_LARGE
    429 -> DiagnosticReason.RATE_LIMITED
    else -> DiagnosticReason.UNKNOWN
}

interface SocketListener {
    fun onOpen()
    fun onMessage(text: String)
    fun onInvalidFrame()
    fun onClosed(reason: DiagnosticReason)
}

interface RelayApi {
    suspend fun request(method: String, url: String, body: String?): HttpResult
    fun openSocket(credentialId: String, url: String, listener: SocketListener)
    fun send(credentialId: String, text: String): Boolean
    fun closeSocket(credentialId: String)
    fun closeAll()
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
    private val sockets = ConcurrentHashMap<String, WebSocket>()

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

    override fun openSocket(credentialId: String, url: String, listener: SocketListener) {
        sockets.remove(credentialId)?.close(1000, "bye")
        val request = Request.Builder().url(url).build()
        val opened = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onMessage(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                listener.onInvalidFrame()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onClosed(DiagnosticReason.DISCONNECTED)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onClosed(response?.takeUnless { it.isSuccessful || it.code == 101 }?.let { httpReason(it.code) } ?: networkReason(t))
            }
        })
        sockets[credentialId] = opened
    }

    override fun send(credentialId: String, text: String): Boolean = sockets[credentialId]?.send(text) == true

    override fun closeSocket(credentialId: String) {
        sockets.remove(credentialId)?.close(1000, "bye")
    }

    override fun closeAll() {
        sockets.keys.toList().forEach(::closeSocket)
    }
}
