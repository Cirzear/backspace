package io.github.backspace.mobile

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalScreencastVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import livekit.org.webrtc.ScreenCapturerAndroid
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.json.JSONObject

internal class NativeShareRooms(
    private val context: Context,
    private val scope: CoroutineScope,
    private val onFailure: (String) -> Unit,
) {
    private var screenRoom: Room? = null
    private var voiceRoom: Room? = null
    private var screenTrack: LocalScreencastVideoTrack? = null
    private var audioTrack: LocalAudioTrack? = null
    private var playback: PlaybackAudioCapture? = null
    private var screenAdm: JavaAudioDeviceModule? = null
    private val observers = mutableListOf<Job>()
    private var ownerIdentity = ""
    private var audioState = NativeAudioState(micMuted = true, deafened = true)
    private var closed = false
    private var serverMuted = false
    private var serverDeafened = false
    private val microphoneStarted = CompletableDeferred<Unit>()

    suspend fun start(options: ScreenShareOptions, consent: Intent) {
        audioState = options.audio
        LiveKit.init(context)
        val adm = JavaAudioDeviceModule.builder(context)
            .setInputSampleRate(PlaybackAudioCapture.SAMPLE_RATE)
            .setUseStereoInput(true)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setAudioRecordErrorCallback(audioErrors())
            .setAudioBufferCallback { buffer, format, channels, rate, _, _ ->
                if (format != android.media.AudioFormat.ENCODING_PCM_16BIT || channels != 2 || rate != PlaybackAudioCapture.SAMPLE_RATE) {
                    onFailure("SCREEN_SHARE_AUDIO_FORMAT_FAILED")
                    0L
                } else playback?.fill(buffer) ?: 0L
            }
            .createAudioDeviceModule()
        // This is recordingless mode, not a muted microphone. WebRTC never opens its mic AudioRecord.
        adm.setAudioRecordEnabled(false)
        screenAdm = adm
        val screen = LiveKit.create(context, overrides = LiveKitOverrides(audioOptions = AudioOptions(
            audioDeviceModule = adm, audioHandler = NoAudioHandler(),
            disableCommunicationModeWorkaround = true, disableAudioPrewarming = true,
        )))
        screenRoom = screen
        observe(screen)
        screen.connect(options.url, options.token, ConnectOptions(autoSubscribe = false))
        ownerIdentity = JSONObject(checkNotNull(screen.localParticipant.metadata)).getString("ownerIdentity")
        check(ownerIdentity.isNotBlank()) { "Screen token is missing ownerIdentity" }
        createScreen(screen, options, consent)
        val voice = LiveKit.create(context, overrides = LiveKitOverrides(audioOptions = AudioOptions(
            disableAudioPrewarming = true,
            javaAudioDeviceModuleCustomizer = {
                it.setAudioRecordErrorCallback(audioErrors())
                it.setAudioRecordStateCallback(object : JavaAudioDeviceModule.AudioRecordStateCallback {
                    override fun onWebRtcAudioRecordStart() { microphoneStarted.complete(Unit) }
                    override fun onWebRtcAudioRecordStop() = Unit
                })
                it.setAudioTrackErrorCallback(playbackErrors())
            },
        )))
        voiceRoom = voice
        observe(voice)
        voice.connect(options.url, options.voiceToken, ConnectOptions(autoSubscribe = false))
        updateAudioState(audioState)
    }

    private suspend fun createScreen(room: Room, options: ScreenShareOptions, consent: Intent) {
        val video = room.localParticipant.createScreencastTrack(
            name = "screen", mediaProjectionPermissionResultData = consent,
            options = LocalVideoTrackOptions(isScreencast = true, captureParams = VideoCaptureParameter(
                maxOf(options.width, options.height), minOf(options.width, options.height), options.frameRate,
            )),
            onStop = { if (!closed) onFailure("SCREEN_SHARE_PROJECTION_STOPPED") },
        )
        screenTrack = video
        video.startCapture()
        check(room.localParticipant.publishVideoTrack(video, VideoTrackPublishOptions(
            source = Track.Source.SCREEN_SHARE, simulcast = false,
            videoEncoding = VideoEncoding(options.bitrate, options.frameRate),
        ))) { "Screen video publication failed" }
        if (options.shareAudio) createPlayback(room, video)
    }

    private suspend fun createPlayback(room: Room, video: LocalScreencastVideoTrack) {
        check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) { "System audio requires Android 10" }
        // Reuse the single projection owned by the video capturer; do not consume consent twice.
        val projection = checkNotNull((video.capturer as ScreenCapturerAndroid).mediaProjection)
        val capture = PlaybackAudioCapture(projection, onFailure)
        playback = capture
        capture.start()
        val audio = room.localParticipant.createAudioTrack("screen-audio", LocalAudioTrackOptions(
            noiseSuppression = false, echoCancellation = false, autoGainControl = false,
            highPassFilter = false, typingNoiseDetection = false,
        ))
        audioTrack = audio
        check(room.localParticipant.publishAudioTrack(audio, AudioTrackPublishOptions(
            source = Track.Source.SCREEN_SHARE_AUDIO, audioBitrate = 128_000, dtx = false, red = false,
        ))) { "Screen audio publication failed" }
        // A published track alone is insufficient: verify the real capture pipeline has delivered PCM.
        withTimeout(10_000) { capture.firstBuffer.await() }
    }

    suspend fun updateAudioState(state: NativeAudioState) {
        audioState = state
        val room = voiceRoom ?: return
        val microphoneEnabled = !state.micMuted && !state.deafened && !serverMuted && !serverDeafened
        check(room.localParticipant.setMicrophoneEnabled(microphoneEnabled)) {
            "Native microphone state change failed"
        }
        if (microphoneEnabled) withTimeout(10_000) { microphoneStarted.await() }
        syncSubscriptions()
    }

    suspend fun updateRestrictions(muted: Boolean?, deafened: Boolean?) {
        if (muted != null) serverMuted = muted
        if (deafened != null) serverDeafened = deafened
        updateAudioState(audioState)
    }

    private fun syncSubscriptions() {
        val room = voiceRoom ?: return
        room.remoteParticipants.values.forEach { participant ->
            val isOwner = participant.identity?.value == ownerIdentity
            participant.trackPublications.values.forEach { publication ->
                val remote = publication as? RemoteTrackPublication ?: return@forEach
                // No camera/screen subscriptions; other screen audio remains on the Web playback path.
                val subscribe = !isOwner && !audioState.deafened && !serverDeafened && remote.source == Track.Source.MICROPHONE
                (remote.track as? RemoteAudioTrack)?.setVolume(if (subscribe) 1.0 else 0.0)
                remote.setSubscribed(subscribe)
            }
        }
    }

    private fun observe(room: Room) {
        observers += scope.launch {
            room.events.collect { event ->
                when (event) {
                    is RoomEvent.Disconnected -> if (!closed) onFailure("SCREEN_SHARE_DISCONNECTED")
                    is RoomEvent.TrackPublished -> if (room === voiceRoom) syncSubscriptions()
                    is RoomEvent.TrackSubscribed -> if (room === voiceRoom) syncSubscriptions()
                    is RoomEvent.TrackSubscriptionFailed -> onFailure("SCREEN_SHARE_VOICE_SUBSCRIPTION_FAILED")
                    else -> Unit
                }
            }
        }
    }

    private fun audioErrors() = object : JavaAudioDeviceModule.AudioRecordErrorCallback {
        override fun onWebRtcAudioRecordInitError(message: String) = onFailure("SCREEN_SHARE_AUDIO_CAPTURE_FAILED")
        override fun onWebRtcAudioRecordStartError(code: JavaAudioDeviceModule.AudioRecordStartErrorCode, message: String) =
            onFailure("SCREEN_SHARE_AUDIO_CAPTURE_FAILED")
        override fun onWebRtcAudioRecordError(message: String) = onFailure("SCREEN_SHARE_AUDIO_CAPTURE_FAILED")
    }

    private fun playbackErrors() = object : JavaAudioDeviceModule.AudioTrackErrorCallback {
        override fun onWebRtcAudioTrackInitError(message: String) = onFailure("SCREEN_SHARE_VOICE_PLAYBACK_FAILED")
        override fun onWebRtcAudioTrackStartError(code: JavaAudioDeviceModule.AudioTrackStartErrorCode, message: String) =
            onFailure("SCREEN_SHARE_VOICE_PLAYBACK_FAILED")
        override fun onWebRtcAudioTrackError(message: String) = onFailure("SCREEN_SHARE_VOICE_PLAYBACK_FAILED")
    }

    fun close() {
        if (closed) return
        closed = true
        observers.forEach { it.cancel() }
        // Release every owned object even if one native release fails; propagate a visible terminal error.
        // Detach publications first so Room.release does not also dispose tracks that we own.
        val releases: List<() -> Unit> = listOf(
            { playback?.close() },
            { screenTrack?.let { screenRoom?.localParticipant?.unpublishTrack(it) } },
            { audioTrack?.let { screenRoom?.localParticipant?.unpublishTrack(it) } },
            { screenTrack?.takeUnless { it.rtcTrack.isDisposed }?.stop() },
            { screenTrack?.takeUnless { it.rtcTrack.isDisposed }?.dispose() },
            { audioTrack?.takeUnless { it.rtcTrack.isDisposed }?.dispose() },
            { screenRoom?.release() }, { voiceRoom?.release() }, { screenAdm?.release() },
        )
        var failure: Exception? = null
        releases.forEach { release ->
            try { release() } catch (error: Exception) {
                Log.e("BackspaceScreenShare", "Native media release failed", error)
                failure = error
            }
        }
        playback = null
        screenTrack = null
        audioTrack = null
        screenRoom = null
        voiceRoom = null
        screenAdm = null
        failure?.let { throw it }
    }
}
