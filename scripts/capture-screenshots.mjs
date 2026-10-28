import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "docs/screenshots");
mkdirSync(OUT, { recursive: true });
const URL = "http://127.0.0.1:8791/";

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  headless: true,
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
});

async function shot(page, name) {
  const path = join(OUT, name);
  await page.screenshot({ path, type: "png", fullPage: false });
  console.log("wrote", path);
}

async function selectQt(page) {
  await page.evaluate(() => {
    const items = [...document.querySelectorAll(".ws-item")];
    const hit = items.find((el) => (el.textContent || "").includes("qt"));
    if (hit) hit.click();
  });
  await new Promise((r) => setTimeout(r, 500));
}

async function gotoTheme(page, pref) {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.evaluate((p) => {
    localStorage.setItem("agent-board.theme", p);
  }, pref);
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector(".swimlanes", { timeout: 10000 });
  await page.waitForSelector(".ws-item", { timeout: 10000 });
  await selectQt(page);
  await new Promise((r) => setTimeout(r, 700));
}

const page = await browser.newPage();

await gotoTheme(page, "dark");
await shot(page, "board-dark.png");

await gotoTheme(page, "light");
await shot(page, "board-light.png");

await gotoTheme(page, "dark");
const opened = await page.evaluate(() => {
  const card = document.querySelector(".lane .card, .card");
  if (!card) return false;
  card.click();
  return true;
});
if (opened) {
  await page.waitForFunction(
    () => !document.getElementById("detail-modal")?.classList.contains("hidden"),
    { timeout: 8000 },
  ).catch(() => null);
  await new Promise((r) => setTimeout(r, 1000));
  await shot(page, "detail-dark.png");
} else {
  console.warn("no card for detail");
}

await browser.close();
console.log("done");
