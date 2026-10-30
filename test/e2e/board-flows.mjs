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

async function createViaUi(page, { mode, title, prompt }) {
  if (mode === "todo") await page.click("#btn-new-todo");
  else await page.click("#btn-new");
  await page.waitForSelector("#create-modal:not(.hidden)");
  await page.click('input[name="title"]', { clickCount: 3 });
  await page.type('input[name="title"]', title);
  await page.click("#create-prompt", { clickCount: 3 });
  await page.type("#create-prompt", prompt);
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
        title: "E3草稿",
        prompt: "写一份单元测试计划",
      });
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
      console.log("[e2e-board] E4 bulk-delete skip ok");
    }

    console.log("[e2e-board] all E1–E4 passed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("[e2e-board] failed:", err);
  process.exit(1);
});
