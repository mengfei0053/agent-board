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
