import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyWorkspaceToPrompt,
  buildWorkspacePromptPrefix,
  mergeWorkspaceSettings,
  normalizeWorkspaceSettings,
  workspaceSettingsSummary,
} from "./workspaceApply.js";

describe("normalizeWorkspaceSettings", () => {
  it("returns undefined for empty and rejects wrong types", () => {
    assert.equal(normalizeWorkspaceSettings(null), undefined);
    assert.equal(normalizeWorkspaceSettings(undefined), undefined);
    assert.equal(normalizeWorkspaceSettings({}), undefined);
    assert.throws(() => normalizeWorkspaceSettings([]), /settings must be an object/);
    assert.throws(() => normalizeWorkspaceSettings("bad"), /settings must be an object/);
    assert.throws(
      () => normalizeWorkspaceSettings({ systemPrompt: 1 }),
      /systemPrompt must be a string/,
    );
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

  it("returns prefix alone when user prompt empty", () => {
    const out = applyWorkspaceToPrompt(settings, "   ");
    assert.ok(out.startsWith("[工作区指令]"));
    assert.ok(!out.includes("---"));
  });
});

describe("workspaceSettingsSummary", () => {
  it("returns empty without settings", () => {
    assert.equal(workspaceSettingsSummary(undefined), "");
    assert.equal(workspaceSettingsSummary({} as never), "");
    assert.equal(
      workspaceSettingsSummary({ id: "1", name: "n", path: "/tmp", createdAt: 0 } as never),
      "",
    );
  });

  it("joins configured bits", () => {
    const ws = {
      id: "1",
      name: "n",
      path: "/tmp",
      createdAt: 0,
      settings: {
        systemPrompt: "x",
        skills: ["a", "b"],
        mcp: "{}",
      },
    };
    assert.equal(workspaceSettingsSummary(ws as never), "提示词 · skills×2 · MCP");
    assert.equal(
      workspaceSettingsSummary({
        ...ws,
        settings: { skills: ["only"] },
      } as never),
      "skills×1",
    );
  });
});

describe("workspaceApply remaining branches (U15)", () => {
  it("rejects non-object settings and non-string fields", () => {
    assert.throws(() => normalizeWorkspaceSettings("nope"), /settings must be an object/);
    assert.throws(() => normalizeWorkspaceSettings(42), /settings must be an object/);
    assert.throws(
      () => normalizeWorkspaceSettings({ skills: ["ok", 1 as never] }),
      /skills must be an array of strings/,
    );
    assert.throws(
      () => normalizeWorkspaceSettings({ systemPrompt: 9 as never }),
      /systemPrompt must be a string/,
    );
  });

  it("merge returns prev when patch undefined; clears mcp only", () => {
    const prev = { systemPrompt: "a", skills: ["s"], mcp: "m" };
    assert.deepEqual(mergeWorkspaceSettings(prev, undefined), prev);
    const next = mergeWorkspaceSettings(prev, { mcp: "   " });
    assert.deepEqual(next, { systemPrompt: "a", skills: ["s"] });
  });

  it("prefix/summary edge bits", () => {
    assert.equal(buildWorkspacePromptPrefix({ systemPrompt: "  " }), "");
    assert.match(buildWorkspacePromptPrefix({ mcp: "cfg" }), /\[工作区 MCP\]/);
    assert.equal(
      workspaceSettingsSummary({
        id: "1",
        name: "n",
        path: "/t",
        createdAt: "0",
        settings: { systemPrompt: "only" },
      } as never),
      "提示词",
    );
    assert.equal(
      workspaceSettingsSummary({
        id: "1",
        name: "n",
        path: "/t",
        createdAt: "0",
        settings: { mcp: "x" },
      } as never),
      "MCP",
    );
  });
});
