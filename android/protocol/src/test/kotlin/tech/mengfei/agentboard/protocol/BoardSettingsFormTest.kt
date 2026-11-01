package tech.mengfei.agentboard.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
