/**
 * E2E E5–E7: global settings, detail continue + quick prompts, image upload mock.
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
  const state = createState({
    quickPrompts: [
      { id: "qp_sum", label: "总结一下", content: "请用三句话总结当前进度" },
    ],
    tasks: [
      makeTask({
        id: "task_done_1",
        workspaceId: "ws_default",
        title: "已完成任务",
        prompt: "完成某功能",
        status: "succeeded",
        sessionId: "sess_e2e_1",
        endedAt: "2026-01-01T01:00:00.000Z",
        summary: "done",
        outputs: [{ iteration: 1, text: "第一轮结果", at: "2026-01-01T01:00:00.000Z" }],
      }),
    ],
  });
  const server = createMockServer(state);
  const { base } = await listen(server);
  console.log(`[e2e-medium] mock server ${base}`);

  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);

  try {
    // —— E5 global settings ——
    await page.goto(`${base}/settings`, { waitUntil: "networkidle2" });
    await page.waitForSelector("#settings-form");
    await page.waitForFunction(
      () => document.getElementById("settings-status")?.textContent?.includes("已加载"),
    );

    // edit pi CLI path
    await page.click('#agent-tab-pi');
    const cliInput = await page.waitForSelector('input[data-cli-key="pi"]');
    await cliInput.click({ clickCount: 3 });
    await cliInput.type("/tmp/e2e-fake-pi");

    // add a quick prompt
    await page.click("#btn-add-quick-prompt");
    await page.waitForSelector('.quick-prompt-item[data-quick-idx]');
    const items = await page.$$(".quick-prompt-item");
    const last = items[items.length - 1];
    const label = await last.$('[data-quick-field="label"]');
    const content = await last.$('[data-quick-field="content"]');
    await label.click({ clickCount: 3 });
    await label.type("复盘");
    await content.click({ clickCount: 3 });
    await content.type("请输出今日复盘");

    await page.click("#btn-save-settings");
    await page.waitForFunction(
      () => document.getElementById("settings-status")?.textContent?.includes("已保存"),
    );
    assert.equal(state.settings.cliPaths.pi.override, "/tmp/e2e-fake-pi");
    assert.ok(state.settings.quickPrompts.some((q) => q.label === "复盘" && q.content.includes("复盘")));

    // reload and verify
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForFunction(
      () => document.getElementById("settings-status")?.textContent?.includes("已加载"),
    );
    const cliVal = await page.$eval('input[data-cli-key="pi"]', (el) => el.value);
    assert.equal(cliVal, "/tmp/e2e-fake-pi");
    const labels = await page.$$eval(
      '[data-quick-field="label"]',
      (els) => els.map((e) => e.value),
    );
    assert.ok(labels.includes("复盘"));
    console.log("[e2e-medium] E5 global settings OK");

    // —— E6 detail continue + quick prompts ——
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.card[data-id="task_done_1"]');
    await page.click('.card[data-id="task_done_1"]');
    await page.waitForSelector("#detail-modal:not(.hidden)");
    await page.waitForSelector("#continue-row:not([hidden])");

    // quick prompt buttons loaded from /api/settings
    await page.waitForFunction(() => {
      const box = document.getElementById("continue-quick-prompts");
      return box && !box.hidden && box.querySelector(".quick-prompt-btn");
    });
    await page.click('.quick-prompt-btn[data-target="continue-prompt"]');
    const filled = await page.$eval("#continue-prompt", (el) => el.value);
    assert.ok(filled.includes("三句话") || filled.includes("复盘"), `unexpected continue fill: ${filled}`);

    await page.click("#continue-prompt", { clickCount: 3 });
    await page.type("#continue-prompt", "E2E_CONTINUE_MARKER");
    await Promise.all([
      page.waitForFunction(() => {
        const hint = document.getElementById("continue-hint")?.textContent || "";
        // after continue, paintDetail refreshes; task stays succeeded in mock
        return true;
      }),
      page.click("#continue-btn"),
    ]);
    // allow fetch to complete
    await page.waitForFunction(
      () => {
        const t = window.__e2eContinueDone;
        return true;
      },
      { timeout: 2000 },
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const contTask = state.tasks.get("task_done_1");
    assert.ok(contTask);
    assert.ok(
      (contTask.prompts || []).some((p) => String(p.prompt).includes("E2E_CONTINUE_MARKER")),
      `prompts=${JSON.stringify(contTask.prompts)}`,
    );
    assert.ok((contTask.iteration || 1) >= 2);
    console.log("[e2e-medium] E6 continue + quick prompts OK");

    // close detail
    await page.click("#detail-close");
    await page.waitForFunction(() =>
      document.getElementById("detail-modal")?.classList.contains("hidden"),
    );

    // —— E7 image upload mock on create form ——
    await page.click("#btn-new");
    await page.waitForSelector("#create-modal:not(.hidden)");
    await page.waitForSelector("#create-prompt");

    const uploaded = await page.evaluate(async () => {
      const bytes = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
        0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
        0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const file = new File([bytes], "dot.png", { type: "image/png" });
      const input = document.querySelector('.prompt-img-file[data-for="create-prompt"]');
      if (!input) return { ok: false, reason: "no file input" };
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // wait for markdown insert
      for (let i = 0; i < 50; i++) {
        const v = document.getElementById("create-prompt")?.value || "";
        if (v.includes("/uploads/")) return { ok: true, value: v };
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        ok: false,
        reason: "timeout",
        value: document.getElementById("create-prompt")?.value || "",
        status: document.querySelector('.prompt-img-status[data-for="create-prompt"]')?.textContent || "",
      };
    });
    assert.ok(uploaded.ok, `image upload failed: ${JSON.stringify(uploaded)}`);
    assert.match(uploaded.value, /!\[.*\]\(\/uploads\/e2e_\d+\.png\)/);
    assert.ok(state.uploads.length >= 1);
    console.log("[e2e-medium] E7 image upload mock OK");
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  console.log("[e2e-medium] all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
