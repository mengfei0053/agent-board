/**
 * E2E E8–E9 (low): theme toggle cycle; docs page opens (lightweight, mock API).
 * Screenshots (X2) intentionally not covered.
 */
import assert from "node:assert/strict";
import {
  createState,
  createMockServer,
  listen,
  launchBrowser,
  makeTask,
} from "./harness.mjs";

async function main() {
  const state = createState();
  const server = createMockServer(state);
  const { base } = await listen(server);
  console.log(`[e2e-low] mock server ${base}`);

  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);

  try {
    // —— E8 theme toggle ——
    await page.goto(`${base}/`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#theme-toggle");

    // clear any leftover pref from prior runs in this profile
    await page.evaluate(() => localStorage.removeItem("agent-board.theme"));
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector("#theme-toggle");

    const readTheme = () =>
      page.evaluate(() => ({
        pref: document.documentElement.getAttribute("data-theme-pref"),
        theme: document.documentElement.getAttribute("data-theme"),
        stored: localStorage.getItem("agent-board.theme"),
      }));

    const initial = await readTheme();
    assert.equal(initial.pref, "system");
    const topbarHeight = await page.$eval(".topbar", (el) => el.getBoundingClientRect().height);
    assert.ok(topbarHeight <= 52, `topbar should be compact (<= 52px), got ${topbarHeight}`);

    await page.click("#theme-toggle");
    const after1 = await readTheme();
    assert.equal(after1.pref, "light");
    assert.equal(after1.theme, "light");
    assert.equal(after1.stored, "light");

    await page.click("#theme-toggle");
    const after2 = await readTheme();
    assert.equal(after2.pref, "dark");
    assert.equal(after2.theme, "dark");
    assert.equal(after2.stored, "dark");

    await page.click("#theme-toggle");
    const after3 = await readTheme();
    assert.equal(after3.pref, "system");
    assert.equal(after3.stored, "system");
    assert.ok(after3.theme === "light" || after3.theme === "dark");

    // persist across reload
    await page.click("#theme-toggle"); // -> light
    await page.reload({ waitUntil: "networkidle2" });
    const persisted = await readTheme();
    assert.equal(persisted.pref, "light");
    assert.equal(persisted.theme, "light");
    console.log("[e2e-low] E8 theme toggle ok");

    // —— Long URL card wrapping (no horizontal overflow) ——
    const longPrompt =
      "http://192.168.3.15:8090/pages/viewpage.action?pageId=3080562 是否可以读取，有没有相关的 mcp 或skill";
    state.tasks.set(
      "oW4WvAUoFJ",
      makeTask({
        id: "oW4WvAUoFJ",
        workspaceId: "ws_default",
        cwd: "/home/menghongfei/projects/qt-projects",
        title: longPrompt.slice(0, 48),
        prompt: longPrompt,
        status: "succeeded",
        summary:
          "### 一、工作区指令已确认并记入准则 1. **Worklog 格式检查**: 完成 http://192.168.3.15:8090/pages/viewpage.action?pageId=3080562",
      }),
    );
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('.card[data-id="oW4WvAUoFJ"]');
    const cardMetrics = await page.evaluate(() => {
      const card = document.querySelector('.card[data-id="oW4WvAUoFJ"]');
      const heading = card.querySelector(".card-heading");
      const title = card.querySelector(".card-title");
      const badge = card.querySelector(".badge");
      const prompt = card.querySelector(".card-prompt");
      const summary = card.querySelector(".card-summary");
      const cardRect = card.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const badgeRect = badge.getBoundingClientRect();
      return {
        cardOverflow: card.scrollWidth - card.clientWidth,
        titleOverflow: title.scrollWidth - title.clientWidth,
        promptOverflow: prompt.scrollWidth - prompt.clientWidth,
        summaryOverflow: summary.scrollWidth - summary.clientWidth,
        titleFitsHeading: titleRect.right <= headingRect.right + 1,
        headingBeforeBadge: headingRect.right <= badgeRect.left + 1,
        titleInsideCard: titleRect.right <= cardRect.right,
      };
    });
    assert.equal(cardMetrics.cardOverflow, 0, "card should not overflow horizontally");
    assert.equal(cardMetrics.titleOverflow, 0, "card-title should wrap without horizontal overflow");
    assert.equal(cardMetrics.promptOverflow, 0, "card-prompt should wrap without horizontal overflow");
    assert.equal(cardMetrics.summaryOverflow, 0, "card-summary should wrap without horizontal overflow");
    assert.ok(cardMetrics.titleFitsHeading, "card-title should stay within card-heading");
    assert.ok(cardMetrics.headingBeforeBadge, "card-heading should stay to the left of badge");
    assert.ok(cardMetrics.titleInsideCard, "card-title should stay inside card bounds");

    // Seed many archived tasks to ensure virtual scrolling & flex column do not vertically squash cards
    for (let i = 0; i < 60; i++) {
      const id = `arch_${i}`;
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 60 - i)).toISOString();
      state.tasks.set(
        id,
        makeTask({
          id,
          workspaceId: "ws_default",
          cwd: "/home/menghongfei/projects/qt-projects",
          title: `归档任务 ${i}`,
          prompt: longPrompt,
          status: "archived",
          createdAt: ts,
          updatedAt: ts,
          summary: "已完成归档",
        }),
      );
    }
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('#list-archived .card[data-id="arch_0"]');
    const archiveMetrics = await page.evaluate(() => {
      const laneBody = document.getElementById("list-archived");
      const firstCard = laneBody.querySelector(".card");
      const rect = firstCard.getBoundingClientRect();
      const renderedCards = laneBody.querySelectorAll(".card").length;
      const hasLastAtTop = Boolean(laneBody.querySelector('.card[data-id="arch_59"]'));
      return {
        cardHeight: rect.height,
        verticalClip: firstCard.scrollHeight - firstCard.clientHeight,
        laneScrollable: laneBody.scrollHeight > laneBody.clientHeight,
        renderedCards,
        hasLastAtTop,
        countBadge: document.getElementById("count-archived")?.textContent,
      };
    });
    assert.ok(archiveMetrics.cardHeight > 100, `archived card should keep full height, got ${archiveMetrics.cardHeight}`);
    assert.equal(archiveMetrics.verticalClip, 0, "archived card should not clip vertically");
    assert.ok(archiveMetrics.laneScrollable, "archived lane should scroll vertically when overflowing");
    assert.equal(archiveMetrics.countBadge, "60", "archived lane badge should show total 60");
    assert.ok(
      archiveMetrics.renderedCards < 30,
      `virtual scroll should only mount visible window, got ${archiveMetrics.renderedCards}`,
    );
    assert.equal(archiveMetrics.hasLastAtTop, false, "arch_59 should not be mounted while scrolled to top");

    // Scroll to bottom of archived lane and verify bottom items mount dynamically
    await page.evaluate(() => {
      const laneBody = document.getElementById("list-archived");
      laneBody.scrollTop = laneBody.scrollHeight;
      laneBody.dispatchEvent(new Event("scroll"));
    });
    await page.waitForSelector('#list-archived .card[data-id="arch_59"]');
    const bottomMetrics = await page.evaluate(() => {
      const laneBody = document.getElementById("list-archived");
      return {
        renderedCards: laneBody.querySelectorAll(".card").length,
        hasFirstAtBottom: Boolean(laneBody.querySelector('.card[data-id="arch_0"]')),
        hasLastAtBottom: Boolean(laneBody.querySelector('.card[data-id="arch_59"]')),
      };
    });
    assert.ok(bottomMetrics.renderedCards < 30, "virtual scroll should stay bounded at bottom");
    assert.equal(bottomMetrics.hasFirstAtBottom, false, "arch_0 should unmount when scrolled to bottom");
    assert.equal(bottomMetrics.hasLastAtBottom, true, "arch_59 should mount when scrolled to bottom");
    console.log("[e2e-low] long URL card wrapping & virtualized archived lane scroll ok");

    // —— Detail drawer auto-scrolls #detail-output to the last round ——
    const manyRoundsText = Array.from({ length: 12 }, (_, idx) => `第 ${idx + 1} 行输出内容，用于撑开本轮高度。`).join("\n\n");
    state.tasks.set(
      "multi_round_task",
      makeTask({
        id: "multi_round_task",
        workspaceId: "ws_default",
        cwd: "/home/menghongfei/projects/qt-projects",
        title: "多轮对话定位测试",
        prompt: "第 1 轮提示词",
        iteration: 6,
        status: "succeeded",
        prompts: Array.from({ length: 6 }, (_, i) => ({
          iteration: i + 1,
          prompt: `第 ${i + 1} 轮提示词\n\n${manyRoundsText}`,
          at: new Date(Date.UTC(2026, 0, 1, 1, i, 0)).toISOString(),
        })),
        outputs: Array.from({ length: 6 }, (_, i) => ({
          iteration: i + 1,
          text: `### 第 ${i + 1} 轮回复\n\n${manyRoundsText}`,
          at: new Date(Date.UTC(2026, 0, 1, 1, i, 30)).toISOString(),
        })),
      }),
    );
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('.card[data-id="multi_round_task"]');
    await page.click('.card[data-id="multi_round_task"]');
    await page.waitForSelector('#detail-modal:not(.hidden) #detail-output .output-turn[data-iteration="6"]');
    await page.waitForFunction(() => {
      const box = document.getElementById("detail-output");
      return box && box.scrollTop > 0;
    });
    const detailScrollMetrics = await page.evaluate(() => {
      const box = document.getElementById("detail-output");
      const lastTurn = box.querySelector('.output-turn[data-iteration="6"]');
      const boxRect = box.getBoundingClientRect();
      const lastRect = lastTurn.getBoundingClientRect();
      return {
        scrollTop: box.scrollTop,
        scrollHeight: box.scrollHeight,
        clientHeight: box.clientHeight,
        lastTurnVisibleInViewport:
          lastRect.top >= boxRect.top - 4 && lastRect.top < boxRect.bottom,
      };
    });
    assert.ok(detailScrollMetrics.scrollTop > 0, "detail-output should scroll down to the last round");
    assert.ok(detailScrollMetrics.lastTurnVisibleInViewport, "last round should be positioned inside detail-output viewport");
    await page.click("#detail-close");
    await page.waitForSelector("#detail-modal.hidden");
    console.log("[e2e-low] detail drawer auto-scroll to last round ok");

    // —— Workspace drag-and-drop reorder ——
    await page.evaluate(() => localStorage.removeItem("agent-board.workspaceOrder"));
    state.workspaces.set("ws_third", {
      id: "ws_third",
      name: "第三个工作区",
      path: "/tmp/agent-board-third",
      createdAt: "2026-01-01T00:02:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('.ws-item[data-workspace-id="ws_third"]');

    const readWsOrder = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#ws-list .ws-item")].map((el) => el.dataset.workspaceId),
      );
    assert.deepEqual(await readWsOrder(), ["ws_default", "ws_extra", "ws_third"]);

    // Drag ws_third onto ws_default (move to first position)
    await page.evaluate(() => {
      const from = document.querySelector('.ws-item[data-workspace-id="ws_third"]');
      const to = document.querySelector('.ws-item[data-workspace-id="ws_default"]');
      const dt = new DataTransfer();
      dt.setData("text/plain", "ws_third");
      from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      from.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.waitForFunction(() => {
      const ids = [...document.querySelectorAll("#ws-list .ws-item")].map((el) => el.dataset.workspaceId);
      return ids[0] === "ws_third";
    });
    assert.deepEqual(await readWsOrder(), ["ws_third", "ws_default", "ws_extra"]);

    // Persist across reload
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('.ws-item[data-workspace-id="ws_third"]');
    assert.deepEqual(await readWsOrder(), ["ws_third", "ws_default", "ws_extra"]);

    // Real pointer-driven drag (ws_extra → ws_third)
    const fromBox = await page.$eval('.ws-item[data-workspace-id="ws_extra"]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const toBox = await page.$eval('.ws-item[data-workspace-id="ws_third"]', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(fromBox.x, fromBox.y);
    await page.mouse.down();
    await page.mouse.move(toBox.x, toBox.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const ids = [...document.querySelectorAll("#ws-list .ws-item")].map((el) => el.dataset.workspaceId);
      return ids[0] === "ws_extra";
    });
    assert.deepEqual(await readWsOrder(), ["ws_extra", "ws_third", "ws_default"]);
    console.log("[e2e-low] workspace drag reorder ok");

    // —— E9 docs page ——
    await page.goto(`${base}/docs`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".docs-main");
    const docsOk = await page.evaluate(() => {
      const h1 = document.querySelector(".docs-main h1, .docs-app h1, h1");
      const toc = document.querySelector(".docs-toc");
      const main = document.querySelector(".docs-main");
      return {
        title: (h1?.textContent || "").trim(),
        hasToc: Boolean(toc),
        hasMain: Boolean(main),
        bodyClass: document.body.className,
      };
    });
    assert.ok(docsOk.hasMain, "docs main missing");
    assert.ok(docsOk.hasToc, "docs toc missing");
    assert.ok(docsOk.bodyClass.includes("docs-page"), "docs-page class");
    assert.ok(docsOk.title.length > 0, "docs title empty");
    console.log("[e2e-low] E9 docs page ok:", docsOk.title);

    console.log("[e2e-low] all passed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
