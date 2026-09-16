# Captcha Solver (OpenRouter)

A Chrome (MV3) extension that reads an image captcha with an OpenRouter vision model,
types the answer into the form and presses the submit button - automatically on every
page load of a site you have configured once.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** -> select this folder
4. Pin the extension (puzzle-piece icon -> pin), then click its icon

## Use

1. **First run** - paste your OpenRouter key (`sk-or-v1-...`) and press **Enter**.
   The key is validated against `GET /api/v1/key`; on success you land on the main view
   and the model list is pulled from `GET /api/v1/models`, filtered to models that accept
   **image** input and return **text** (OpenRouter's own order is kept). The default is
   `deepseek/deepseek-v4.1-flash`.
2. **Train a site once** - open the protected page, then right-click:
   * the captcha picture -> **Mark as Captcha Source**
   * the answer text box -> **Put Captcha Answer Here**
   * the continue button -> **Solve Captcha**

   Each choice is stored per origin (e.g. `http://protected.to`) together with a CSS
   selector, an id, a name and the button text, so it still resolves after a reload.
3. **Every next visit** - the content script waits for the three elements, captures the
   picture, asks the model, fills the field, clicks the button and reports the status in
   the popup (icon + text) and in a small pill at the bottom-right of the page.

The popup also has: the model dropdown, the **editable prompt**, **Solve now** (solve
without reloading), **Auto-solve** toggle, **total cost** (with `reset`), a per-origin
checklist of the three marked elements, an **answers sent** counter with `reset attempts`,
and a **Test image** button that reads any picture from disk with the selected model - the
fastest way to compare models on a captcha you saved from the page.

**Last request** always shows what the extension actually sent:

* a thumbnail of the captured picture (compare it with the page - if it is a different
  captcha, the capture went down the wrong path, see `⚠` below),
* the model's answer, or the error message,
* how the picture was obtained, the model, the cost and the latency,
* `copy details` - JSON of the last attempt for bug reports.

### Capture paths (`via`)

| `via` | Meaning |
| --- | --- |
| `canvas` | Pixels of the image already on the page - no request, always matches the screen |
| `screenshot` | Crop of the visible tab - no request, matches the screen |
| `data-url` | The image was already a data URL |
| `upload` | You used **Test image** |
| `page-fetch` / `url-fetch` (⚠) | The image URL was requested again - see the note below |

### Prompt

The popup shows the prompt that is sent with every captcha image and lets you edit it.
It is saved to `chrome.storage.local` (`prompt`) as you type; `reset to default` (shown
only while the text differs) puts the built-in one back. Default:

> Read the characters shown in this captcha image. They may be slanted, overlapping or
> crossed by background lines. Reply with only those characters, in order, without spaces
> or explanation.

It is defined once in `shared.js` (`CS.DEFAULT_PROMPT`) and used by the service worker, so
the text in the popup is always the text that goes out. Notes:

* A blank prompt falls back to the default - you cannot break the request by clearing it.
* The model's reply still passes through the answer cleaner (markdown, quotes, "The captcha
  is:", glued single characters), so a more chatty prompt is fine.
* Useful tweaks: `Answer with digits only.` when a model insists on letters,
  `Ignore the coloured background lines.` for noisy captchas, or
  `Reply with the lowercase letters only.` for case-sensitive ones.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: `storage`, `contextMenus`, `<all_urls>` host permission |
| `shared.js` | constants, status table + SVG icons, model filter, answer cleaner, cost math, base64 |
| `background.js` | service worker: context menus, OpenRouter calls, cost + attempt accounting, status fan-out |
| `content.js` | content script (all frames): marking, image capture, filling, submitting, on-page pill |
| `popup.html/css/js` | the popup UI |

**Image capture** never re-requests the image before trying what is already on screen:
`protected.to` **regenerates the captcha on every `GET /Captcha?id=…`** (verified: three
requests with the same id returned three different pictures), so a fresh request would
show the model a different captcha *and* invalidate the answer stored on the server.
The order is therefore:

1. `canvas.drawImage(img)` - the exact rendered pixels, no request (same-origin images);
2. a `captureVisibleTab` crop of the element rectangle - the exact visible pixels, no request;
3. `fetch(image url)` from the page, then from the service worker - only when there is no
   rectangle to crop (for example a cross-origin iframe).

Whatever comes back is normalised to a **PNG** data URL, because not every model accepts
gif/webp/bmp.

**Cost** comes from `usage.cost`, requested with `usage: {include: true}`. If a provider
does not report it, it is computed from the token counts and the model's pricing in
`/api/v1/models`. The running total lives in `chrome.storage.local` (`totalCost`), so it
survives popup reloads; `reset` puts it back to `$0`.

**Parameters** are only sent when the chosen model advertises them in
`supported_parameters`, so strict models do not reject the request. The output cap is the
model's own limit from the models API (`top_provider.max_completion_tokens`), sent as
`max_completion_tokens` for models that renamed the field and as `max_tokens` otherwise;
models that advertise neither get no cap. The cap is a ceiling, not a charge - you pay for
the tokens actually generated, which the popup reports.

**Answer cleaning** drops markdown/quotes, keeps the last line of multi-line replies, and
glues spacing artefacts: `2 5 6 1 8` becomes `25618`, while `red car` is left alone
(only single characters separated by spaces/commas/dots are joined). Lead-ins such as
`The captcha is: ` / `The digits are ` are stripped - but only when something follows, so a
captcha that literally reads `code` survives.

### Reasoning models

Some vision models (`inclusionai/ling-3.0-flash-vl`, most DeepSeek/GPT/Claude hybrids)
think before they answer, and **thinking tokens come out of the same budget**. Three
consequences, all handled:

* the output cap is the model's advertised maximum (`top_provider.max_completion_tokens`,
  e.g. 32768 for Ling, 384000 for `deepseek/deepseek-v4.1-flash`), so a chatty reasoner is
  never cut off by a limit the extension invented;
* the answer is read from `content` (string *or* an array of text parts), and if that is
  empty, from `reasoning` / `reasoning_content` / `reasoning_details`. The extension also
  sends `include_reasoning: true` to models that advertise it, so that text is available;
* when the only text is a thinking trace, a **bare token** is accepted (`…\n25618`) but
  prose is refused (`So the captcha is 25618`) instead of being typed into the form, where
  it would waste the attempt anyway. The popup then marks the answer `from reasoning`.

A reply that yields nothing is reported with the reason and its numbers - for example
`The model returned no answer: it used the whole token budget thinking
(finish_reason=length, 32768/32768 tokens). Try another model.` - and it does **not**
consume your retry budget, because nothing was submitted.

**Safety rails**: at most `MAX_ATTEMPTS` (8) *submitted answers* per origin per 10 minutes,
counted in `chrome.storage.session` - API errors and unreadable images do not count, so a
bad key or a network hiccup cannot lock you out. A wrong answer reloads the page and would
otherwise loop forever and burn credits. `reset attempts` in the popup clears the counter.

## Tests

`test/selftest.js` loads the real `background.js` and `content.js`, wires them to fake
Chrome APIs and jsdom, and drives a full mark -> solve -> submit run against the real
captcha page markup plus real OpenRouter model metadata.

```sh
npm install                 # jsdom, dev-only
npm test                    # 101 checks
```

`test/index.html` is a local sandbox page with the same ids as the real site. Serve it
over HTTP (content scripts do not run on `file://` unless you enable file access):

```sh
npx http-server test -p 8080     # or: python -m http.server 8080 -d test
# then open http://localhost:8080/ and mark the three elements
```

Bundled captchas and their human reading: `test/captcha.png` reads **`36741`**,
`test/fixtures/user-captcha.png` reads **`25618`**. Use **Test image** in the popup to see
what each model makes of them - if the model disagrees with you there, the model is the
problem, not the plumbing.

## Pinpointing a wrong answer

1. Open the popup right after a failure: **Last request** shows the picture that was sent
   next to the model's answer. If the picture is not the captcha on the page, watch `via`
   (a `⚠ …fetch` means the URL was requested again).
2. Press **Test image** with the same picture and try a second model to compare accuracy.
3. Press **copy details** and paste the JSON into a bug report.

Model suggestions for noisy captchas (all present in today's `/api/v1/models`, cheapest
first): `google/gemini-2.5-flash-lite`, `qwen/qwen3.7-flash`, `openai/gpt-5-nano`,
`deepseek/deepseek-v4-flash-vision-exp`, `anthropic/claude-haiku-4.5`. A bigger model
usually costs well under a tenth of a cent per captcha.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "This tab is not reachable" | Reload the page: content scripts only exist in tabs opened after the extension was installed/reloaded. |
| Context menus missing | Reload the extension in `chrome://extensions` (menus are created on install). |
| "The marked elements are not on this page" | The site re-rendered or you marked elements on a different page/layout. Mark them again. |
| "8 answers in a row failed" | Wrong answers. Open the popup, press `reset attempts`, and try a stronger model. |
| The model reads a different captcha than the screen shows | **Last request** shows `⚠ page-fetch`/`⚠ url-fetch`. That site regenerates images on every request; re-mark the source element on the `<img>` itself so the canvas path can be used. |
| Answers come back as `2 5 6 1 8` | Already handled by the answer cleaner - make sure you are on the latest version of these files. |
| "The model returned no answer: it used the whole token budget thinking" | That model spent its entire advertised output budget thinking and never wrote an answer. Fix the model, not the cap: use a non-reasoning model, or the paid twin of the free one (free variants are heavily rate-limited and often return nothing). |
| "…it produced reasoning text but no answer" | Same cause: the trace ends in prose, so there is no answer to type. Switch model. |
| Answers work in **Test image** but not on the page | Capture problem, not a model problem - check the `via` label and the thumbnail in **Last request**. |
| Wrong answer, correct picture | Model accuracy. Compare models with **Test image**. |
| Marking is unavailable | "Mark as Captcha Source" only appears for real `<img>` elements. Canvas-only captchas are not supported. |
| Model list empty | Press ⟳; check that the key is valid on openrouter.ai. |

## Privacy

The API key and the marked selectors stay in `chrome.storage.local` on your machine. The
only network calls are to `openrouter.ai`: key validation, the model list, and the chat
completion that carries the captcha image. Nothing else is sent anywhere.

## Packaging

`test/`, `package.json` and `node_modules/` are development-only; exclude them when zipping for the Chrome Web Store (the extension itself is `manifest.json`, `shared.js`, `background.js`, `content.js` and `popup.*`).
