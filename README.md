# keybr detailed stats

A Chrome extension that, while you practice on [keybr.com](https://www.keybr.com), collects speed and error stats per **bigram**, **word** and **letter**, records which keys you **mix up**, and builds custom practice text from your weakest spots.

Stats collection works with any layout. The finger-based training filters know ЙЦУКЕН (Russian), QWERTY, Colemak and Dvorak; pick yours in the **Layout** selector.

## Install

1. Download or clone this repo into a folder you won't delete.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the repo folder.
4. Pin the extension icon. Clicking it opens the stats page.

## How it's measured

- **ms**: time from the previous letter to this one. It's a median, so one random pause doesn't spoil it.
- Only **clean transitions** are timed: no error on this letter or the previous one, no pause longer than 2 s.
- An **error** counts against the bigram "a→b" if you got it wrong when "b" was due after "a".
- Right vs. wrong comes from keybr's own highlighting (green or red letter), so it works with any layout and mode.
- **≈wpm** = 12000 / ms (1 word = 5 characters).
- **Trouble** = ms + error rate × 1000 ms, a rough estimate of the time lost at that spot.
- **Words**: speed from the space before the word to its last letter.
- **Mix-ups**: which key you pressed when another was expected. *Mirror finger* = the same finger on the other hand (а↔о, в↔л, е↔н…).

Data stays local (`chrome.storage.local`) and is never sent anywhere.

## Training text

The **Training text** tab picks words from your own stats and lets you filter them:

| Filter | Options |
|---|---|
| Hand | Both / Left only / Right only (every letter of the word on that hand) |
| Weak at | Speed + accuracy / Speed (slowest bigrams) / Accuracy (most errors) |
| Right pinky | Rest / then unlock its keys from easiest to hardest. ЙЦУКЕН: з ж → + х → + э → + ъ; QWERTY: p → + [ → + ' → + ] |
| Pattern | Weak bigrams / Same finger (two keys in a row with one finger) / Hand mix-ups (alternates letters you confuse between hands) |

Paste the result into keybr: **Settings → Lessons → Custom text**.

## Checking it on the live site

keybr gets a small debug panel in the corner with your last 10 keystrokes: letter, ok/error, ms.

1. Type a lesson, make a couple of deliberate errors and pause once for 3 s. Errors should be marked, and after the pause the ms column should show "—".
2. If the panel says **"keybr input not found"**, keybr changed its markup and nothing is being collected.
3. Turn the panel off with its × button or the checkbox on the stats page.

## Tests (development only)

`test/` holds a copy of keybr's DOM and two Playwright tests: unit logic and an end-to-end run with the extension loaded.

```
npm install
npx playwright install chromium
npm test            # unit logic
npm run test:e2e    # real extension; screenshots go to test/
```
