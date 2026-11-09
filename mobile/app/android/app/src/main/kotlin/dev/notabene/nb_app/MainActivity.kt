package dev.notabene.nb_app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaMetadataRetriever
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors

// local_auth's BiometricPrompt needs a FragmentActivity.
class MainActivity : FlutterFragmentActivity() {
    // Frame extraction blocks on I/O, so it runs off the UI thread; one thread keeps requests in order.
    private val frameExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    // Dictation: one recognizer at a time, always used on the main thread. `events` is Dart's listener on
    // nb/speech/events; `pendingLang` is a `start` waiting for the microphone permission answer.
    private var recognizer: SpeechRecognizer? = null
    private var events: EventChannel.EventSink? = null
    private var pendingLang: String? = null

    // The session spans pauses: the recognizer is replaced after each finished stretch of speech. `finishing`
    // is set by `stop`; `restarting` is true between one recognizer and the next, when none exists.
    private var speechLang = ""
    private var finishing = false
    private var restarting = false
    private var lastLevelAt = 0L

    // Recording for the host's Whisper (`nb/record`): one recorder at a time. `recordChannel` is also how the
    // phone tells Dart the recorder stopped itself at its cap (`capped`) or failed (`failed`); `pendingStart` is a `start` waiting for the
    // microphone permission answer.
    private var recordChannel: MethodChannel? = null
    private var recording: Recording? = null
    private var pendingStart: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "nb/frame").setMethodCallHandler { call, result ->
            if (call.method != "frameAt") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            val url = call.argument<String>("url") ?: ""
            val us = (call.argument<Any>("us") as? Number)?.toLong() ?: 0L
            frameExecutor.execute {
                try {
                    val reply = frameAt(url, us)
                    // Replies must reach Flutter on the main thread.
                    mainHandler.post { result.success(reply) }
                } catch (e: Throwable) {
                    // an OutOfMemoryError on a large frame is a reply, not a crash
                    mainHandler.post {
                        result.error("frame", e.message ?: e.javaClass.simpleName, null)
                    }
                }
            }
        }
        configureSpeech(flutterEngine)
        configureRecord(flutterEngine)
    }

    private fun configureSpeech(flutterEngine: FlutterEngine) {
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        EventChannel(messenger, "nb/speech/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) {
                events = sink
            }

            override fun onCancel(arguments: Any?) {
                events = null
            }
        })
        MethodChannel(messenger, "nb/speech").setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    startSpeech(call.argument<String>("lang") ?: "")
                    result.success(null)
                }
                "stop" -> {
                    finishing = true
                    val r = recognizer
                    if (r != null) {
                        r.stopListening()
                    } else if (restarting) {
                        // between two recognizers: nothing more to hear, the segments are all Dart has
                        restarting = false
                        emit("final", "text", "")
                        emit("end")
                    }
                    result.success(null)
                }
                "cancel" -> {
                    dropRecognizer()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun emit(type: String, key: String? = null, value: Any? = null) {
        val event = HashMap<String, Any>()
        event["type"] = type
        if (key != null && value != null) event[key] = value
        events?.success(event)
    }

    // An error is always followed by the end of the session.
    private fun fail(code: String) {
        emit("error", "code", code)
        emit("end")
    }

    private fun startSpeech(lang: String) {
        // a new session replaces a running one, silently
        dropRecognizer()
        speechLang = lang
        finishing = false
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            fail("unavailable")
            return
        }
        if (!hasMicrophone()) {
            pendingLang = lang
            requestMicrophone()
            return
        }
        listenSpeech(lang)
    }

    private fun hasMicrophone() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    // The one RECORD_AUDIO request, for dictation by the phone's recognizer and for recording alike.
    private fun requestMicrophone() =
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), SPEECH_PERMISSION)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != SPEECH_PERMISSION) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        pendingStart?.let { result ->
            pendingStart = null
            if (granted) startRecording(result) else result.error("denied", null, null)
        }
        val lang = pendingLang ?: return
        pendingLang = null
        if (granted) listenSpeech(lang) else fail("denied")
    }

    private fun listenSpeech(lang: String) {
        val r = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            // A callback from a recognizer that was since replaced or cancelled must not reach Dart.
            private fun current() = recognizer === r

            override fun onPartialResults(partialResults: Bundle?) {
                if (!current()) return
                firstResult(partialResults)?.let { emit("partial", "text", it) }
            }

            override fun onResults(results: Bundle?) {
                if (!current()) return
                val text = firstResult(results) ?: ""
                release(r)
                if (finishing) {
                    // the last stretch (possibly empty); Dart adds it to the segments
                    emit("final", "text", text)
                    emit("end")
                } else {
                    if (text.isNotEmpty()) emit("segment", "text", text)
                    restart()
                }
            }

            override fun onError(error: Int) {
                if (!current()) return
                release(r)
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                        if (finishing) {
                            emit("final", "text", "")
                            emit("end")
                        } else {
                            restart()
                        }
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail("denied")
                    ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE -> fail("unavailable")
                    else -> fail("other")
                }
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {
                if (!current()) return
                emitLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
            }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                // hints only; some recognizers ignore them, the restart after each result keeps the session going
                .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
                .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
                .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 15000L)
        )
    }

    // A fresh recognizer for the next stretch. Posted, so the finished one is destroyed first; a `stop` or
    // `cancel` that comes in the gap is handled there (no recognizer exists to be stopped).
    private fun restart() {
        restarting = true
        mainHandler.post {
            if (!restarting) return@post
            restarting = false
            listenSpeech(speechLang)
        }
    }

    // at most one level event per 100 ms
    private fun emitLevel(value: Float) {
        val now = android.os.SystemClock.uptimeMillis()
        if (now - lastLevelAt < 100) return
        lastLevelAt = now
        emit("level", "value", value.toDouble())
    }

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    // The session is over: forget the recognizer now, so a late callback is ignored, and destroy it after the
    // callback has returned, so the next start does not find it busy.
    private fun release(r: SpeechRecognizer) {
        if (recognizer === r) recognizer = null
        mainHandler.post { r.destroy() }
    }

    private fun dropRecognizer() {
        pendingLang = null
        restarting = false
        val r = recognizer ?: return
        recognizer = null
        r.cancel()
        r.destroy()
    }

    private fun configureRecord(flutterEngine: FlutterEngine) {
        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "nb/record")
        recordChannel = channel
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    dropRecording()
                    if (hasMicrophone()) {
                        startRecording(result)
                    } else {
                        pendingStart = result
                        requestMicrophone()
                    }
                }
                "stop" -> {
                    val r = recording
                    if (r == null) result.error("none", null, null) else r.stop(result)
                }
                "cancel" -> {
                    dropRecording()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun startRecording(result: MethodChannel.Result) {
        val size = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, maxOf(size, RATE)
            )
        } catch (e: Throwable) {
            null
        }
        if (record == null || record.state != AudioRecord.STATE_INITIALIZED) {
            record?.release()
            result.error("failed", null, null)
            return
        }
        try {
            record.startRecording()
        } catch (e: Throwable) {
            record.release()
            result.error("failed", null, null)
            return
        }
        recording = Recording(record, maxOf(size, RATE)).also { it.begin() }
        result.success(null)
    }

    // Replies for a dropped recording are never sent: Dart has cancelled it, or replaced it with a new one.
    private fun dropRecording() {
        pendingStart?.error("cancelled", null, null)
        pendingStart = null
        recording?.drop()
        recording = null
    }

    // One recording. The reading runs on its own thread; every callback into Flutter is posted to the main thread,
    // where this object's state is also kept.
    private inner class Recording(private val record: AudioRecord, private val chunk: Int) {
        private val pcm = ByteArrayOutputStream()
        @Volatile private var stopping = false
        private var dropped = false
        private var wav: ByteArray? = null
        private var waiting: MethodChannel.Result? = null

        fun begin() {
            Thread {
                val buf = ByteArray(chunk)
                var capped = false
                var failed = false
                while (!stopping) {
                    val n = record.read(buf, 0, buf.size)
                    if (n <= 0) {
                        // a read error while recording (a stop in between makes the read return early)
                        failed = !stopping
                        break
                    }
                    pcm.write(buf, 0, minOf(n, MAX_PCM - pcm.size()))
                    if (pcm.size() >= MAX_PCM) {
                        capped = true
                        break
                    }
                }
                try {
                    record.stop()
                } catch (_: Throwable) {}
                record.release()
                val bytes = wavOf(pcm.toByteArray())
                mainHandler.post { finished(bytes, capped, failed) }
            }.also { it.isDaemon = true }.start()
        }

        private fun finished(bytes: ByteArray, capped: Boolean, failed: Boolean) {
            if (dropped) return
            wav = bytes
            val w = waiting
            if (w != null) {
                waiting = null
                reply(w)
            } else if (failed) {
                // Dart ends the session and cancels this recording
                recordChannel?.invokeMethod("failed", null)
            } else if (capped) {
                // the audio is kept; Dart treats this like the user pressing stop
                recordChannel?.invokeMethod("capped", null)
            }
        }

        fun stop(result: MethodChannel.Result) {
            stopping = true
            if (wav != null) reply(result) else waiting = result
        }

        private fun reply(result: MethodChannel.Result) {
            if (recording === this) recording = null
            result.success(wav)
        }

        fun drop() {
            dropped = true
            stopping = true
            waiting = null
        }
    }

    // 16-bit mono PCM in a RIFF/WAVE container
    private fun wavOf(pcm: ByteArray): ByteArray {
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * 2)
            .putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(pcm.size)
        return h.array() + pcm
    }

    // OPTION_CLOSEST returns the nearest frame, not the one at a keyframe, so the markup shows the exact paused frame.
    private fun frameAt(url: String, us: Long): Map<String, Any> {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(url, HashMap())
            val bmp = retriever.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST)
                ?: throw IllegalStateException("no frame at $us")
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            val reply = mapOf("png" to out.toByteArray(), "width" to bmp.width, "height" to bmp.height)
            bmp.recycle()
            return reply
        } finally {
            // a failing release must not replace the frame or the real error
            try {
                retriever.release()
            } catch (_: Exception) {}
        }
    }

    override fun onDestroy() {
        dropRecognizer()
        dropRecording()
        frameExecutor.shutdown()
        super.onDestroy()
    }

    private companion object {
        const val SPEECH_PERMISSION = 4791

        // what the host takes: 16 kHz mono PCM16, at most 2 minutes (3.84 MB, under its 4 MiB limit with the header)
        const val RATE = 16000
        const val MAX_PCM = RATE * 2 * 120

        // SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED / _UNAVAILABLE exist from API 31; the app's minSdk is lower
        const val ERROR_LANGUAGE_NOT_SUPPORTED = 12
        const val ERROR_LANGUAGE_UNAVAILABLE = 13
    }
}
