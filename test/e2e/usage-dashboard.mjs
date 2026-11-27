// Real Chrome + Hono + SQLite. No hosted Board, CLI accounts, task logs, uploads, or relay.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { launchBrowser } from "./harness.mjs";

const dir = mkdtempSync(join(tmpdir(), "board-usage-e2e-"));
Object.assign(process.env, {
  DATA_DIR: dir,
  DATABASE_URL: `sqlite:${join(dir, "usage.db")}`,
  UPLOADS_DIR: join(dir, "uploads"),
  AGENT_BOARD_REFUSE_REPO_DATA: "1",
  AGENT_BOARD_SKIP_MODEL_SYNC: "1",
});
const { ensureSchema, closePool } = await import("../../src/db.ts");
const { recordUsage, flushUsage } = await import("../../src/usageStats.ts");
const { app } = await import("../../src/server.ts");
const out = process.env.USAGE_SCREENSHOTS_DIR;
let browser, server;
try {
  await ensureSchema();
  const now = Date.now(),
    start = new Date(now).setHours(0, 0, 0, 0);
  for (let i = 0; i < 32; i++) {
    const turn = i === 0;
    const input = 4500 + i * 30,
      output = 250 + i,
      cacheRead = 420000 + i * 400;
    recordUsage(
      `fixture-${i}`,
      turn ? "codex" : "pi",
      {
        key: "final",
        source: turn ? "codex.turn" : "pi.message_end",
        provider: turn ? undefined : ["North", "East", "West"][i % 3],
        model: turn ? undefined : ["atlas", "quartz", "komet", "nova", "spruce"][i % 5],
        requests: turn ? null : 1,
        status: i % 8 === 3 ? "failed" : "success",
        input,
        output,
        cacheRead,
        cacheWrite: turn ? null : 0,
        total: input + output + cacheRead,
        costUsd: turn ? null : 0.25 + i * 0.034,
        costSource: turn ? undefined : "pi-catalog",
        durationMs: 2000 + i * 31,
        firstTokenMs: turn || i % 3 === 1 ? undefined : 120 + i * 7,
      },
      Math.floor(start + ((now - start) * (i + 1)) / 34),
    );
  }
  recordUsage(
    "old-sample",
    "pi",
    {
      key: "old",
      model: "atlas",
      requests: 1,
      total: 4,
      costUsd: null,
      input: 1,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
    },
    now - 400 * 86400000,
  );
  await flushUsage();
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  if (!server.listening) await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`,
    pageErrors = [];
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("agent-board.usage.interval", "0");
  });
  let fail = false,
    legacy = false,
    hold = false,
    held;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/usage") {
      if (legacy) {
        void req.respond({
          status: 200,
          contentType: "application/json",
          body: '{"summary":{},"byAgent":[],"trend":[],"slots":[]}',
        });
        return;
      }
      if (fail) {
        void req.respond({ status: 503, contentType: "application/json", body: '{"error":"隔离测试故障"}' });
        return;
      }
      if (hold) {
        held = req;
        return;
      }
    }
    void req.continue();
  });
  const done = (n) =>
    page.waitForFunction(
      (n) =>
        document.querySelector("#results").getAttribute("aria-busy") === "false" &&
        !document.querySelector("#results").hidden &&
        (n == null || document.querySelector("#tab-logs .u-badge").textContent === String(n)),
      {},
      n,
    );
  const txt = (selector) => page.$eval(selector, (n) => n.innerText);
  const clickText = async (selector, text) => {
    const ok = await page.$$eval(
      selector,
      (nodes, value) => {
        const n = nodes.find((n) => n.textContent.includes(value));
        n?.click();
        return !!n;
      },
      text,
    );
    assert.ok(ok, text);
  };
  const shot = async (name) => {
    if (out) {
      mkdirSync(out, { recursive: true });
      await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    }
  };
  await page.goto(`${url}/usage.html`);
  await done(32);
  assert.match(await txt("#card-requests"), /31/);
  await shot("01-logs");
  await page.click("#tab-providers");
  assert.equal(await txt("#tab-providers .u-badge"), "4");
  await shot("02-providers");
  await page.click("#tab-models");
  assert.equal(await txt("#tab-models .u-badge"), "6");
  const heads = await page.$$eval("#table th", (nodes) => nodes.map((n) => n.textContent));
  assert.deepEqual(heads, ["模型", "请求数 ↓", "成本", "Tokens", "成功率", "速度 ⓘ", "首字 ⓘ"]);
  assert.equal(await page.$eval("#table th[aria-sort]", (n) => n.getAttribute("aria-sort")), "descending");
  await shot("03-models");
  await clickText("#table th button", "模型");
  assert.equal(await txt("#table tbody td:first-child"), "atlas");
  await clickText("#table th button", "模型");
  assert.equal(await txt("#table tbody td:first-child"), "spruce");
  const rect = await page.evaluate(() => ({
    chart: document.querySelector("#chart").getBoundingClientRect().bottom,
    table: document.querySelector(".u-data").getBoundingClientRect().top,
    last: document.querySelector("#table").getBoundingClientRect().bottom,
  }));
  assert.ok(rect.table > rect.chart && rect.last < 900, JSON.stringify(rect));
  await page.click("#card-tokens");
  await page.click("#more");
  assert.match(await txt("#parts"), /缓存写入/);
  await page.select("#chart-style", "line");
  await page.focus("#chart");
  await page.keyboard.press("ArrowRight");
  assert.ok(await page.$eval("#plot-tip", (n) => !n.hidden));
  await page.keyboard.press("Escape");
  await page.select("#provider", "=East");
  await done(11);
  assert.equal(await txt("#tab-providers .u-badge"), "1");
  await page.select("#model", "=atlas");
  await done(2);
  await page.click("#agents [data-agent=codex]");
  await done(1);
  assert.match(await txt("#card-requests"), /—/);
  assert.equal(await txt("#tab-models .u-badge"), "1");
  await page.click('#agents [data-agent=""]');
  await done(32);
  await page.select("#status", "failed");
  await done(4);
  await page.select("#status", "");
  await done(32);
  await page.click("#tab-logs");
  await page.select("#pager select", "10");
  await done(32);
  assert.equal((await page.$$("#table tbody tr")).length, 10);
  const first = await txt("#table tbody td");
  await clickText("#pager button", "下一页");
  await page.waitForFunction(() => document.querySelector("#pager").innerText.includes("第 2 /"));
  assert.notEqual(first, await txt("#table tbody td"));
  await page.click("#table tbody tr:first-child .u-link");
  await page.waitForSelector("#detail[open]");
  const detail = await txt("#detail-body");
  for (const key of [
    "记录完成",
    "Agent",
    "供应商",
    "模型",
    "状态",
    "新增输入",
    "输出",
    "缓存命中",
    "缓存写入",
    "费用来源",
    "耗时",
    "首字延迟",
    "速度",
    "记录来源",
  ])
    assert.ok(detail.includes(key), key);
  await shot("04-detail");
  await page.keyboard.press("Escape");
  await page.select("#range", "all");
  await done(33);
  assert.match(await txt("#chart-title"), /53 周热力图/);
  const allCost = await txt("#card-costUsd");
  await page.click("#earlier");
  await page.waitForFunction(() => !document.querySelector("#later").disabled);
  assert.equal(await txt("#card-costUsd"), allCost);
  await page.click("#later");
  await done(33);
  await shot("05-heat");
  await page.select("#range", "custom");
  await done(32);
  await page.click("#custom button");
  await done(32);
  await page.select("#range", "today");
  await done(32);
  await page.click("#settings");
  await page.waitForSelector("#config[open]");
  await page.waitForFunction(() => document.querySelector("#prices").textContent.includes("尚无"));
  await page.select("#currency", "CNY");
  await page.type("#fx", "7");
  await page.click("#display-form button");
  await done(32);
  assert.match(await txt("#card-costUsd"), /CN¥/);
  await page.select("#currency", "USD");
  await page.click("#display-form button");
  await done(32);
  assert.match(await txt("#card-costUsd"), /\$/);
  await page.type("#price-model", "atlas");
  for (const id of ["input", "output", "cacheRead", "cacheWrite"]) await page.type(`#rate-${id}`, "1");
  await page.click("#price-form button");
  await page.waitForFunction(() => document.querySelector("#prices").textContent.includes("atlas"));
  page.once("dialog", (d) => d.accept());
  await clickText("#prices button", "删除");
  await page.waitForFunction(() => document.querySelector("#prices").textContent.includes("尚无"));
  await page.select("#interval", "5");
  const previousSync = await txt("#last-sync");
  await page.keyboard.press("Escape");
  await page.waitForFunction((old) => document.querySelector("#last-sync").textContent !== old, { timeout: 12000 }, previousSync);
  await page.click("#settings");
  await page.select("#interval", "0");
  await page.keyboard.press("Escape");
  await done(32);
  await page.click("#agents [data-agent=kimi]");
  await done(0);
  assert.match(await txt("#notice"), /尚未接入/);
  await page.click('#agents [data-agent=""]');
  await done(32);
  legacy = true;
  await page.click("#sync");
  await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("旧版用量接口"));
  legacy = false;
  fail = true;
  await page.click("#sync");
  await page.waitForFunction(() => document.querySelector("#notice").dataset.error === "true");
  assert.match(await txt("#notice"), /503/);
  assert.ok(await page.$eval("#results", (n) => n.hidden));
  fail = false;
  hold = true;
  await page.click("#sync");
  await page.waitForFunction(() => document.querySelector("#notice").textContent.includes("正在读取"));
  for (let i = 0; !held && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(held, "request held");
  hold = false;
  await held.continue();
  await done(32);
  await page.select("#chart-style", "bar");
  await page.click("#tab-models");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.$eval(".u-data .u-table-scroll", (n) => n.scrollWidth > n.clientWidth));
  await shot("06-mobile-dark");
  assert.deepEqual(pageErrors, []);
  console.log(
    "PASS real Chrome · 3 tables, counts, sorting, page/detail, filters, pricing, charts, partial/empty/error/loading, light/390px dark; geometry",
    rect,
    out ?? "(no captures requested)",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await closePool();
  rmSync(dir, { recursive: true, force: true });
}
