package tech.mengfei.agentboard

import tech.mengfei.agentboard.data.DiagnosticOperation
import tech.mengfei.agentboard.data.DiagnosticReason
import tech.mengfei.agentboard.protocol.Envelope
import tech.mengfei.agentboard.protocol.text

/** Only these labels can cross the diagnostic boundary, never arbitrary relay fields. */
internal fun operationFor(type: String): DiagnosticOperation? =
    when (type) {
        "cmd.create" -> DiagnosticOperation.CREATE
        "cmd.continue" -> DiagnosticOperation.CONTINUE
        "cmd.stop" -> DiagnosticOperation.STOP
        "cmd.steer" -> DiagnosticOperation.STEER
        "cmd.lookup" -> DiagnosticOperation.LOOKUP
        "cmd.detail" -> DiagnosticOperation.DETAIL
        "cmd.archive" -> DiagnosticOperation.ARCHIVE
        "cmd.archive.list" -> DiagnosticOperation.ARCHIVE_LIST
        "cmd.workspace.create" -> DiagnosticOperation.WORKSPACE_CREATE
        "cmd.workspace.delete" -> DiagnosticOperation.WORKSPACE_DELETE
        "cmd.workspace.get" -> DiagnosticOperation.WORKSPACE_GET
        "cmd.workspace.update" -> DiagnosticOperation.WORKSPACE_UPDATE
        "cmd.settings.get" -> DiagnosticOperation.SETTINGS_GET
        "cmd.settings.put" -> DiagnosticOperation.SETTINGS_PUT
        "client.hello" -> DiagnosticOperation.CONNECT
        "board.list" -> DiagnosticOperation.BOARD_LIST
        "sub.tasks", "sub.logs" -> DiagnosticOperation.SUBSCRIBE
        else -> null
    }

internal fun replyReason(frame: Envelope): DiagnosticReason =
    when (frame.text("code")) {
        "unauthorized", "revoked" -> DiagnosticReason.UNAUTHORIZED
        "forbidden" -> DiagnosticReason.FORBIDDEN
        "unsupported", "bad_type" -> DiagnosticReason.UNSUPPORTED
        "board_offline", "board_disconnected" -> DiagnosticReason.BOARD_OFFLINE
        "bad_request" -> DiagnosticReason.BAD_REQUEST
        "rate_limited" -> DiagnosticReason.RATE_LIMITED
        "not_found", "task_not_found", "workspace_not_found" -> DiagnosticReason.NOT_FOUND
        else -> stageReason(frame.text("stage"))
    }

private fun stageReason(stage: String?): DiagnosticReason =
    when (stage) {
        "accepted" -> DiagnosticReason.ACCEPTED
        "executed" -> DiagnosticReason.EXECUTED
        "failed" -> DiagnosticReason.FAILED
        "timeout" -> DiagnosticReason.TIMEOUT
        else -> DiagnosticReason.UNKNOWN
    }
