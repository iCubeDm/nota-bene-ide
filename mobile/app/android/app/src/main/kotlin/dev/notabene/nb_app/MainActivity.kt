package dev.notabene.nb_app

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.media.AudioFormat
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.provider.OpenableColumns
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import android.net.Uri
import android.util.Size
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

// local_auth's BiometricPrompt needs a FragmentActivity.
class MainActivity : FlutterFragmentActivity() {
    // Frame extraction blocks on I/O, so it runs off the UI thread; one thread keeps requests in order.
    private val frameExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    // Playing voice messages (`nb/play`): one MediaPlayer on a cached WAV at a time. `dir` answers the folder of the
    // cached files; `play {path, from}` starts the file (a paused one of the same path resumes) at `from` ms;
    // `pause`, `seek {ms}` and `stop` do what they say. The phone calls back `position {ms}` about every 100 ms while
    // playing, `done` at the end, and `paused` when the app leaves the screen.
    private var playChannel: MethodChannel? = null
    private var player: MediaPlayer? = null
    private var playing: String? = null
    private val tick = object : Runnable {
        override fun run() {
            val p = player ?: return
            try {
                if (p.isPlaying) playChannel?.invokeMethod("position", mapOf("ms" to p.currentPosition))
            } catch (_: IllegalStateException) {}
            mainHandler.postDelayed(this, 100)
        }
    }

    private fun configurePlay(flutterEngine: FlutterEngine) {
        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "nb/play")
        playChannel = channel
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "dir" -> result.success(File(cacheDir, "voice").also { it.mkdirs() }.path)
                // recordings not yet delivered: kept (not cache) until the window has shown them
                "outDir" -> result.success(File(filesDir, "voice-out").also { it.mkdirs() }.path)
                "play" -> {
                    val path = call.argument<String>("path")
                    val from = (call.argument<Any>("from") as? Number)?.toInt() ?: 0
                    if (path == null) {
                        result.error("path", null, null)
                        return@setMethodCallHandler
                    }
                    try {
                        playFile(path, from)
                        result.success(null)
                    } catch (e: Exception) {
                        releasePlayer()
                        result.error("failed", e.message, null)
                    }
                }
                "pause" -> {
                    try {
                        player?.takeIf { it.isPlaying }?.pause()
                    } catch (_: IllegalStateException) {}
                    // nothing to report while paused
                    mainHandler.removeCallbacks(tick)
                    result.success(null)
                }
                "seek" -> {
                    val ms = (call.argument<Any>("ms") as? Number)?.toInt() ?: 0
                    try {
                        player?.seekTo(ms)
                    } catch (_: IllegalStateException) {}
                    result.success(null)
                }
                "stop" -> {
                    releasePlayer()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun playFile(path: String, from: Int) {
        val current = player
        if (current != null && playing == path) {
            if (from > 0) current.seekTo(from)
            requestFocus()
            current.start()
            mainHandler.removeCallbacks(tick)
            mainHandler.post(tick)
            return
        }
        releasePlayer()
        val p = MediaPlayer()
        try {
            p.setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build()
            )
            p.setDataSource(path)
            p.prepare()
            if (from > 0) p.seekTo(from)
            p.setOnCompletionListener {
                releasePlayer()
                playChannel?.invokeMethod("done", null)
            }
        } catch (e: Exception) {
            // a file that cannot be read must not leave a native player behind
            p.release()
            throw e
        }
        requestFocus()
        p.start()
        player = p
        playing = path
        mainHandler.post(tick)
    }

    // a call or another player takes the speaker: the voice pauses (the phone is told, as when the app leaves)
    private var focus: AudioFocusRequest? = null

    private fun requestFocus() {
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        val req = focus ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build()
            )
            .setOnAudioFocusChangeListener { change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                    val p = player
                    if (p != null && p.isPlaying) {
                        p.pause()
                        mainHandler.removeCallbacks(tick)
                        playChannel?.invokeMethod("paused", null)
                    }
                }
            }
            .build()
        focus = req
        am.requestAudioFocus(req)
    }

    private fun releasePlayer() {
        mainHandler.removeCallbacks(tick)
        player?.release()
        player = null
        playing = null
        focus?.let { (getSystemService(AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(it) }
    }

    // a voice does not go on playing behind the lock screen or another app
    override fun onStop() {
        val p = player
        if (p != null && p.isPlaying) {
            p.pause()
            mainHandler.removeCallbacks(tick)
            playChannel?.invokeMethod("paused", null)
        }
        super.onStop()
    }

    // Recording for the host's Whisper (`nb/record`): one recorder at a time. `recordChannel` is also how the
    // phone tells Dart the recorder stopped itself at its cap (`capped`) or failed (`failed`); `pendingStart` is a `start` waiting for the
    // microphone permission answer.
    private var recordChannel: MethodChannel? = null
    private var recording: Recording? = null
    private var pendingStart: MethodChannel.Result? = null

    // `nb/background`: the foreground service, the agent notifications and the periodic check (Notices.kt)
    private var background: BackgroundChannel? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        alive = true
        background?.launch = BackgroundChannel.placeOf(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        BackgroundChannel.placeOf(intent)?.let { background?.opened(it) }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        background = BackgroundChannel(this, flutterEngine.dartExecutor.binaryMessenger).also {
            it.launch = BackgroundChannel.placeOf(intent)
            channel = it.channel
        }
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
        configureRecord(flutterEngine)
        configurePlay(flutterEngine)
        configurePick(flutterEngine)
        configureGallery(flutterEngine)
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

    // The latest photos (`nb/gallery`), from MediaStore: `access {ask, settings}` answers "full", "partial" (Android 14's
    // selected photos: MediaStore then lists only what the user allowed) or "denied", after the permission dialog when
    // [ask] is set; with [settings] a permission the system no longer asks for opens the app's settings page instead.
    // `page {afterId, afterAdded, limit, mimes}` answers [{id, added}] newest first, the ones after that item (the first
    // ones when it is null: the list is continued from an item, so a photo taken meanwhile moves nothing), only of the
    // image types in `mimes` (what the attach flow takes, so no heic or video is offered). `thumbnail {id, px, key}` answers
    // the jpeg bytes of one thumbnail (null when there is none); the newest request is served first and `cancel {key}`
    // drops one that has not started. `take {items: [{id}]}` copies the items like a pick does; one that cannot be read
    // is answered as {unreadable: name} and the others are still copied.
    private var pendingGallery: MethodChannel.Result? = null
    // the thumbnail work waits in a stack: what the user scrolled to last is drawn first
    private val thumbQueue = object : LinkedBlockingDeque<Runnable>() {
        override fun offer(e: Runnable): Boolean = offerFirst(e)
    }
    private val thumbExecutor = ThreadPoolExecutor(3, 3, 0L, TimeUnit.MILLISECONDS, thumbQueue)
    private val thumbPending = ConcurrentHashMap.newKeySet<Int>()
    // what the permission request was asked with, for the answer
    private var gallerySettings = false
    private var galleryRationale = false

    private fun configureGallery(flutterEngine: FlutterEngine) {
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "nb/gallery").setMethodCallHandler { call, result ->
            when (call.method) {
                "access" -> galleryAccess(call.argument<Boolean>("ask") == true, call.argument<Boolean>("settings") == true, result)
                "page" -> {
                    val afterId = call.argument<Number>("afterId")?.toLong()
                    val afterAdded = call.argument<Number>("afterAdded")?.toLong() ?: 0L
                    val limit = call.argument<Int>("limit") ?: 60
                    val mimes = call.argument<List<String>>("mimes") ?: emptyList()
                    pickExecutor.execute {
                        try {
                            val page = galleryPage(afterId, afterAdded, limit, mimes)
                            mainHandler.post { result.success(page) }
                        } catch (e: Throwable) {
                            mainHandler.post { result.error("read", e.message ?: e.javaClass.simpleName, null) }
                        }
                    }
                }
                "thumbnail" -> {
                    val id = (call.argument<Number>("id") ?: 0).toLong()
                    val px = call.argument<Int>("px") ?: 256
                    val key = call.argument<Int>("key") ?: 0
                    thumbPending.add(key)
                    thumbExecutor.execute {
                        // a cancelled request is answered without the work
                        val bytes = if (thumbPending.remove(key)) {
                            try { galleryThumbnail(id, px) } catch (e: Throwable) { null }
                        } else null
                        mainHandler.post { result.success(bytes) }
                    }
                }
                "cancel" -> {
                    thumbPending.remove(call.argument<Int>("key") ?: 0)
                    result.success(null)
                }
                "take" -> {
                    val items = call.argument<List<Map<String, Any>>>("items") ?: emptyList()
                    pickExecutor.execute {
                        val out = ArrayList<Map<String, Any>>()
                        try {
                            for (m in items.take(MAX_PICK_COUNT)) {
                                val uri = galleryUri((m["id"] as Number).toLong())
                                try {
                                    out.add(readPicked(uri, null))
                                } catch (e: Throwable) {
                                    // one that cannot be read is told by its name; the others still go
                                    out.add(mapOf("unreadable" to galleryName(uri)))
                                }
                            }
                            mainHandler.post { result.success(out) }
                        } catch (e: Throwable) {
                            out.forEach { (it["path"] as? String)?.let { p -> File(p).delete() } }
                            mainHandler.post { result.error("read", e.message ?: e.javaClass.simpleName, null) }
                        }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun galleryPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
        )
        Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun galleryState(): String = when {
        Build.VERSION.SDK_INT >= 33 ->
            if (granted(Manifest.permission.READ_MEDIA_IMAGES)) "full"
            else if (Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) "partial"
            else "denied"
        granted(Manifest.permission.READ_EXTERNAL_STORAGE) -> "full"
        else -> "denied"
    }

    private fun galleryAccess(ask: Boolean, settings: Boolean, result: MethodChannel.Result) {
        val state = galleryState()
        // "partial" is asked for again too: that is how the user changes the selection
        if (!ask || state == "full" || pendingGallery != null) {
            result.success(state)
            return
        }
        pendingGallery = result
        gallerySettings = settings
        galleryRationale = galleryPermissions().any { ActivityCompat.shouldShowRequestPermissionRationale(this, it) }
        ActivityCompat.requestPermissions(this, galleryPermissions(), GALLERY_PERMISSION)
    }

    // The answer of the request. Denied with no rationale before and none after means the system did not show a dialog
    // (the user said no for good): a tap on Grant access then opens the app's settings page instead.
    private fun galleryAnswered() {
        val result = pendingGallery ?: return
        pendingGallery = null
        val state = galleryState()
        if (state == "denied" && gallerySettings && !galleryRationale &&
            galleryPermissions().none { ActivityCompat.shouldShowRequestPermissionRationale(this, it) }
        ) {
            try {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
                )
            } catch (e: ActivityNotFoundException) {
                // nowhere to send the user: the answer is the state it is
            }
        }
        result.success(state)
    }

    private fun galleryUri(id: Long): Uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)

    private fun galleryName(uri: Uri): String {
        var name = "image"
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.let { name = it }
            }
        } catch (e: Exception) {
            // the name is only for the message
        }
        return name
    }

    // [limit] photos after the one at ([afterAdded], [afterId]) of the list newest first: by date added, then id.
    private fun galleryPage(afterId: Long?, afterAdded: Long, limit: Int, mimes: List<String>): List<Map<String, Any>> {
        val images = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val columns = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_ADDED)
        var select = "${MediaStore.Images.Media.MIME_TYPE} IN (${mimes.joinToString(",") { "?" }})"
        val args = ArrayList(mimes)
        if (afterId != null) {
            select += " AND (${MediaStore.Images.Media.DATE_ADDED} < ? OR " +
                "(${MediaStore.Images.Media.DATE_ADDED} = ? AND ${MediaStore.Images.Media._ID} < ?))"
            args.addAll(listOf(afterAdded.toString(), afterAdded.toString(), afterId.toString()))
        }
        val order = "${MediaStore.Images.Media.DATE_ADDED} DESC, ${MediaStore.Images.Media._ID} DESC"
        val cursor = if (Build.VERSION.SDK_INT >= 30) {
            val q = Bundle().apply {
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, select)
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args.toTypedArray())
                putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, order)
                putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
            }
            contentResolver.query(images, columns, q, null)
        } else {
            // before Android 11 the limit is part of the sort order (the bundle's limit is ignored before 11)
            contentResolver.query(images, columns, select, args.toTypedArray(), "$order LIMIT $limit")
        }
        val out = ArrayList<Map<String, Any>>()
        // at most [limit] rows whatever the provider did with the limit
        cursor?.use { c ->
            while (out.size < limit && c.moveToNext()) out.add(hashMapOf("id" to c.getLong(0), "added" to c.getLong(1)))
        }
        return out
    }

    @Suppress("DEPRECATION")
    private fun galleryThumbnail(id: Long, px: Int): ByteArray? {
        val loaded: Bitmap? = if (Build.VERSION.SDK_INT >= 29) {
            contentResolver.loadThumbnail(galleryUri(id), Size(px, px), null)
        } else {
            MediaStore.Images.Thumbnails.getThumbnail(contentResolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null)
        }
        if (loaded == null) return null
        // jpeg has no alpha: a transparent png would come out black, so it is drawn on white first
        val bitmap = if (loaded.hasAlpha()) {
            Bitmap.createBitmap(loaded.width, loaded.height, Bitmap.Config.ARGB_8888).also {
                Canvas(it).apply { drawColor(Color.WHITE); drawBitmap(loaded, 0f, 0f, null) }
                loaded.recycle()
            }
        } else loaded
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    private fun hasMicrophone() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    // The RECORD_AUDIO request, for recording.
    private fun requestMicrophone() =
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), MIC_PERMISSION)

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == BackgroundChannel.REQUEST) {
            background?.permissionAnswered(grantResults)
            return
        }
        if (requestCode == GALLERY_PERMISSION) {
            galleryAnswered()
            return
        }
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
        if (requestCode != MIC_PERMISSION) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        pendingStart?.let { result ->
            pendingStart = null
            if (granted) startRecording(result) else result.error("denied", null, null)
        }
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
            // a `stop` already asked must still be answered, or its Dart future never ends
            waiting?.error("cancelled", null, null)
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
        alive = false
        channel = null
        // the links go with this activity's engine: a service left running would claim a connection nobody holds
        stopService(Intent(this, AgentService::class.java))
        mainHandler.removeCallbacksAndMessages(null)
        dropRecording()
        releasePlayer()
        frameExecutor.shutdown()
        pickExecutor.shutdown()
        thumbExecutor.shutdown()
        super.onDestroy()
    }

    companion object {
        /// An activity, and with it the app's engine and links, exists: the periodic check asks it rather than connect.
        @Volatile
        var alive = false

        /// This activity's `nb/background`, for the worker's `check`.
        @Volatile
        var channel: MethodChannel? = null

        private const val MIC_PERMISSION = 4791
        private const val CAMERA_PERMISSION = 4792
        private const val PICK_REQUEST = 4793
        private const val GALLERY_PERMISSION = 4794

        // what a pick answers: at most ten images, none over 40 MB (the phone skips it and says so)
        private const val MAX_PICK_COUNT = 10
        private const val MAX_PICK_BYTES = 40 * 1024 * 1024
        // a file of cache/pick younger than this may still belong to a draft or a share; the camera start spares it
        private const val PICK_KEEP_MS = 60L * 60 * 1000

        // what the host takes (`POST /voice`): 16 kHz mono PCM16, at most 10 minutes (19.2 MB); the host splits it for
        // Whisper itself
        private const val RATE = 16000
        private const val MAX_PCM = RATE * 2 * 600
    }
}
