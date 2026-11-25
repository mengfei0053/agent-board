package tech.mengfei.agentboard.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import tech.mengfei.agentboard.AgentBoardApp
import tech.mengfei.agentboard.R
import tech.mengfei.agentboard.SessionRow
import tech.mengfei.agentboard.data.DiagnosticEvent
import tech.mengfei.agentboard.data.DiagnosticOperation
import tech.mengfei.agentboard.data.DiagnosticReason
import tech.mengfei.agentboard.data.DiagnosticWaitReason
import java.text.DateFormat
import java.util.Date

@Composable
internal fun LocalDiagnosticsEntry(boards: List<SessionRow>) {
    var open by rememberSaveable { mutableStateOf(false) }
    TextButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.diag_title)) }
    if (!open) return
    val app = LocalContext.current.applicationContext as AgentBoardApp
    val status by app.diagnostics.status.collectAsStateWithLifecycle()
    val locale = LocalConfiguration.current.locales[0]
    val format = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM, locale)
    DetailActionDialog(stringResource(R.string.diag_title), { open = false }) {
        Text(stringResource(R.string.diag_boards), style = MaterialTheme.typography.titleSmall)
        if (boards.isEmpty()) Text(stringResource(R.string.no_paired_board))
        boards.forEach { board -> Text(stringResource(R.string.diag_board_status, board.displayName, board.pill)) }
        Text(stringResource(R.string.diag_device), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(R.string.diag_pending, status.pendingCount))
        val lastAck = status.lastAckAtMs?.let { format.format(Date(it)) } ?: stringResource(R.string.diag_never)
        Text(stringResource(R.string.diag_last_ack, lastAck))
        val wait = status.waitReason?.let { stringResource(it.label()) } ?: stringResource(R.string.diag_none)
        Text(stringResource(R.string.diag_wait, wait))
        Text(stringResource(R.string.diag_errors), style = MaterialTheme.typography.titleSmall)
        if (status.recentErrors.isEmpty()) Text(stringResource(R.string.diag_no_errors))
        status.recentErrors.forEach { error ->
            val labels =
                listOfNotNull(
                    stringResource(error.event.label()),
                    error.operation?.let { stringResource(it.label()) },
                    error.reason?.let { stringResource(it.label()) },
                )
            Text(stringResource(R.string.diag_error_row, format.format(Date(error.timestampMs)), labels.joinToString(" · "), error.count))
        }
    }
}

internal fun DiagnosticEvent.label(): Int =
    when (this) {
        DiagnosticEvent.APP_STARTED -> R.string.diag_app_started
        DiagnosticEvent.RELAY_CONNECTED -> R.string.diag_relay_connected
        DiagnosticEvent.SNAPSHOT_SYNCED -> R.string.diag_snapshot_synced
        DiagnosticEvent.COMMAND_SENT -> R.string.diag_command_sent
        DiagnosticEvent.COMMAND_EXECUTED -> R.string.diag_command_executed
        DiagnosticEvent.RELAY_DISCONNECTED -> R.string.diag_disconnected
        DiagnosticEvent.AUTH_REJECTED -> R.string.diag_unauthorized
        DiagnosticEvent.SYNC_GAP -> R.string.diag_sync_gap
        DiagnosticEvent.COMMAND_FAILED -> R.string.diag_command_failed
        DiagnosticEvent.COMMAND_TIMEOUT -> R.string.diag_command_timeout
        DiagnosticEvent.BOARD_ONLINE -> R.string.diag_online
        DiagnosticEvent.SYNC_WAITING -> R.string.diag_sync_waiting
        DiagnosticEvent.SYNC_RECOVERED -> R.string.diag_sync_recovered
        DiagnosticEvent.RECONNECTING -> R.string.diag_reconnecting
        DiagnosticEvent.LOOKUP_RESULT -> R.string.diag_lookup_result
        DiagnosticEvent.BOARD_OFFLINE -> R.string.diag_board_offline
        DiagnosticEvent.BOARD_UNAVAILABLE -> R.string.diag_board_unavailable
        DiagnosticEvent.NETWORK_FAILED -> R.string.diag_network
        DiagnosticEvent.PROTOCOL_INVALID -> R.string.diag_protocol_invalid
        DiagnosticEvent.PAIR_FAILED -> R.string.diag_pair_failed
        DiagnosticEvent.STORAGE_FAILED -> R.string.diag_storage
        DiagnosticEvent.ATTACHMENT_FAILED -> R.string.diag_attachment_failed
        DiagnosticEvent.APP_EXIT_ABNORMAL -> R.string.diag_exit_abnormal
        DiagnosticEvent.NOTIFICATION_FAILED -> R.string.diag_notification_failed
    }

internal fun DiagnosticWaitReason.label(): Int =
    when (this) {
        DiagnosticWaitReason.LOADING -> R.string.diag_loading
        DiagnosticWaitReason.BUSY -> R.string.diag_busy
        DiagnosticWaitReason.USER_ACTIVE -> R.string.diag_user_active
        DiagnosticWaitReason.OFFLINE -> R.string.diag_no_route
        DiagnosticWaitReason.BAD_REQUEST -> R.string.diag_bad_request
        DiagnosticWaitReason.UNAUTHORIZED -> R.string.diag_unauthorized
        DiagnosticWaitReason.FORBIDDEN -> R.string.diag_forbidden
        DiagnosticWaitReason.RATE_LIMITED -> R.string.diag_rate_limited
        DiagnosticWaitReason.HTTP_CLIENT -> R.string.diag_client_error
        DiagnosticWaitReason.HTTP_SERVER -> R.string.diag_server_error
        DiagnosticWaitReason.DNS -> R.string.diag_dns
        DiagnosticWaitReason.TLS -> R.string.diag_tls
        DiagnosticWaitReason.TIMEOUT -> R.string.diag_timeout
        DiagnosticWaitReason.NETWORK -> R.string.diag_network
        DiagnosticWaitReason.INVALID_ACK -> R.string.diag_invalid_ack
        DiagnosticWaitReason.STORAGE -> R.string.diag_storage
    }

internal fun DiagnosticReason.label(): Int =
    when (this) {
        DiagnosticReason.DNS -> R.string.diag_dns
        DiagnosticReason.TLS -> R.string.diag_tls
        DiagnosticReason.TIMEOUT -> R.string.diag_timeout
        DiagnosticReason.NETWORK -> R.string.diag_network
        DiagnosticReason.UNAUTHORIZED -> R.string.diag_unauthorized
        DiagnosticReason.FORBIDDEN -> R.string.diag_forbidden
        DiagnosticReason.UNSUPPORTED -> R.string.diag_unsupported
        DiagnosticReason.BOARD_OFFLINE -> R.string.diag_board_offline
        DiagnosticReason.BAD_REQUEST -> R.string.diag_bad_request
        DiagnosticReason.RATE_LIMITED -> R.string.diag_rate_limited
        DiagnosticReason.NOT_FOUND -> R.string.diag_not_found
        DiagnosticReason.DISCONNECTED -> R.string.diag_disconnected
        DiagnosticReason.UNKNOWN -> R.string.diag_unknown
        DiagnosticReason.ACCEPTED -> R.string.diag_accepted
        DiagnosticReason.EXECUTED -> R.string.diag_command_executed
        DiagnosticReason.FAILED -> R.string.diag_failed
        DiagnosticReason.INVALID -> R.string.diag_invalid
        DiagnosticReason.STORAGE -> R.string.diag_storage
        DiagnosticReason.TOO_LARGE -> R.string.diag_too_large
        DiagnosticReason.EMPTY -> R.string.attachment_missing_content
        DiagnosticReason.UNREADABLE -> R.string.attachment_read_failed
        DiagnosticReason.LIMIT -> R.string.attachment_count_exceeded
        DiagnosticReason.CRASH -> R.string.diag_crash
        DiagnosticReason.ANR -> R.string.diag_anr
        DiagnosticReason.LOW_MEMORY -> R.string.diag_low_memory
        DiagnosticReason.PERMISSION -> R.string.diag_permission
    }

internal fun DiagnosticOperation.label(): Int =
    when (this) {
        DiagnosticOperation.CREATE -> R.string.new_task
        DiagnosticOperation.CONTINUE -> R.string.continue_task
        DiagnosticOperation.STOP -> R.string.stop
        DiagnosticOperation.STEER -> R.string.detail_queue_send
        DiagnosticOperation.LOOKUP -> R.string.check_stored
        DiagnosticOperation.DETAIL -> R.string.title_detail
        DiagnosticOperation.ARCHIVE -> R.string.archive_task
        DiagnosticOperation.ARCHIVE_LIST -> R.string.diag_archive_list
        DiagnosticOperation.WORKSPACE_CREATE -> R.string.title_new_workspace
        DiagnosticOperation.WORKSPACE_DELETE -> R.string.diag_workspace_delete
        DiagnosticOperation.WORKSPACE_GET -> R.string.diag_workspace_get
        DiagnosticOperation.WORKSPACE_UPDATE -> R.string.diag_workspace_update
        DiagnosticOperation.SETTINGS_GET -> R.string.diag_settings_get
        DiagnosticOperation.SETTINGS_PUT -> R.string.diag_settings_put
        DiagnosticOperation.PAIR -> R.string.pair_action
        DiagnosticOperation.REFRESH -> R.string.diag_refresh
        DiagnosticOperation.HEALTH -> R.string.check_relay
        DiagnosticOperation.CONNECT -> R.string.diag_connect
        DiagnosticOperation.BOARD_LIST -> R.string.diag_board_list
        DiagnosticOperation.SUBSCRIBE -> R.string.diag_subscribe
    }
