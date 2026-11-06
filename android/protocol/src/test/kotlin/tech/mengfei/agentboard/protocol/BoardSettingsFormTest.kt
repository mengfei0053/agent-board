package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class BoardSettingsFormTest {
    @Test
    fun incompleteOrMistypedOverridesCannotBecomeAnEditableForm() {
        val payload = settingsPayload()
        val settings = payload.obj("settings")!!
        assertNull(readBoardSettingsForm(buildJsonObject { put("settings", JsonObject(settings - "proxyEnv")) }))
        val cli = settings.obj("cliPaths")!!
        val codex = cli.obj("codex")!!
        val invalidCli = JsonObject(cli + ("codex" to JsonObject(codex + ("override" to JsonPrimitive(12)))))
        assertNull(readBoardSettingsForm(buildJsonObject { put("settings", JsonObject(settings + ("cliPaths" to invalidCli))) }))
        assertNotNull(readBoardSettingsForm(payload))
    }

    @Test
    fun settingsWriteKeepsRedactedCredentialsAndUsesCursorBinaryKey() {
        val form = readBoardSettingsForm(settingsPayload())!!
        val changed = form.copy(
            codexSandbox = false,
            agents = form.agents + ("agent" to form.agents.getValue("agent").copy(cliPath = "/opt/cursor/agent")),
        )
        val envelope = settingsPutFormEnvelope("save-1", 1, "board-1",
            listOf(QuickPromptChip("q1", "Fix", "Fix this")), changed, "settings-key-1")
        assertEquals("cmd.settings.put", envelope.type)
        assertEquals("/opt/cursor/agent", envelope.payload.obj("cliPaths")!!.text("agent"))
        assertFalse("cursor" in envelope.payload.obj("cliPaths")!!)
        assertEquals("http://user:***@proxy:8899", envelope.payload.obj("proxyEnv")!!.obj("codex")!!.text("HTTP_PROXY"))
        assertEquals("", envelope.payload.obj("proxyEnv")!!.obj("pi")!!.text("HTTP_PROXY"))
        assertEquals(false, envelope.payload.bool("codexSandbox"))
        assertFalse("clear" in envelope.payload)
        assertFalse("default" in envelope.payload.obj("cliPaths")!!)
        assertEquals("Fix this", readQuickPrompts(buildJsonObject { put("settings", envelope.payload) })!!.single().content)
    }

    @Test
    fun readsAgentModelCatalogAndSelectsThinkingEfforts() {
        val payload = buildJsonObject {
            put("settings", buildJsonObject {
                put("quickPrompts", buildJsonArray {})
                put("agentModels", buildJsonObject {
                    put("pi", buildJsonArray {
                        add(buildJsonObject {
                            put("model", "mgp/antigravity/gemini-4-argon")
                            put("thinkingEfforts", buildJsonArray {
                                add(JsonPrimitive("low"))
                                add(JsonPrimitive("high"))
                            })
                        })
                        add(buildJsonObject {
                            put("model", "openai/gpt-5")
                            put("thinkingEfforts", buildJsonArray {
                                add(JsonPrimitive("medium"))
                                add(JsonPrimitive("max"))
                            })
                        })
                    })
                })
                put("thinkingEfforts", buildJsonObject {
                    put("pi", buildJsonArray {
                        add(JsonPrimitive("low"))
                        add(JsonPrimitive("medium"))
                        add(JsonPrimitive("high"))
                        add(JsonPrimitive("max"))
                    })
                    put("kimi", buildJsonArray {})
                })
                put("modelHistory", buildJsonObject {
                    put("pi", buildJsonArray {
                        add(JsonPrimitive("openai/gpt-5"))
                    })
                })
            })
        }
        val catalog = readAgentModelCatalog(payload)!!
        val options = modelOptionsForAgent(catalog, "pi")
        assertEquals(listOf("openai/gpt-5", "mgp/antigravity/gemini-4-argon"), options.map { it.model })
        assertEquals(listOf("low", "high"), supportedThinkingEfforts(catalog, "pi", "mgp/antigravity/gemini-4-argon"))
        assertEquals("high", pickDefaultThinkingEffort(supportedThinkingEfforts(catalog, "pi", "mgp/antigravity/gemini-4-argon")))
        assertEquals(listOf("low", "medium", "high", "max"), supportedThinkingEfforts(catalog, "pi", ""))
        assertEquals("medium", pickDefaultThinkingEffort(supportedThinkingEfforts(catalog, "pi", "")))
        assertTrue(supportedThinkingEfforts(catalog, "kimi", "").isEmpty())
        assertEquals("", pickDefaultThinkingEffort(supportedThinkingEfforts(catalog, "kimi", "")))
    }

    @Test
    fun createAndContinueFramesIncludeOptionalModelAndThinkingEffort() {
        val created = validateCreate(
            id = "m1",
            ts = 1L,
            boardId = "board-1",
            title = "Build feature",
            prompt = "Implement it",
            agent = "pi",
            cwd = "/tmp/repo",
            idempotencyKey = "idem-create-01",
            model = "  mgp/antigravity/gemini-4-argon  ",
            thinkingEffort = "  high  ",
        ) as Validated.Ok
        assertEquals("mgp/antigravity/gemini-4-argon", created.value.payload.text("model"))
        assertEquals("high", created.value.payload.text("thinkingEffort"))

        val defaultCreate = validateCreate(
            id = "m2",
            ts = 1L,
            boardId = "board-1",
            title = "Build feature",
            prompt = "Implement it",
            agent = "pi",
            cwd = "/tmp/repo",
            idempotencyKey = "idem-create-02",
        ) as Validated.Ok
        assertNull(defaultCreate.value.payload.text("model"))
        assertNull(defaultCreate.value.payload.text("thinkingEffort"))

        val continued = validatePhoneContinue(
            id = "m3",
            ts = 2L,
            boardId = "board-1",
            taskId = "task_01",
            idempotencyKey = "idem-cont-01",
            prompt = "Next round",
            model = "claude-opus-4-6",
            thinkingEffort = "max",
        ) as Validated.Ok
        assertEquals("claude-opus-4-6", continued.value.payload.text("model"))
        assertEquals("max", continued.value.payload.text("thinkingEffort"))
    }

    private fun settingsPayload(): JsonObject = buildJsonObject {
        put("settings", buildJsonObject {
            put("codexSandbox", true)
            put("cliPaths", buildJsonObject {
                BOARD_AGENT_KEYS.forEach { key -> put(key, buildJsonObject {
                    put("default", key)
                    put("override", "")
                    put("resolved", "/usr/local/bin/$key")
                }) }
            })
            put("proxyEnv", buildJsonObject {
                BOARD_AGENT_KEYS.forEach { key -> put(key, buildJsonObject {
                    BOARD_PROXY_KEYS.forEach { proxy -> put(proxy, buildJsonObject {
                        put("override", if (key == "codex" && proxy == "HTTP_PROXY") "http://user:***@proxy:8899" else "")
                    }) }
                }) }
            })
        })
    }
}
