package io.github.backspace.mobile

import org.json.JSONObject
import java.net.URI

/** Only the bundled SPA can invoke the bridge, but its arguments remain an input boundary. */
internal data class ScreenShareOptions(
    val url: String,
    val token: String,
    val voiceToken: String,
    val wsUrl: String,
    val wsToken: String,
    val identity: String,
    val width: Int,
    val height: Int,
    val frameRate: Int,
    val bitrate: Int,
    val shareAudio: Boolean,
    val audio: NativeAudioState,
) {
    companion object {
        fun parse(json: JSONObject): ScreenShareOptions {
            val width = integer(json, "width", 0..8192)
            val height = integer(json, "height", 0..8192)
            require((width == 0) == (height == 0)) { "width and height must both be zero or positive" }
            return ScreenShareOptions(
                secureUrl(json, "url"), text(json, "token"), text(json, "voiceToken"),
                secureUrl(json, "wsUrl"), text(json, "wsToken"), text(json, "identity"),
                width, height, integer(json, "frameRate", 1..120),
                integer(json, "bitrate", 1..100_000_000), boolean(json, "shareAudio"),
                NativeAudioState.parse(json),
            )
        }

        private fun text(json: JSONObject, key: String): String {
            val value = json.get(key)
            require(value is String && value.isNotBlank() && value.length <= 16384) { "Invalid $key" }
            return value
        }

        private fun secureUrl(json: JSONObject, key: String): String {
            val value = text(json, key)
            val uri = URI(value)
            require(uri.scheme == "wss" && !uri.host.isNullOrEmpty() && uri.userInfo == null && uri.fragment == null) {
                "$key must be a secure WebSocket URL"
            }
            return value
        }

        private fun integer(json: JSONObject, key: String, range: IntRange): Int {
            val value = json.get(key)
            require(value is Number && value.toDouble() == value.toInt().toDouble() && value.toInt() in range) {
                "Invalid $key"
            }
            return value.toInt()
        }

        internal fun boolean(json: JSONObject, key: String): Boolean {
            val value = json.get(key)
            require(value is Boolean) { "$key must be boolean" }
            return value
        }
    }
}

internal data class NativeAudioState(val micMuted: Boolean, val deafened: Boolean) {
    companion object {
        fun parse(json: JSONObject) = NativeAudioState(
            ScreenShareOptions.boolean(json, "micMuted"),
            ScreenShareOptions.boolean(json, "deafened"),
        )
    }
}
