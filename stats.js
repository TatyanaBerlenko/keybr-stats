"use strict";

const TRAIN_DEFAULTS = { hand: "both", weak: "both", pinky: 4, pattern: "none" };
const DEFAULTS = { layout: "ru", minN: 10, minW: 3, spaces: false, debug: true, train: TRAIN_DEFAULTS };
const ERROR_COST_MS = 1000; // "cost" of one error in the trouble score
const SLOW_FACTOR = 1.3; // a row is "slow" if its ms is this much above the median of all rows
const TRAIN_WORDS = 80;

let stats = null;
let settings = { ...DEFAULTS };
let tab = "B";
const sortState = {
  B: { key: "score", asc: false },
  L: { key: "score", asc: false },
  W: { key: "wpm", asc: true },
  C: { key: "n", asc: false },
};

const $ = (id) => document.getElementById(id);
const median = (a) => {
  if (!a || !a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const show = (k) => k.replaceAll(" ", "␣");
// wpm ↔ ms per char: 1 word = 5 chars → ms = 60000 / (wpm·5) = 12000 / wpm
const msToWpm = (ms) => (ms ? 12000 / ms : null);

// ---------- keyboard layouts, standard touch-typing fingers ----------

// Keys by physical position: top row from Q to ], home row from A to ', bottom row from Z to /.
const LAYOUTS = {
  ru: { name: "ЙЦУКЕН", rows: ["йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю."], extra: "ё" },
  qwerty: { name: "QWERTY", rows: ["qwertyuiop[]", "asdfghjkl;'", "zxcvbnm,./"] },
  colemak: { name: "Colemak", rows: ["qwfpgjluy;[]", "arstdhneio'", "zxcvbkm,./"] },
  dvorak: { name: "Dvorak", rows: ["',.pyfgcrl/=", "aoeuidhtns-", ";qjkxbmwvz"] },
};
const COL_FINGER = ["pinky", "ring", "middle", "index", "index", "index", "index", "middle", "ring", "pinky", "pinky", "pinky"];
// Right pinky keys unlock in this order: [row, col] → level 1..4 (ЙЦУКЕН: з ж → х → э → ъ).
const PINKY_LEVEL = { "0,9": 1, "1,9": 1, "2,9": 1, "0,10": 2, "1,10": 3, "0,11": 4 };

let KEY = {}; // char → { hand: "L"|"R", finger, pinky?: level }
let MIRROR = []; // "ab": the same finger, the same key position on the other hand
let PINKY_GROUPS = []; // chars unlocked at each right pinky level

function setLayout(id) {
  const lay = LAYOUTS[id] ?? LAYOUTS.ru;
  KEY = {};
  MIRROR = [];
  PINKY_GROUPS = [[], [], [], []];
  lay.rows.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      const pinky = PINKY_LEVEL[`${r},${c}`];
      KEY[ch] = { hand: c < 5 ? "L" : "R", finger: COL_FINGER[c], pinky };
      if (pinky) PINKY_GROUPS[pinky - 1].push(ch);
      if (c < 5 && row[9 - c]) MIRROR.push(ch + row[9 - c]);
    });
  });
  for (const ch of lay.extra ?? "") KEY[ch] = { hand: "L", finger: "pinky" };
}

const keyOf = (ch) => KEY[ch.toLowerCase()];
const sameFinger = (a, b) => {
  const x = keyOf(a), y = keyOf(b);
  return !!x && !!y && x.hand === y.hand && x.finger === y.finger;
};
const mirrorFinger = (a, b) => {
  const x = keyOf(a), y = keyOf(b);
  return !!x && !!y && x.hand !== y.hand && x.finger === y.finger;
};

function charAllowed(ch, f) {
  const k = keyOf(ch);
  if (!k) return f.hand === "both" && !/\p{L}/u.test(ch); // letters from another layout never pass
  if (f.hand !== "both" && k.hand !== f.hand) return false;
  if (k.pinky && k.pinky > f.pinky) return false;
  return true;
}
const wordAllowed = (w, f) => [...w].every((ch) => charAllowed(ch, f));

// Right pinky buttons are labeled with the letters each level adds in the current layout.
function renderPinky() {
  const label = (g) => (g.filter((ch) => /\p{L}/u.test(ch)).join(" ") || g.join(" "));
  const btn = (v, text, title = "") => `<button data-v="${v}" title="${escapeHtml(title)}">${escapeHtml(text)}</button>`;
  $("pinkySeg").innerHTML =
    btn(0, "Rest", "No " + PINKY_GROUPS.flat().join(" ")) +
    PINKY_GROUPS.map((g, i) => btn(i + 1, (i ? "+ " : "") + label(g) + (i === 3 ? " (all)" : ""))).join("");
}

// ---------- tables ----------

function rowsFor(kind) {
  if (kind === "C") return mixupRows();
  const src = stats?.[kind] ?? {};
  const rows = [];
  for (const [key, v] of Object.entries(src)) {
    if (kind === "W") {
      if (v.n < settings.minW) continue;
      rows.push({ key, n: v.n, err: v.e / v.n, wpm: median(v.t), samples: v.t.length });
    } else {
      if (v.n < settings.minN) continue;
      if (kind === "B" && !settings.spaces && key.includes(" ")) continue;
      if (kind === "L" && key === " " && !settings.spaces) continue;
      const ms = median(v.t);
      const err = v.e / v.n;
      rows.push({ key, n: v.n, err, ms, wpm: msToWpm(ms), score: ms != null ? ms + err * ERROR_COST_MS : null });
    }
  }
  return rows;
}

function mixupKind(a, b) {
  const x = keyOf(a), y = keyOf(b);
  if (!x || !y) return "other";
  if (x.hand === y.hand) return x.finger === y.finger ? "same finger" : "same hand";
  return x.finger === y.finger ? "mirror finger" : "other hand";
}

function mixupRows() {
  const rows = [];
  for (const [pair, n] of Object.entries(stats?.C ?? {})) {
    const [exp, typed] = [...pair];
    const total = stats.L?.[exp]?.n ?? 0;
    rows.push({ key: exp, typed, n, rate: total ? n / total : null, kind: mixupKind(exp, typed) });
  }
  return rows;
}

function sortRows(rows, { key, asc }) {
  return rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "string" ? x.localeCompare(y) : x - y;
    return asc ? c : -c;
  });
}

function fmtPct(x) { return (x * 100).toFixed(x < 0.1 ? 1 : 0) + "%"; }

const COLS = {
  B: [["key", "Bigram"], ["n", "Count"], ["err", "Errors"], ["ms", "ms"], ["wpm", "≈wpm"], ["score", "Trouble"], ["bar", ""]],
  L: [["key", "Letter"], ["n", "Count"], ["err", "Errors"], ["ms", "ms"], ["wpm", "≈wpm"], ["score", "Trouble"], ["bar", ""]],
  W: [["key", "Word"], ["n", "Count"], ["err", "With errors"], ["wpm", "Median wpm"]],
  C: [["key", "Expected"], ["typed", "Typed instead"], ["n", "Times"], ["rate", "Of all presses"], ["kind", "Kind"]],
};

function render() {
  const keys = stats?.keys ?? 0;
  $("summary").textContent = keys
    ? `Keystrokes: ${keys.toLocaleString("en")} · bigrams: ${Object.keys(stats.B).length} · words: ${Object.keys(stats.W).length}` +
      (stats.since ? ` · since ${new Date(stats.since).toLocaleDateString("en")}` : "")
    : "No data yet. Go practice on keybr.com.";

  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  $("tableWrap").hidden = tab === "T";
  $("train").hidden = tab !== "T";

  $("legend").innerHTML = tab === "C"
    ? `<b>Mix-ups</b>: which key you pressed when another one was expected. ` +
      `<b>Mirror finger</b> is the same finger on the other hand (${MIRROR.slice(-8, -5).map((p) => p[0] + "↔" + p[1]).join(", ")}…).`
    : `<b>ms</b>: median time from the previous letter to this one, clean transitions only (no errors nearby, no pauses over 2 s). ` +
      `<b>≈wpm</b>: the same speed in words per minute. ` +
      `<b>Trouble</b> = ms + error rate × ${ERROR_COST_MS} ms, a rough estimate of the time lost at this spot.`;
  if (tab === "T") return;

  const rows = sortRows(rowsFor(tab), sortState[tab]);
  if (!rows.length) {
    $("tableWrap").innerHTML = tab === "C"
      ? `<div class="empty">No mix-ups recorded yet.</div>`
      : `<div class="empty">No data with at least ${tab === "W" ? settings.minW : settings.minN} repetitions. ` +
        `Practice more or lower the threshold above.</div>`;
    return;
  }

  const cols = COLS[tab];
  const maxMs = Math.max(1, ...rows.map((r) => r.ms ?? 0));
  const medMs = median(rows.map((r) => r.ms).filter((x) => x != null));
  const avgErr = rows.reduce((s, r) => s + (r.err ?? 0) * r.n, 0) / rows.reduce((s, r) => s + r.n, 0);

  const ss = sortState[tab];
  let html = "<table><thead><tr>";
  for (const [k, label] of cols) {
    const cls = [k === "bar" ? "barc" : "", ss.key === k ? "sorted" + (ss.asc ? " asc" : "") : ""].join(" ");
    html += `<th data-k="${k}" class="${cls}">${label}</th>`;
  }
  html += "</tr></thead><tbody>";
  for (const r of rows.slice(0, 300)) {
    const slow = r.ms != null && medMs != null && r.ms > medMs * SLOW_FACTOR;
    const err = r.err != null && r.err > Math.max(0.05, avgErr * 2);
    const mirror = r.kind === "mirror finger";
    html += `<tr class="${slow ? "slow" : ""} ${err ? "err" : ""} ${mirror ? "mirror" : ""}">`;
    for (const [k] of cols) {
      let v;
      if (k === "key" || k === "typed") v = `<td class="key">${escapeHtml(show(r[k]))}</td>`;
      else if (k === "n") v = `<td>${r.n}</td>`;
      else if (k === "err") v = `<td class="errc">${fmtPct(r.err)}</td>`;
      else if (k === "rate") v = `<td>${r.rate != null ? fmtPct(r.rate) : "—"}</td>`;
      else if (k === "kind") v = `<td class="kind">${r.kind}</td>`;
      else if (k === "ms") v = `<td class="speed">${r.ms != null ? Math.round(r.ms) : "—"}</td>`;
      else if (k === "wpm") v = `<td class="speed">${r.wpm != null ? r.wpm.toFixed(0) : "—"}</td>`;
      else if (k === "score") v = `<td>${r.score != null ? Math.round(r.score) : "—"}</td>`;
      else if (k === "bar") v = `<td class="barc"><div class="bar"><b style="width:${((r.ms ?? 0) / maxMs) * 100}%"></b></div></td>`;
      html += v;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  if (rows.length > 300) html += `<p class="hint">Showing the first 300 of ${rows.length}.</p>`;
  $("tableWrap").innerHTML = html;
  for (const th of $("tableWrap").querySelectorAll("th")) {
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (k === "bar") return;
      if (ss.key === k) ss.asc = !ss.asc;
      else { ss.key = k; ss.asc = k === "key" || k === "typed" || k === "kind"; }
      render();
    });
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// ---------- training text ----------

// How bad a bigram/letter row is, by the chosen weakness. null = not weak by this measure.
function weakness(r, weak) {
  if (weak === "speed") return r.ms;
  if (weak === "accuracy") return r.err > 0 ? r.err : null;
  return r.score;
}

const shuffle = (a) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Opposite-hand letter pairs to drill: recorded mix-ups first, otherwise mirror keys you're weakest at.
function mixupPairs(f) {
  const ok = (a, b) => charAllowed(a, f) && charAllowed(b, f);
  const seen = new Map();
  for (const [pair, n] of Object.entries(stats?.C ?? {})) {
    const [a, b] = [...pair];
    const ka = keyOf(a), kb = keyOf(b);
    if (!ka || !kb || ka.hand === kb.hand || !ok(a, b)) continue;
    const id = [a, b].sort().join("");
    seen.set(id, (seen.get(id) ?? 0) + n * (mirrorFinger(a, b) ? 2 : 1));
  }
  if (seen.size) return [...seen].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([id]) => id);

  const letters = Object.fromEntries(rowsFor("L").map((r) => [r.key.toLowerCase(), weakness(r, f.weak) ?? 0]));
  return MIRROR.filter((p) => ok(p[0], p[1]))
    .map((p) => [p, (letters[p[0]] ?? 0) + (letters[p[1]] ?? 0)])
    .filter(([, s]) => s > 0)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 6)
    .map(([p]) => p);
}

function generateTraining() {
  const f = settings.train;
  const words = Object.keys(stats?.W ?? {}).filter((w) => wordAllowed(w, f));
  const say = (focus, text) => { $("trainPairs").textContent = focus; $("trainText").value = text; };

  if (f.pattern === "mixups") {
    if (f.hand !== "both") return say("Hand mix-ups need both hands: set Hand to Both.", "");
    const pairs = mixupPairs(f);
    if (!pairs.length) return say("Not enough data on letters yet.", "");
    // Alternate a word with one letter of the pair and a word with the other, so the hands keep switching.
    const out = [];
    const has = (w, ch) => w.toLowerCase().includes(ch);
    const usable = pairs.filter((p) => words.some((w) => has(w, p[0])) && words.some((w) => has(w, p[1])));
    if (!usable.length) return say(`Pairs: ${pairs.map((p) => p[0] + "↔" + p[1]).join(", ")}. Not enough words with them yet.`, "");
    for (let i = 0; out.length < TRAIN_WORDS; i++) {
      const [a, b] = usable[i % usable.length];
      const both = words.filter((w) => has(w, a) && has(w, b));
      if (both.length && Math.random() < 0.5) { out.push(pick(both)); continue; }
      out.push(pick(words.filter((w) => has(w, a))), pick(words.filter((w) => has(w, b))));
    }
    return say(`Pairs: ${usable.map((p) => p[0] + "↔" + p[1]).join(", ")} · ${words.length} words match the filters`,
      out.slice(0, TRAIN_WORDS).join(" "));
  }

  const bigrams = rowsFor("B").filter((r) =>
    !r.key.includes(" ") &&
    [...r.key].every((ch) => charAllowed(ch, f)) &&
    (f.pattern !== "samefinger" || (r.key[0] !== r.key[1] && sameFinger(r.key[0], r.key[1]))) &&
    weakness(r, f.weak) != null,
  );
  const top = bigrams.sort((a, b) => weakness(b, f.weak) - weakness(a, f.weak)).slice(0, 8);
  if (!top.length) return say("Not enough bigram data for these filters yet.", "");

  const pool = words.filter((w) => top.some((p) => w.toLowerCase().includes(p.key.toLowerCase())));
  const focus = "Bigrams: " + top.map((p) => p.key).join(", ");
  if (pool.length < 5) return say(`${focus}. Fewer than 5 of your words match (${pool.length}); practice more or loosen the filters.`, "");
  const out = [];
  while (out.length < TRAIN_WORDS) out.push(...shuffle(pool));
  say(`${focus} · ${pool.length} words`, out.slice(0, TRAIN_WORDS).join(" "));
}

function renderFilters() {
  for (const seg of document.querySelectorAll(".seg")) {
    for (const b of seg.querySelectorAll("button")) {
      b.classList.toggle("active", String(settings.train[seg.dataset.f]) === b.dataset.v);
    }
  }
}

// ---------- loading and settings ----------

async function load() {
  const data = await chrome.storage.local.get(["stats", "settings"]);
  stats = data.stats ?? null;
  const saved = data.settings ?? {};
  settings = { ...DEFAULTS, ...saved, train: { ...TRAIN_DEFAULTS, ...(saved.train ?? {}) } };
  $("layout").innerHTML = Object.entries(LAYOUTS).map(([id, l]) => `<option value="${id}">${l.name}</option>`).join("");
  $("layout").value = LAYOUTS[settings.layout] ? settings.layout : "ru";
  setLayout($("layout").value);
  renderPinky();
  for (const k of ["minN", "minW"]) $(k).value = settings[k];
  $("spaces").checked = settings.spaces;
  $("debug").checked = settings.debug;
  renderFilters();
  render();
}

function saveSettings() {
  settings = {
    ...settings,
    layout: $("layout").value,
    minN: Math.max(1, +$("minN").value || DEFAULTS.minN),
    minW: Math.max(1, +$("minW").value || DEFAULTS.minW),
    spaces: $("spaces").checked,
    debug: $("debug").checked,
  };
  chrome.storage.local.set({ settings });
  setLayout(settings.layout);
  renderPinky();
  renderFilters();
  render();
  if (tab === "T") generateTraining();
}

for (const id of ["layout", "minN", "minW", "spaces", "debug"]) $(id).addEventListener("change", saveSettings);
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    render();
    if (tab === "T" && !$("trainText").value) generateTraining();
  });
}
for (const seg of document.querySelectorAll(".seg")) {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const v = b.dataset.v;
    settings.train = { ...settings.train, [seg.dataset.f]: /^\d+$/.test(v) ? +v : v };
    chrome.storage.local.set({ settings });
    renderFilters();
    generateTraining();
  });
}
$("gen").addEventListener("click", generateTraining);
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("trainText").value);
  $("copied").textContent = "Copied";
  setTimeout(() => ($("copied").textContent = ""), 1500);
});
$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(stats ?? {}, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `keybr-stats-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});
$("reset").addEventListener("click", async () => {
  if (!confirm("Delete all collected stats? This cannot be undone.")) return;
  await chrome.storage.local.remove("stats");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stats) { stats = changes.stats.newValue ?? null; render(); }
});

load();
