import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestDb, stopTestDb, testDataRoot } from "./harness.js";
import { ensureSchema, getPool, closePool, upsertMetaMany } from "../../src/db.js";
import { ExtensionManager, setExtensionManagerForTests, type ExtensionCatalog } from "../../src/extensions.js";
import { extensionPaths } from "../../src/extensionFiles.js";

await startTestDb();
await ensureSchema();
const { app } = await import("../../src/server.js");
const paths = extensionPaths(join(testDataRoot(), "home"), {});
const deps = {
  paths, store: join(testDataRoot(), "skill-store"),
  async load(): Promise<ExtensionCatalog> {
    const result = await getPool().query("SELECT value FROM meta WHERE key = 'extensions'");
    return result.rows[0] ? JSON.parse(result.rows[0].value) : { revision: 0, mcp: [], skills: [] };
  },
  async save(catalog: ExtensionCatalog) { await upsertMetaMany([["extensions", JSON.stringify(catalog)]]); },
};
setExtensionManagerForTests(new ExtensionManager(deps));
after(async () => { setExtensionManagerForTests(undefined); await closePool(); await stopTestDb(); });
async function post(action: string, body: unknown) {
  return app.request(`/api/settings/extensions/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("extension HTTP routes persist centrally, redact secrets, detect concurrent edits and distribute real files", async () => {
  const initial = await app.request("/api/settings/extensions");
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  let result = await post("save-mcp", { revision: 0, name: "docs", config: { url: "https://example.com/mcp", headers: { Authorization: "private-test-token" } }, apps: ["cursor", "devin"] });
  assert.equal(result.status, 200);
  const saved = await result.json() as any;
  assert.equal(saved.revision, 1);
  assert.doesNotMatch(JSON.stringify(saved), /private-test-token/);
  assert.ok(saved.syncResults.every((entry: any) => entry.ok));
  assert.equal(JSON.parse(readFileSync(paths.cursor.mcp, "utf8")).mcpServers.docs.headers.Authorization, "private-test-token");
  setExtensionManagerForTests(new ExtensionManager(deps));
  assert.equal(((await (await app.request("/api/settings/extensions")).json()) as any).mcp[0].name, "docs");
  const concurrent = await Promise.all([
    post("set-apps", { revision: 1, resource: "mcp", name: "docs", apps: ["cursor"] }),
    post("set-apps", { revision: 1, resource: "mcp", name: "docs", apps: ["devin"] }),
  ]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  assert.equal((await post("sync", { revision: 2 })).status, 200);
  const source = join(testDataRoot(), "http-review");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), "---\nname: http-review\ndescription: Review HTTP\n---\nReview it.\n");
  result = await post("install-skill", { revision: 2, name: "http-review", path: source, apps: ["cursor", "devin"] });
  assert.equal(result.status, 200);
  assert.ok(existsSync(join(paths.devin.skills, "http-review", "SKILL.md")));
  assert.equal((await post("delete", { revision: 3, resource: "skills", name: "http-review" })).status, 200);
  assert.equal(existsSync(join(paths.devin.skills, "http-review")), false);
  const local = await app.request("/api/settings/extensions/local-skills");
  assert.equal(local.status, 200);
  assert.ok(((await local.json()) as any).skills.some((entry: any) => entry.agent === "board"));
  assert.equal((await post("save-mcp", { revision: 4, name: "../bad", config: { command: "x" }, apps: [] })).status, 400);
  assert.equal((await post("not-an-action", { revision: 4 })).status, 404);
});

test("skill HTTP toggles auto-check existing folders, overwrite when enabled and delete when disabled", async () => {
  await getPool().query("DELETE FROM meta WHERE key = 'extensions'");
  setExtensionManagerForTests(new ExtensionManager(deps));
  const source = join(testDataRoot(), "auto-review");
  mkdirSync(source);
  const skillText = "---\nname: auto-review\ndescription: Review\n---\nCentral version.\n";
  writeFileSync(join(source, "SKILL.md"), skillText);
  const existing = join(paths.cursor.skills, "auto-review");
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, "SKILL.md"), "Old version");
  let result = await post("install-skill", { revision: 0, name: "auto-review", path: source, apps: [] });
  assert.equal(result.status, 200);
  let doc = await result.json() as any;
  assert.deepEqual(doc.skills[0].apps, ["cursor"]);
  assert.equal(readFileSync(join(existing, "SKILL.md"), "utf8"), "Old version");
  result = await post("set-apps", { revision: 1, resource: "skills", name: "auto-review", agent: "cursor", enabled: true });
  assert.equal(result.status, 200);
  doc = await result.json() as any;
  assert.ok(doc.syncResults.every((entry: any) => entry.ok));
  assert.ok(lstatSync(existing).isSymbolicLink());
  assert.equal(readFileSync(join(existing, "SKILL.md"), "utf8"), skillText);
  result = await post("set-apps", { revision: 2, resource: "skills", name: "auto-review", agent: "cursor", enabled: false });
  assert.equal(result.status, 200);
  assert.equal(existsSync(existing), false);
  assert.deepEqual(((await result.json()) as any).skills[0].apps, []);
  assert.ok(existsSync(join(deps.store, "auto-review", "SKILL.md")));
  const devin = join(paths.devin.skills, "auto-review");
  mkdirSync(devin, { recursive: true });
  writeFileSync(join(devin, "SKILL.md"), "Existing Devin skill");
  const reloaded = await app.request("/api/settings/extensions");
  assert.deepEqual(((await reloaded.json()) as any).skills[0].apps, ["devin"]);
  result = await post("set-apps", { revision: 3, resource: "skills", name: "auto-review", agent: "devin", enabled: false });
  assert.equal(result.status, 200);
  assert.equal(existsSync(devin), false);
});
