// Automated test: "type" on a copy of keybr's DOM with given pauses and errors
// and check that the extension counted exactly that.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const contentJs = readFileSync(path.join(dir, "..", "content.js"), "utf8");
const mockUrl = "file://" + path.join(dir, "mock-keybr.html");

// chrome.storage stub so content.js can run outside the extension.
const stub = `
  globalThis.__KBS_TEST__ = {};
  const mem = { settings: { debug: true } }; const ls = [];
  globalThis.chrome = { storage: {
    local: {
      get: async (k) => ({ [k]: mem[k] && JSON.parse(JSON.stringify(mem[k])) }),
      set: async (o) => { for (const [k, v] of Object.entries(o)) { const old = mem[k]; mem[k] = JSON.parse(JSON.stringify(v));
        ls.forEach(f => f({ [k]: { oldValue: old, newValue: mem[k] } }, "local")); } },
    },
    onChanged: { addListener: (f) => ls.push(f) },
  } };
  globalThis.__mem = mem;
`;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
let failures = 0;
function check(name, cond, info = "") {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${info ? "  (" + info + ")" : ""}`);
  if (!cond) failures++;
}

// A real keydown event with the given event.key (as with a Russian layout).
const pressKey = (page, key) =>
  page.evaluate((key) => {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }, key);

async function session(browser, mode, texts, script) {
  const page = await browser.newPage();
  await page.addInitScript(stub);
  await page.goto(`${mockUrl}?mode=${mode}&texts=${encodeURIComponent(JSON.stringify(texts))}`);
  await page.addScriptTag({ content: contentJs });
  await page.focus("#ta");
  await page.waitForTimeout(300);
  for (const [key, wait] of script) {
    await page.waitForTimeout(wait);
    await pressKey(page, key);
  }
  await page.waitForTimeout(50);
  await page.evaluate(() => globalThis.__KBS_TEST__.flush());
  const stats = await page.evaluate(() => globalThis.__mem.stats);
  const panel = await page.evaluate(() => document.documentElement.lastElementChild.shadowRoot?.textContent ?? "");
  await page.close();
  return { stats, panel };
}

const browser = await chromium.launch();

// ---- Scenario 1: keybr default mode (stop on error) ----
console.log("Scenario 1: stop on error, text «абв где» × 3");
{
  const script = [];
  for (let rep = 0; rep < 3; rep++) {
    script.push(["а", 150], ["б", 400]); // bigram «аб» is always slow: 400 ms
    if (rep === 1) script.push(["х", 150], ["в", 150]); // error on «в» in the 2nd repetition
    else script.push(["в", 150]);
    script.push([" ", 150], ["г", 150], ["д", 150], ["е", 150]);
  }
  const { stats: s, panel } = await session(browser, "stop", ["абв где"], script);
  const B = s.B, W = s.W;
  check("bigram «аб»: 3 times, 0 errors", B["аб"]?.n === 3 && B["аб"]?.e === 0, JSON.stringify(B["аб"]));
  check("bigram «аб»: median ≈ 400 ms", Math.abs(median(B["аб"].t) - 400) < 60, median(B["аб"].t) + " ms");
  check("bigram «бв»: 3 times, 1 error", B["бв"]?.n === 3 && B["бв"]?.e === 1, JSON.stringify(B["бв"]));
  check("bigram «бв»: timed on the 2 clean transitions only", B["бв"].t.length === 2);
  check("bigram «бв»: median ≈ 150 ms", Math.abs(median(B["бв"].t) - 150) < 60, median(B["бв"].t) + " ms");
  check("bigram «в␣» after the error in rep 2 is not timed", B["в "]?.n === 3 && B["в "].t.length === 2);
  check("last letter of the lesson is counted («де» × 3)", B["де"]?.n === 3, JSON.stringify(B["де"]));
  check("no bigram across lesson boundary («еа»)", !B["еа"]);
  check("word «абв»: 3 times, 1 with an error", W["абв"]?.n === 3 && W["абв"]?.e === 1, JSON.stringify(W["абв"]));
  const wpm = median(W["где"].t);
  check("word «где»: 3 times, no errors", W["где"]?.n === 3 && W["где"]?.e === 0);
  check("word «где»: ≈ 80 wpm (3 letters in 3×150 ms)", Math.abs(wpm - 80) < 12, wpm + " wpm");
  check("letter «в»: 3 times, 1 error", s.L["в"]?.n === 3 && s.L["в"]?.e === 1);
  check("mix-up «в» typed as «х» recorded once", s.C?.["вх"] === 1, JSON.stringify(s.C));
  check("panel shows «input found»", panel.includes("keybr input found"));
}

// ---- Scenario 2: no stop on error (extra characters + Backspace) ----
console.log("Scenario 2: no stop on error, «кот кит», error «ка» → Backspace → «и»");
{
  const script = [["к", 150], ["о", 150], ["т", 150], [" ", 150], ["к", 150], ["а", 150], ["Backspace", 150], ["и", 150], ["т", 150]];
  const { stats: s } = await session(browser, "garbage", ["кот кит", "xxxx"], script);
  check("bigram «ки»: 1 time, 1 error, not timed", s.B["ки"]?.n === 1 && s.B["ки"]?.e === 1 && s.B["ки"].t.length === 0, JSON.stringify(s.B["ки"]));
  check("no bogus bigram «ка»", !s.B["ка"]);
  check("bigram «ит» counted (error on the previous letter → not timed)", s.B["ит"]?.n === 1 && s.B["ит"].t.length === 0);
  check("word «кит» with an error, «кот» without", s.W["кит"]?.e === 1 && s.W["кот"]?.e === 0);
  check("mix-up «и» typed as «а» recorded once", s.C?.["иа"] === 1, JSON.stringify(s.C));
}

// ---- Scenario 3: input not focused ----
console.log("Scenario 3: focus left the input");
{
  const page = await browser.newPage();
  await page.addInitScript(stub);
  await page.goto(`${mockUrl}?texts=${encodeURIComponent('["абв"]')}`);
  await page.addScriptTag({ content: contentJs });
  await page.evaluate(() => document.activeElement.blur());
  await pressKey(page, "а");
  await page.waitForTimeout(50);
  await page.evaluate(() => globalThis.__KBS_TEST__.flush());
  const stats = await page.evaluate(() => globalThis.__mem.stats);
  check("nothing recorded", stats == null);
  await page.close();
}

await browser.close();
console.log(failures ? `\nFAILED checks: ${failures}` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
