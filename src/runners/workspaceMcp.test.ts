import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspaceMcp, syncProjectMcp } from "./workspaceMcp.js";
import { parseWorkspaceMcp } from "../workspaceMcp.js";
import { buildWorkspacePromptPrefix, normalizeWorkspaceSettings } from "../workspaceApply.js";
import { spawnLogged } from "./common.js";

const config = JSON.stringify({ mcpServers: {
  remote: { url: "https://example.com/mcp", headers: { Authorization: "secret-marker" } },
  local: { command: "node", args: ["server.js"], env: { API_KEY: "secret-marker" } },
} });

describe("workspace MCP validation", () => {
  it("keeps prose compatible and keeps credentials out of prompts", () => {
    assert.equal(parseWorkspaceMcp("legacy note"), undefined);
    assert.match(buildWorkspacePromptPrefix({ mcp: "legacy note" }), /legacy note/);
    assert.equal(buildWorkspacePromptPrefix({ mcp: config }), "");
    assert.deepEqual(Object.keys(parseWorkspaceMcp(config)!), ["remote", "local"]);
  });

  it("rejects malformed JSON, ambiguous transports and unsupported fields on save", () => {
    for (const mcp of ["{", "[]", '{"x":1}', ...[
      { command: "node", url: "https://example.com" },
      { url: "file:///tmp/foo" }, { url: "https://example.com", type: "sse" },
      { command: "node", args: [4] }, { command: "node", env: null },
      { url: "https://example.com", headers: { token: 4 } }, { command: "node", typo: true },
    ].map((server) => JSON.stringify({ mcpServers: { example: server } }))]) {
      assert.throws(() => normalizeWorkspaceSettings({ mcp }), /settings.mcp/);
    }
    assert.throws(() => parseWorkspaceMcp('{"mcpServers":{"a-b":{"command":"x"},"a_b":{"command":"y"}}}'), /unique/);
  });
});

describe("native MCP configuration", () => {
  it("maps all five clients and removes private temporary configs after use", () => {
    const cwd = mkdtempSync(join(tmpdir(), "board-mcp-test-"));
    try {
      const codex = prepareWorkspaceMcp("codex", cwd, config);
      assert.match(codex.args.join(" "), /http_headers/);
      assert.match(codex.args.join(" "), /mcp_servers.local=/);
      for (const kind of ["claude", "pi"] as const) {
        const prepared = prepareWorkspaceMcp(kind, cwd, config);
        assert.equal(prepared.args[0], "--mcp-config");
        const path = prepared.args[1];
        const native = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(native.mcpServers.remote.url, "https://example.com/mcp");
        assert.equal(native.mcpServers.local.env.API_KEY, "secret-marker");
        if (kind === "claude") assert.equal(native.mcpServers.remote.type, "http");
        assert.equal(statSync(path).mode & 0o777, 0o600);
        prepared.cleanup();
        assert.equal(existsSync(path), false);
      }
      assert.deepEqual(prepareWorkspaceMcp("agent", cwd, config).args, ["--approve-mcps"]);
      prepareWorkspaceMcp("devin", cwd, config);
      const devin = JSON.parse(readFileSync(join(cwd, ".devin/mcp_config.local.json"), "utf8"));
      assert.equal(devin.mcpServers.remote.transport, "http");
      assert.equal(devin.mcpServers.local.transport, "stdio");
      for (const [kind, path] of [["agent", ".cursor/mcp.json"], ["devin", ".devin/mcp_config.local.json"]] as const) {
        prepareWorkspaceMcp(kind, cwd, "");
        assert.deepEqual(JSON.parse(readFileSync(join(cwd, path), "utf8")).mcpServers, {});
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("updates managed entries, preserves unrelated entries, and restores original collisions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "board-mcp-test-"));
    const path = join(cwd, "mcp.json");
    const original = { mcpServers: { other: { command: "keep" }, remote: { url: "https://original.test" } }, extra: true };
    try {
      writeFileSync(path, JSON.stringify(original));
      syncProjectMcp(path, { remote: { url: "https://first.test" }, local: { command: "added" } });
      syncProjectMcp(path, { remote: { url: "https://second.test" } });
      const current = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(current.mcpServers.remote.url, "https://second.test");
      assert.equal(current.mcpServers.local, undefined);
      assert.deepEqual(current.mcpServers.other, original.mcpServers.other);
      syncProjectMcp(path, {});
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
      assert.equal(existsSync(`${path}.agent-board.json`), false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("reports conflicts and invalid existing files without overwriting them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "board-mcp-test-"));
    const path = join(cwd, "mcp.json");
    try {
      syncProjectMcp(path, { x: { command: "managed" } });
      const edited = JSON.stringify({ mcpServers: { x: { command: "external" } } });
      writeFileSync(path, edited);
      assert.throws(() => syncProjectMcp(path, { x: { command: "new" } }), /edited outside/);
      assert.equal(readFileSync(path, "utf8"), edited);
      syncProjectMcp(path, {});
      assert.equal(readFileSync(path, "utf8"), edited);
      writeFileSync(path, "broken");
      assert.throws(() => syncProjectMcp(path, { x: {} }), /Invalid MCP JSON/);
      assert.equal(readFileSync(path, "utf8"), "broken");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("passes config to a real child, cleans up on exit, and redacts Codex arguments", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "board-mcp-test-"));
    const script = join(cwd, "fake-cli");
    writeFileSync(script, '#!/usr/bin/env node\nconsole.log(JSON.stringify({argv:process.argv.slice(2)}));\n', { mode: 0o700 });
    try {
      for (const kind of ["claude", "pi", "codex", "agent", "devin"] as const) {
        const logs: string[] = [];
        const handle = spawnLogged(script, ["resume", "session-id", "next prompt"], cwd, {
          onStatus() {}, onLog: (line) => logs.push(line),
        }, { cliKind: kind, workspaceMcp: config, getStatus: () => "running" });
        await handle.settled;
        const child = logs.map((line) => JSON.parse(line)).find((line) => line.argv);
        assert.deepEqual(child.argv.slice(-3), ["resume", "session-id", "next prompt"]);
        if (kind === "claude" || kind === "pi") {
          assert.equal(child.argv[0], "--mcp-config");
          assert.equal(existsSync(child.argv[1]), false);
        }
        const spawn = logs.map((line) => JSON.parse(line)).find((line) => line.type === "spawn");
        assert.doesNotMatch(JSON.stringify(spawn), /secret-marker/);
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("fails before spawning if MCP configuration is invalid", async () => {
    const statuses: string[] = [];
    const handle = spawnLogged("must-not-run", [], tmpdir(), {
      onStatus: (patch) => { if (patch.status) statuses.push(patch.status); }, onLog() {},
    }, { cliKind: "codex", workspaceMcp: "{", getStatus: () => "queued" });
    await handle.settled;
    assert.deepEqual(statuses, ["failed"]);
  });
});
