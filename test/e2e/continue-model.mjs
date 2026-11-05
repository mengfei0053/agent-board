import assert from "node:assert/strict";
import {
  createState, createMockServer, json, readBody, listen, launchBrowser, makeTask,
} from "./harness.mjs";

const first = makeTask({
  id: "switch-model", kind: "claude", status: "succeeded", model: "sonnet",
  sessionId: "original-session", prompt: "original task",
  outputs: [{ iteration: 1, text: "previous answer" }],
  prompts: [{ iteration: 1, prompt: "original task" }],
});
const state = createState({ tasks: [
  first,
  makeTask({ id: "no-session", status: "failed", model: "pi-original" }),
  makeTask({ id: "running-task", status: "running", sessionId: "running-session" }),
  makeTask({ id: "archived-task", status: "archived", sessionId: "archived-session" }),
] });
for (const task of state.tasks.values()) task.workspaceId = "ws_default";
state.agentModels.claude = [
  { model: "saved-claude-model", thinkingEfforts: ["low", "medium", "high"] },
  { model: "sonnet", thinkingEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "opus", thinkingEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "haiku", thinkingEfforts: ["low", "medium", "high", "xhigh", "max"] },
];
state.agentModels.codex = [
  { model: "codex-only-model", thinkingEfforts: ["low", "medium", "high"] },
];
let failNext = false;
let lastBody;
const streams = new Set();
const server = createMockServer(state, async (req, res, url) => {
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`event: hello\ndata: ${JSON.stringify({
      tasks: [...state.tasks.values()], workspaces: [...state.workspaces.values()],
    })}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return true;
  }
  if (url.pathname.endsWith("/continue") && req.method === "POST") {
    lastBody = await readBody(req);
    if (failNext) {
      failNext = false;
      json(res, 409, { error: "目标模型无法续接原会话" });
      return true;
    }
    const task = state.tasks.get(url.pathname.split("/")[3]);
    task.model = lastBody.model || task.model;
    task.iteration += 1;
    task.prompts.push({ iteration: task.iteration, prompt: lastBody.prompt || "请基于当前上下文继续完成任务" });
    json(res, 200, { task });
    return true;
  }
  return false;
});
const { base } = await listen(server);
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: "networkidle2" });
  const open = async (id) => {
    await page.click(`.card[data-id="${id}"]`);
    await page.waitForFunction((taskId) => document.getElementById("detail-task-id")?.textContent === taskId, {}, id);
  };
  await open(first.id);
  assert.equal(await page.$eval("#continue-model", (el) => el.disabled), false);
  assert.match(await page.$eval("#continue-model", (el) => el.placeholder), /sonnet/);
  await page.click("#continue-model");
  await page.waitForSelector("#continue-model-dropdown:not(.hidden)");
  const suggestions = await page.$$eval(
    "#continue-model-dropdown .model-option:not(.model-option-default)",
    (els) => els.map((el) => el.dataset.value),
  );
  assert.ok(suggestions.includes("saved-claude-model"));
  assert.ok(suggestions.includes("opus"));
  assert.ok(!suggestions.includes("codex-only-model"));

  // Fuzzy search filters the detail modal model dropdown
  await page.type("#continue-model", "op");
  const filtered = await page.$$eval(
    "#continue-model-dropdown .model-option:not(.model-option-default)",
    (els) => els.map((el) => el.dataset.value),
  );
  assert.deepEqual(filtered, ["opus"]);
  await page.click('#continue-model-dropdown .model-option[data-value="opus"]');

  // Repeated server updates must not erase an unfinished selection or follow-up.
  await page.type("#continue-prompt", "next instruction");
  for (const stream of streams) stream.write(`event: task_upsert\ndata: ${JSON.stringify({ task: first })}\n\n`);
  await page.waitForFunction(() => document.getElementById("continue-model")?.value === "opus");
  assert.equal(await page.$eval("#continue-prompt", (el) => el.value), "next instruction");

  // Errors retain input and allow retry without replacing the task/session.
  failNext = true;
  await page.click("#continue-btn");
  await page.waitForSelector("#continue-error:not([hidden])");
  assert.match(await page.$eval("#continue-error", (el) => el.textContent), /无法续接/);
  assert.equal(await page.$eval("#continue-model", (el) => el.value), "opus");
  assert.equal(state.tasks.get(first.id).model, "sonnet");
  assert.equal(await page.$eval("#continue-btn", (el) => el.disabled), false);
  await page.click("#continue-btn");
  try {
    await page.waitForFunction(() => document.getElementById("continue-model")?.placeholder.includes("opus"));
  } catch (error) {
    console.error("[e2e-continue-model] retry state", lastBody, await page.evaluate(() => ({
      model: document.getElementById("continue-model")?.value,
      placeholder: document.getElementById("continue-model")?.placeholder,
      error: document.getElementById("continue-error")?.textContent,
      disabled: document.getElementById("continue-btn")?.disabled,
    })));
    throw error;
  }
  assert.deepEqual(lastBody, { prompt: "next instruction", model: "opus" });
  assert.equal(state.tasks.get(first.id).sessionId, "original-session");
  assert.equal(state.tasks.get(first.id).iteration, 2);
  assert.equal(state.tasks.get(first.id).outputs[0].text, "previous answer");
  assert.equal(await page.$eval("#continue-model", (el) => el.value), "");
  assert.equal(await page.$eval("#continue-prompt", (el) => el.value), "");

  // Blank selection omits model rather than clearing the current one.
  await page.click("#continue-btn");
  await page.waitForFunction(() => document.getElementById("detail-sub")?.textContent.includes("迭代 3"));
  assert.equal("model" in lastBody, false);
  assert.equal(state.tasks.get(first.id).model, "opus");
  await page.click("#detail-close");

  await open("no-session");
  assert.equal(await page.$eval("#continue-model", (el) => el.disabled), true);
  assert.match(await page.$eval("#continue-model-hint", (el) => el.textContent), /缺少原会话/);
  assert.match(await page.$eval("#continue-hint", (el) => el.textContent), /不恢复历史上下文/);
  await page.click("#detail-close");
  await open("running-task");
  assert.equal(await page.$eval("#continue-model", (el) => el.disabled), true);
  assert.equal(await page.$eval("#continue-btn", (el) => el.disabled), true);
  await page.click("#detail-close");
  await open("archived-task");
  assert.equal(await page.$eval("#continue-row", (el) => el.hidden), false);
  assert.equal(await page.$eval("#continue-btn", (el) => el.disabled), false);
  assert.equal(await page.$eval("#continue-model", (el) => el.disabled), false);
  await page.click("#continue-btn");
  await page.waitForFunction(() => document.getElementById("detail-sub")?.textContent.includes("迭代 2"));
  assert.equal(state.tasks.get("archived-task").sessionId, "archived-session");
  assert.deepEqual(lastBody, {});
  assert.equal(state.tasks.get("archived-task").prompts[1].prompt, "请基于当前上下文继续完成任务");
  assert.deepEqual(errors, []);
  console.log("[e2e-continue-model] model selection, history scoping, SSE, retry and safety guards passed");
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await new Promise((resolve) => server.close(resolve));
}
