package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class QuickPromptChip(val id: String, val label: String, val content: String)

data class WorkspaceSettingsForm(
    val name: String,
    val path: String,
    val systemPrompt: String,
    val skills: String,
    val mcp: String,
)

fun workspaceGetEnvelope(id: String, ts: Long, boardId: String, workspaceId: String, idempotencyKey: String): Validated<Envelope> {
    if (!isWorkspaceId(workspaceId)) return Validated.Invalid("workspaceId is invalid")
    return Validated.Ok(settingsFrame(id, ts, "cmd.workspace.get", buildJsonObject {
        put("boardId", boardId)
        put("idempotencyKey", idempotencyKey)
        put("workspaceId", workspaceId)
    }))
}

fun workspaceUpdateEnvelope(
    id: String,
    ts: Long,
    boardId: String,
    form: WorkspaceSettingsForm,
    workspaceId: String,
    idempotencyKey: String,
): Validated<Envelope> {
    if (!isWorkspaceId(workspaceId)) return Validated.Invalid("workspaceId is invalid")
    val name = form.name.trim()
    if (name.isEmpty() || name.length > 200) return Validated.Invalid("name is required, up to 200 characters")
    return Validated.Ok(settingsFrame(id, ts, "cmd.workspace.update", buildJsonObject {
        put("boardId", boardId)
        put("idempotencyKey", idempotencyKey)
        put("workspaceId", workspaceId)
        put("name", name)
        put("path", form.path.trim())
        put("settings", buildJsonObject {
            put("systemPrompt", form.systemPrompt)
            put("skills", buildJsonArray {
                form.skills.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.forEach { add(JsonPrimitive(it)) }
            })
            put("mcp", form.mcp)
        })
    }))
}

fun settingsGetEnvelope(id: String, ts: Long, boardId: String, idempotencyKey: String): Envelope = settingsFrame(
    id, ts, "cmd.settings.get", buildJsonObject {
        put("boardId", boardId)
        put("idempotencyKey", idempotencyKey)
    },
)

fun settingsPutPromptsEnvelope(
    id: String,
    ts: Long,
    boardId: String,
    prompts: List<QuickPromptChip>,
    idempotencyKey: String,
): Envelope = settingsFrame(id, ts, "cmd.settings.put", buildJsonObject {
    put("boardId", boardId)
    put("idempotencyKey", idempotencyKey)
    put("quickPrompts", buildJsonArray {
        prompts.forEach { prompt ->
            add(buildJsonObject {
                put("id", prompt.id)
                put("label", prompt.label)
                put("content", prompt.content)
            })
        }
    })
})

fun archiveWriteEnvelope(id: String, ts: Long, boardId: String, taskId: String, idempotencyKey: String): Validated<Envelope> {
    return validateStop(id, ts, boardId, taskId, idempotencyKey).let { validated ->
        if (validated is Validated.Invalid) return validated
        Validated.Ok(settingsFrame(id, ts, "cmd.archive", buildJsonObject {
            put("boardId", boardId)
            put("idempotencyKey", idempotencyKey)
            put("taskId", taskId)
        }))
    }
}

fun readWorkspaceSettingsForm(payload: JsonObject): WorkspaceSettingsForm? {
    val workspace = payload.obj("workspace") ?: return null
    val name = workspace.text("name") ?: return null
    val path = workspace.text("path") ?: return null
    if ("settings" !in workspace) return null
    val settings = workspace.obj("settings") ?: return null
    if ("systemPrompt" !in settings || "skills" !in settings || "mcp" !in settings) return null
    val systemPrompt = settings.text("systemPrompt") ?: return null
    val mcp = settings.text("mcp") ?: return null
    val skillsArray = settings.array("skills") ?: return null
    val lines = ArrayList<String>(skillsArray.size)
    for (item in skillsArray) {
        val primitive = item as? JsonPrimitive ?: return null
        if (!primitive.isString) return null
        lines.add(primitive.content)
    }
    return WorkspaceSettingsForm(name, path, systemPrompt, lines.joinToString("\n"), mcp)
}

fun readQuickPrompts(payload: JsonObject): List<QuickPromptChip>? {
    val settings = payload.obj("settings") ?: return null
    if ("quickPrompts" !in settings) return null
    val array = settings.array("quickPrompts") ?: return null
    val prompts = ArrayList<QuickPromptChip>(array.size)
    for (item in array) {
        val row = item as? JsonObject ?: return null
        val id = row.text("id")?.takeIf { it.isNotBlank() } ?: return null
        val label = row.text("label") ?: return null
        val content = row.text("content") ?: return null
        prompts.add(QuickPromptChip(id, label, content))
    }
    return prompts
}

/** True only when this command's executed body is a complete settings document. */
fun settingsDocumentOk(command: String, payload: JsonObject): Boolean = when (command) {
    "cmd.workspace.get", "cmd.workspace.update" -> readWorkspaceSettingsForm(payload) != null
    "cmd.settings.get", "cmd.settings.put" -> readQuickPrompts(payload) != null
    else -> false
}

private fun settingsFrame(id: String, ts: Long, type: String, payload: JsonObject): Envelope {
    return Envelope(v = 1, id = id, type = type, ts = ts, payload = payload)
}
