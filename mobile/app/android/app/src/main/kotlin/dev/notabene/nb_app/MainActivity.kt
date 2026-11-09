package dev.notabene.nb_app

import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

// local_auth's BiometricPrompt needs a FragmentActivity.
class MainActivity : FlutterFragmentActivity() {
    // Frame extraction blocks on I/O, so it runs off the UI thread; one thread keeps requests in order.
    private val frameExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

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
                } catch (e: Exception) {
                    mainHandler.post {
                        result.error("frame", e.message ?: e.javaClass.simpleName, null)
                    }
                }
            }
        }
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
            return mapOf("png" to out.toByteArray(), "width" to bmp.width, "height" to bmp.height)
        } finally {
            retriever.release()
        }
    }
}
