package io.github.backspace.mobile

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Keeps the existing voice session alive without displacing the Web socket or joining another room. */
internal class NativeVoiceSocket(
    private val scope: CoroutineScope,
    private val onRestrictions: suspend (Boolean, Boolean) -> Unit,
    private val onFailure: (String) -> Unit,
) {
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private val bound = CompletableDeferred<Unit>()
    private var socket: WebSocket? = null
    private var userId: String? = null
    private var identity: String? = null
    @Volatile private var closed = false
    private var forcedMute = false
    private var permissionMute = false
    private var forcedDeafen = false

    suspend fun connect(options: ScreenShareOptions) {
        identity = options.identity
        socket = client.newWebSocket(Request.Builder().url(options.wsUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                send(webSocket, JSONObject().put("type", "auth").put("token", options.wsToken).put("client", "mobile"))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch {
                    try {
                        receive(webSocket, JSONObject(text))
                    } catch (error: Exception) {
                        fail("SCREEN_SHARE_VOICE_SESSION_FAILED")
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                if (!closed) scope.launch { fail("SCREEN_SHARE_VOICE_SESSION_FAILED") }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                if (!closed) scope.launch { fail("SCREEN_SHARE_VOICE_SESSION_CLOSED") }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!closed) scope.launch { fail("SCREEN_SHARE_VOICE_SESSION_CLOSED") }
            }
        })
        withTimeout(15_000) { bound.await() }
    }

    private suspend fun receive(webSocket: WebSocket, event: JSONObject) {
        if (closed) return
        when (event.getString("type")) {
            "ready" -> send(webSocket, JSONObject().put("type", "native_voice_bind").put("identity", identity))
            "native_voice_bound" -> {
                check(event.getString("identity") == identity) { "Native voice binding identity mismatch" }
                userId = event.getString("userId")
                forcedMute = event.getBoolean("spaceMuted")
                permissionMute = event.getBoolean("permissionMuted")
                forcedDeafen = event.getBoolean("deafened")
                onRestrictions(forcedMute || permissionMute, forcedDeafen)
                bound.complete(Unit)
            }
            "error" -> fail("SCREEN_SHARE_VOICE_SESSION_REJECTED")
            "voice_space_muted", "voice_permission_muted", "voice_space_deafened" -> restriction(event)
            "voice_disconnected", "voice_moved" -> if (event.optString("userId") == userId) fail("SCREEN_SHARE_VOICE_SESSION_ENDED")
        }
    }

    private suspend fun restriction(event: JSONObject) {
        if (event.optString("userId") != userId) return
        when (event.getString("type")) {
            "voice_space_muted" -> forcedMute = event.getBoolean("muted")
            "voice_permission_muted" -> permissionMute = event.getBoolean("muted")
            "voice_space_deafened" -> forcedDeafen = event.getBoolean("deafened")
        }
        onRestrictions(forcedMute || permissionMute, forcedDeafen)
    }

    private fun send(webSocket: WebSocket, event: JSONObject) {
        check(webSocket.send(event.toString())) { "Native voice WebSocket send failed" }
    }

    private fun fail(code: String) {
        if (closed) return
        bound.completeExceptionally(IllegalStateException(code))
        onFailure(code)
    }

    fun close() {
        closed = true
        socket?.close(1000, "Screen sharing stopped")
        socket?.cancel()
        socket = null
        identity = null
        userId = null
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }
}
