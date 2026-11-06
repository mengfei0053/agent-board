import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePiModelsOutput,
  parseClaudeModelsOutput,
  parseCursorModelsOutput,
  parseDevinModelsOutput,
  parseCodexModelsOutput,
  parseKimiModelsOutput,
  fetchAgentModelsFromCli,
  PI_THINKING_EFFORTS,
  CLAUDE_DEFAULT_EFFORTS,
} from "./agentModels.js";
import { _resetCliPathOverridesForTests } from "./cliPaths.js";

describe("agentModels output parsers", () => {
  afterEach(() => {
    _resetCliPathOverridesForTests({});
  });

  it("parses pi --list-models table and JSON outputs with thinking efforts", () => {
    const table = [
      "provider   model                         context  max-out  thinking  images",
      "api        claude-haiku-4-5              200K     64K      no        yes",
      "api        claude-opus-5-5               1M       128K     yes       yes",
      "wb         cn:deepseek-v4.1-flash        128K     64K      yes       no",
      "mgp        antigravity/gemini-4-argon    1M       64K      yes       yes",
    ].join("\n");

    const parsed = parsePiModelsOutput(table);
    assert.deepEqual(parsed, [
      { model: "api/claude-haiku-4-5", thinkingEfforts: [] },
      { model: "api/claude-opus-5-5", thinkingEfforts: [...PI_THINKING_EFFORTS] },
      { model: "wb/cn:deepseek-v4.1-flash", thinkingEfforts: [...PI_THINKING_EFFORTS] },
      { model: "mgp/antigravity/gemini-4-argon", thinkingEfforts: [...PI_THINKING_EFFORTS] },
    ]);

    const jsonOut = JSON.stringify({
      models: [
        { provider: "cpa", id: "gpt-6.1-sol", reasoning: true },
        { provider: "cpa", id: "legacy-fast", reasoning: false },
      ],
    });
    assert.deepEqual(parsePiModelsOutput(jsonOut), [
      { model: "cpa/gpt-6.1-sol", thinkingEfforts: [...PI_THINKING_EFFORTS] },
      { model: "cpa/legacy-fast", thinkingEfforts: [] },
    ]);
  });

  it("parses claude initialize control_response with supportedEffortLevels", () => {
    const line = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req_1",
        response: {
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-5-5",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5-5",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high"],
            },
          ],
        },
      },
    });
    const parsed = parseClaudeModelsOutput(line);
    assert.deepEqual(parsed, [
      { model: "claude-opus-5-5", thinkingEfforts: [...CLAUDE_DEFAULT_EFFORTS] },
      { model: "sonnet", thinkingEfforts: ["low", "medium", "high"] },
      { model: "claude-sonnet-5-5", thinkingEfforts: ["low", "medium", "high"] },
    ]);
  });

  it("parses cursor agent --list-models output and extracts effort levels", () => {
    const out = [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5",
      "grok-4.7-low - Grok 4.7 Low",
      "grok-4.7-high-fast - Grok 4.7 High Fast (current)",
      "deepseek-v41-flash-1017-none - DeepSeek V4.1 Flash None",
      "deepseek-v41-flash-1017-max - DeepSeek V4.1 Flash Max",
      "",
      "Tip: use --model <id> to switch.",
    ].join("\n");

    const parsed = parseCursorModelsOutput(out);
    assert.deepEqual(parsed, [
      { model: "auto", thinkingEfforts: [] },
      { model: "composer-2.5", thinkingEfforts: [] },
      { model: "grok-4.7-low", thinkingEfforts: ["low"] },
      { model: "grok-4.7-high-fast", thinkingEfforts: ["high"] },
      { model: "deepseek-v41-flash-1017-none", thinkingEfforts: ["none"] },
      { model: "deepseek-v41-flash-1017-max", thinkingEfforts: ["max"] },
    ]);
  });

  it("parses devin models list --format json and extracts family + variant efforts", () => {
    const json = JSON.stringify({
      families: [
        {
          slug: "swe-2",
          variants: [
            { model_uid: "swe-2-medium" },
            { model_uid: "swe-2-high" },
            { model_uid: "swe-2-max" },
          ],
        },
        {
          slug: "fusion",
          variants: [{ model_uid: "fusion-a-sidekick-b" }],
        },
      ],
    });
    const parsed = parseDevinModelsOutput(json);
    assert.deepEqual(parsed, [
      { model: "swe-2", thinkingEfforts: ["medium", "high", "max"] },
      { model: "swe-2-medium", thinkingEfforts: ["medium"] },
      { model: "swe-2-high", thinkingEfforts: ["high"] },
      { model: "swe-2-max", thinkingEfforts: ["max"] },
    ]);
  });

  it("parses Kimi provider model aliases", () => {
    const parsed = parseKimiModelsOutput(JSON.stringify({
      providers: { "managed:kimi-code": { apiKey: "not-a-model" } },
      models: {
        "kimi-code/k3": { model: "k3", supportEfforts: ["low", "high"] },
        "kimi-code/k3.1-pro": { model: "k3.1-pro" },
      },
    }));
    assert.deepEqual(parsed, [
      { model: "kimi-code/k3", thinkingEfforts: [] },
      { model: "kimi-code/k3.1-pro", thinkingEfforts: [] },
    ]);
    assert.deepEqual(parseKimiModelsOutput("not-json"), []);
  });

  it("parses codex debug models JSON and skips hidden models", () => {
    const json = JSON.stringify({
      models: [
        {
          slug: "gpt-6.1-terra",
          visibility: "list",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
            { effort: "max" },
          ],
        },
        {
          slug: "hidden-internal",
          visibility: "hide",
          supported_reasoning_levels: [{ effort: "low" }],
        },
      ],
    });
    const parsed = parseCodexModelsOutput(json);
    assert.deepEqual(parsed, [
      {
        model: "gpt-6.1-terra",
        thinkingEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
  });

  it("fetchAgentModelsFromCli probes CLI binaries and throws on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-models-cli-"));
    try {
      const makeScript = (name: string, body: string) => {
        const p = join(dir, name);
        writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, "utf8");
        chmodSync(p, 0o755);
        return p;
      };

      const piBin = makeScript(
        "pi",
        `echo "provider  model  context  max-out  thinking  images"\necho "wb  cn:glm-5.3  200K  64K  yes  yes"`,
      );
      const claudeBin = makeScript(
        "claude",
        `echo '{"type":"control_response","response":{"response":{"models":[{"value":"sonnet","resolvedModel":"claude-sonnet-5-5","supportedEffortLevels":["low","medium","high"]}]}}}'`,
      );
      const agentBin = makeScript(
        "agent",
        `echo "Available models"\necho "grok-4.7-high - Grok 4.7 High"`,
      );
      const devinBin = makeScript(
        "devin",
        `echo '{"families":[{"slug":"swe-2","variants":[{"model_uid":"swe-2-high"}]}]}'`,
      );
      const codexBin = makeScript(
        "codex",
        `echo '{"models":[{"slug":"gpt-6.1-sol","visibility":"list","supported_reasoning_levels":[{"effort":"medium"},{"effort":"high"}]}]}'`,
      );

      _resetCliPathOverridesForTests({
        pi: piBin,
        claude: claudeBin,
        agent: agentBin,
        devin: devinBin,
        codex: codexBin,
      });

      assert.deepEqual(await fetchAgentModelsFromCli("pi", 5000), [
        { model: "wb/cn:glm-5.3", thinkingEfforts: [...PI_THINKING_EFFORTS] },
      ]);
      assert.deepEqual(await fetchAgentModelsFromCli("claude", 5000), [
        { model: "sonnet", thinkingEfforts: ["low", "medium", "high"] },
        { model: "claude-sonnet-5-5", thinkingEfforts: ["low", "medium", "high"] },
      ]);
      assert.deepEqual(await fetchAgentModelsFromCli("cursor", 5000), [
        { model: "grok-4.7-high", thinkingEfforts: ["high"] },
      ]);
      assert.deepEqual(await fetchAgentModelsFromCli("devin", 5000), [
        { model: "swe-2", thinkingEfforts: ["high"] },
        { model: "swe-2-high", thinkingEfforts: ["high"] },
      ]);
      assert.deepEqual(await fetchAgentModelsFromCli("codex", 5000), [
        { model: "gpt-6.1-sol", thinkingEfforts: ["medium", "high"] },
      ]);

      const failBin = makeScript("fail-agent", `echo "auth error" >&2; exit 1`);
      _resetCliPathOverridesForTests({ agent: failBin });
      await assert.rejects(() => fetchAgentModelsFromCli("cursor", 5000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
