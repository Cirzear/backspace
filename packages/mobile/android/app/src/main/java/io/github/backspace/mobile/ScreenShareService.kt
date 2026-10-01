package io.github.backspace.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

/** Owns capture and voice while other apps are visible; never restarts without fresh system consent. */
class ScreenShareService : Service() {
    companion object {
        const val CONSENT = "projectionConsent"
        private const val STOP = "io.github.backspace.mobile.STOP_SCREEN_SHARE"
        private const val CHANNEL = "backspace_screen_share"
        private const val NOTIFICATION_ID = 8101
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val audioLock = Mutex()
    private var startup: Job? = null
    private var rooms: NativeShareRooms? = null
    private var socket: NativeVoiceSocket? = null
    private var stopped = false
    private var terminalError: String? = null

    override fun onCreate() {
        super.onCreate()
        ScreenShareSession.service = this
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ScreenShareSession.serviceLaunchPending = false
        if (intent?.action == STOP) {
            stopSharing()
            return START_NOT_STICKY
        }
        if (stopped || startup != null) return START_NOT_STICKY
        val options = ScreenShareSession.options
        @Suppress("DEPRECATION")
        val consent = intent?.getParcelableExtra<Intent>(CONSENT)
        ScreenShareSession.options = null
        try {
            // Even a launch cancelled before onStartCommand must satisfy Android's
            // startForegroundService contract before it immediately tears down.
            showNotification()
            if (options == null || consent == null) {
                stopSharing()
                return START_NOT_STICKY
            }
            startup = scope.launch {
                try {
                    val media = NativeShareRooms(applicationContext, scope, ::fail)
                    rooms = media
                    val session = NativeVoiceSocket(scope, { muted, deafened ->
                        audioLock.withLock { media.updateRestrictions(muted, deafened) }
                    }, ::fail)
                    socket = session
                    withTimeout(60_000) {
                        // Obtain authoritative moderation state before opening the microphone.
                        session.connect(options)
                        media.start(options, consent)
                    }
                    if (!stopped) ScreenShareSession.update("started")
                } catch (error: CancellationException) {
                    if (!stopped) fail("SCREEN_SHARE_START_TIMEOUT")
                } catch (error: Exception) {
                    Log.e("BackspaceScreenShare", "Native screen sharing startup failed", error)
                    fail("SCREEN_SHARE_START_FAILED")
                }
            }
        } catch (error: Exception) {
            Log.e("BackspaceScreenShare", "Foreground service startup failed", error)
            fail("SCREEN_SHARE_SERVICE_FAILED")
        }
        return START_NOT_STICKY
    }

    private fun showNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL, getString(R.string.screen_share_channel), NotificationManager.IMPORTANCE_LOW,
            ))
        }
        val stopIntent = PendingIntent.getService(this, 0, Intent(this, ScreenShareService::class.java).setAction(STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val openIntent = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_screen_share)
            .setContentTitle(getString(R.string.screen_share_title))
            .setContentText(getString(R.string.screen_share_body))
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(R.drawable.ic_screen_share, getString(R.string.screen_share_stop), stopIntent)
            .build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        } else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    }

    internal fun updateAudioState(state: NativeAudioState, complete: (String?) -> Unit) {
        scope.launch {
            try {
                check(!stopped && ScreenShareSession.state == "started") { "Screen share is not active" }
                audioLock.withLock { checkNotNull(rooms).updateAudioState(state) }
                complete(null)
            } catch (error: Exception) {
                complete("SCREEN_SHARE_AUDIO_UPDATE_FAILED")
                fail("SCREEN_SHARE_AUDIO_UPDATE_FAILED")
            }
        }
    }

    private fun fail(code: String) {
        // Projection and WebRTC callbacks may come from native worker threads.
        scope.launch {
            if (code == "SCREEN_SHARE_PROJECTION_STOPPED") stopSharing()
            else stopSharing(code)
        }
    }

    internal fun stopSharing(error: String? = null) {
        if (stopped) return
        stopped = true
        startup?.cancel()
        socket?.close()
        socket = null
        terminalError = error
        try {
            rooms?.close()
        } catch (releaseError: Exception) {
            terminalError = "SCREEN_SHARE_RELEASE_FAILED"
        }
        rooms = null
        ScreenShareSession.options = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSharing()
    }

    override fun onDestroy() {
        stopSharing()
        scope.cancel()
        super.onDestroy()
        // Run after Android's destroy callback has returned, not merely after stopSelf().
        Handler(Looper.getMainLooper()).post {
            ScreenShareSession.serviceDestroyed(this, terminalError)
        }
    }
}
