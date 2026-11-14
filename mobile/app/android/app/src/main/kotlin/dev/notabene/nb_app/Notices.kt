package dev.notabene.nb_app

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

// The notifications of agent events and of the service, and the `nb/background` channel the Dart side drives them
// through. Channel names come from Dart in the app's language.
object Notices {
    const val SERVICE_CHANNEL = "nb-connection"
    const val EVENTS_CHANNEL = "nb-agents"
    const val SERVICE_ID = 1
    const val EVENT_ID = 2
    private const val PREFS = "nb-background"

    fun serviceChannel(ctx: Context, name: String) {
        if (Build.VERSION.SDK_INT < 26) return
        val c = NotificationChannel(SERVICE_CHANNEL, name, NotificationManager.IMPORTANCE_MIN)
        c.setShowBadge(false)
        c.setSound(null, null)
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(c)
    }

    private fun eventsChannel(ctx: Context, name: String) {
        if (Build.VERSION.SDK_INT < 26) return
        val c = NotificationChannel(EVENTS_CHANNEL, name, NotificationManager.IMPORTANCE_DEFAULT)
        c.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(c)
    }

    private fun openApp(ctx: Context, code: Int, place: Map<String, Any?>?): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            if (place != null) {
                putExtra("hostId", place["hostId"] as String)
                putExtra("port", (place["port"] as Number).toInt())
                putExtra("root", place["root"] as String)
            }
        }
        return PendingIntent.getActivity(
            ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun serviceNotification(ctx: Context, title: String, text: String): Notification =
        NotificationCompat.Builder(ctx, SERVICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp(ctx, 0, null))
            .build()

    fun post(ctx: Context, a: Map<String, Any?>) {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        eventsChannel(ctx, a["channel"] as String)
        val tag = a["tag"] as String
        val publicTitle = a["publicTitle"] as String
        val public = NotificationCompat.Builder(ctx, EVENTS_CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(publicTitle)
            .build()
        val n = NotificationCompat.Builder(ctx, EVENTS_CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(a["title"] as String)
            .setContentText(a["text"] as String?)
            .setStyle((a["text"] as String?)?.let { NotificationCompat.BigTextStyle().bigText(it) })
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx, tag.hashCode(), a))
            .build()
        try {
            nm.notify(tag, EVENT_ID, n)
        } catch (_: SecurityException) {
            // the permission was taken back meanwhile
        }
    }

    fun cancel(ctx: Context, tag: String) = NotificationManagerCompat.from(ctx).cancel(tag, EVENT_ID)

    fun permission(a: Activity): String {
        if (NotificationManagerCompat.from(a).areNotificationsEnabled()) return "granted"
        if (Build.VERSION.SDK_INT < 33) return "denied"
        val asked = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("asked", false)
        return if (asked && !ActivityCompat.shouldShowRequestPermissionRationale(a, Manifest.permission.POST_NOTIFICATIONS)) {
            "denied"
        } else {
            "ask"
        }
    }

    fun markAsked(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("asked", true).apply()

    fun openSettings(a: Activity) {
        val i = if (Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.packageName)
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${a.packageName}"))
        }
        a.startActivity(i)
    }

    fun granted(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
}

// The activity's end of `nb/background`.
class BackgroundChannel(private val activity: MainActivity, messenger: BinaryMessenger) {
    val channel = MethodChannel(messenger, "nb/background")
    private var pendingPermission: MethodChannel.Result? = null

    /// The chat of the notification that started the activity, until Dart takes it.
    var launch: Map<String, Any?>? = null

    init {
        channel.setMethodCallHandler { call, result ->
            val ctx = activity.applicationContext
            when (call.method) {
                "permission" -> result.success(Notices.permission(activity))
                "requestPermission" -> {
                    if (Build.VERSION.SDK_INT < 33 || Notices.granted(ctx)) {
                        result.success(NotificationManagerCompat.from(ctx).areNotificationsEnabled())
                    } else {
                        pendingPermission?.success(false)
                        pendingPermission = result
                        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST)
                    }
                }
                "startService", "updateService" -> {
                    val update = call.method == "updateService"
                    val i = AgentService.intent(
                        ctx, call.argument<String>("title") ?: "", call.argument<String>("text") ?: "",
                        call.argument<String>("channel"), update,
                    )
                    try {
                        if (update) ctx.startService(i) else ContextCompat.startForegroundService(ctx, i)
                        result.success(null)
                    } catch (e: Exception) {
                        // Android refuses a foreground service from the background (12+): the caller keeps going without it
                        result.error("refused", e.javaClass.simpleName, null)
                    }
                }
                "stopService" -> {
                    ctx.stopService(Intent(ctx, AgentService::class.java))
                    result.success(null)
                }
                "notify" -> {
                    Notices.post(ctx, call.arguments as Map<String, Any?>)
                    result.success(null)
                }
                "cancel" -> {
                    Notices.cancel(ctx, call.argument<String>("tag")!!)
                    result.success(null)
                }
                "schedule" -> {
                    CheckWorker.schedule(ctx, call.argument<Boolean>("on") == true)
                    result.success(null)
                }
                "openSettings" -> {
                    Notices.openSettings(activity)
                    result.success(null)
                }
                "done" -> result.success(null)
                "takeLaunch" -> {
                    result.success(launch)
                    launch = null
                }
                else -> result.notImplemented()
            }
        }
    }

    /// Android's answer. Only a real refusal counts as asked: a dialog dismissed or interrupted (empty results) may be
    /// asked again, or the app would stay "denied" for good.
    fun permissionAnswered(grantResults: IntArray) {
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (grantResults.isNotEmpty() && !granted) Notices.markAsked(activity)
        pendingPermission?.success(granted)
        pendingPermission = null
    }

    /// A tapped notification while the activity runs.
    fun opened(place: Map<String, Any?>) = channel.invokeMethod("opened", place)

    companion object {
        const val REQUEST = 4795

        fun placeOf(i: Intent?): Map<String, Any?>? {
            val host = i?.getStringExtra("hostId") ?: return null
            val root = i.getStringExtra("root") ?: return null
            if (!i.hasExtra("port")) return null
            return mapOf("hostId" to host, "port" to i.getIntExtra("port", 0), "root" to root)
        }
    }
}
