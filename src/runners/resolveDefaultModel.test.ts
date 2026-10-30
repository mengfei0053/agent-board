import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { resolveDefaultModel } from "./resolveDefaultModel.js";

type Backup = { path: string; existed: boolean; content?: string };

function backupAndWrite(path: string, content: string, backups: Backup[]) {
  const existed = existsSync(path);
  backups.push({
    path,
    existed,
    content: existed ? readFileSync(path, "utf8") : undefined,
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function restoreAll(backups: Backup[]) {
  for (const b of backups.reverse()) {
    try {
      if (b.existed && b.content != null) writeFileSync(b.path, b.content, "utf8");
      else if (existsSync(b.path)) rmSync(b.path, { force: true });
    } catch {
      /* ignore */
    }
  }
}

describe("resolveDefaultModel (U14)", () => {
  const home = homedir();
  const backups: Backup[] = [];
  const marker = `agent-board-test-model-${Date.now()}`;

  before(() => {
    backupAndWrite(
      join(home, ".pi/agent/settings.json"),
      JSON.stringify({ defaultModel: `${marker}-pi` }),
      backups,
    );
    backupAndWrite(
      join(home, ".cursor/cli-config.json"),
      JSON.stringify({ selectedModel: { modelId: `${marker}-cursor` } }),
      backups,
    );
    backupAndWrite(
      join(home, ".config/devin/config.json"),
      JSON.stringify({ agent: { model: `${marker}-devin` } }),
      backups,
    );
    backupAndWrite(
      join(home, ".codex/config.toml"),
      `# test\nmodel = "${marker}-codex"\n\n[profiles.x]\nmodel = "ignored"\n`,
      backups,
    );
    backupAndWrite(
      join(home, ".claude/settings.json"),
      JSON.stringify({ model: `${marker}-claude` }),
      backups,
    );
  });

  after(() => restoreAll(backups));

  it("reads pi / cursor / devin / codex / claude configs", () => {
    assert.equal(resolveDefaultModel("pi"), `${marker}-pi`);
    assert.equal(resolveDefaultModel("cursor"), `${marker}-cursor`);
    assert.equal(resolveDefaultModel("devin"), `${marker}-devin`);
    assert.equal(resolveDefaultModel("codex"), `${marker}-codex`);
    assert.equal(resolveDefaultModel("claude"), `${marker}-claude`);
  });

  it("falls back to claude.json lastModelUsage when settings missing model", () => {
    // Temporarily blank settings model; provide projects usage
    const settingsPath = join(home, ".claude/settings.json");
    writeFileSync(settingsPath, JSON.stringify({}), "utf8");
    const claudeJson = join(home, ".claude.json");
    const existed = existsSync(claudeJson);
    const prev = existed ? readFileSync(claudeJson, "utf8") : undefined;
    backups.push({ path: claudeJson, existed, content: prev });
    writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: {
          a: { lastModelUsage: { "small-model": { inputTokens: 1, outputTokens: 1 } } },
          b: {
            lastModelUsage: {
              [`${marker}-usage`]: { inputTokens: 100, outputTokens: 200 },
            },
          },
        },
      }),
      "utf8",
    );
    assert.equal(resolveDefaultModel("claude"), `${marker}-usage`);
    // restore settings for other tests if any
    writeFileSync(settingsPath, JSON.stringify({ model: `${marker}-claude` }), "utf8");
  });
});
