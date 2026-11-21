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
  makeTask({ id: "bot-task", kind: "grok", status: "succeeded", sessionId: "bot-session" }),
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
let settingsPatch;
const streams = new Set();
const grokRequests = [];
const mockLink = "https://cursor.com/loginDeepControl?code=mock-only";
let loginResult = { state: "idle" };
let loginHttp = 200;
let deploymentsHttp = 200;
let slugs = ["team-agent", "<bad>", "team-agent"];
const server = createMockServer(state, async (req, res, url) => {
  if (["/api/settings/grok/login", "/api/settings/grok/deployments"].includes(url.pathname)) {
    const resource = url.pathname.split("/").pop();
    grokRequests.push(`${req.method} ${resource}`);
    if (req.headers["x-board-local"] !== "1") json(res, 403, {});
    else if (resource === "deployments" && req.method === "GET") json(res, deploymentsHttp, { slugs });
    else if (resource === "login" && req.method === "GET") json(res, loginHttp, loginResult);
    else if (resource === "login" && req.method === "POST") {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const valid = req.headers.origin === base && req.headers["content-type"] === "application/json" && Buffer.concat(body).toString() === "{}";
      json(res, valid ? loginHttp : 400, loginResult);
    } else json(res, 405, {});
    return true;
  }
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`event: hello\ndata: ${JSON.stringify({
      tasks: [...state.tasks.values()], workspaces: [...state.workspaces.values()],
    })}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return true;
  }
  if (url.pathname === "/api/settings" && req.method === "PUT") {
    settingsPatch = await readBody(req);
    if (settingsPatch.grokBot) state.settings.grokBot = settingsPatch.grokBot;
    json(res, 200, state.settings);
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
    task.thinkingEffort = lastBody.thinkingEffort || task.thinkingEffort;
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
  const nav = { waitUntil: "domcontentloaded" };
  // Board readiness is a rendered snapshot plus applied settings, not an idle SSE socket.
  const loadBoard = async (reload = false) => {
    await (reload ? page.reload(nav) : page.goto(base, nav));
    await page.waitForSelector('.card[data-id="bot-task"]');
    await page.waitForSelector('#create-quick-prompts [data-quick-id="qp_demo"]');
  };
  await loadBoard();
  const open = async (id) => {
    await page.click(`.card[data-id="${id}"]`);
    await page.waitForFunction((taskId) => document.getElementById("detail-task-id")?.textContent === taskId, {}, id);
  };
  await open(first.id);
  assert.equal(await page.$eval("#continue-model", (el) => el.disabled), false);
  assert.equal(await page.$eval("#continue-thinking-effort", (el) => el.disabled), false);
  assert.equal(await page.$eval("#continue-thinking-effort", (el) => el.value), "medium");
  assert.match(await page.$eval("#continue-model", (el) => el.placeholder), /sonnet/);
  await page.click("#continue-model");
  await page.waitForSelector('#continue-model-dropdown:not(.hidden) [data-value="opus"]');
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
  await page.select("#continue-thinking-effort", "high");

  // Repeated server updates must not erase an unfinished selection or follow-up.
  await page.type("#continue-prompt", "next instruction");
  for (const stream of streams) stream.write(`event: task_upsert\ndata: ${JSON.stringify({ task: first })}\n\n`);
  await page.waitForFunction(() => document.getElementById("continue-model")?.value === "opus");
  assert.equal(await page.$eval("#continue-thinking-effort", (el) => el.value), "high");
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
  assert.deepEqual(lastBody, { prompt: "next instruction", model: "opus", thinkingEffort: "high" });
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
  assert.equal(await page.$eval("#continue-thinking-effort", (el) => el.disabled), true);
  assert.equal(await page.$eval("#continue-btn", (el) => el.disabled), true);
  await page.click("#detail-close");
  await open("archived-task");
  assert.equal(await page.$eval("#continue-row", (el) => el.hidden), false);
  assert.equal(await page.$eval("#continue-btn", (el) => el.disabled), false);
  assert.equal(await page.$eval("#continue-model", (el) => el.disabled), false);
  assert.equal(await page.$eval("#continue-thinking-effort", (el) => el.value), "medium");
  await page.click("#continue-btn");
  await page.waitForFunction(() => document.getElementById("detail-sub")?.textContent.includes("迭代 2"));
  assert.equal(state.tasks.get("archived-task").sessionId, "archived-session");
  assert.deepEqual(lastBody, { thinkingEffort: "medium" });
  assert.equal(state.tasks.get("archived-task").prompts[1].prompt, "请基于当前上下文继续完成任务");
  await page.click("#detail-close");
  const botOption = 'select[name="kind"] option[value="grok"]';
  // A legacy board has no toggle or Grok actions, but historical tasks stay readable.
  assert.equal(await page.$(botOption), null);
  await open("bot-task");
  assert.match(await page.$eval("#detail-sub", (el) => el.textContent), /Grok Bot/);
  assert.equal(await page.$eval("#continue-row", (el) => el.hidden), true);
  await page.goto(`${base}/settings`, nav);
  await page.waitForFunction(() => document.querySelector("#settings-status")?.textContent.includes("已加载"));
  assert.equal(await page.$eval("#grok-bot-setting", (el) => el.hidden), true);
  state.settings.grokBot = { enabled: false, slug: "" };
  await page.reload(nav);
  await page.waitForSelector("#grok-bot-enabled", { visible: true });
  const waitText = (id, text) => page.waitForFunction((id, text) => document.getElementById(id).textContent.includes(text), {}, id, text);
  assert.deepEqual(grokRequests, [], "settings load must not contact Cursor APIs");
  await page.evaluate(() => { window.open = () => { throw new Error("unexpected automatic popup"); }; });

  // Already-authorized accounts can list deployments without starting/checking login.
  await page.click("#grok-refresh-deployments");
  await page.waitForSelector("#grok-deployments:not([hidden])");
  assert.deepEqual(grokRequests, ["GET deployments"]);
  assert.deepEqual(await page.$$eval("#grok-deployments option", els => els.map(el => el.value)), ["", "team-agent"]);
  await page.click("#grok-login-check");
  await waitText("grok-login-status", "没有进行中");

  loginResult = { state: "pending", loginUrl: mockLink };
  await page.click("#grok-login");
  await page.waitForSelector("#grok-login-link:not([hidden])");
  assert.deepEqual(await page.$eval("#grok-login-link", el => [el.href, el.target, [...el.relList].sort()]), [mockLink, "_blank", ["noopener", "noreferrer"]]);
  assert.equal(await page.$eval("#grok-login", el => el.disabled), true);
  loginResult = { state: "success" }; // Simulate approval without navigating to Cursor.
  await waitText("grok-login-status", "已登录");
  assert.deepEqual(grokRequests.slice(-2), ["POST login", "GET login"]);
  assert.equal(await page.$("#grok-login-link[href]"), null);
  slugs = ["authorized-agent"];
  await page.click("#grok-refresh-deployments");
  await page.waitForSelector('#grok-deployments option[value="authorized-agent"]');
  await page.select("#grok-deployments", "authorized-agent");
  assert.equal(await page.$eval("#grok-bot-slug", el => el.value), "authorized-agent");
  assert.equal(await page.$eval("#grok-bot-enabled", el => el.checked), false);
  assert.equal(settingsPatch, undefined);

  for (const unsafe of ["https://cursor.com.evil.invalid/loginDeepControl", "https://evil@cursor.com/loginDeepControl", "https://cursor.com/loginDeepControl/other", "javascript:alert(1)"]) {
    loginResult = { state: "pending", loginUrl: unsafe };
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/grok/login")), page.click("#grok-login-check")]);
    await page.waitForSelector("#grok-login-check:not([disabled])");
    await waitText("grok-login-status", "暂无可信授权链接");
    assert.equal(await page.$("#grok-login-link[href]"), null);
  }
  loginResult = { state: "failed", message: mockLink };
  await page.click("#grok-login-check");
  await waitText("grok-login-status", "登录失败");
  assert.ok(!(await page.$eval("#grok-login-status", el => el.textContent)).includes(mockLink));
  loginHttp = 403;
  await page.click("#grok-login");
  await waitText("grok-login-status", "本机直连");
  deploymentsHttp = 404;
  await page.click("#grok-refresh-deployments");
  await waitText("grok-deployments-status", "升级看板");
  assert.equal(await page.$eval("#grok-bot-slug", el => el.value), "authorized-agent");

  // Failed/unsupported login and listing must never block manual configuration.
  await page.$eval("#grok-bot-slug", el => { el.value = ""; });
  await page.click("#grok-bot-enabled");
  await page.click("#btn-save-settings");
  assert.match(await page.$eval("#settings-status", (el) => el.textContent), /slug/);
  assert.equal(settingsPatch, undefined);
  await page.type("#grok-bot-slug", "review-bot");
  await Promise.all([page.waitForResponse((r) => r.request().method() === "PUT"), page.click("#btn-save-settings")]);
  assert.deepEqual(settingsPatch.grokBot, { enabled: true, slug: "review-bot" });
  await loadBoard();
  await page.click("#btn-new");
  await page.type("#create-prompt", "Review ![photo](/uploads/local.png)");
  await page.select('select[name="kind"]', "grok");
  for (const selector of ["#create-model", "#create-thinking-effort", "#create-attach-btn", "#create-use-worktree", '.prompt-img-btn[data-for="create-prompt"]']) {
    assert.equal(await page.$eval(selector, (el) => el.getClientRects().length), 0, selector);
  }
  const [creation] = await Promise.all([page.waitForRequest((r) => r.url().endsWith("/api/tasks") && r.method() === "POST"), page.click("#create-submit")]);
  const createBody = JSON.parse(creation.postData());
  assert.equal(createBody.kind, "grok");
  assert.equal(createBody.prompt.trim(), "Review");
  for (const field of ["attachments", "useGitWorktree", "model", "thinkingEffort", "sessionId"]) assert.ok(!(field in createBody), field);
  await loadBoard();
  await open("bot-task");
  assert.equal(await page.$eval("#continue-btn", (el) => el.disabled), false);
  assert.equal(await page.$eval("#continue-model", (el) => el.getClientRects().length), 0);
  await page.type("#continue-prompt", "More");
  await page.click("#continue-btn");
  await page.waitForFunction(() => document.getElementById("detail-sub")?.textContent.includes("迭代 2"));
  assert.deepEqual(lastBody, { prompt: "More" });
  assert.equal(state.tasks.get("bot-task").sessionId, "bot-session");
  state.settings.grokBot = { enabled: false, slug: "review-bot" };
  await loadBoard(true);
  assert.equal(await page.$(botOption), null);
  await open("bot-task");
  assert.equal(await page.$eval("#continue-btn", (el) => el.hidden), true);
  assert.deepEqual(errors, []);
  console.log("[e2e-continue-model] model selection, history scoping, SSE, retry and safety guards passed");
} finally {
  await browser?.close();
  for (const stream of streams) stream.end();
  await new Promise((resolve) => server.close(resolve));
}
