package tech.mengfei.agentboard.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import tech.mengfei.agentboard.MainActivity
import tech.mengfei.agentboard.R
import tech.mengfei.agentboard.protocol.DoneNotice

class DoneNotifier(private val context: Context) {
    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL,
            context.getString(R.string.task_done_channel),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.task_done_channel_desc)
        }
        manager.createNotificationChannel(channel)
    }

    fun post(notice: DoneNotice) {
        ensureChannel()
        val title = notice.title ?: "Task ${notice.status}"
        val body = notice.summary ?: "${notice.taskId} ${notice.status}"
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_done)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(notice.eventId.hashCode(), notification)
        } catch (error: SecurityException) {
            // Notification permission is not granted. The task row still updates.
        }
    }

    private companion object {
        const val CHANNEL = "task_done"
    }
}
