/**
 * E2E E1–E4: workspace delete/edit, create draft/todo, move lane, bulk-delete skip.
 * Uses shared mock API harness (no production DB).
 */
import assert from "node:assert/strict";
import {
  createState,
  createMockServer,
  listen,
  launchBrowser,
  openWsContextMenu,
  dragCardToLane,
  makeTask,
} from "./harness.mjs";

async function waitDialog(page, action, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dialog timeout")), timeout);
    page.once("dialog", async (dialog) => {
      clearTimeout(timer);
      const message = dialog.message();
      const type = dialog.type();
      if (action === "accept") await dialog.accept();
      else await dialog.dismiss();
      resolve({ message, type });
    });
  });
}

async function clickCtx(page, action) {
  await page.evaluate((a) => {
    document.querySelector(`[data-action="${a}"]`)?.click();
  }, action);
}

async function closeDetailIfOpen(page) {
  const open = await page.evaluate(() => {
    const m = document.getElementById("detail-modal");
    return m && !m.classList.contains("hidden");
  });
  if (open) {
    await page.click("#detail-close");
    await page.waitForFunction(() =>
      document.getElementById("detail-modal")?.classList.contains("hidden"),
    );
  }
}

async function selectWorkspace(page, id) {
  await page.evaluate((wsId) => {
    document.querySelector(`.ws-item[data-workspace-id="${wsId}"]`)?.click();
  }, id);
  await page.waitForFunction(
    (wsId) =>
      document.querySelector(`.ws-item[data-workspace-id="${wsId}"]`)?.classList.contains("active"),
    {},
    id,
  );
}

async function expectWorkspaceCounts(page, workspaceId, expected) {
  await page.waitForFunction((id, counts) => {
    const item = document.querySelector(`.ws-item[data-workspace-id="${id}"]`);
    if (!item) return false;
    const actual = [...item.querySelectorAll(".ws-lane-count")].map((el) => Number(el.textContent));
    const total = counts.reduce((sum, count) => sum + count, 0);
    return JSON.stringify(actual) === JSON.stringify(counts)
      && item.querySelector(".ws-item-count")?.textContent === `${total} 个任务`;
  }, {}, workspaceId, expected);
}

async function createViaUi(page, { mode, title, prompt, model }) {
  if (mode === "todo") await page.click("#btn-new-todo");
  else await page.click("#btn-new");
  await page.waitForSelector("#create-modal:not(.hidden)");
  await page.click('input[name="title"]', { clickCount: 3 });
  await page.type('input[name="title"]', title);
  await page.click("#create-prompt", { clickCount: 3 });
  await page.type("#create-prompt", prompt);
  if (model) await page.type("#create-model", model);
  await Promise.all([
    page.waitForSelector("#detail-modal:not(.hidden)"),
    page.click("#create-submit"),
  ]);
}

async function main() {
  const state = createState();
  const server = createMockServer(state);
  const { base } = await listen(server);
  console.log(`[e2e-board] mock server ${base}`);

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);

    // Clear sticky workspace selection from prior runs
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => localStorage.removeItem("agent-board.workspaceId"));
    await page.goto(base + "/", { waitUntil: "networkidle2" });
    await page.waitForSelector(".ws-item");

    // ─── E1: right-click delete ───
    // E1a: cancel confirm → workspace stays
    {
      const dlgP = waitDialog(page, "dismiss");
      assert.equal((await openWsContextMenu(page, "ws_extra")).ok, true);
      await clickCtx(page, "delete");
      const dlg = await dlgP;
      assert.match(dlg.message, /删除工作区/);
      await page.waitForSelector('.ws-item[data-workspace-id="ws_extra"]');
      console.log("[e2e-board] E1a delete cancel ok");
    }

    // E1b: default workspace → error alert
    {
      const confirmP = waitDialog(page, "accept");
      assert.equal((await openWsContextMenu(page, "ws_default")).ok, true);
      await clickCtx(page, "delete");
      await confirmP;
      const alertP = waitDialog(page, "accept");
      const alert = await alertP;
      assert.match(alert.message, /cannot delete the default workspace|默认/);
      await page.waitForSelector('.ws-item[data-workspace-id="ws_default"]');
      console.log("[e2e-board] E1b default delete blocked ok");
    }

    // E1c: workspace with tasks → error alert
    {
      const task = makeTask({
        id: "task_on_extra",
        workspaceId: "ws_extra",
        cwd: "/tmp/agent-board-extra",
        title: "占用任务",
        status: "draft",
        prompt: "keep ws alive",
      });
      state.tasks.set(task.id, task);
      // refresh list so count updates (optional); delete checks server-side
      const confirmP = waitDialog(page, "accept");
      assert.equal((await openWsContextMenu(page, "ws_extra")).ok, true);
      await clickCtx(page, "delete");
      await confirmP;
      const alertP = waitDialog(page, "accept");
      const alert = await alertP;
      assert.match(alert.message, /still has tasks|任务/);
      await page.waitForSelector('.ws-item[data-workspace-id="ws_extra"]');
      state.tasks.delete(task.id);
      console.log("[e2e-board] E1c has-tasks delete blocked ok");
    }

    // E1d: empty non-default → deleted from sidebar
    {
      const confirmP = waitDialog(page, "accept");
      assert.equal((await openWsContextMenu(page, "ws_extra")).ok, true);
      await clickCtx(page, "delete");
      await confirmP;
      await page.waitForFunction(
        () => !document.querySelector('.ws-item[data-workspace-id="ws_extra"]'),
      );
      assert.equal(state.workspaces.has("ws_extra"), false);
      console.log("[e2e-board] E1d delete success ok");
    }

    // Restore ws_extra for later tests / edit
    {
      const now = new Date().toISOString();
      state.workspaces.set("ws_extra", {
        id: "ws_extra",
        name: "可删工作区",
        path: "/tmp/agent-board-extra",
        createdAt: now,
        updatedAt: now,
      });
      await page.reload({ waitUntil: "networkidle2" });
      await page.waitForSelector('.ws-item[data-workspace-id="ws_extra"]');
    }

    // ─── E2: right-click edit name/path reflects sidebar ───
    {
      await selectWorkspace(page, "ws_extra");
      assert.equal((await openWsContextMenu(page, "ws_extra")).ok, true);
      await clickCtx(page, "edit");
      await page.waitForSelector("#ws-modal:not(.hidden)");
      const title = await page.$eval("#ws-modal-title", (el) => el.textContent);
      assert.match(title || "", /编辑/);

      await page.click("#ws-name", { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type("#ws-name", "改名后的空间");
      await page.click("#ws-path", { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type("#ws-path", "/tmp/agent-board-renamed");
      await page.click("#ws-modal-submit");
      await page.waitForSelector("#ws-modal.hidden");

      await page.waitForFunction(() => {
        const name = document.querySelector(
          '.ws-item[data-workspace-id="ws_extra"] .ws-item-name',
        )?.textContent;
        const path = document.querySelector(
          '.ws-item[data-workspace-id="ws_extra"] .ws-item-path',
        )?.textContent;
        return name === "改名后的空间" && path === "/tmp/agent-board-renamed";
      });
      const banner = await page.evaluate(() => ({
        name: document.getElementById("ws-banner-name")?.textContent,
        path: document.getElementById("ws-banner-path")?.textContent,
      }));
      assert.equal(banner.name, "改名后的空间");
      assert.equal(banner.path, "/tmp/agent-board-renamed");
      assert.equal(state.workspaces.get("ws_extra")?.name, "改名后的空间");
      console.log("[e2e-board] E2 edit reflects sidebar ok");
    }

    // ─── E3: create draft / todo into lanes ───
    {
      await selectWorkspace(page, "ws_default");
      await createViaUi(page, {
        mode: "draft",
        title: "E3草稿初始",
        prompt: "写一份单元测试计划",
      });
      await page.waitForSelector("#detail-title-edit-btn");
      await page.click("#detail-title-edit-btn");
      await page.waitForSelector("#detail-title-editor:not([hidden])");
      await page.click("#detail-title-input", { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type("#detail-title-input", "E3草稿");
      await page.click("#detail-title-save");
      await page.waitForFunction(
        () =>
          document.getElementById("detail-title-editor")?.hidden === true &&
          document.getElementById("detail-title")?.textContent === "E3草稿",
      );
      await closeDetailIfOpen(page);
      await page.waitForFunction(() =>
        [...document.querySelectorAll("#list-draft .card .card-title")].some((el) =>
          (el.textContent || "").includes("E3草稿"),
        ),
      );
      const draftIds = [...state.tasks.values()]
        .filter((t) => t.title === "E3草稿")
        .map((t) => t.id);
      assert.equal(draftIds.length, 1);
      assert.equal(state.tasks.get(draftIds[0])?.status, "draft");
      await expectWorkspaceCounts(page, "ws_default", [1, 0, 0, 0, 0]);
      console.log("[e2e-board] E3 draft lane ok");

      await createViaUi(page, {
        mode: "todo",
        title: "E3Todo",
        prompt: "立刻开始跑检查",
      });
      await closeDetailIfOpen(page);
      await page.waitForFunction(() =>
        [...document.querySelectorAll("#list-todo .card .card-title")].some((el) =>
          (el.textContent || "").includes("E3Todo"),
        ),
      );
      const todo = [...state.tasks.values()].find((t) => t.title === "E3Todo");
      assert.ok(todo);
      assert.equal(todo.status, "queued");
      await expectWorkspaceCounts(page, "ws_default", [1, 1, 0, 0, 0]);
      console.log("[e2e-board] E3 todo lane ok");
    }

    // ─── E4: move to lane + bulk delete skips undeletable ───
    {
      // Seed a fresh draft for move (avoid relying on prior create alone)
      const moveId = "task_move_1";
      state.tasks.set(
        moveId,
        makeTask({
          id: moveId,
          workspaceId: "ws_default",
          cwd: "/tmp/agent-board-default",
          title: "待拖草稿",
          status: "draft",
          prompt: "move me",
        }),
      );
      await page.reload({ waitUntil: "networkidle2" });
      await page.waitForSelector(`.card[data-id="${moveId}"]`);
      await selectWorkspace(page, "ws_default");

      await dragCardToLane(page, moveId, "done");
      await page.waitForFunction(
        (id) => Boolean(document.querySelector(`#list-done .card[data-id="${id}"]`)),
        {},
        moveId,
      );
      assert.equal(state.tasks.get(moveId)?.status, "stopped");
      await expectWorkspaceCounts(page, "ws_default", [1, 1, 0, 1, 0]);
      console.log("[e2e-board] E4 move to done ok");

      // Bulk delete: draft (ok) + running (skip)
      const delOk = "task_del_ok";
      const delSkip = "task_del_skip";
      state.tasks.set(
        delOk,
        makeTask({
          id: delOk,
          workspaceId: "ws_default",
          cwd: "/tmp/agent-board-default",
          title: "可删草稿",
          status: "draft",
          prompt: "delete me",
        }),
      );
      state.tasks.set(
        delSkip,
        makeTask({
          id: delSkip,
          workspaceId: "ws_default",
          cwd: "/tmp/agent-board-default",
          title: "进行中不可删",
          status: "running",
          prompt: "keep me",
          summary: "busy",
        }),
      );
      await page.reload({ waitUntil: "networkidle2" });
      await page.waitForSelector(`.card[data-id="${delOk}"]`);
      await page.waitForSelector(`.card[data-id="${delSkip}"]`);
      await selectWorkspace(page, "ws_default");

      await page.evaluate((ids) => {
        for (const id of ids) {
          const check = document.querySelector(`.card[data-id="${id}"] .card-check`);
          if (check && !check.checked) check.click();
        }
      }, [delOk, delSkip]);
      await page.waitForSelector("#bulk-bar:not(.hidden)");

      const confirmP = waitDialog(page, "accept");
      await page.click("#bulk-delete");
      const confirm = await confirmP;
      assert.match(confirm.message, /确认删除/);
      assert.match(confirm.message, /跳过/);

      const alertP = waitDialog(page, "accept");
      const alert = await alertP;
      assert.match(alert.message, /跳过.*不可删|已删除/);

      await page.waitForFunction(
        (okId, skipId) =>
          !document.querySelector(`.card[data-id="${okId}"]`) &&
          Boolean(document.querySelector(`.card[data-id="${skipId}"]`)),
        {},
        delOk,
        delSkip,
      );
      assert.equal(state.tasks.has(delOk), false);
      assert.equal(state.tasks.has(delSkip), true);
      await expectWorkspaceCounts(page, "ws_default", [1, 1, 1, 1, 0]);
      console.log("[e2e-board] E4 bulk-delete skip ok");
    }

    // E5: worktree checkbox follows eligibility, defaults off, submit sets cwd.
    {
      state.workspaces.get("ws_default").gitWorktreeEligible = false;
      state.workspaces.get("ws_extra").gitWorktreeEligible = true;
      await selectWorkspace(page, "ws_default");
      await page.click("#btn-new");
      await page.waitForSelector("#create-modal:not(.hidden)");
      await page.waitForFunction(
        () => document.getElementById("create-use-worktree-label")?.dataset.elig === "no",
      );
      assert.equal(
        await page.$eval("#create-use-worktree-label", (el) => el.hidden),
        true,
      );
      await page.click("#create-close");
      await page.waitForSelector("#create-modal.hidden");

      await selectWorkspace(page, "ws_extra");
      await page.click("#btn-new");
      await page.waitForSelector("#create-modal:not(.hidden)");
      await page.waitForFunction(
        () => document.getElementById("create-use-worktree-label")?.dataset.elig === "yes",
      );
      assert.equal(await page.$eval("#create-use-worktree", (el) => el.checked), false);
      assert.equal(
        await page.$eval("#create-use-worktree-label", (el) => el.hidden),
        false,
      );
      assert.match(
        await page.$eval("#create-use-worktree-label", (el) => el.textContent || ""),
        /在 git worktree 中启动/,
      );
      await page.click("#create-close");
      await page.click("#btn-new");
      await page.waitForFunction(
        () => document.getElementById("create-use-worktree-label")?.dataset.elig === "yes",
      );
      assert.equal(await page.$eval("#create-use-worktree", (el) => el.checked), false);

      await page.click("#create-use-worktree");
      assert.equal(await page.$eval("#create-use-worktree", (el) => el.checked), true);
      await selectWorkspace(page, "ws_default");
      await page.waitForFunction(
        () => document.getElementById("create-use-worktree-label")?.dataset.elig === "no",
      );
      assert.equal(await page.$eval("#create-use-worktree", (el) => el.checked), false);
      assert.equal(
        await page.$eval("#create-use-worktree-label", (el) => el.hidden),
        true,
      );
      await selectWorkspace(page, "ws_extra");
      await page.waitForFunction(
        () => document.getElementById("create-use-worktree-label")?.dataset.elig === "yes",
      );
      assert.equal(await page.$eval("#create-use-worktree", (el) => el.checked), false);

      await page.click("#create-use-worktree");
      await page.click('input[name="title"]', { clickCount: 3 });
      await page.type('input[name="title"]', "worktree 任务");
      await page.click("#create-prompt", { clickCount: 3 });
      await page.type("#create-prompt", "在 worktree 里做");
      await Promise.all([
        page.waitForSelector("#detail-modal:not(.hidden)"),
        page.click("#create-submit"),
      ]);
      const created = [...state.tasks.values()].find((t) => t.title === "worktree 任务");
      assert.ok(created);
      assert.equal(created.workspaceId, "ws_extra");
      assert.match(created.cwd, /\/\.agent-board\/worktrees\/task_e2e_/);
      assert.equal(created.worktree?.owned, true);
      assert.equal(created.worktree?.branch, `agent-board/${created.id}`);

      const dlgP = waitDialog(page, "dismiss");
      await page.click("#delete-btn");
      const dlg = await dlgP;
      assert.match(dlg.message, /worktree/);
      assert.match(dlg.message, /移除/);
      assert.equal(state.tasks.has(created.id), true);
      await page.click("#detail-close");
      console.log("[e2e-board] E5 worktree checkbox ok");
    }

    // E6: database model picker with fuzzy search, thinking effort select (with default value), and Agent linkage in Create Draft & Create Todo.
    {
      const dropdownModels = () =>
        page.$$eval("#create-model-dropdown .model-option:not(.model-option-default)", (els) =>
          els.map((el) => el.dataset.value),
        );
      const effortOptions = () =>
        page.$$eval("#create-thinking-effort option", (els) => els.map((el) => el.value));
      await selectWorkspace(page, "ws_default");

      // Open New Draft: loads pi models from database, does not show efforts in model dropdown, and defaults thinking effort to medium
      await page.click("#btn-new");
      await page.waitForSelector("#create-modal:not(.hidden)");
      assert.equal(await page.$eval("#create-thinking-effort", (el) => el.value), "medium");
      await page.click("#create-model");
      await page.waitForSelector("#create-model-dropdown:not(.hidden)");
      assert.deepEqual(await dropdownModels(), [
        "wb/cn:deepseek-v4.1-flash",
        "wb/cn:glm-5.3",
        "api/claude-haiku-4-5",
      ]);
      assert.equal(
        await page.$('#create-model-dropdown .model-option-efforts'),
        null,
      );

      // Fuzzy search filters options and clicking selects the model
      await page.type("#create-model", "glm");
      assert.deepEqual(await dropdownModels(), ["wb/cn:glm-5.3"]);
      await page.click('#create-model-dropdown .model-option[data-value="wb/cn:glm-5.3"]');
      assert.equal(await page.$eval("#create-model", (el) => el.value), "wb/cn:glm-5.3");
      assert.deepEqual(await effortOptions(), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      assert.equal(await page.$eval("#create-thinking-effort", (el) => el.value), "medium");

      // Switching Agent updates model list and thinking effort options, keeping a default value
      await page.select('#create-form select[name="kind"]', "claude");
      assert.equal(await page.$eval("#create-model", (el) => el.value), "");
      assert.deepEqual(await effortOptions(), ["low", "medium", "high", "xhigh", "max"]);
      assert.equal(await page.$eval("#create-thinking-effort", (el) => el.value), "medium");
      await page.click("#create-model");
      assert.deepEqual(await dropdownModels(), ["sonnet", "opus", "haiku"]);

      // Free-text input not in DB model list is rejected/reverted on blur or submit
      await page.type("#create-model", "not-in-db-model");
      await page.click('input[name="title"]');
      await page.waitForFunction(() => document.getElementById("create-model")?.value === "");

      // Switch back to pi and create a draft with fuzzy-searched model and selected thinking effort
      await page.select('#create-form select[name="kind"]', "pi");
      await page.click("#create-model");
      await page.type("#create-model", "dpv41");
      assert.deepEqual(await dropdownModels(), ["wb/cn:deepseek-v4.1-flash"]);
      await page.keyboard.press("Enter");
      assert.equal(await page.$eval("#create-model", (el) => el.value), "wb/cn:deepseek-v4.1-flash");
      await page.select("#create-thinking-effort", "high");
      await page.type('input[name="title"]', "数据库模型草稿");
      await page.type("#create-prompt", "use db model in draft");
      await Promise.all([
        page.waitForSelector("#detail-modal:not(.hidden)"),
        page.click("#create-submit"),
      ]);
      const createdDraft = [...state.tasks.values()].find((t) => t.title === "数据库模型草稿");
      assert.equal(createdDraft?.model, "wb/cn:deepseek-v4.1-flash");
      assert.equal(createdDraft?.thinkingEffort, "high");
      await closeDetailIfOpen(page);

      // New Todo also uses the database model picker and defaults thinking effort
      await page.click("#btn-new-todo");
      await page.waitForSelector("#create-modal:not(.hidden)");
      await page.select('#create-form select[name="kind"]', "codex");
      assert.equal(await page.$eval("#create-thinking-effort", (el) => el.value), "medium");
      await page.click("#create-model");
      assert.deepEqual(await dropdownModels(), ["gpt-6.1-terra", "gpt-6.1-sol"]);
      await page.click('#create-model-dropdown .model-option[data-value="gpt-6.1-terra"]');
      await page.type('input[name="title"]', "数据库模型Todo");
      await page.type("#create-prompt", "use db model in todo");
      await Promise.all([
        page.waitForSelector("#detail-modal:not(.hidden)"),
        page.click("#create-submit"),
      ]);
      const createdTodo = [...state.tasks.values()].find((t) => t.title === "数据库模型Todo");
      assert.equal(createdTodo?.kind, "codex");
      assert.equal(createdTodo?.model, "gpt-6.1-terra");
      assert.equal(createdTodo?.thinkingEffort, "medium");
      assert.equal(createdTodo?.status, "queued");

      // While task is active, pressing Enter in #continue-prompt queues up to 5 pending prompts without stopping the task
      for (let i = 1; i <= 5; i++) {
        await page.click("#continue-prompt");
        await page.type("#continue-prompt", `待办提示词 ${i}`);
        await page.keyboard.press("Enter");
      }
      assert.equal(state.tasks.get(createdTodo.id)?.status, "queued");
      const queuedTexts = await page.$$eval("#followup-queue .followup-text", (els) =>
        els.map((el) => el.textContent),
      );
      assert.deepEqual(queuedTexts, [
        "待办提示词 1",
        "待办提示词 2",
        "待办提示词 3",
        "待办提示词 4",
        "待办提示词 5",
      ]);
      // 6th item is rejected with limit error
      await page.type("#continue-prompt", "待办提示词 6");
      await page.keyboard.press("Enter");
      assert.equal(await page.$$eval("#followup-queue .followup-item", (els) => els.length), 5);
      assert.match(await page.$eval("#continue-error", (el) => el.textContent || ""), /最多 5 条/);

      // Right-side buttons on each todo item: "发送至当前会话" (without interrupting task) and "删除待办"
      const actionLabels = await page.$eval("#followup-queue .followup-item", (el) => ({
        send: el.querySelector(".followup-send")?.textContent?.trim(),
        remove: el.querySelector(".followup-remove")?.textContent?.trim(),
      }));
      assert.equal(actionLabels.send, "发送至当前会话");
      assert.equal(actionLabels.remove, "删除待办");

      // Click "删除待办" on item 2 ("待办提示词 2")
      await page.click('#followup-queue .followup-remove[data-followup-index="1"]');
      assert.deepEqual(
        await page.$$eval("#followup-queue .followup-text", (els) => els.map((el) => el.textContent)),
        ["待办提示词 1", "待办提示词 3", "待办提示词 4", "待办提示词 5"],
      );

      // Click "发送至当前会话" on item 1 ("待办提示词 1") — sends to current session without interrupting task
      await page.click('#followup-queue .followup-send[data-followup-index="0"]');
      await page.waitForFunction(
        () => document.querySelectorAll("#followup-queue .followup-item").length === 3,
      );
      assert.equal(state.tasks.get(createdTodo.id)?.status, "queued");
      assert.match(state.tasks.get(createdTodo.id)?.prompts?.[0]?.prompt || "", /待办提示词 1/);
      assert.deepEqual(
        await page.$$eval("#followup-queue .followup-text", (els) => els.map((el) => el.textContent)),
        ["待办提示词 3", "待办提示词 4", "待办提示词 5"],
      );

      await closeDetailIfOpen(page);
      console.log("[e2e-board] E6 database model picker, thinking effort default, fuzzy search and Agent filtering ok");
    }

    // E7: sidebar counts group every status and follow SSE across workspaces.
    {
      const statuses = ["draft", "queued", "running", "blocked", "succeeded", "failed", "stopped", "archived"];
      const countState = createState({ tasks: statuses.map((status) => makeTask({
        id: status === "draft" ? "AbC123xYz9" : `count_${status}`,
        title: `状态任务 ${status}`, prompt: `搜索回归内容 ${status}`,
        workspaceId: "ws_default", status,
      })) });
      const streams = new Set();
      const countServer = createMockServer(countState, (req, res, url) => {
        if (url.pathname !== "/api/events") return false;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`event: hello\ndata: ${JSON.stringify({
          tasks: [...countState.tasks.values()], workspaces: [...countState.workspaces.values()],
        })}\n\n`);
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return true;
      });
      const { base: countBase } = await listen(countServer);
      const countPage = await browser.newPage();
      const sendEvent = (event, payload) => {
        for (const stream of streams) stream.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      try {
        await countPage.goto(countBase, { waitUntil: "networkidle2" });
        await expectWorkspaceCounts(countPage, "ws_default", [1, 1, 2, 3, 1]);
        await expectWorkspaceCounts(countPage, "ws_extra", [0, 0, 0, 0, 0]);

        for (const search of ["AbC123xYz9", "123xY", "ABC123XYZ9", "  aBc123xYz9  ", "状态任务 draft", "搜索回归内容 draft"]) {
          await countPage.evaluate((value) => {
            const input = document.getElementById("search");
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }, search);
          await countPage.waitForFunction(() => {
            const cards = [...document.querySelectorAll(".card[data-id]")];
            return cards.length === 1 && cards[0].dataset.id === "AbC123xYz9"
              && document.getElementById("count-draft")?.textContent === "1";
          });
          await expectWorkspaceCounts(countPage, "ws_default", [1, 1, 2, 3, 1]);
        }
        await countPage.evaluate(() => {
          const input = document.getElementById("search");
          input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await countPage.waitForFunction(() => document.querySelectorAll(".card[data-id]").length === 8);

        await countPage.type("#search", "no matching task");
        await countPage.waitForFunction(() => document.getElementById("count-draft")?.textContent === "0");
        await expectWorkspaceCounts(countPage, "ws_default", [1, 1, 2, 3, 1]);
        await selectWorkspace(countPage, "ws_extra");

        const task = countState.tasks.get("AbC123xYz9");
        for (const [status, expected] of [
          ["queued", [0, 2, 2, 3, 1]],
          ["running", [0, 1, 3, 3, 1]],
          ["succeeded", [0, 1, 2, 4, 1]],
          ["archived", [0, 1, 2, 3, 2]],
        ]) {
          task.status = status;
          sendEvent("task_upsert", { task });
          await expectWorkspaceCounts(countPage, "ws_default", expected);
          await expectWorkspaceCounts(countPage, "ws_extra", [0, 0, 0, 0, 0]);
        }

        task.workspaceId = "ws_extra";
        sendEvent("task_upsert", { task });
        await expectWorkspaceCounts(countPage, "ws_default", [0, 1, 2, 3, 1]);
        await expectWorkspaceCounts(countPage, "ws_extra", [0, 0, 0, 0, 1]);
        sendEvent("task_delete", { taskIds: [task.id] });
        await expectWorkspaceCounts(countPage, "ws_extra", [0, 0, 0, 0, 0]);
        console.log("[e2e-board] E7 workspace counts, search and live SSE updates ok");
      } finally {
        await countPage.close();
        for (const stream of streams) stream.end();
        await new Promise((resolve) => countServer.close(resolve));
      }
    }

    console.log("[e2e-board] all E1–E7 passed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("[e2e-board] failed:", err);
  process.exit(1);
});
