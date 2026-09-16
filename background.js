/* Captcha Solver - service worker: context menus, OpenRouter calls, cost bookkeeping. */
importScripts('shared.js');

const DATA_URL_RE = /^data:/i;
const HTTP_RE = /^https?:/i;
const MENUS = {
  'cs-source': { role: 'source', title: 'Mark as Captcha Source', contexts: ['image'] },
  'cs-input': { role: 'input', title: 'Put Captcha Answer Here', contexts: ['editable'] },
  'cs-submit': { role: 'submit', title: 'Solve Captcha', contexts: ['all'] }
};
const PROMPT = CS.DEFAULT_PROMPT; // overridden by the popup via storage
const IMAGE_STORE_LIMIT = 200000; // keep chrome.storage.local small

/* ---------------------------------------------------------------- menus */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, menu] of Object.entries(MENUS)) {
      chrome.contextMenus.create({ id, title: menu.title, contexts: menu.contexts });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const menu = MENUS[info.menuItemId];
  if (!menu || tab?.id === undefined) return;
  chrome.tabs
    .sendMessage(tab.id, { type: 'mark', role: menu.role }, { frameId: info.frameId || 0 })
    .catch(() =>
      reportStatus('error', 'The page is not ready - reload it, then mark the elements again.')
    );
});

/* -------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'status') {
    reportStatus(msg.state, msg.text, msg.origin);
    respond({ ok: true });
    return;
  }
  if (msg?.type === 'connect') {
    connect(msg).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (msg?.type === 'solve') {
    solve(msg).then(respond);
    return true;
  }
  if (msg?.type === 'resetCost') {
    chrome.storage.local.set({ totalCost: 0 }).then(() => respond({ ok: true }));
    return true;
  }
  if (msg?.type === 'resetAttempts') {
    chrome.storage.session.remove('attempts').then(() => respond({ ok: true }));
    return true;
  }
});

/* ---------------------------------------------------------------- status */

// The popup may be closed, so the latest status is kept in session storage too.
const reportStatus = async (state, text, origin = '') => {
  const entry = { state, text, origin, at: Date.now() };
  await chrome.storage.session.set({ status: entry });
  chrome.runtime.sendMessage({ type: 'status', from: 'background', ...entry }).catch(() => {});
};

/* -------------------------------------------------------------- openrouter */

const validateKey = async apiKey => {
  const res = await fetch(`${CS.API_BASE}/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.ok) {
    const { data } = await res.json();
    return { ok: true, label: data?.label || '' };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'OpenRouter rejected that key.' };
  }
  return { ok: false, error: `OpenRouter answered ${res.status} while validating the key.` };
};

const modelList = async refresh => {
  const { modelsCache } = await chrome.storage.local.get('modelsCache');
  if (!refresh && modelsCache?.items?.length && Date.now() - modelsCache.at < CS.MODELS_TTL_MS) {
    return modelsCache.items;
  }
  const res = await fetch(`${CS.API_BASE}/models`);
  if (!res.ok) throw new Error(`Could not load the model list (${res.status}).`);
  const items = CS.filterModels((await res.json()).data);
  await chrome.storage.local.set({ modelsCache: { at: Date.now(), items } });
  return items;
};

// Validate (optional new key), refresh the model list and pick a valid selection.
const connect = async ({ key = '', refresh = false } = {}) => {
  const stored = await chrome.storage.local.get(['apiKey', 'model']);
  const apiKey = key.trim() || stored.apiKey || '';
  if (!apiKey) return { ok: false, error: 'Enter your OpenRouter API key.' };
  if (key.trim()) {
    const checked = await validateKey(apiKey);
    if (!checked.ok) return checked;
    await chrome.storage.local.set({ apiKey });
  }
  const models = await modelList(refresh);
  if (!models.length) return { ok: false, error: 'OpenRouter returned no image-capable models.' };
  const model = models.some(m => m.id === stored.model)
    ? stored.model
    : models.some(m => m.id === CS.DEFAULT_MODEL)
      ? CS.DEFAULT_MODEL
      : models[0].id;
  await chrome.storage.local.set({ model });
  return { ok: true, models, model };
};

const requestBody = (model, image, prompt) => {
  const body = {
    model: model.id,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt.trim() || PROMPT },
          { type: 'image_url', image_url: { url: image } }
        ]
      }
    ],
    usage: { include: true }
  };
  // Only send parameters the chosen model actually advertises.
  // The output cap is the model's own advertised limit: a captcha needs a handful of
  // tokens, but reasoning models burn thousands before they write the answer.
  const cap = model.maxTokens || 0;
  if (cap && model.params?.includes('max_completion_tokens')) body.max_completion_tokens = cap;
  else if (cap && model.params?.includes('max_tokens')) body.max_tokens = cap;
  if (model.params?.includes('temperature')) body.temperature = 0;
  // Ask for the reasoning text: if a reasoning model runs out of budget before it
  // writes the final answer, the answer is still recoverable from it.
  if (model.params?.includes('include_reasoning')) body.include_reasoning = true;
  return body;
};

/* ------------------------------------------------------------------ image */

const captureCrop = async ({ x, y, w, h, dpr }) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
  const sx = Math.round(x * dpr);
  const sy = Math.round(y * dpr);
  const sw = Math.max(Math.round(w * dpr), 1);
  const sh = Math.max(Math.round(h * dpr), 1);
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
};

// Everything is normalised to a PNG data URL: not every model accepts webp/gif/bmp.
// Returns the image plus how it was obtained, which the popup reports as diagnostics.
const toDataUrl = async (message, via) => {
  const url = message.url || '';
  let { bytes, mime } = message;
  let source = via;

  if (!bytes && DATA_URL_RE.test(url)) {
    const dataMime = /^data:([^;,]+)/.exec(url)?.[1] || 'image/png';
    if (dataMime === 'image/png') return { image: url, source: source || 'data-url' };
    bytes = await (await fetch(url)).arrayBuffer();
    mime = dataMime;
  }
  // Prefer pixels the user is looking at: re-requesting the URL can return a
  // *different* picture (protected.to regenerates it on every GET), which would
  // both hide the real captcha from the model and invalidate the stored answer.
  if (!bytes && message.crop) {
    try {
      bytes = await captureCrop(message.crop);
      mime = 'image/png';
      source = 'screenshot';
    } catch (error) {
      if (!HTTP_RE.test(url)) throw error;
    }
  }
  if (!bytes && HTTP_RE.test(url)) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`Could not load the captcha image (HTTP ${res.status}).`);
    bytes = await res.arrayBuffer();
    mime = res.headers.get('content-type') || '';
    source = 'url-fetch';
  }
  if (!bytes) return { image: null, source };
  if (/png/i.test(mime)) return { image: `data:image/png;base64,${CS.b64(bytes)}`, source: source || 'page-fetch' };

  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime || 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { image: `data:image/png;base64,${CS.b64(await blob.arrayBuffer())}`, source: source || 'page-fetch' };
};

/* ------------------------------------------------------------------ solve */

// Stops a wrong answer from reloading the page and burning credits forever.
// Only submissions are counted: API errors or unreadable images do not lock you out.
const attemptsUsed = async origin => {
  const { attempts = {} } = await chrome.storage.session.get('attempts');
  const record = attempts[origin];
  return Date.now() - (record?.at || 0) < CS.ATTEMPT_WINDOW_MS ? record.count : 0;
};

const recordAttempt = async origin => {
  const { attempts = {} } = await chrome.storage.session.get('attempts');
  const count = await attemptsUsed(origin);
  await chrome.storage.session.set({ attempts: { ...attempts, [origin]: { count: count + 1, at: Date.now() } } });
};

// Keeps the last attempt (image included) so the popup can show what was sent.
const remember = async run => {
  const image = run.image || '';
  await chrome.storage.local.set({
    lastRun: { ...run, at: run.at || Date.now(), image: image.length < IMAGE_STORE_LIMIT ? image : '' }
  });
};

const addCost = async cost => {
  if (!cost) return;
  const { totalCost = 0 } = await chrome.storage.local.get('totalCost');
  await chrome.storage.local.set({ totalCost: Number(totalCost) + cost });
};

const solve = async ({ origin = '', via = '', ...message }) => {
  const { apiKey, model, prompt } = await chrome.storage.local.get(['apiKey', 'model', 'prompt']);
  if (!apiKey) return { ok: false, error: 'No API key saved - open the extension and add one.' };
  if ((await attemptsUsed(origin)) >= CS.MAX_ATTEMPTS) {
    return {
      ok: false,
      error: `${CS.MAX_ATTEMPTS} answers in a row failed. Open the popup to reset the limit, or wait 10 minutes.`
    };
  }

  let chosenId = model;
  let image = '';
  let source = via;
  try {
    const grabbed = await toDataUrl(message, via);
    image = grabbed.image;
    source = grabbed.source;
    if (!image) throw new Error('Could not read the captcha image.');

    const models = await modelList(false).catch(() => []);
    const chosen = models.find(item => item.id === model) || { id: model, params: [] };
    chosenId = chosen.id;
    const started = Date.now();
    const res = await fetch(`${CS.API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Captcha Solver'
      },
      body: JSON.stringify(requestBody(chosen, image, prompt || ''))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `OpenRouter answered ${res.status}.`);

    const choice = data.choices?.[0] || {};
    const reply = choice.message || {};
    const thinking = reply.reasoning || reply.reasoning_content || reply.reasoning_details;
    const { text, from } = CS.extractAnswer(reply);
    const answer = CS.cleanAnswer(text);
    // A reasoning trace ends wherever the model was interrupted. Only a bare token
    // can be a captcha answer; prose ("So the captcha is 25618") is rejected rather
    // than typed into the form, which would waste the attempt anyway.
    const usable = from !== 'reasoning' || (!/\s/.test(answer) && answer.length <= CS.MAX_ANSWER_LENGTH);
    const details = {
      finish: choice.finish_reason || 'unknown',
      tokens: data.usage?.completion_tokens || 0,
      reasoning: !!thinking,
      source: from,
      cap: chosen.maxTokens || 0
    };
    if (!answer || !usable) {
      const cause =
        details.finish === 'length'
          ? 'it used the whole token budget thinking'
          : from === 'reasoning'
            ? 'it produced reasoning text but no answer'
            : 'it returned no text at all';
      const failure = new Error(
        `The model returned no answer: ${cause} (finish_reason=${details.finish}, ` +
          `${details.tokens}${details.cap ? `/${details.cap}` : ''} tokens). Try another model.`
      );
      failure.details = details;
      throw failure;
    }

    const cost = CS.costFromUsage(data.usage, chosen);
    const ms = Date.now() - started;
    await addCost(cost);
    await recordAttempt(origin);
    await remember({ origin, model: chosenId, image, via: source, answer, cost, ms, details });
    return { ok: true, answer, cost, model: chosenId, ms, via: source, details };
  } catch (error) {
    const failure = error?.message || String(error);
    await remember({ origin, model: chosenId, image, via: source, error: failure, details: error?.details });
    return { ok: false, error: failure };
  }
};
