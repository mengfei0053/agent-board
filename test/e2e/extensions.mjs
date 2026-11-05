import assert from "node:assert/strict";
import { createState, createMockServer, listen, launchBrowser, json, readBody } from "./harness.mjs";

let catalog = {
  revision: 0, mcp: [], skills: [], syncResults: [], skillStore: "/tmp/board-skills",
  agents: ["pi", "claude", "cursor", "devin", "codex"].map(id => ({ id, mcp: `/tmp/${id}/mcp.json`, skills: `/tmp/${id}/skills` })),
};
let conflict = false;
const server = createMockServer(createState(), async (req, res, url) => {
  if (!url.pathname.startsWith("/api/settings/extensions")) return false;
  if (req.method === "GET") { json(res, 200, catalog); return true; }
  const body = await readBody(req);
  if (conflict) { conflict = false; json(res, 409, { error: "配置已被其他页面修改，请重新加载后重试" }); return true; }
  const action = url.pathname.split("/").pop();
  if (action === "save-mcp") {
    const entry = { name: body.name, config: body.config, apps: body.apps };
    const index = catalog.mcp.findIndex(item => item.name === entry.name);
    if (index >= 0) catalog.mcp[index] = entry;
    else catalog.mcp.push(entry);
  } else if (action === "set-apps") catalog[body.resource].find(entry => entry.name === body.name).apps = body.apps;
  else if (action === "delete") catalog[body.resource] = catalog[body.resource].filter(entry => entry.name !== body.name);
  else if (action === "install-skill") catalog.skills.push({ name: body.name, description: "Review code", source: body.path, apps: body.apps });
  catalog.revision++;
  json(res, 200, catalog);
  return true;
});
const { base } = await listen(server);
const browser = await launchBrowser();
const page = await browser.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("dialog", dialog => dialog.accept());
try {
  await page.goto(`${base}/settings`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => document.querySelector("#extensions-status")?.textContent.includes("已加载"));
  await page.click("#extensions-add");
  await page.type("#extension-name", "docs");
  await page.$eval("#extension-config", input => { input.value = '{"url":"https://example.com/mcp"}'; });
  await page.click('#extension-apps input[value="cursor"]');
  await page.click('#extension-apps input[value="devin"]');
  await page.click("#extension-editor-save");
  await page.waitForFunction(() => !document.getElementById("extension-editor").open);
  assert.deepEqual(catalog.mcp[0].apps, ["cursor", "devin"]);
  await page.click('[data-extension-name="docs"][data-extension-agent="cursor"]');
  await page.waitForFunction(() => document.querySelector('[data-extension-name="docs"][data-extension-agent="cursor"]')?.checked === false && document.querySelector("#extensions-status")?.textContent === "已保存");
  assert.deepEqual(catalog.mcp[0].apps, ["devin"]);
  conflict = true;
  await page.click('[data-extension-name="docs"][data-extension-agent="cursor"]');
  await page.waitForFunction(() => document.querySelector("#extensions-status")?.textContent.includes("其他页面"));
  assert.equal(await page.$eval('[data-extension-name="docs"][data-extension-agent="cursor"]', input => input.checked), false);
  await page.click("#extensions-reload");
  await page.waitForFunction(() => document.querySelector("#extensions-status")?.textContent === "已加载");
  await page.click("#extensions-tab-skills");
  await page.click("#extensions-add");
  await page.type("#extension-name", "review");
  await page.type("#extension-skill-path", "/tmp/review");
  await page.click('#extension-apps input[value="devin"]');
  await page.click("#extension-editor-save");
  await page.waitForFunction(() => !document.getElementById("extension-editor").open);
  assert.equal(catalog.skills[0].name, "review");
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => document.querySelector("#extensions-status")?.textContent === "已加载");
  await page.click("#extensions-tab-skills");
  assert.equal(await page.$eval('[data-extension-name="review"][data-extension-agent="devin"]', input => input.checked), true);
  await page.click(".extensions-table .danger-ish");
  await page.waitForFunction(() => document.querySelector("#extensions-list")?.textContent.includes("暂无"));
  assert.equal(catalog.skills.length, 0);
  await page.setViewport({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, "mobile settings must not overflow the viewport");
  assert.deepEqual(errors, []);
  console.log("[e2e-extensions] matrix, edit, distribution toggles, conflict recovery, skill installation, uninstall, reload and mobile layout OK");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
