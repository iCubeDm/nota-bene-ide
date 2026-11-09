package dev.notabene.nb_app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaMetadataRetriever
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import android.net.Uri
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

    // The dictation session spans pauses. States (all on the main thread; `recognizer` is null in IDLE only):
    //   IDLE        no session. `start` -> WAITING_PERMISSION (pendingLang set) or LISTENING.
    //   WAITING_PERMISSION  `stop` -> final "" + end (IDLE); granted -> LISTENING; denied -> error + end.
    //   LISTENING   one recognizer is listening (`restarting` false). A result or an error that means "nothing was
    //               said" moves to RESTARTING; `stop` sets `finishing` and asks the recognizer for its last result.
    //   RESTARTING  the same recognizer waits for a delayed startListening (`restarting` true; at least 300 ms
    //               after the previous start); `stop` -> final "" + end (IDLE), the segments are all Dart has.
    // From API 33 one segmented session (EXTRA_SEGMENTED_SESSION) replaces the restart loop: the recognizer itself
    // keeps listening across pauses, each stretch arrives in onSegmentResults (event `segment`), and the session
    // ends with onEndOfSegmentedSession (final "" + end) after `stop`. Below 33, and if a recognizer ignores the
    // extra, each onResults is a `segment` and the loop restarts listening.
    // Errors: while `finishing`, any error ends the session (final "" + end). Otherwise NO_MATCH / SPEECH_TIMEOUT
    // restart, and after NO_MATCH_LIMIT immediate ones (under 500 ms each) the session ends with what was heard
    // (final "" + end, not an error); CLIENT / BUSY / SERVER_DISCONNECTED retry after 300 ms, at most 3 times in a
    // row, then fail; permission and language errors fail at once. Every end event is preceded by `final` or `error`.
    private var speechLang = ""
    private var finishing = false
    private var restarting = false
    private var segmented = false
    private var lastStartAt = 0L
    private var noMatchRun = 0
    private var retryRun = 0
    private var lastLevelAt = 0L
    private val restartTask = Runnable {
        if (!restarting) return@Runnable
        restarting = false
        startRound()
    }

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
        configurePick(flutterEngine)
    }

    // Images from the system (`nb/pick`): `camera`, `gallery` and `file` each start one system activity and answer a
    // list of {path, mime, name} (empty when cancelled; {skipped: name} for an image over MAX_PICK_BYTES). Each image
    // is a file in cache/pick, copied there as a stream (nothing is held in the heap); Dart reads it when it prepares
    // the image and deletes it after. No
    // permission of ours but CAMERA, which the manifest declares for the QR scanner and which the camera intent then
    // requires us to hold. The camera writes a full-size photo to a file of ours in cache/pick, shared through
    // androidx.core's FileProvider. One pick at a time; reading runs off the main thread.
    private var pickResult: MethodChannel.Result? = null
    private var pickCamera: File? = null
    private var pendingCamera: MethodChannel.Result? = null
    private val pickExecutor = Executors.newSingleThreadExecutor()

    private fun configurePick(flutterEngine: FlutterEngine) {
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "nb/pick").setMethodCallHandler { call, result ->
            if (call.method == "share") {
                shareImage(call, result)
                return@setMethodCallHandler
            }
            if (call.method != "camera" && call.method != "gallery" && call.method != "file") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            if (pickResult != null || pendingCamera != null) {
                result.error("busy", null, null)
                return@setMethodCallHandler
            }
            when (call.method) {
                "camera" ->
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
                        PackageManager.PERMISSION_GRANTED
                    ) {
                        startCamera(result)
                    } else {
                        pendingCamera = result
                        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION)
                    }
                "gallery" -> startGallery(result)
                else -> startFile(result)
            }
        }
    }

    // `share` {bytes, mime, name}: the image is written to cache/pick (the camera's folder and provider) and offered to the
    // system's share sheet as ACTION_SEND. Independent of a pick in progress; answers null once the sheet is shown.
    private fun shareImage(call: MethodCall, result: MethodChannel.Result) {
        val bytes = call.argument<ByteArray>("bytes")
        val mime = call.argument<String>("mime") ?: "image/*"
        if (bytes == null) {
            result.error("read", "no bytes", null)
            return
        }
        try {
            val dir = File(cacheDir, "pick")
            dir.mkdirs()
            dir.listFiles()?.forEach { if (it.name.startsWith("share-")) it.delete() } // an earlier share's copy
            // a file name from the user's own name, stripped of anything that is not a plain character
            val clean = (call.argument<String>("name") ?: "image").replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)
            val file = File(dir, "share-$clean")
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(this, "$packageName.pick", file)
            val send = Intent(Intent.ACTION_SEND)
                .setType(mime)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            val chooser = Intent.createChooser(send, null)
            chooser.clipData = ClipData.newRawUri("", uri)
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivity(chooser)
            result.success(null)
        } catch (e: ActivityNotFoundException) {
            result.error("unavailable", null, null)
        } catch (e: Exception) {
            result.error("read", e.message ?: e.javaClass.simpleName, null)
        }
    }

    // True when the system activity started. When there is none, [noActivity] decides (default: an error reply).
    private fun launchPick(intent: Intent, result: MethodChannel.Result, noActivity: (() -> Unit)? = null): Boolean {
        pickResult = result
        return try {
            startActivityForResult(intent, PICK_REQUEST)
            true
        } catch (e: ActivityNotFoundException) {
            pickResult = null
            if (noActivity != null) noActivity() else result.error("unavailable", null, null)
            false
        } catch (e: SecurityException) {
            pickResult = null
            result.error("denied", null, null)
            false
        }
    }

    private fun startCamera(result: MethodChannel.Result) {
        val dir = File(cacheDir, "pick")
        dir.mkdirs()
        // leftovers of an earlier pick or capture; a younger file may still be a draft's or a share's in use
        val old = System.currentTimeMillis() - PICK_KEEP_MS
        dir.listFiles()?.forEach { if (it.lastModified() < old) it.delete() }
        val file = File(dir, "camera-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(this, "$packageName.pick", file)
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri)
            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        intent.clipData = ClipData.newRawUri("", uri) // the grant reaches the camera app below API 21's rules too
        pickCamera = file
        if (!launchPick(intent, result)) {
            pickCamera = null
            file.delete()
        }
    }

    private fun startGallery(result: MethodChannel.Result) {
        val generic = {
            val intent = Intent(Intent.ACTION_GET_CONTENT)
                .setType("image/*")
                .addCategory(Intent.CATEGORY_OPENABLE)
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            launchPick(intent, result)
            Unit
        }
        if (Build.VERSION.SDK_INT >= 33) {
            val intent = Intent(MediaStore.ACTION_PICK_IMAGES)
                .putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, minOf(MAX_PICK_COUNT, MediaStore.getPickImagesMaxLimit()))
            launchPick(intent, result, noActivity = generic) // no photo picker on this phone: the generic chooser
        } else {
            generic()
        }
    }

    private fun startFile(result: MethodChannel.Result) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .setType("image/*")
            .addCategory(Intent.CATEGORY_OPENABLE)
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        launchPick(intent, result)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != PICK_REQUEST) return
        val result = pickResult ?: return
        pickResult = null
        val camera = pickCamera
        pickCamera = null
        if (resultCode != Activity.RESULT_OK) {
            camera?.delete()
            result.success(ArrayList<Any>())
            return
        }
        val uris = ArrayList<Uri>()
        if (camera != null) {
            uris.add(Uri.fromFile(camera))
        } else if (data != null) {
            data.clipData?.let { c -> for (i in 0 until minOf(c.itemCount, MAX_PICK_COUNT)) uris.add(c.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
        }
        pickExecutor.execute {
            val out = ArrayList<Map<String, Any>>()
            try {
                for (uri in uris) out.add(readPicked(uri, camera))
                mainHandler.post { result.success(out) }
            } catch (e: Throwable) {
                // an unreadable image or an OutOfMemoryError is a reply, not a crash; what was copied is of no use now
                out.forEach { (it["path"] as? String)?.let { p -> File(p).delete() } }
                camera?.delete()
                mainHandler.post { result.error("read", e.message ?: e.javaClass.simpleName, null) }
            }
        }
    }

    // The camera's photo is already a file of ours: it is handed over as it is (Dart deletes it after its use). Any other
    // image is copied to its own file in cache/pick, chunk by chunk, and dropped again when it is over MAX_PICK_BYTES.
    private fun readPicked(uri: Uri, camera: File?): Map<String, Any> {
        if (camera != null) {
            if (camera.length() > MAX_PICK_BYTES) {
                camera.delete()
                return mapOf("skipped" to "camera.jpg")
            }
            return mapOf("path" to camera.absolutePath, "mime" to "image/jpeg", "name" to "camera.jpg")
        }
        var name = uri.lastPathSegment ?: "image"
        var size = -1L
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        if (size > MAX_PICK_BYTES) return mapOf("skipped" to name)
        val dir = File(cacheDir, "pick")
        dir.mkdirs()
        val dest = File.createTempFile("pick-", ".img", dir) // a name of its own: no two picks meet
        var done = false
        try {
            val input = contentResolver.openInputStream(uri) ?: throw IOException("cannot open $name")
            var total = 0L
            input.use { src ->
                dest.outputStream().use { out ->
                    val chunk = ByteArray(64 * 1024)
                    while (true) {
                        val n = src.read(chunk)
                        if (n < 0) break
                        total += n
                        if (total > MAX_PICK_BYTES) return mapOf("skipped" to name) // the size column can be missing or wrong
                        out.write(chunk, 0, n)
                    }
                }
            }
            done = true
            val mime = contentResolver.getType(uri) ?: "application/octet-stream"
            return mapOf("path" to dest.absolutePath, "mime" to mime, "name" to name)
        } finally {
            if (!done) dest.delete()
        }
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
                    if (pendingLang != null) {
                        // still waiting for the permission answer: nothing was heard
                        pendingLang = null
                        emit("final", "text", "")
                        emit("end")
                    } else if (r != null && restarting) {
                        // between two rounds: nothing more to hear, the segments are all Dart has
                        release(r)
                        emit("final", "text", "")
                        emit("end")
                    } else if (r != null) {
                        r.stopListening()
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
        if (requestCode == CAMERA_PERMISSION) {
            val camera = pendingCamera ?: return
            pendingCamera = null
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startCamera(camera)
            } else {
                camera.error("denied", null, null)
            }
            return
        }
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
        speechLang = lang
        noMatchRun = 0
        retryRun = 0
        segmented = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        newRecognizer()
        startRound()
    }

    private fun newRecognizer() {
        val r = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = r
        r.setRecognitionListener(listenerFor(r))
    }

    private fun listenerFor(r: SpeechRecognizer): RecognitionListener =
        object : RecognitionListener {
            // A callback from a recognizer that was since released or cancelled must not reach Dart.
            private fun current() = recognizer === r

            override fun onPartialResults(partialResults: Bundle?) {
                if (!current()) return
                firstResult(partialResults)?.let { emit("partial", "text", it) }
            }

            // segmented session (API 33+): one finished stretch of speech; the session goes on
            override fun onSegmentResults(segmentResults: Bundle) {
                if (!current()) return
                noMatchRun = 0
                retryRun = 0
                val text = firstResult(segmentResults) ?: ""
                if (text.isNotEmpty()) emit("segment", "text", text)
            }

            override fun onEndOfSegmentedSession() {
                if (!current()) return
                if (finishing) {
                    release(r)
                    emit("final", "text", "")
                    emit("end")
                } else {
                    // the recognizer closed the session on its own: listen again
                    nothingHeard(r)
                }
            }

            override fun onResults(results: Bundle?) {
                // a doubled result while a restart is waiting must not repeat its segment
                if (!current() || restarting) return
                noMatchRun = 0
                retryRun = 0
                // in a segmented session the segments are the text; a whole-session onResults would repeat them
                val text = if (segmented) "" else firstResult(results) ?: ""
                if (finishing) {
                    // the last stretch (possibly empty); Dart adds it to the segments
                    release(r)
                    emit("final", "text", text)
                    emit("end")
                } else {
                    if (text.isNotEmpty()) emit("segment", "text", text)
                    scheduleRound()
                }
            }

            override fun onError(error: Int) {
                if (!current() || restarting) return
                if (finishing) {
                    // whatever went wrong, the segments already delivered are the result
                    release(r)
                    emit("final", "text", "")
                    emit("end")
                    return
                }
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> nothingHeard(r)
                    SpeechRecognizer.ERROR_CLIENT, SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
                    ERROR_SERVER_DISCONNECTED -> {
                        if (++retryRun > MAX_RETRIES) {
                            release(r)
                            fail("other")
                        } else {
                            // a broken connection needs a new recognizer; a busy or confused one is reused
                            if (error == ERROR_SERVER_DISCONNECTED) renewRecognizer(r) else r.cancel()
                            scheduleRound(RETRY_BACKOFF_MS)
                        }
                    }
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                        release(r)
                        fail("denied")
                    }
                    ERROR_LANGUAGE_NOT_SUPPORTED, ERROR_LANGUAGE_UNAVAILABLE -> {
                        release(r)
                        fail("unavailable")
                    }
                    else -> {
                        release(r)
                        fail("other")
                    }
                }
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {
                if (!current()) return
                noMatchRun = 0
                retryRun = 0
            }
            override fun onRmsChanged(rmsdB: Float) {
                if (!current()) return
                emitLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
            }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        }

    // One listening round of the current recognizer.
    private fun startRound() {
        val r = recognizer ?: return
        lastStartAt = android.os.SystemClock.uptimeMillis()
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, speechLang)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            // hints only; some recognizers ignore them, the loop in `nothingHeard`/`scheduleRound` covers that
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 15000L)
        if (segmented && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // one session across pauses: segments arrive in onSegmentResults, the silence length above splits them
            // the extra's value names the boundary extra (a String), not a boolean
            // Device check: whether partials restart per segment or stay cumulative across the session is unknown.
            intent.putExtra(
                RecognizerIntent.EXTRA_SEGMENTED_SESSION,
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS
            )
        }
        r.startListening(intent)
    }

    // The next round of the same recognizer, after `delayMs` and at least MIN_GAP_MS after the last start. Posted,
    // so the callback that asked for it returns first; a `stop` or `cancel` in the gap is handled there.
    private fun scheduleRound(delayMs: Long = 0L) {
        val since = android.os.SystemClock.uptimeMillis() - lastStartAt
        restarting = true
        mainHandler.removeCallbacks(restartTask)
        mainHandler.postDelayed(restartTask, maxOf(delayMs, MIN_GAP_MS - since, 0L))
    }

    // A round that heard nothing (no match, timeout, or a segmented session that closed itself). Immediate ones
    // (under 500 ms) in a row mean the recognizer is not hearing anything at all: end with the segments so far.
    private fun nothingHeard(r: SpeechRecognizer) {
        val immediate = android.os.SystemClock.uptimeMillis() - lastStartAt < IMMEDIATE_MS
        noMatchRun = if (immediate) noMatchRun + 1 else 0
        retryRun = 0
        if (noMatchRun >= NO_MATCH_LIMIT) {
            release(r)
            emit("final", "text", "")
            emit("end")
        } else {
            scheduleRound()
        }
    }

    // A new recognizer in place of a broken one, same session; its first round is left to scheduleRound.
    private fun renewRecognizer(old: SpeechRecognizer) {
        release(old)
        newRecognizer()
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
        restarting = false
        mainHandler.removeCallbacks(restartTask)
        mainHandler.post { r.destroy() }
    }

    private fun dropRecognizer() {
        pendingLang = null
        restarting = false
        mainHandler.removeCallbacks(restartTask)
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
        private var lastLevelAt = 0L
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
                    val now = android.os.SystemClock.uptimeMillis()
                    if (now - lastLevelAt >= 100) {
                        lastLevelAt = now
                        val level = levelOf(buf, n)
                        mainHandler.post { if (!dropped && !stopping) recordChannel?.invokeMethod("level", level) }
                    }
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

    // RMS of the 16-bit little-endian samples in the first n bytes, 0..1
    private fun levelOf(buf: ByteArray, n: Int): Double {
        val samples = n / 2
        if (samples == 0) return 0.0
        var sum = 0.0
        for (i in 0 until samples) {
            val v = ((buf[2 * i + 1].toInt() shl 8) or (buf[2 * i].toInt() and 0xff)).toShort().toDouble()
            sum += v * v
        }
        return (Math.sqrt(sum / samples) / 32768.0).coerceIn(0.0, 1.0)
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
        mainHandler.removeCallbacksAndMessages(null)
        dropRecording()
        frameExecutor.shutdown()
        pickExecutor.shutdown()
        super.onDestroy()
    }

    private companion object {
        const val SPEECH_PERMISSION = 4791
        const val CAMERA_PERMISSION = 4792
        const val PICK_REQUEST = 4793

        // what a pick answers: at most ten images, none over 40 MB (the phone skips it and says so)
        const val MAX_PICK_COUNT = 10
        const val MAX_PICK_BYTES = 40 * 1024 * 1024
        // a file of cache/pick younger than this may still belong to a draft or a share; the camera start spares it
        const val PICK_KEEP_MS = 60L * 60 * 1000

        // what the host takes: 16 kHz mono PCM16, at most 2 minutes (3.84 MB, under its 4 MiB limit with the header)
        const val RATE = 16000
        const val MAX_PCM = RATE * 2 * 120

        // SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED / _UNAVAILABLE exist from API 31; the app's minSdk is lower
        const val ERROR_LANGUAGE_NOT_SUPPORTED = 12
        const val ERROR_LANGUAGE_UNAVAILABLE = 13
        // ERROR_SERVER_DISCONNECTED exists from API 31
        const val ERROR_SERVER_DISCONNECTED = 11

        // restart loop: spacing of the starts, retry backoff and limits (see the state machine above)
        const val MIN_GAP_MS = 300L
        const val RETRY_BACKOFF_MS = 300L
        const val MAX_RETRIES = 3
        const val IMMEDIATE_MS = 500L
        const val NO_MATCH_LIMIT = 10
    }
}
