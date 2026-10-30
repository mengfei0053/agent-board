import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyWorkspaceToPrompt,
  buildWorkspacePromptPrefix,
  mergeWorkspaceSettings,
  normalizeWorkspaceSettings,
} from "./workspaceApply.js";

describe("normalizeWorkspaceSettings", () => {
  it("returns undefined for empty / invalid", () => {
    assert.equal(normalizeWorkspaceSettings(null), undefined);
    assert.equal(normalizeWorkspaceSettings(undefined), undefined);
    assert.equal(normalizeWorkspaceSettings({}), undefined);
    assert.equal(normalizeWorkspaceSettings([]), undefined);
    assert.equal(
      normalizeWorkspaceSettings({ systemPrompt: "  ", skills: [], mcp: "" }),
      undefined,
    );
  });

  it("keeps trimmed systemPrompt, skills, mcp", () => {
    const s = normalizeWorkspaceSettings({
      systemPrompt: "  用 pnpm  ",
      skills: [" a ", "", "b"],
      mcp: ' {"x":1} ',
    });
    assert.deepEqual(s, {
      systemPrompt: "用 pnpm",
      skills: ["a", "b"],
      mcp: '{"x":1}',
    });
  });

  it("accepts skills as newline string", () => {
    const s = normalizeWorkspaceSettings({ skills: "one\n\ntwo\n" });
    assert.deepEqual(s?.skills, ["one", "two"]);
  });
});

describe("mergeWorkspaceSettings", () => {
  it("clears fields when patch sends empty", () => {
    const prev = { systemPrompt: "a", skills: ["s"], mcp: "m" };
    const next = mergeWorkspaceSettings(prev, {
      systemPrompt: "",
      skills: [],
      mcp: "",
    });
    assert.equal(next, undefined);
  });

  it("merges partial patch", () => {
    const next = mergeWorkspaceSettings(
      { systemPrompt: "old", skills: ["x"] },
      { systemPrompt: "new" },
    );
    assert.deepEqual(next, { systemPrompt: "new", skills: ["x"] });
  });
});

describe("buildWorkspacePromptPrefix", () => {
  it("builds labeled sections", () => {
    const prefix = buildWorkspacePromptPrefix({
      systemPrompt: "规则 A",
      skills: ["review"],
      mcp: '{"mcpServers":{}}',
    });
    assert.match(prefix, /\[工作区指令\]/);
    assert.match(prefix, /规则 A/);
    assert.match(prefix, /\[工作区 Skills\]/);
    assert.match(prefix, /- review/);
    assert.match(prefix, /\[工作区 MCP\]/);
  });

  it("returns empty when no settings", () => {
    assert.equal(buildWorkspacePromptPrefix(undefined), "");
    assert.equal(buildWorkspacePromptPrefix({}), "");
  });
});

describe("applyWorkspaceToPrompt", () => {
  const settings = {
    systemPrompt: "空间指令",
    skills: ["foo"],
  };

  it("passes through when no settings or continue with session", () => {
    assert.equal(applyWorkspaceToPrompt(undefined, "hello"), "hello");
    assert.equal(
      applyWorkspaceToPrompt(settings, "hello", { continueWithSession: true }),
      "hello",
    );
  });

  it("prepends prefix with separator on first run", () => {
    const out = applyWorkspaceToPrompt(settings, "实现右键菜单");
    assert.ok(out.startsWith("[工作区指令]"));
    assert.ok(out.includes("空间指令"));
    assert.ok(out.includes("- foo"));
    assert.ok(out.endsWith("实现右键菜单"));
    assert.match(out, /\n---\n/);
  });
});
