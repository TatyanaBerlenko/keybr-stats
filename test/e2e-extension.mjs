// End-to-end test: the real extension in Chromium, requests to keybr.com are served by the mock page.
import { chromium } from "playwright";
import { readFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(dir, "..");
const mock = readFileSync(path.join(dir, "mock-keybr.html"), "utf8");
const out = process.argv[2] || dir;

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), "kbs-")), {
  channel: "chromium", // extensions need full Chromium, not the headless shell
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new"],
  viewport: { width: 1000, height: 900 },
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2];
console.log("extension loaded:", extId);

const texts = ["тест стол", "стоп тесто", "сто лет", "тесный стон"];
await ctx.route("https://www.keybr.com/**", (r) =>
  r.fulfill({ contentType: "text/html; charset=utf-8", body: mock }),
);
const page = await ctx.newPage();
await page.goto("https://www.keybr.com/?texts=" + encodeURIComponent(JSON.stringify(texts)));
await page.focus("#ta");
await page.waitForTimeout(500);

const press = (key) =>
  page.evaluate((key) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })), key);

// Type 15 lessons: «ст» is slow (350 ms), «о» after «т» sometimes gets an error.
let typed = 0;
for (let lesson = 0; lesson < 15; lesson++) {
  const t = texts[lesson % texts.length];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    const slow = ch === "т" && t[i - 1] === "с";
    await page.waitForTimeout(slow ? 350 : 140 + ((i * 37) % 60));
    if (ch === "о" && t[i - 1] === "т" && lesson % 3 === 0) {
      await press("а");
      await page.waitForTimeout(120);
    }
    await press(ch);
    typed++;
  }
}
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(out, "e2e-keybr-panel.png"), clip: { x: 600, y: 600, width: 400, height: 300 } });
// leaving the page → save
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await page.goto("about:blank");
await page.waitForTimeout(500);

const stats = await page.evaluate(async (id) => null, extId);
const sp = await ctx.newPage();
await sp.goto(`chrome-extension://${extId}/stats.html`);
await sp.waitForTimeout(500);
const data = await sp.evaluate(() => chrome.storage.local.get("stats").then((d) => d.stats));
console.log("keystrokes saved:", data?.keys, "of", typed);
console.log("«ст»:", JSON.stringify(data?.B?.["ст"]).slice(0, 120));
console.log("«то»:", JSON.stringify({ n: data?.B?.["то"]?.n, e: data?.B?.["то"]?.e }));
console.log("word «стол»:", JSON.stringify(data?.W?.["стол"]));
await sp.screenshot({ path: path.join(out, "e2e-stats-pairs.png"), fullPage: true });
await sp.click('button[data-tab="W"]');
await sp.screenshot({ path: path.join(out, "e2e-stats-words.png"), fullPage: true });
await sp.fill("#minW", "1");
await sp.dispatchEvent("#minW", "change");
await sp.click('button[data-tab="T"]');
await sp.waitForTimeout(200);
console.log("training text:", (await sp.inputValue("#trainText")).slice(0, 80));
await sp.click('.seg[data-f="pattern"] button[data-v="mixups"]');
console.log("hand mix-ups:", await sp.textContent("#trainPairs"), "|", (await sp.inputValue("#trainText")).slice(0, 80));
await sp.click('.seg[data-f="pattern"] button[data-v="none"]');
await sp.click('.seg[data-f="pinky"] button[data-v="0"]');
console.log("pinky rest:", await sp.textContent("#trainPairs"), "|", (await sp.inputValue("#trainText")).slice(0, 80));
await sp.screenshot({ path: path.join(out, "e2e-stats-train.png"), fullPage: true });
await sp.click('button[data-tab="C"]');
await sp.screenshot({ path: path.join(out, "e2e-stats-mixups.png"), fullPage: true });
await ctx.close();
