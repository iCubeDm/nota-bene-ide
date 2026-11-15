package dev.notabene.nb_app

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// The periodic check (every 15 minutes, with a network): while the activity exists its engine holds the links, so the
// worker asks it to check (one device key, one connection: a second one would close the app's with 4409); otherwise it
// runs the Dart entry point `backgroundCheck` in an engine of its own, which connects, notifies and says `done`.
class CheckWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val finished = CountDownLatch(1)
        val main = Handler(Looper.getMainLooper())
        var engine: FlutterEngine? = null
        main.post {
            val app = MainActivity.channel
            if (MainActivity.alive && app != null) {
                app.invokeMethod("check", null, object : MethodChannel.Result {
                    override fun success(result: Any?) = finished.countDown()
                    override fun error(code: String, message: String?, details: Any?) = finished.countDown()
                    override fun notImplemented() = finished.countDown()
                })
                return@post
            }
            val ctx = applicationContext
            val loader = FlutterInjector.instance().flutterLoader()
            loader.startInitialization(ctx)
            loader.ensureInitializationComplete(ctx, null)
            val e = FlutterEngine(ctx)
            engine = e
            MethodChannel(e.dartExecutor.binaryMessenger, "nb/background").setMethodCallHandler { call, result ->
                when (call.method) {
                    "notify" -> Notices.post(ctx, call.arguments as Map<String, Any?>)
                    "cancel" -> Notices.cancel(ctx, call.argument<String>("tag")!!)
                    "done" -> finished.countDown()
                }
                result.success(null)
            }
            e.dartExecutor.executeDartEntrypoint(
                DartExecutor.DartEntrypoint(loader.findAppBundlePath(), "package:nb_app/notify/headless.dart", "backgroundCheck"),
            )
        }
        finished.await(LIMIT_S, TimeUnit.SECONDS)
        main.post { engine?.destroy() }
        return Result.success()
    }

    companion object {
        private const val NAME = "nb-check"
        private const val LIMIT_S = 60L

        fun schedule(ctx: Context, on: Boolean) {
            val wm = WorkManager.getInstance(ctx)
            if (!on) {
                wm.cancelUniqueWork(NAME)
                return
            }
            val req = PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            wm.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}
