package dev.notabene.nb_app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat

// Keeps the process, and with it the app's relay links, alive while agents work: Android freezes a backgrounded app
// otherwise. It holds no connection itself; the Dart side starts and stops it (`nb/background`), and the activity's end
// stops it, since the links go with the activity's engine.
class AgentService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra("title") ?: ""
        val text = intent?.getStringExtra("text") ?: ""
        intent?.getStringExtra("channel")?.let { Notices.serviceChannel(this, it) }
        val n = Notices.serviceNotification(this, title, text)
        if (intent?.action == ACTION_UPDATE) {
            NotificationManagerCompat.from(this).let { if (it.areNotificationsEnabled()) it.notify(Notices.SERVICE_ID, n) }
            return START_NOT_STICKY
        }
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, Notices.SERVICE_ID, n, type)
        // a killed process has no engine to restart the links: the periodic check takes over
        return START_NOT_STICKY
    }

    companion object {
        const val ACTION_UPDATE = "dev.notabene.nb_app.UPDATE"

        fun intent(ctx: Context, title: String, text: String, channel: String?, update: Boolean) =
            Intent(ctx, AgentService::class.java).apply {
                if (update) action = ACTION_UPDATE
                putExtra("title", title)
                putExtra("text", text)
                channel?.let { putExtra("channel", it) }
            }
    }
}
