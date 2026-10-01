package io.github.backspace.mobile

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Process
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CompletableDeferred
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/** Playback-only PCM; never constructs a microphone recorder or mixes in microphone samples. */
@RequiresApi(Build.VERSION_CODES.Q)
internal class PlaybackAudioCapture(private val projection: MediaProjection, private val onError: (String) -> Unit) {
    companion object {
        const val SAMPLE_RATE = 48_000
        private const val CHANNELS = 2
        private const val PCM_BYTES = 2
        private const val CALLBACKS_PER_SECOND = 100
        private const val FRAME_BYTES = SAMPLE_RATE / CALLBACKS_PER_SECOND * CHANNELS * PCM_BYTES
    }

    val firstBuffer = CompletableDeferred<Unit>()
    @Volatile private var recorder: AudioRecord? = null
    private val readLock = Any()
    private val stopped = AtomicBoolean(false)

    @SuppressLint("MissingPermission")
    fun start() {
        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            // Exclude WebView and native voice playback alike; both run under this application's UID.
            .excludeUid(Process.myUid())
            .build()
        val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0) { "Playback capture buffer size unavailable: $minimum" }
        val audioRecord = AudioRecord.Builder()
            .setAudioFormat(AudioFormat.Builder().setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setAudioPlaybackCaptureConfig(config)
            .setBufferSizeInBytes(maxOf(minimum * 2, FRAME_BYTES))
            .build()
        recorder = audioRecord
        check(audioRecord.state == AudioRecord.STATE_INITIALIZED) { "Playback AudioRecord initialization failed" }
        audioRecord.startRecording()
        check(audioRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Playback AudioRecord did not start" }
    }

    fun fill(buffer: ByteBuffer): Long = synchronized(readLock) {
        if (stopped.get()) return@synchronized 0L
        val audioRecord = recorder ?: return@synchronized 0L
        val count = audioRecord.read(buffer, buffer.capacity(), AudioRecord.READ_BLOCKING)
        if (stopped.get()) return@synchronized 0L
        if (count != buffer.capacity()) {
            val error = IllegalStateException("Playback AudioRecord read failed: $count/${buffer.capacity()}")
            firstBuffer.completeExceptionally(error)
            if (stopped.compareAndSet(false, true)) onError("SCREEN_SHARE_AUDIO_CAPTURE_FAILED")
            return@synchronized 0L
        }
        firstBuffer.complete(Unit)
        System.nanoTime()
    }

    fun close() {
        stopped.set(true)
        val audioRecord = recorder ?: return
        try {
            // stop() must run outside readLock: it unblocks AudioRecord's blocking read.
            if (audioRecord.recordingState == AudioRecord.RECORDSTATE_RECORDING) audioRecord.stop()
        } finally {
            // Releasing while the WebRTC callback is inside read() can abort Android's audio client.
            // Wait for that read to exit before destroying its native buffer and recorder.
            synchronized(readLock) {
                recorder = null
                audioRecord.release()
            }
        }
    }
}
