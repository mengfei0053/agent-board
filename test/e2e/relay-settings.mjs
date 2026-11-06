import assert from "node:assert/strict";
import { createState, createMockServer, listen, launchBrowser, json, readBody } from "./harness.mjs";

let relay = { source: "none", enabled: false, relayWsUrl: "", boardId: "", boardLabel: "", hasToken: false, status: "off", lastError: null };
let lastPut = null;
let failNext = null;
const server = createMockServer(createState(), async (req, res, url) => {
  if (url.pathname === "/api/settings/relay" && req.method === "GET") { json(res, 200, relay); return true; }
  if (url.pathname === "/api/settings/relay" && req.method === "PUT") {
    const body = await readBody(req);
    lastPut = body;
    if (failNext) { const error = failNext; failNext = null; json(res, 401, { error }); return true; }
    relay = { source: "settings", enabled: true, relayWsUrl: body.relayWsUrl, boardId: body.boardId, boardLabel: body.boardLabel || body.boardId, hasToken: true, status: "connected", lastError: null };
    json(res, 200, relay);
    return true;
  }
  if (url.pathname === "/api/settings/relay/disconnect" && req.method === "POST") {
    relay = { ...relay, enabled: false, status: "off" };
    json(res, 200, relay);
    return true;
  }
  return false;
});
const { base } = await listen(server);
const browser = await launchBrowser();
const page = await browser.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
try {
  await page.goto(`${base}/settings`, { waitUntil: "networkidle2" });
  assert.equal(await page.$eval("#relay-status-pill", (el) => el.textContent), "未连接");
  assert.equal(await page.$eval("#btn-relay-disconnect", (el) => el.hidden), true);

  // A rejected admin token is shown and the secret field is cleared.
  failNext = "中继管理员令牌无效。";
  await page.type("#relay-url", "wss://relay.example/v1/ws");
  await page.type("#relay-board-id", "thinkbook-main");
  await page.type("#relay-admin-token", "wrong");
  await page.click("#btn-relay-save");
  await page.waitForFunction(() => document.querySelector("#relay-status").textContent.includes("令牌无效"));
  assert.equal(await page.$eval("#relay-admin-token", (el) => el.value), "");

  // Save registers and connects without any restart.
  await page.type("#relay-admin-token", "admin-secret");
  await page.click("#btn-relay-save");
  await page.waitForFunction(() => document.querySelector("#relay-status-pill").textContent === "已连接");
  assert.deepEqual(lastPut, { relayWsUrl: "wss://relay.example/v1/ws", boardId: "thinkbook-main", boardLabel: "", adminToken: "admin-secret", boardToken: "" });
  assert.equal(await page.$eval("#btn-relay-disconnect", (el) => el.hidden), false);
  assert.match(await page.$eval("#relay-status", (el) => el.textContent), /thinkbook-main/);
  assert.equal((await page.content()).includes("admin-secret"), false);

  // Reload restores the saved fields (never the tokens).
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => document.querySelector("#relay-board-id").value === "thinkbook-main");
  assert.equal(await page.$eval("#relay-url", (el) => el.value), "wss://relay.example/v1/ws");
  assert.equal(await page.$eval("#relay-admin-token", (el) => el.value), "");

  await page.click("#btn-relay-disconnect");
  await page.waitForFunction(() => document.querySelector("#relay-status-pill").textContent === "未连接");
  assert.equal(await page.evaluate(() => [localStorage.length, sessionStorage.length]).then((v) => v.join()), "0,0");
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("PASS relay settings: save/connect, error display, secrets cleared, reload restore, disconnect, mobile layout");
} finally {
  await browser.close();
  server.close();
}
