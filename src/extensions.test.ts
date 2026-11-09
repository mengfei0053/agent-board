import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { ExtensionManager, type ExtensionCatalog } from "./extensions.js";
import { extensionPaths, syncNativeMcp, syncNativeSkills } from "./extensionFiles.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "board-extensions-"));
  roots.push(root);
  const paths = extensionPaths(join(root, "home"), {});
  const store = join(root, "store");
  let saved: ExtensionCatalog = { revision: 0, mcp: [], skills: [] };
  let failSave = false;
  const deps = {
    paths, store,
    async load() { return structuredClone(saved); },
    async save(value: ExtensionCatalog) { if (failSave) throw new Error("private-database-url"); saved = structuredClone(value); },
  };
  const manager = new ExtensionManager(deps);
  return { root, paths, store, manager, deps, get catalog() { return saved; }, failSave() { failSave = true; } };
}
function write(path: string, value: unknown) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function read(path: string) { return JSON.parse(readFileSync(path, "utf8")); }
function makeSkill(root: string) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nUse scripts/review.sh\n");
  writeFileSync(join(root, "scripts", "review.sh"), "#!/bin/sh\necho review\n", { mode: 0o755 });
}

test("native paths include Cursor and XDG Devin and honor tool environment overrides", () => {
  const paths = extensionPaths("/example", { XDG_CONFIG_HOME: "/xdg", CODEX_HOME: "/codex", PI_CODING_AGENT_DIR: "/pi", KIMI_CODE_HOME: "/kimi" });
  assert.equal(paths.cursor.mcp, "/example/.cursor/mcp.json");
  assert.equal(paths.devin.skills, "/xdg/devin/skills");
  assert.equal(paths.codex.mcp, "/codex/config.toml");
  assert.equal(paths.pi.mcp, "/pi/mcp.json");
  assert.equal(paths.kimi.mcp, "/kimi/mcp.json");
  assert.equal(paths.kimi.skills, "/kimi/skills");
});

test("MCP CRUD distributes to all six formats, preserves other settings, masks credentials and survives reload", async () => {
  const f = fixture();
  write(f.paths.cursor.mcp, { otherSetting: true, mcpServers: { manual: { command: "keep" } } });
  mkdirSync(join(f.paths.codex.mcp, ".."), { recursive: true });
  writeFileSync(f.paths.codex.mcp, 'model = "keep-model"\n[mcp_servers.manual]\ncommand = "keep"\n');
  const apps = ["pi", "claude", "cursor", "devin", "codex", "kimi"];
  let result = await f.manager.mutate("save-mcp", { revision: 0, name: "tools", config: { url: "https://example.com/mcp", headers: { Authorization: "secret" } }, apps });
  assert.ok(result.syncResults.every(r => r.ok));
  assert.equal(result.mcp[0].config.headers!.Authorization, "••••••••");
  assert.equal(read(f.paths.devin.mcp).mcpServers.tools.transport, "http");
  assert.equal(read(f.paths.claude.mcp).mcpServers.tools.type, "http");
  assert.equal(read(f.paths.cursor.mcp).otherSetting, true);
  assert.equal(read(f.paths.kimi.mcp).mcpServers.tools.headers.Authorization, "secret");
  const codex = parse(readFileSync(f.paths.codex.mcp, "utf8")) as any;
  assert.equal(codex.model, "keep-model");
  assert.equal(codex.mcp_servers.tools.http_headers.Authorization, "secret");
  assert.equal(read(f.paths.cursor.mcp + ".agent-board.bak").mcpServers.manual.command, "keep");
  result = await f.manager.mutate("save-mcp", { revision: 1, name: "tools", config: result.mcp[0].config, apps });
  assert.ok(result.syncResults.every(r => r.ok));
  assert.equal(f.catalog.mcp[0].config.headers!.Authorization, "secret");
  assert.equal((await new ExtensionManager(f.deps).document()).mcp[0].name, "tools");
  await assert.rejects(f.manager.mutate("delete", { revision: 0, resource: "mcp", name: "tools" }), /其他页面/);
  await f.manager.mutate("set-apps", { revision: 2, resource: "mcp", name: "tools", apps: ["devin"] });
  assert.equal(read(f.paths.cursor.mcp).mcpServers.tools, undefined);
  assert.ok(read(f.paths.devin.mcp).mcpServers.tools);
  await f.manager.mutate("delete", { revision: 3, resource: "mcp", name: "tools" });
  assert.deepEqual(read(f.paths.cursor.mcp).mcpServers, { manual: { command: "keep" } });
  assert.equal(read(f.paths.devin.mcp).mcpServers.tools, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(parse(readFileSync(f.paths.codex.mcp, "utf8")))).mcp_servers, { manual: { command: "keep" } });
});

test("MCP conflict and malformed file leave that agent intact, report partial failure, and allow retry", async () => {
  const f = fixture();
  write(f.paths.cursor.mcp, { mcpServers: { tools: { command: "mine" } } });
  const result = await f.manager.mutate("save-mcp", { revision: 0, name: "tools", config: { command: "managed" }, apps: ["cursor", "devin"] });
  assert.ok(result.syncResults.some(r => r.agent === "cursor" && !r.ok));
  assert.equal(read(f.paths.cursor.mcp).mcpServers.tools.command, "mine");
  assert.equal(read(f.paths.devin.mcp).mcpServers.tools.command, "managed");
  assert.ok((await new ExtensionManager(f.deps).document()).syncResults.some(r => r.agent === "cursor" && !r.ok), "sync failures remain visible after server restart");
  write(f.paths.cursor.mcp, { mcpServers: {} });
  assert.ok((await f.manager.mutate("sync", { revision: 1 })).syncResults.every(r => r.ok));
  write(f.paths.cursor.mcp, { mcpServers: { tools: { command: "external-edit" } } });
  assert.ok((await f.manager.mutate("sync", { revision: 1 })).syncResults.some(r => !r.ok));
  assert.equal(read(f.paths.cursor.mcp).mcpServers.tools.command, "external-edit");
  await f.manager.mutate("delete", { revision: 1, resource: "mcp", name: "tools" });
  assert.equal(read(f.paths.cursor.mcp).mcpServers.tools.command, "external-edit");
  writeFileSync(f.paths.cursor.mcp, "invalid JSON");
  const failed = await f.manager.mutate("save-mcp", { revision: 2, name: "valid", config: { command: "echo" }, apps: ["cursor"] });
  assert.ok(failed.syncResults.some(r => !r.ok));
  assert.equal(readFileSync(f.paths.cursor.mcp, "utf8"), "invalid JSON");
});

test("import adopts equivalent native entries without losing credentials and rejects conflicting imports atomically", async () => {
  const f = fixture();
  write(f.paths.claude.mcp, { mcpServers: { fetch: { command: "uvx", args: ["fetch"] } } });
  await f.manager.mutate("import-mcp", { revision: 0, agent: "claude" });
  assert.ok(read(f.paths.claude.mcp).mcpServers.fetch);
  await f.manager.mutate("set-apps", { revision: 1, resource: "mcp", name: "fetch", apps: [] });
  assert.equal(read(f.paths.claude.mcp).mcpServers.fetch, undefined);
  write(f.paths.devin.mcp, { mcpServers: { first: { command: "ok" }, fetch: { command: "conflict" } } });
  await assert.rejects(f.manager.mutate("import-mcp", { revision: 2, agent: "devin" }), /配置不同/);
  assert.equal(f.catalog.mcp.length, 1);
});

test("MCP validation and failed persistence do not write native config or echo secrets", async () => {
  const f = fixture();
  for (const body of [
    { name: "../bad", config: { command: "x" }, apps: [] },
    { name: "bad", config: { command: "x", url: "https://example.com" }, apps: [] },
    { name: "bad", config: { command: "x" }, apps: ["unknown"] },
  ]) await assert.rejects(f.manager.mutate("save-mcp", { revision: 0, ...body }));
  f.failSave();
  await assert.rejects(f.manager.mutate("save-mcp", { revision: 0, name: "test", config: { command: "x" }, apps: ["cursor"] }), /扩展配置保存失败/);
  assert.equal(existsSync(f.paths.cursor.mcp), false);
});

test("MCP interrupted update journal recovers both before and after native write", () => {
  const f = fixture();
  const path = f.paths.cursor.mcp;
  syncNativeMcp(path, { tools: { command: "old" } });
  write(path + ".agent-board.json", { tools: { applied: { command: "old" }, pending: { command: "new" } } });
  syncNativeMcp(path, { tools: { command: "new" } });
  assert.equal(read(path).mcpServers.tools.command, "new");
  write(path + ".agent-board.json", { tools: { applied: { command: "old" }, pending: { command: "new" } } });
  syncNativeMcp(path, {});
  assert.deepEqual(read(path).mcpServers, {});
});

test("skill packages retain scripts, distribute independently, preserve originals, uninstall and restore", async () => {
  const f = fixture();
  const source = join(f.root, "review");
  makeSkill(source);
  const result = await f.manager.mutate("install-skill", { revision: 0, name: "review", path: source, apps: ["cursor", "devin"] });
  assert.ok(result.syncResults.every(r => r.ok));
  assert.equal(readlinkSync(join(f.paths.devin.skills, "review")), join(f.store, "review"));
  assert.ok(lstatSync(join(f.store, "review", "scripts", "review.sh")).mode & 0o111);
  assert.equal(existsSync(join(source, "SKILL.md")), true);
  await f.manager.mutate("set-apps", { revision: 1, resource: "skills", name: "review", apps: ["devin"] });
  assert.equal(existsSync(join(f.paths.cursor.skills, "review")), false);
  await f.manager.mutate("delete", { revision: 2, resource: "skills", name: "review" });
  assert.equal(existsSync(join(f.paths.devin.skills, "review")), false);
  assert.equal(existsSync(join(f.store, "review", "SKILL.md")), true);
  assert.ok((await f.manager.discoverSkills()).some(entry => entry.agent === "board" && entry.name === "review"));
  await f.manager.mutate("install-skill", { revision: 3, name: "review", path: join(f.store, "review"), apps: ["cursor"] });
  assert.ok(existsSync(join(f.paths.cursor.skills, "review", "scripts", "review.sh")));
});

test("existing same-name skills are checked on load; unchecking deletes them without restoring originals", async () => {
  const f = fixture();
  const source = join(f.root, "review");
  const existing = join(f.paths.cursor.skills, "review");
  makeSkill(source);
  makeSkill(existing);
  writeFileSync(join(existing, "original.txt"), "different existing content");
  const installed = await f.manager.mutate("install-skill", { revision: 0, name: "review", path: source, apps: [] });
  assert.deepEqual(installed.skills[0].apps, ["cursor"]);
  assert.ok(installed.syncResults.every(result => result.ok));
  assert.ok(existsSync(join(existing, "original.txt")), "import with no target selected leaves detected directories intact");
  assert.equal(lstatSync(existing).isSymbolicLink(), false);
  const reloaded = await new ExtensionManager(f.deps).document();
  assert.deepEqual(reloaded.skills[0].apps, ["cursor"]);
  await f.manager.mutate("set-apps", { revision: 1, resource: "skills", name: "review", apps: [] });
  assert.equal(existsSync(existing), false);
  assert.ok(existsSync(join(f.store, "review", "SKILL.md")));
  assert.deepEqual(readdirSync(f.paths.cursor.skills), []);
});

test("checking overwrites same-name skill directories and links while preserving other skills and link destinations", () => {
  const f = fixture();
  const root = f.paths.cursor.skills;
  const master = join(f.store, "review");
  makeSkill(master);
  makeSkill(join(root, "review"));
  writeFileSync(join(root, "review", "old.txt"), "old");
  makeSkill(join(root, "unrelated"));
  syncNativeSkills(root, { review: master }, f.store, ["review"]);
  assert.equal(readlinkSync(join(root, "review")), master);
  assert.equal(existsSync(join(root, "review", "old.txt")), false);
  syncNativeSkills(root, {}, f.store, ["review"]);
  assert.equal(existsSync(join(root, "review")), false);
  const external = join(f.root, "external");
  makeSkill(external);
  symlinkSync(external, join(root, "review"));
  syncNativeSkills(root, { review: master }, f.store, ["review"]);
  assert.equal(readlinkSync(join(root, "review")), master);
  assert.ok(existsSync(join(external, "SKILL.md")));
  rmSync(join(root, "review"));
  symlinkSync(external, join(root, "review"));
  syncNativeSkills(root, {}, f.store, ["review"]);
  assert.ok(existsSync(join(external, "SKILL.md")), "unchecking must unlink without deleting the symlink destination");
  assert.ok(existsSync(join(root, "unrelated", "SKILL.md")));
  assert.throws(() => syncNativeSkills(root, {}, f.store, ["../external"]), /名称/);
});

test("external same-name skills are detected after import and unrelated toggles never overwrite them", async () => {
  const f = fixture();
  const source = join(f.root, "review");
  makeSkill(source);
  await f.manager.mutate("install-skill", { revision: 0, name: "review", path: source, apps: [] });
  const existing = join(f.paths.cursor.skills, "review");
  makeSkill(existing);
  writeFileSync(join(existing, "original.txt"), "keep until explicitly checked or resynced");
  assert.deepEqual((await f.manager.document()).skills[0].apps, ["cursor"]);
  const result = await f.manager.mutate("set-apps", { revision: 1, resource: "skills", name: "review", apps: ["cursor", "devin"] });
  assert.deepEqual(result.skills[0].apps, ["cursor", "devin"]);
  assert.ok(existsSync(join(existing, "original.txt")));
  assert.equal(readlinkSync(join(f.paths.devin.skills, "review")), join(f.store, "review"));
  const synced = await f.manager.mutate("sync", { revision: 2 });
  assert.ok(synced.syncResults.every(result => result.ok));
  assert.equal(readlinkSync(existing), join(f.store, "review"));
  assert.equal(existsSync(join(existing, "original.txt")), false);
});

test("skill import rejects traversal, external symlinks and invalid packages", async () => {
  const f = fixture();
  const source = join(f.root, "bad");
  makeSkill(source);
  symlinkSync("/etc/passwd", join(source, "outside"));
  await assert.rejects(f.manager.mutate("install-skill", { revision: 0, name: "bad", path: source, apps: [] }), /目录外/);
  assert.equal(existsSync(join(f.store, "bad")), false);
  await assert.rejects(f.manager.mutate("install-skill", { revision: 0, name: "../bad", path: source, apps: [] }), /名称/);
  await assert.rejects(f.manager.mutate("install-skill", { revision: 0, name: "bad", url: "file:///etc", apps: [] }), /GitHub HTTPS/);
});

test("skill installation rolls back private files if catalog persistence fails", async () => {
  const f = fixture();
  const source = join(f.root, "review");
  makeSkill(source);
  f.failSave();
  await assert.rejects(f.manager.mutate("install-skill", { revision: 0, name: "review", path: source, apps: ["cursor"] }), /保存失败/);
  assert.equal(existsSync(join(f.store, "review")), false);
  assert.equal(existsSync(f.paths.cursor.skills), false);
});

test("GitHub skill installation passes a branch safely and validates repository subdirectories", async () => {
  const f = fixture();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const capture = join(f.root, "git-args.json");
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
const dir = path.join(args.at(-1), 'skills', 'review');
fs.mkdirSync(dir, {recursive:true});
fs.writeFileSync(path.join(dir,'SKILL.md'), '---\\nname: review\\ndescription: Review code\\n---\\nReview.\\n');
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const result = await f.manager.mutate("install-skill", { revision: 0, name: "review", url: "https://github.com/example/skills", ref: "release/v1", subdir: "skills/review", apps: ["devin"] });
    assert.ok(result.syncResults.every(entry => entry.ok));
    assert.ok(existsSync(join(f.paths.devin.skills, "review", "SKILL.md")));
    const args = JSON.parse(readFileSync(capture, "utf8"));
    assert.deepEqual(args.slice(0, -1), ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--single-branch", "--branch", "release/v1", "--", "https://github.com/example/skills"]);
    await assert.rejects(f.manager.mutate("install-skill", { revision: 1, name: "bad", url: "https://github.com/example/skills", subdir: "../../outside", apps: [] }), /仓库内/);
    await assert.rejects(f.manager.mutate("install-skill", { revision: 1, name: "bad", url: "https://github.com/example/skills", ref: "--upload-pack=bad", apps: [] }), /分支/);
  } finally { process.env.PATH = previousPath; }
});

test("single-agent toggles preserve newly discovered peers and explicitly overwrite checked same-name skills", async () => {
  const f = fixture();
  const source = join(f.root, "review");
  makeSkill(source);
  await f.manager.mutate("install-skill", { revision: 0, name: "review", path: source, apps: [] });
  const cursor = join(f.paths.cursor.skills, "review");
  makeSkill(cursor);
  writeFileSync(join(cursor, "old.txt"), "existing version");
  const enabled = await f.manager.mutate("set-apps", { revision: 1, resource: "skills", name: "review", apps: ["devin"], agent: "devin", enabled: true });
  assert.deepEqual(enabled.skills[0].apps, ["cursor", "devin"]);
  assert.ok(existsSync(join(cursor, "old.txt")), "newly detected peer must not be deleted by a stale selection list");
  await f.manager.mutate("set-apps", { revision: 2, resource: "skills", name: "review", agent: "cursor", enabled: true });
  assert.equal(readlinkSync(cursor), join(f.store, "review"));
  assert.equal(existsSync(join(cursor, "old.txt")), false);
  await f.manager.mutate("set-apps", { revision: 3, resource: "skills", name: "review", agent: "cursor", enabled: false });
  assert.equal(existsSync(cursor), false);
  assert.ok(existsSync(join(f.paths.devin.skills, "review", "SKILL.md")));
});

test("deleting a skill removes same-name agent folders even when they were never linked by the board", async () => {
  const f = fixture();
  const source = join(f.root, "review");
  makeSkill(source);
  await f.manager.mutate("install-skill", { revision: 0, name: "review", path: source, apps: [] });
  for (const agent of ["cursor", "devin"] as const) makeSkill(join(f.paths[agent].skills, "review"));
  await f.manager.mutate("delete", { revision: 1, resource: "skills", name: "review" });
  for (const agent of ["cursor", "devin"] as const) assert.equal(existsSync(join(f.paths[agent].skills, "review")), false);
  assert.ok(existsSync(join(f.store, "review", "SKILL.md")));
});

test("multiline frontmatter descriptions and empty MCP env maps normalize cleanly across agents", async () => {
  const f = fixture();
  write(f.paths.claude.mcp, { mcpServers: { devtools: { type: "stdio", command: "npx", args: ["-y", "devtools"], env: {} } } });
  write(f.paths.cursor.mcp, { mcpServers: { devtools: { command: "npx", args: ["-y", "devtools"] } } });
  await f.manager.mutate("import-mcp", { revision: 0, agent: "claude" });
  const afterMcp = await f.manager.mutate("import-mcp", { revision: 1, agent: "cursor" });
  assert.deepEqual(afterMcp.mcp[0].apps, ["claude", "cursor"]);
  assert.ok(afterMcp.syncResults.every(r => r.ok));
  const folded = join(f.root, "folded");
  mkdirSync(folded, { recursive: true });
  writeFileSync(join(folded, "SKILL.md"), "---\nname: folded\ndescription: >-\n  First line\n  second line.\nversion: 1.0.0\n---\nBody\n");
  const afterSkill = await f.manager.mutate("install-skill", { revision: 2, name: "folded", path: folded, apps: ["cursor"] });
  assert.equal(afterSkill.skills[0].description, "First line second line.");
});

