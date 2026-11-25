package tech.mengfei.agentboard.data

import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import kotlin.concurrent.thread

// Do not install an uncaught-exception handler: a crashing or OOM process is not a safe place for I/O.
internal fun recordPreviousProcessExit(
    context: Context,
    diagnostics: AppDiagnostics,
) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    thread(name = "app-exit-diagnostics", isDaemon = true) {
        try {
            val manager = context.getSystemService(ActivityManager::class.java) ?: return@thread
            val exit = manager.getHistoricalProcessExitReasons(context.packageName, 0, 1).firstOrNull() ?: return@thread
            if (exit.processName != Application.getProcessName()) return@thread
            val reason = exitDiagnosticReason(exit.reason) ?: return@thread
            // The OS may keep returning the same record. Store only a timestamp, never descriptions/traces.
            val prefs = context.getSharedPreferences("diagnostic-exit", Context.MODE_PRIVATE)
            if (exit.timestamp <= prefs.getLong("lastSeen", 0L)) return@thread
            diagnostics.recordLocal(DiagnosticEvent.APP_EXIT_ABNORMAL, reason = reason)
            prefs.edit().putLong("lastSeen", exit.timestamp).apply()
        } catch (_: Exception) {
            // Best-effort: OEMs may restrict access or have no exit history.
        }
    }
}

internal fun exitDiagnosticReason(reason: Int): DiagnosticReason? =
    when (reason) {
        ApplicationExitInfo.REASON_ANR -> DiagnosticReason.ANR
        ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE -> DiagnosticReason.CRASH
        ApplicationExitInfo.REASON_LOW_MEMORY -> DiagnosticReason.LOW_MEMORY
        else -> null // Do not treat updates, force-stop, or normal background process removal as crashes.
    }
