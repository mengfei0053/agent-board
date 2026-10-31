package tech.mengfei.agentboard.protocol

/**
 * What the phone does with one ack or err.
 * The automatic path never builds another cmd.create. Timeout and stored failure ask for cmd.lookup.
 */
enum class Retry {
    None,
    ReuseSameKey,
    LookupOnly,
}

data class CommandInterpretation(
    val summary: String,
    val retry: Retry,
    val task: RelayTask? = null,
    val settled: Boolean,
)

sealed interface CommandAction {
    data object Wait : CommandAction
    data object SendLookup : CommandAction
    data object Settle : CommandAction
}

sealed interface SubmitPlan {
    data class Send(val idempotencyKey: String) : SubmitPlan
    data class Lookup(val idempotencyKey: String, val cmd: String) : SubmitPlan
    data object Busy : SubmitPlan
}

private val preStoreCodes = setOf(
    "board_offline",
    "forbidden",
    "unauthorized",
    "bad_request",
    "rate_limited",
)

fun interpretCommand(message: Envelope): CommandInterpretation? {
    if (message.type != "ack" && message.type != "err") return null
    val stage = message.payload.text("stage")
    val code = message.payload.text("code")
    val text = message.payload.text("message")
    val task = message.payload.obj("task")?.let(::readTask)
    if (message.type == "ack") {
        return when (stage) {
            "accepted" -> CommandInterpretation(
                "Relay accepted the command. Waiting for the board.",
                Retry.None,
                task,
                settled = false,
            )
            "executed" -> CommandInterpretation(
                "Board accepted the command.",
                Retry.None,
                task,
                settled = true,
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
                null,
                settled = true,
            )
            else -> CommandInterpretation(stage ?: "Unexpected acknowledgement.", Retry.None, null, settled = true)
        }
    }
    val summary = listOfNotNull(code, text).joinToString(": ").ifBlank { "The relay rejected the command." }
    return if (code in preStoreCodes) {
        CommandInterpretation(summary, Retry.ReuseSameKey, null, settled = true)
    } else {
        CommandInterpretation(summary, Retry.LookupOnly, null, settled = true)
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

/** A second stop or continue after lookup is an explicit new command. Create stays on lookup. */
fun explicitResendAllowed(cmd: String, last: CommandInterpretation?): Boolean {
    return cmd != "cmd.create" && last?.retry == Retry.LookupOnly
}

/** Lookups of an accepted command are not registered as waiters, so poll a few times and then stop. */
const val MAX_ACCEPTED_POLLS = 3

data class OutstandingCommand(
    val cmd: String,
    val boardId: String,
    val idempotencyKey: String,
    val polls: Int = 0,
)

sealed interface Recovery {
    data class Lookup(val command: OutstandingCommand) : Recovery
    data class Poll(val command: OutstandingCommand) : Recovery
    data class Clear(val summary: String, val interpretation: CommandInterpretation?) : Recovery
}

/**
 * After client.hello on a new socket, an in-flight command is recovered with cmd.lookup.
 * This never builds another cmd.create, cmd.stop, or cmd.continue.
 */
fun recoverAfterHello(command: OutstandingCommand?): Recovery? {
    if (command == null) return null
    if (command.idempotencyKey.isBlank() || command.boardId.isBlank() || command.cmd.isBlank()) {
        return Recovery.Clear(
            "Lost the in-flight command during reconnect. It was not sent again.",
            null,
        )
    }
    if (command.polls >= MAX_ACCEPTED_POLLS) return stillInFlight()
    return Recovery.Lookup(command)
}

fun recoverFromLookup(command: OutstandingCommand, message: Envelope): Recovery {
    val interpreted = interpretCommand(message)
    if (interpreted == null) {
        return Recovery.Clear(
            "The relay reply could not be read. The command was not sent again.",
            lookupHold("The relay reply could not be read. The command was not sent again."),
        )
    }
    val stage = message.payload.text("stage")
    if (message.type == "ack" && stage == "accepted") {
        val next = command.copy(polls = command.polls + 1)
        if (next.polls >= MAX_ACCEPTED_POLLS) return stillInFlight()
        return Recovery.Poll(next)
    }
    val safe = if (interpreted.retry == Retry.ReuseSameKey) {
        interpreted.copy(
            summary = interpreted.summary.ifBlank { "The command was not sent again." },
            retry = Retry.LookupOnly,
        )
    } else {
        interpreted
    }
    return Recovery.Clear(safe.summary, safe)
}

fun lookupSendFailed(): Recovery.Clear {
    val summary = "Could not reach the relay to check the stored result. The command was not sent again."
    return Recovery.Clear(summary, lookupHold(summary))
}

private fun stillInFlight(): Recovery.Clear {
    val summary = "The command is still in flight on the relay. It was not sent again."
    return Recovery.Clear(summary, lookupHold(summary))
}

private fun lookupHold(summary: String) = CommandInterpretation(summary, Retry.LookupOnly, settled = true)
