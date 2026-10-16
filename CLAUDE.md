# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension (plain JS, no build step) that collects per-bigram, per-letter and per-word speed/error stats while the user types on keybr.com, records key mix-ups, and generates filtered practice text. All UI text, comments and docs are in English (the repo is meant to be public); Cyrillic appears only as data (ЙЦУКЕН layout, test texts). Data lives only in `chrome.storage.local`.

To try it: `chrome://extensions` → Developer mode → Load unpacked → this folder. Clicking the toolbar icon (`background.js`) opens `stats.html`.

## Tests

Playwright is the only dev dependency (`npm install && npx playwright install chromium`):

```
npm test                               # test/run-test.mjs: injects content.js into test/mock-keybr.html with a chrome.storage stub; exits 1 on failure
node test/e2e-extension.mjs [outDir]   # loads the real unpacked extension (needs channel "chromium", not the headless shell), routes keybr.com to the mock, prints stats, writes screenshots
```

There is no way to run a single check; `run-test.mjs` runs all `session(...)` scenarios sequentially. The e2e script prints values rather than asserting; check its output and screenshots.

## Architecture

**`content.js`** (the core) — runs on keybr.com. It does not interpret keys itself; it reads keybr's rendering:
- keybr draws each text char as a `<span>` whose inline style references CSS vars: `--textinput--hit__color` (correct), `--textinput--miss__color` (error), miss color as *background* (garbage/extra chars), plain `--textinput__color` (not yet typed). `attrOf()` maps style → state.
- `findRoot()` locates the text container by walking up from the focused hidden `<textarea>`. If keybr changes its DOM, this is what breaks (debug panel shows "keybr input not found").
- On each `keydown` (capture phase) it snapshots the text *before* keybr handles it, then again in `setTimeout(0)`; the diff in `typedLen` tells whether the cursor advanced and with what result. This makes it layout-independent.
- Timing rules: only "clean" transitions are timed (no error on this or previous char, interval ≤ `MAX_DT` 2 s). Errors are attributed to the bigram ending at the char that was mistyped. Lesson end is detected by text change / cursor reset; no bigram is formed across lessons. Word wpm is measured from the preceding space to the word's last letter.
- Wrong presses are recorded as mix-ups (`confusion(expected, e.key)`), both when the cursor doesn't move and when keybr advances with a `miss` char.
- `SPECIAL` maps keybr's space glyphs (NBSP, U+E000–E003) to " "; keep them as `\u` escapes, since raw private-use chars get silently lost in edits.
- Stats accumulate in an in-memory `delta` and are merged into storage by `flush()` (debounced 2 s, also on `pagehide`/hidden). Sample arrays are capped (`MAX_SAMPLES`, `MAX_WORD_SAMPLES`).
- Debug panel is rendered in a shadow DOM; toggled via `settings.debug`.
- `globalThis.__KBS_TEST__.flush` is a test hook used by `run-test.mjs`.

**Storage schema** (shared contract between `content.js` and `stats.js`):
- `stats`: `{ L: {char: E}, B: {bigram: E}, W: {word: E}, C: {expected+typed: count}, keys, since, updated }` where `E = { n: count, e: errorCount, t: samples[] }`. For L/B, `t` is ms intervals; for W, `t` is wpm values.
- `settings`: `{ layout, minN, minW, spaces, debug, train: { hand, weak, pinky, pattern } }` (defaults in `stats.js` `DEFAULTS`/`TRAIN_DEFAULTS`). There is deliberately no target-wpm setting; keybr already has one.

**`stats.js` / `stats.html`**: stats page with tabs for bigrams (B), letters (L), words (W), mix-ups (C) and the training-text generator (T). Uses medians; ≈wpm = 12000 / ms; "trouble" = median ms + error rate × `ERROR_COST_MS` (1000). Rows are highlighted as slow relative to the median of all rows (`SLOW_FACTOR`), not against a target.
- Training filters are segmented button groups (`.seg[data-f]`) bound to `settings.train`. Finger info comes from `LAYOUTS` (`settings.layout`): each layout lists keys by physical position (rows Q…], A…', Z…/), and `setLayout()` derives `KEY` (hand/finger from column via `COL_FINGER`), `MIRROR` (column c ↔ 9−c) and `PINKY_GROUPS` (right pinky unlock order from `PINKY_LEVEL`; ЙЦУКЕН: з ж → х → э → ъ). Adding a layout = adding its three row strings. Letters not in the selected layout never pass the training filters.
- Training text is built from the user's own recorded words (`stats.W`), never from a dictionary. The "Hand mix-ups" pattern prefers recorded opposite-hand confusions and falls back to `MIRROR` pairs ranked by letter weakness.

**`test/mock-keybr.html`** — replica of keybr's text-input DOM (`?mode=stop|garbage`, `?texts=[...]` JSON) used by both tests. Keep it in sync with keybr's real markup if `content.js` DOM assumptions change.
