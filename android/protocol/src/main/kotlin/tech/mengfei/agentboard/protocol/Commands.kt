package tech.mengfei.agentboard.protocol

const val MAX_ACCEPTED_POLLS = 3

private val preStoreCodes = setOf("board_offline", "forbidden", "unauthorized", "bad_request", "rate_limited")

fun interpretCommand(message: Envelope): CommandInterpretation? {
    if (message.type != "ack" && message.type != "err") return null
    val stage = message.payload.text("stage")
    val code = message.payload.text("code")
    val text = message.payload.text("message")
    val task = message.payload.obj("task")?.let { readTask(it) }
    if (message.type != "ack") {
        val joined = listOfNotNull(code, text).joinToString(": ")
        val summary = joined.ifBlank { "The relay rejected the command." }
        val retry = if (code in preStoreCodes) Retry.ReuseSameKey else Retry.LookupOnly
        return CommandInterpretation(summary, retry, task = null, settled = true)
    }
    return when (stage) {
        "accepted" -> CommandInterpretation(
            "Relay accepted the command. Waiting for the board.",
            Retry.None,
            task,
            settled = false,
        )
        "timeout" -> CommandInterpretation(
            text ?: "The board did not answer in time.",
            Retry.LookupOnly,
            task,
            settled = true,
        )
        "failed" -> CommandInterpretation(
            text ?: code ?: "The command failed after the relay stored it.",
            Retry.LookupOnly,
            task,
            settled = true,
        )
        "unknown" -> CommandInterpretation(
            "The relay has no record of this command.",
            Retry.LookupOnly,
            task = null,
            settled = true,
        )
        "executed" -> CommandInterpretation(
            "Board accepted the command.",
            Retry.None,
            task,
            settled = true,
        )
        null -> CommandInterpretation("Unexpected acknowledgement.", Retry.None, task = null, settled = true)
        else -> CommandInterpretation(stage, Retry.None, task = null, settled = true)
    }
}

fun nextCommandAction(lookupAlreadySent: Boolean, interpreted: CommandInterpretation): CommandAction {
    if (!interpreted.settled) return CommandAction.Wait
    if (interpreted.retry == Retry.LookupOnly && !lookupAlreadySent) return CommandAction.SendLookup
    return CommandAction.Settle
}

fun planSubmit(
    cmd: String,
    inflight: Boolean,
    last: CommandInterpretation?,
    lastKey: String?,
    newKey: () -> String,
): SubmitPlan {
    if (inflight) return SubmitPlan.Busy
    if (last?.retry == Retry.LookupOnly && !lastKey.isNullOrBlank()) {
        return SubmitPlan.Lookup(lastKey, cmd)
    }
    if (last?.retry == Retry.ReuseSameKey && !lastKey.isNullOrBlank()) {
        return SubmitPlan.Send(lastKey)
    }
    return SubmitPlan.Send(newKey())
}

fun explicitResendAllowed(cmd: String, last: CommandInterpretation?): Boolean {
    if (cmd != "cmd.create" && last?.retry == Retry.LookupOnly) return true
    return false
}

fun recoverAfterHello(command: OutstandingCommand?): Recovery? {
    if (command == null) return null
    if (command.idempotencyKey.isBlank() || command.boardId.isBlank() || command.cmd.isBlank()) {
        return Recovery.Clear("Lost the in-flight command during reconnect. It was not sent again.", null)
    }
    return if (command.polls >= MAX_ACCEPTED_POLLS) stillInFlight() else Recovery.Lookup(command)
}

fun recoverFromLookup(command: OutstandingCommand, message: Envelope): Recovery {
    val interpreted = interpretCommand(message)
        ?: return Recovery.Clear(
            "The relay reply could not be read. The command was not sent again.",
            lookupHold("The relay reply could not be read. The command was not sent again."),
        )
    val stage = message.payload.text("stage")
    if (message.type == "ack" && stage == "accepted") {
        val next = command.copy(polls = command.polls + 1)
        return if (next.polls >= MAX_ACCEPTED_POLLS) stillInFlight() else Recovery.Poll(next)
    }
    val safe = if (interpreted.retry == Retry.ReuseSameKey) {
        val summary = interpreted.summary.ifBlank { "The command was not sent again." }
        interpreted.copy(summary = summary, retry = Retry.LookupOnly)
    } else {
        interpreted
    }
    return Recovery.Clear(safe.summary, safe)
}

fun lookupSendFailed(): Recovery.Clear = Recovery.Clear(
    "Could not reach the relay to check the stored result. The command was not sent again.",
    lookupHold("Could not reach the relay to check the stored result. The command was not sent again."),
)

private fun stillInFlight(): Recovery.Clear = Recovery.Clear(
    "The command is still in flight on the relay. It was not sent again.",
    lookupHold("The command is still in flight on the relay. It was not sent again."),
)

private fun lookupHold(summary: String): CommandInterpretation =
    CommandInterpretation(summary, Retry.LookupOnly, task = null, settled = true)
