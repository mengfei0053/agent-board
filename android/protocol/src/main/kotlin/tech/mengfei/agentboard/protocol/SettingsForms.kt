package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class QuickPromptChip(val id: String, val label: String, val content: String)

val BOARD_AGENT_KEYS = listOf("codex", "agent", "pi", "claude", "devin")
val BOARD_PROXY_KEYS = listOf("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY")

data class AgentSettingsForm(
    val cliPath: String,
    val defaultPath: String,
    val resolved: String?,
    val proxies: Map<String, String>,
)

data class BoardSettingsForm(val agents: Map<String, AgentSettingsForm>, val codexSandbox: Boolean)

/** Only use a complete document so saving a partial response cannot clear overrides. */
fun readBoardSettingsForm(payload: JsonObject): BoardSettingsForm? {
    val settings = payload.obj("settings") ?: return null
    val cliPaths = settings.obj("cliPaths") ?: return null
    val proxyEnv = settings.obj("proxyEnv") ?: return null
    val sandbox = settings.bool("codexSandbox") ?: return null
    val agents = linkedMapOf<String, AgentSettingsForm>()
    for (key in BOARD_AGENT_KEYS) {
        val cli = cliPaths.obj(key) ?: return null
        val proxies = proxyEnv.obj(key) ?: return null
        val overrides = linkedMapOf<String, String>()
        for (proxyKey in BOARD_PROXY_KEYS) {
            val proxy = proxies.obj(proxyKey) ?: return null
            overrides[proxyKey] = proxy.text("override") ?: return null
        }
        agents[key] = AgentSettingsForm(cli.text("override") ?: return null, cli.text("default") ?: return null,
            cli.text("resolved"), overrides)
    }
    return BoardSettingsForm(agents, sandbox)
}

fun settingsPutFormEnvelope(
    id: String, ts: Long, boardId: String, prompts: List<QuickPromptChip>,
    form: BoardSettingsForm, idempotencyKey: String,
): Envelope {
    val base = settingsPutPromptsEnvelope(id, ts, boardId, prompts, idempotencyKey)
    return base.copy(payload = JsonObject(base.payload + buildJsonObject {
        put("cliPaths", buildJsonObject {
            BOARD_AGENT_KEYS.forEach { key -> put(key, form.agents.getValue(key).cliPath) }
        })
        put("proxyEnv", buildJsonObject {
            BOARD_AGENT_KEYS.forEach { key -> put(key, buildJsonObject {
                BOARD_PROXY_KEYS.forEach { proxy -> put(proxy, form.agents.getValue(key).proxies.getValue(proxy)) }
            }) }
        })
        put("codexSandbox", form.codexSandbox)
    }))
}

data class WorkspaceSettingsForm(
    val name: String,
    val path: String,
    val systemPrompt: String,
    val skills: String,
    val mcp: String,
    val git: WorkspaceGitSummary? = null,
)

data class WorkspaceGitSummary(val branch: String?, val dirty: Boolean, val repoCount: Int, val error: String?)

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
    val git = workspace.obj("git")?.let {
        val dirty = it.bool("dirty") ?: return@let null
        val repoCount = it.intValue("repoCount")?.takeIf { count -> count >= 0 } ?: return@let null
        WorkspaceGitSummary(it.text("branch"), dirty, repoCount, it.text("error"))
    }
    return WorkspaceSettingsForm(name, path, systemPrompt, lines.joinToString("\n"), mcp, git)
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
