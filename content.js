// keybr detailed stats: content script.
//
// How it works:
// keybr renders every character of the lesson text as a <span> with an inline
// style whose color is a CSS variable: --textinput--hit__color (typed correctly),
// --textinput--miss__color (typed with an error), miss color as background
// (extra "garbage" characters), plain --textinput__color (not typed yet).
// On every keypress we take a snapshot of the text BEFORE keybr handles it
// (keydown listener in the capture phase) and AFTER (setTimeout 0). The diff
// tells whether the cursor advanced and with what result. This way we depend
// neither on the keyboard layout nor on how keybr compares characters.
(() => {
  "use strict";

  const MAX_DT = 2000; // intervals longer than 2 s are pauses, not speed
  const MAX_SAMPLES = 200; // how many recent samples to keep per bigram/letter
  const MAX_WORD_SAMPLES = 50;
  const FLUSH_MS = 2000;

  // keybr draws spaces as NBSP or private-use glyphs; normalize them to " "
  const SPECIAL = {
    " ": " ",
    "": " ",
    "": " ",
    "": " ",
    "": " ",
  };

  const isSpace = (ch) => ch === " ";

  // ---------- reading the DOM ----------

  function attrOf(style) {
    if (!style) return null;
    if (style.includes("background") && style.includes("--textinput--miss__color")) return "garbage";
    if (style.includes("--textinput--hit__color")) return "hit";
    if (style.includes("--textinput--miss__color")) return "miss";
    if (style.includes("--textinput") || style.includes("--syntax-")) return "normal";
    return null;
  }

  // keybr's input is a hidden <textarea>; its "siblings" are the text lines.
  function findRoot() {
    const ae = document.activeElement;
    if (!ae || ae.tagName !== "TEXTAREA") return null;
    let el = ae.parentElement;
    for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
      if (el.querySelector('span[style*="--textinput"]')) return el;
    }
    return null;
  }

  function snapshot(root) {
    const chars = [];
    const words = [];
    let lastParent = null;
    let w = -1;
    let garbage = 0;
    for (const span of root.querySelectorAll("span[style]")) {
      const attr = attrOf(span.getAttribute("style"));
      if (!attr) continue;
      if (attr === "garbage") {
        garbage += span.textContent.length;
        continue;
      }
      if (span.parentElement !== lastParent) {
        lastParent = span.parentElement;
        w++;
        words.push("");
      }
      for (const raw of span.textContent) {
        const ch = SPECIAL[raw] ?? raw;
        chars.push({ ch, attr, w });
        if (!isSpace(ch)) words[w] += ch;
      }
    }
    let typedLen = 0;
    while (typedLen < chars.length && (chars[typedLen].attr === "hit" || chars[typedLen].attr === "miss")) typedLen++;
    const text = chars.map((c) => c.ch).join("");
    return { chars, words, typedLen, garbage, text };
  }

  // ---------- accumulating stats ----------

  let delta = emptyDelta();
  function emptyDelta() {
    // C: mix-ups, key = expected char + actually pressed char, value = count
    return { L: {}, B: {}, W: {}, C: {}, keys: 0 };
  }
  function entry(map, key) {
    return (map[key] ??= { n: 0, e: 0, t: [] });
  }

  function confusion(expected, typed) {
    if (!expected || !typed) return;
    const a = expected.toLowerCase();
    const b = typed.toLowerCase();
    if (a === b || isSpace(a) || isSpace(b)) return;
    delta.C[a + b] = (delta.C[a + b] ?? 0) + 1;
  }

  // State of the current sequence.
  const st = {
    text: null, // the text this state belongs to
    errIdx: -1, // position that already had an error
    prev: null, // {i, ch, t, err}: last completed position
    word: null, // current word
  };

  function resetSeq(text) {
    st.text = text;
    st.errIdx = -1;
    st.prev = null;
    st.word = null;
  }

  // Position i is complete (the cursor moved past it).
  function complete(i, ch, w, err, t, snap) {
    const prev = st.prev && st.prev.i === i - 1 ? st.prev : null;
    const cleanPrev = prev && !prev.err && prev.t != null;
    const dt = cleanPrev && t != null ? t - prev.t : null;
    const timed = dt != null && !err && dt > 0 && dt <= MAX_DT;

    const L = entry(delta.L, ch);
    L.n++;
    if (err) L.e++;
    if (timed) L.t.push(Math.round(dt));

    if (prev) {
      const B = entry(delta.B, prev.ch + ch);
      B.n++;
      if (err) B.e++;
      if (timed) B.t.push(Math.round(dt));
    }

    // words
    if (!isSpace(ch)) {
      const text = snap.words[w] ?? "";
      if (!st.word || st.word.w !== w) {
        st.word = {
          w,
          text,
          startT: prev && isSpace(prev.ch) && !prev.err ? prev.t : null,
          lastT: prev ? prev.t : null,
          errs: 0,
          n: 0,
          clean: true,
        };
      }
      const word = st.word;
      word.n++;
      if (err) word.errs++;
      if (t == null || word.lastT == null || t - word.lastT > MAX_DT) word.clean = false;
      word.lastT = t;
      if (word.n === word.text.length && word.text.length > 0) {
        const W = entry(delta.W, word.text);
        W.n++;
        if (word.errs > 0) W.e++;
        if (word.clean && word.startT != null && t != null) {
          const wpm = (word.text.length / (t - word.startT)) * 60000 / 5;
          if (isFinite(wpm) && wpm > 0) W.t.push(Math.round(wpm * 10) / 10);
        }
        st.word = null;
      }
    } else {
      st.word = null;
    }

    st.prev = { i, ch, t, err };
    debugPush({ ch, err, dt: timed ? Math.round(dt) : null });
  }

  function onKeyDown(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.key || e.key.length !== 1) return; // printable characters only
    const root = findRoot();
    if (!root) {
      const ae = document.activeElement;
      if (ae && ae.tagName === "TEXTAREA") setStatus(false);
      return;
    }
    setStatus(true);
    const pre = snapshot(root);
    const t = e.timeStamp;
    const key = e.key;
    setTimeout(() => afterKey(root, pre, t, key), 0);
  }

  function afterKey(root, pre, t, key) {
    delta.keys++;
    if (st.text !== pre.text) resetSeq(pre.text);
    const i0 = pre.typedLen;

    const liveRoot = root.isConnected ? root : findRoot();
    const post = liveRoot ? snapshot(liveRoot) : null;

    // The text changed (or the cursor jumped back to the start: a new lesson with
    // the same text). Usually this means we just typed the last character of a lesson.
    if (!post || post.text !== pre.text || post.typedLen < i0) {
      if (pre.chars.length - i0 === 1) {
        const c = pre.chars[i0];
        complete(i0, c.ch, c.w, st.errIdx === i0, t, pre);
      }
      resetSeq(post ? post.text : null);
      scheduleFlush();
      return;
    }

    const adv = post.typedLen - i0;
    if (adv <= 0) {
      // The cursor did not move (or "garbage" grew): an error at position i0.
      const c = pre.chars[i0];
      if (c) confusion(c.ch, key);
      if (st.errIdx !== i0) {
        st.errIdx = i0;
        if (c) debugPush({ ch: c.ch, err: true, dt: null, pending: true });
      }
      scheduleFlush();
      return;
    }

    for (let i = i0; i < post.typedLen; i++) {
      const c = post.chars[i];
      const last = i === post.typedLen - 1;
      const err = c.attr === "miss" || st.errIdx === i;
      // keybr modes that don't stop on errors move on with a "miss" character
      if (adv === 1 && c.attr === "miss" && st.errIdx !== i) confusion(c.ch, key);
      complete(i, c.ch, c.w, err, last ? t : null, post);
    }
    st.errIdx = -1;
    scheduleFlush();
  }

  // ---------- saving ----------

  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer == null) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function mergeEntry(dst, src, cap) {
    dst.n += src.n;
    dst.e += src.e;
    if (src.t.length) {
      dst.t.push(...src.t);
      if (dst.t.length > cap) dst.t.splice(0, dst.t.length - cap);
    }
  }

  async function flush() {
    flushTimer = null;
    const d = delta;
    if (d.keys === 0) return;
    delta = emptyDelta();
    try {
      const { stats } = await chrome.storage.local.get("stats");
      const s = stats ?? { L: {}, B: {}, W: {}, C: {}, keys: 0, since: Date.now() };
      s.C ??= {};
      for (const [k, v] of Object.entries(d.L)) mergeEntry((s.L[k] ??= { n: 0, e: 0, t: [] }), v, MAX_SAMPLES);
      for (const [k, v] of Object.entries(d.B)) mergeEntry((s.B[k] ??= { n: 0, e: 0, t: [] }), v, MAX_SAMPLES);
      for (const [k, v] of Object.entries(d.W)) mergeEntry((s.W[k] ??= { n: 0, e: 0, t: [] }), v, MAX_WORD_SAMPLES);
      for (const [k, v] of Object.entries(d.C)) s.C[k] = (s.C[k] ?? 0) + v;
      s.keys += d.keys;
      s.updated = Date.now();
      await chrome.storage.local.set({ stats: s });
    } catch (err) {
      console.warn("[keybr-stats] failed to save", err);
    }
  }

  // ---------- debug panel ----------

  let debugOn = true;
  let panel = null;
  const log = [];
  let statusOk = null;

  function ensurePanel() {
    if (panel || !debugOn) return;
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;";
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `
      <style>
        .p{font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;background:rgba(20,22,28,.92);color:#e8e8ea;
           border-radius:8px;padding:8px 10px;min-width:190px;box-shadow:0 4px 16px rgba(0,0,0,.3)}
        .h{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;font-weight:600}
        .x{cursor:pointer;opacity:.6;border:0;background:none;color:inherit;font:inherit;padding:0}
        .x:hover{opacity:1}
        .s.ok{color:#7ddc8a}.s.bad{color:#ff8a80}
        .r{display:flex;gap:10px}.c{min-width:1.6em}.err{color:#ff8a80}.ok2{color:#7ddc8a}.d{opacity:.75;margin-left:auto}
      </style>
      <div class="p"><div class="h"><span>keybr-stats</span><button class="x" title="Hide (turn it back on from the stats page)">×</button></div>
      <div class="s"></div><div class="l"></div></div>`;
    sh.querySelector(".x").addEventListener("click", () => {
      chrome.storage.local.set({ settings: { ...(currentSettings ?? {}), debug: false } });
    });
    document.documentElement.appendChild(host);
    panel = { host, s: sh.querySelector(".s"), l: sh.querySelector(".l") };
    renderPanel();
  }

  function removePanel() {
    if (panel) panel.host.remove();
    panel = null;
  }

  function setStatus(ok) {
    statusOk = ok;
    renderPanel();
  }

  function debugPush(item) {
    if (!debugOn) return;
    // a "pending" error is later replaced by the final result for the same position
    if (log.length && log[log.length - 1].pending && log[log.length - 1].ch === item.ch && !item.pending) log.pop();
    log.push(item);
    if (log.length > 10) log.shift();
    renderPanel();
  }

  function renderPanel() {
    ensurePanel();
    if (!panel) return;
    panel.s.className = "s " + (statusOk === false ? "bad" : statusOk ? "ok" : "");
    panel.s.textContent =
      statusOk === false ? "✗ keybr input not found" : statusOk ? "✓ keybr input found" : "waiting for keys…";
    panel.l.innerHTML = "";
    for (const it of log.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "r";
      const c = document.createElement("span");
      c.className = "c";
      c.textContent = it.ch === " " ? "␣" : it.ch;
      const r = document.createElement("span");
      r.className = it.err ? "err" : "ok2";
      r.textContent = it.err ? (it.pending ? "error…" : "error") : "ok";
      const d = document.createElement("span");
      d.className = "d";
      d.textContent = it.dt != null ? it.dt + " ms" : "—";
      row.append(c, r, d);
      panel.l.appendChild(row);
    }
  }

  // ---------- settings ----------

  let currentSettings = null;
  function applySettings(s) {
    currentSettings = s ?? {};
    debugOn = currentSettings.debug !== false;
    if (debugOn) ensurePanel();
    else removePanel();
  }

  chrome.storage.local.get("settings").then(({ settings }) => applySettings(settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) applySettings(changes.settings.newValue);
  });

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  // hook for automated tests
  if (globalThis.__KBS_TEST__) globalThis.__KBS_TEST__.flush = flush;
})();
