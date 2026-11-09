package dev.notabene.nb_app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
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
                    recognizer?.stopListening()
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

    private fun emit(type: String, key: String? = null, value: String? = null) {
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
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            fail("unavailable")
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            pendingLang = lang
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), SPEECH_PERMISSION)
            return
        }
        listenSpeech(lang)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != SPEECH_PERMISSION) return
        val lang = pendingLang ?: return
        pendingLang = null
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            listenSpeech(lang)
        } else {
            fail("denied")
        }
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
                emit("final", "text", firstResult(results) ?: "")
                emit("end")
            }

            override fun onError(error: Int) {
                if (!current()) return
                fail(
                    when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no_match"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "denied"
                        else -> "other"
                    }
                )
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        )
    }

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private fun dropRecognizer() {
        pendingLang = null
        val r = recognizer ?: return
        recognizer = null
        r.cancel()
        r.destroy()
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
        frameExecutor.shutdown()
        super.onDestroy()
    }

    private companion object {
        const val SPEECH_PERMISSION = 4791
    }
}
