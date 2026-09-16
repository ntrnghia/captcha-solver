# Captcha Solver (OpenRouter)

Chrome MV3 extension that reads an image captcha with an OpenRouter vision model, types the
answer and submits. Mark the captcha image, the answer field and the submit button once per
origin - every later page load is solved automatically.

## Install

1. `chrome://extensions` -> **Developer mode** -> **Load unpacked** -> this folder
2. Pin the extension, then click its icon

## Use

1. Paste an OpenRouter key (`sk-or-v1-...`), press **Enter**. It is checked with
   `GET /api/v1/key`; the model list then comes from `GET /api/v1/models`, filtered to models
   that take **image** input and return **text**, in OpenRouter's order. Default
   `deepseek/deepseek-v4.1-flash`.
2. On the captcha page, right-click once each:
   * the picture -> **Mark as Captcha Source**
   * the text box -> **Put Captcha Answer Here**
   * the button -> **Solve Captcha**

   Stored per origin (CSS selector + id + name + button text), so it survives reloads.
3. Later visits capture the picture, ask the model, fill the field, submit, and report the
   status in the popup and in a pill at the bottom-right of the page.

Popup: model picker, **editable prompt** (blank falls back to `CS.DEFAULT_PROMPT`),
**Solve now**, **Auto-solve**, **total cost** + `reset`, per-origin element checklist,
**answers sent** + `reset attempts`, **Test image** (run the model on a picture from disk),
and **Last request** - thumbnail of what was sent, the answer or the error, `via` / model /
cost / latency, `copy details`.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | MV3: `storage`, `contextMenus`, `<all_urls>` |
| `shared.js` | constants, status icons, model filter, answer extraction/cleaning, formatters |
| `background.js` | service worker: context menus, OpenRouter calls, cost + attempts, status |
| `content.js` | all frames: marking, capture, fill, submit, on-page pill |
| `popup.*` | the popup UI |

* **Capture never re-requests the image first.** Sites such as `protected.to` regenerate the
  captcha on every `GET`, so a fresh request would show the model a different picture *and*
  invalidate the stored answer. Order: `canvas` pixels -> `screenshot` crop (neither makes a
  request) -> `fetch` / `url-fetch` (⚠, only when there is nothing to crop). Result is
  normalised to PNG.
* **Output cap = the model's own limit** (`top_provider.max_completion_tokens`), sent as
  `max_completion_tokens` or `max_tokens`; other parameters (`temperature`,
  `include_reasoning`) go out only when the model advertises them.
* **Reasoning models** share that budget with their thinking. The answer is read from
  `content` (string or text parts), else from `reasoning*`; a bare token from a trace is
  accepted (`…\n25618`), prose is refused instead of being typed in. A reply with no answer
  reports why (`finish_reason`, tokens) and costs no retry.
* **Answer cleaning**: markdown/quotes dropped, lead-ins like `The captcha is:` stripped,
  `2 5 6 1 8` glued to `25618` (but `red car` left alone).
* **Cost** from `usage.cost` (asked for with `usage:{include:true}`), else tokens x model
  pricing; running total kept in `chrome.storage.local`.
* **Safety**: at most 8 *submitted* answers per origin per 10 minutes. API errors and
  unreadable images do not count, so a bad key cannot lock you out.

## Tests

```sh
npm install && npm test        # 101 offline checks
```

`test/selftest.js` drives the real `background.js` and `content.js` through jsdom and fake
Chrome APIs. Sandbox page with the same ids as the real site:
`npx http-server test -p 8080`. The bundled captchas read `36741` (`test/captcha.png`) and
`25618` (`test/fixtures/user-captcha.png`) - check a model with **Test image** before blaming
the plumbing.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "This tab is not reachable", menus missing | Reload the page, and the extension in `chrome://extensions`. |
| "The marked elements are not on this page" | The site re-rendered - mark the three elements again. |
| "8 answers in a row failed" | Wrong answers: `reset attempts`, then try a stronger model. |
| Wrong answer, correct picture | Model accuracy - compare with **Test image**. Cheap and good: `google/gemini-2.5-flash-lite`, `qwen/qwen3.7-flash`, `openai/gpt-5-nano`, `anthropic/claude-haiku-4.5`. |
| "…used the whole token budget thinking" / "…produced reasoning text but no answer" | A reasoning model never wrote an answer. Switch model - free variants are rate-limited and often return nothing. |
| Model shows a different captcha than the page | **Last request** shows `⚠ …fetch`: re-mark the source on the `<img>` itself. |
| Model list empty | Press ⟳, and check the key on openrouter.ai. |
| No "Mark as Captcha Source" | It only appears on real `<img>` elements; canvas captchas are unsupported. |

The key and the marked selectors stay in `chrome.storage.local`; the only network calls go to
`openrouter.ai` (key check, model list, the completion carrying the captcha image).
Licensed [MIT](LICENSE) - it is a general-purpose automation tool, so what you point it at is
your call under that site's terms. To package: ship `manifest.json`, `shared.js`,
`background.js`, `content.js`, `popup.*`; leave out `test/`, `package.json`, `node_modules/`.
