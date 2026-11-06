package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class QuickPromptChip(val id: String, val label: String, val content: String)

data class AgentModelItem(
    val model: String,
    val thinkingEfforts: List<String> = emptyList(),
)

data class AgentModelCatalog(
    val agentModels: Map<String, List<AgentModelItem>> = emptyMap(),
    val thinkingEfforts: Map<String, List<String>> = emptyMap(),
    val modelHistory: Map<String, List<String>> = emptyMap(),
)

val DEFAULT_THINKING_EFFORTS_BY_KIND: Map<String, List<String>> = mapOf(
    "pi" to listOf("off", "minimal", "low", "medium", "high", "xhigh", "max"),
    "claude" to listOf("low", "medium", "high", "xhigh", "max"),
    "cursor" to listOf("low", "medium", "high", "xhigh", "max"),
    "devin" to listOf("low", "medium", "high", "xhigh", "max"),
    "codex" to listOf("low", "medium", "high", "xhigh", "max"),
    "kimi" to emptyList(),
)

private val EFFORT_CANONICAL_ORDER = listOf(
    "none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
)

val BOARD_AGENT_KEYS = listOf("codex", "agent", "pi", "claude", "devin", "kimi")
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

fun readAgentModelCatalog(payload: JsonObject): AgentModelCatalog? {
    val settings = payload.obj("settings") ?: return null
    val modelsByKind = linkedMapOf<String, List<AgentModelItem>>()
    settings.obj("agentModels")?.let { rawModels ->
        for (kind in AGENT_KINDS) {
            val arr = rawModels.array(kind) ?: continue
            val seen = HashSet<String>()
            val items = ArrayList<AgentModelItem>(arr.size)
            for (element in arr) {
                when (element) {
                    is JsonPrimitive -> {
                        if (!element.isString) continue
                        val model = element.content.trim()
                        if (model.isNotEmpty() && model.length <= 200 && seen.add(model)) {
                            items.add(AgentModelItem(model, emptyList()))
                        }
                    }
                    is JsonObject -> {
                        val model = element.text("model")?.trim().orEmpty()
                        if (model.isEmpty() || model.length > 200 || !seen.add(model)) continue
                        val efforts = element.array("thinkingEfforts")
                            ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.trim()?.lowercase() }
                            ?.filter { it.isNotEmpty() && it.length <= 32 }
                            ?.distinct()
                            .orEmpty()
                        items.add(AgentModelItem(model, efforts))
                    }
                    else -> continue
                }
            }
            modelsByKind[kind] = items
        }
    }
    val effortsByKind = linkedMapOf<String, List<String>>()
    settings.obj("thinkingEfforts")?.let { rawEfforts ->
        for (kind in AGENT_KINDS) {
            val arr = rawEfforts.array(kind) ?: continue
            val list = arr.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.trim()?.lowercase() }
                .filter { it.isNotEmpty() && it.length <= 32 }
                .distinct()
            effortsByKind[kind] = list
        }
    }
    val historyByKind = linkedMapOf<String, List<String>>()
    settings.obj("modelHistory")?.let { rawHistory ->
        for (kind in AGENT_KINDS) {
            val arr = rawHistory.array(kind) ?: continue
            val list = arr.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.trim() }
                .filter { it.isNotEmpty() && it.length <= 200 }
                .distinct()
            historyByKind[kind] = list
        }
    }
    return AgentModelCatalog(
        agentModels = modelsByKind,
        thinkingEfforts = effortsByKind,
        modelHistory = historyByKind,
    )
}

/** Recent models first (from modelHistory), followed by all synced agentModels for [agent]. */
fun modelOptionsForAgent(catalog: AgentModelCatalog?, agent: String): List<AgentModelItem> {
    val key = agent.trim()
    val known = catalog?.agentModels?.get(key).orEmpty()
    val byName = known.associateBy { it.model }
    val history = catalog?.modelHistory?.get(key).orEmpty()
    val out = ArrayList<AgentModelItem>(known.size + history.size)
    val seen = HashSet<String>()
    for (recent in history) {
        val trimmed = recent.trim()
        if (trimmed.isEmpty() || !seen.add(trimmed)) continue
        out.add(byName[trimmed] ?: AgentModelItem(trimmed, emptyList()))
    }
    for (item in known) {
        if (seen.add(item.model)) out.add(item)
    }
    return out
}

/** Supported thinking efforts for [agent] and optional [selectedModel], matching web board logic. */
fun supportedThinkingEfforts(catalog: AgentModelCatalog?, agent: String, selectedModel: String = ""): List<String> {
    val key = agent.trim()
    val list = catalog?.agentModels?.get(key).orEmpty()
    val trimmedModel = selectedModel.trim()
    if (trimmedModel.isNotEmpty()) {
        val matched = list.find { it.model == trimmedModel }
            ?: list.find { it.model.equals(trimmedModel, ignoreCase = true) }
        if (matched != null && matched.thinkingEfforts.isNotEmpty()) {
            return matched.thinkingEfforts
        }
    }
    val aggregated = LinkedHashSet<String>()
    for (item in list) {
        for (effort in item.thinkingEfforts) {
            if (effort.isNotBlank()) aggregated.add(effort)
        }
    }
    if (aggregated.isNotEmpty()) {
        val ordered = EFFORT_CANONICAL_ORDER.filter { it in aggregated }.toMutableList()
        for (effort in aggregated) {
            if (effort !in ordered) ordered.add(effort)
        }
        return ordered
    }
    val explicit = catalog?.thinkingEfforts?.get(key)
    if (explicit != null) return explicit
    return DEFAULT_THINKING_EFFORTS_BY_KIND[key] ?: DEFAULT_THINKING_EFFORTS_BY_KIND.getValue("claude")
}

fun pickDefaultThinkingEffort(efforts: List<String>, preferred: String = ""): String {
    if (efforts.isEmpty()) return ""
    val cleanPreferred = preferred.trim()
    if (cleanPreferred.isNotEmpty() && cleanPreferred in efforts) return cleanPreferred
    if ("medium" in efforts) return "medium"
    if ("high" in efforts) return "high"
    return efforts.firstOrNull { it != "off" && it != "none" } ?: efforts.first()
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
