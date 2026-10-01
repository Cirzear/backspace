package io.github.backspace.mobile

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "BackspaceScreenShare",
    permissions = [Permission(alias = "audio", strings = [Manifest.permission.RECORD_AUDIO])],
)
class BackspaceScreenSharePlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private var startingCall: PluginCall? = null
    private var awaitingConsent = false

    override fun load() {
        main.post {
            ScreenShareSession.listener = { state, error ->
                val result = stateResult(state, error)
                notifyListeners("screenShareState", result)
                if (state != "starting") finishStart(state, error)
            }
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        main.post {
            if (awaitingConsent || ScreenShareSession.hasServiceLifecycle ||
                ScreenShareSession.state == "starting" || ScreenShareSession.state == "started") {
                call.reject("A screen share is already active", "SCREEN_SHARE_BUSY")
                return@post
            }
            try {
                val options = ScreenShareOptions.parse(call.data)
                if (options.shareAudio && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    call.reject("System audio sharing requires Android 10 or later", "SCREEN_SHARE_AUDIO_UNSUPPORTED")
                    ScreenShareSession.update("error", "SCREEN_SHARE_AUDIO_UNSUPPORTED")
                    return@post
                }
                startingCall = call
                ScreenShareSession.options = options
                ScreenShareSession.update("starting")
                if (getPermissionState("audio") != PermissionState.GRANTED) {
                    requestPermissionForAlias("audio", call, "audioPermissionResult")
                } else {
                    requestProjection(call)
                }
            } catch (error: Exception) {
                call.reject(error.message, "SCREEN_SHARE_INVALID_OPTIONS", error)
                ScreenShareSession.options = null
                ScreenShareSession.update("error", "SCREEN_SHARE_INVALID_OPTIONS")
            }
        }
    }

    @PermissionCallback
    private fun audioPermissionResult(call: PluginCall) {
        main.post {
            if (startingCall !== call) return@post
            if (getPermissionState("audio") != PermissionState.GRANTED) {
                fail("SCREEN_SHARE_AUDIO_PERMISSION_DENIED")
            } else {
                requestProjection(call)
            }
        }
    }

    private fun requestProjection(call: PluginCall) {
        try {
            val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            // Android 14 consent is one-shot. Never cache a successful result for the next share.
            awaitingConsent = true
            startActivityForResult(call, manager.createScreenCaptureIntent(), "projectionResult")
        } catch (error: Exception) {
            awaitingConsent = false
            fail("SCREEN_SHARE_CONSENT_FAILED")
        }
    }

    @ActivityCallback
    private fun projectionResult(call: PluginCall?, result: ActivityResult) {
        main.post {
            awaitingConsent = false
            if (call == null || startingCall !== call) return@post
            val consent = result.data
            if (result.resultCode != Activity.RESULT_OK || consent == null) {
                fail("SCREEN_SHARE_CANCELLED")
                return@post
            }
            try {
                val intent = Intent(context, ScreenShareService::class.java)
                    .putExtra(ScreenShareService.CONSENT, consent)
                ScreenShareSession.serviceLaunchPending = true
                ContextCompat.startForegroundService(context, intent)
            } catch (error: Exception) {
                ScreenShareSession.serviceLaunchPending = false
                fail("SCREEN_SHARE_SERVICE_FAILED")
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        main.post {
            ScreenShareSession.stop {
                call.resolve(stateResult(ScreenShareSession.state, ScreenShareSession.error))
            }
        }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        main.post { call.resolve(stateResult(ScreenShareSession.state, ScreenShareSession.error)) }
    }

    @PluginMethod
    fun updateAudioState(call: PluginCall) {
        main.post {
            try {
                val state = NativeAudioState.parse(call.data)
                val service = checkNotNull(ScreenShareSession.service) { "Screen sharing is not active" }
                service.updateAudioState(state) { error ->
                    if (error == null) call.resolve() else call.reject(error, "SCREEN_SHARE_AUDIO_UPDATE_FAILED")
                }
            } catch (error: Exception) {
                call.reject(error.message, "SCREEN_SHARE_AUDIO_UPDATE_FAILED", error)
            }
        }
    }

    override fun handleOnDestroy() {
        main.post {
            // Backgrounding is allowed; destroying the bridge/activity is not an orphaned call.
            ScreenShareSession.stop()
            ScreenShareSession.listener = null
        }
    }

    private fun fail(code: String) {
        ScreenShareSession.options = null
        ScreenShareSession.update("error", code)
    }

    private fun finishStart(state: String, error: String?) {
        val call = startingCall ?: return
        startingCall = null
        if (state == "started") call.resolve(stateResult(state, null))
        else call.reject(error ?: "Screen share stopped before startup completed", error ?: "SCREEN_SHARE_CANCELLED")
    }

    private fun stateResult(state: String, error: String?) = JSObject().apply {
        put("state", state)
        if (error != null) put("error", error)
    }
}

/** Main-thread only, in-memory handoff. Credentials never go into saved state or service intents. */
internal object ScreenShareSession {
    var state = "stopped"
        private set
    var error: String? = null
        private set
    var options: ScreenShareOptions? = null
    var service: ScreenShareService? = null
    var serviceLaunchPending = false
    val hasServiceLifecycle: Boolean get() = serviceLaunchPending || service != null
    var listener: ((String, String?) -> Unit)? = null
    private val stopCompletions = mutableListOf<() -> Unit>()

    fun update(value: String, failure: String? = null) {
        state = value
        error = failure
        listener?.invoke(value, failure)
    }

    fun stop(complete: (() -> Unit)? = null) {
        options = null
        if (hasServiceLifecycle) {
            complete?.let { stopCompletions.add(it) }
            // A pending foreground launch must reach onStartCommand and post its notification
            // before stopping. Clearing options cancels capture without skipping that contract.
            if (!serviceLaunchPending) service?.stopSharing()
        } else {
            update("stopped")
            complete?.invoke()
        }
    }

    fun serviceDestroyed(destroyed: ScreenShareService, failure: String?) {
        if (service !== destroyed) return
        service = null
        serviceLaunchPending = false
        val completions = stopCompletions.toList()
        stopCompletions.clear()
        // stopSelf() only queues destruction. Publish termination only after onDestroy,
        // otherwise await stop(); start() can target the old, already-stopped Service.
        update(if (failure == null) "stopped" else "error", failure)
        completions.forEach { it() }
    }
}
