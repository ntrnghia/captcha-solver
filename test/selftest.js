/* Offline self-test for the Captcha Solver extension.

   It loads the *real* background.js and content.js, wires them to fake Chrome
   APIs (jsdom provides the DOM) and drives a full mark -> solve -> submit run
   against the real page markup and the real OpenRouter model metadata.

   Run:  npm install jsdom   (once)   then   node test/selftest.js           */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { JSDOM, VirtualConsole } = require('jsdom');

const read = (...parts) => fs.readFileSync(path.join(__dirname, ...parts));
const FIXTURE_MODELS = JSON.parse(read('fixtures', 'models.json')).data;
const PAGE_HTML = read('fixtures', 'page.html').toString();
const CAPTCHA_PNG = read('captcha.png');
const USER_CAPTCHA_PNG = read('fixtures', 'user-captcha.png');

const ORIGIN = 'http://protected.to';
const MODEL = 'deepseek/deepseek-v4.1-flash';
const MODEL_INFO = FIXTURE_MODELS.find(model => model.id === MODEL);
const RAW_ANSWER = '```\nThe captcha is: 36741.\n```';
const ANSWER = '36741';
const COST = 0.00021;
const TAB_ID = 1;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      -> ${detail}`}`);
};

const waitFor = async (predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
};

/* ------------------------------------------------------- fake chrome APIs */

const storageArea = () => {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === undefined || keys === null) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, data[key]]));
      return { ...keys, ...data };
    },
    async set(values) {
      Object.assign(data, values);
    },
    async remove(keys) {
      [].concat(keys).forEach(key => delete data[key]);
    }
  };
};

const local = storageArea();
const session = storageArea();
const broadcasts = [];
const sent = [];
let backgroundListener = null;
let contentListener = null;
let menuListener = null;
let lastContentCall = null;

const toBackground = msg =>
  new Promise((resolve, reject) => {
    sent.push(msg);
    if (!backgroundListener) return reject(new Error('background has no listener'));
    backgroundListener(msg, { tab: { id: TAB_ID } }, resolve);
  });

const toContent = msg =>
  new Promise(resolve => {
    if (!contentListener) return resolve(undefined);
    contentListener(msg, { id: TAB_ID }, resolve);
  });

const backgroundChrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener: listener => (backgroundListener = listener) },
    sendMessage: async msg => broadcasts.push(msg)
  },
  contextMenus: {
    removeAll: callback => callback(),
    create: () => {},
    onClicked: { addListener: listener => (menuListener = listener) }
  },
  storage: { local, session },
  tabs: {
    query: async () => [{ id: TAB_ID, windowId: 1 }],
    captureVisibleTab: async () => `data:image/png;base64,${CAPTCHA_PNG.toString('base64')}`,
    sendMessage: async (tabId, msg) => {
      lastContentCall = toContent(msg);
      return lastContentCall;
    }
  }
};

/* --------------------------------------------------------- fake OpenRouter */

const calls = [];
let chatStatus = 200;
let chatPayload = () => ({
  choices: [{ message: { content: RAW_ANSWER } }],
  usage: { prompt_tokens: 1180, completion_tokens: 9, cost: COST }
});
const response = (body, status = 200) => ({
  ok: status < 300,
  status,
  headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : '') },
  json: async () => body
});

const fakeFetch = async (url, init = {}) => {
  calls.push({ url, init });
  if (url.startsWith('data:')) {
    return { ok: true, status: 200, blob: async () => new Blob([CAPTCHA_PNG], { type: 'image/png' }) };
  }
  if (url.endsWith('/key')) {
    const authorised = init.headers?.Authorization === 'Bearer sk-good';
    return authorised ? response({ data: { label: 'test' } }) : response({ error: 'no' }, 401);
  }
  if (url.endsWith('/models')) return response({ data: FIXTURE_MODELS });
  if (url.endsWith('/chat/completions')) {
    if (chatStatus !== 200) return response({ error: { message: 'Rate limited' } }, chatStatus);
    return response(chatPayload());
  }
  if (url.includes('/Captcha?id=')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () =>
        CAPTCHA_PNG.buffer.slice(CAPTCHA_PNG.byteOffset, CAPTCHA_PNG.byteOffset + CAPTCHA_PNG.byteLength),
      json: async () => ({})
    };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

/* ------------------------------------------------ load the real worker code */

const swSandbox = { chrome: backgroundChrome, fetch: fakeFetch, console, setTimeout, clearTimeout, Blob, btoa, URL };
swSandbox.globalThis = swSandbox;
swSandbox.self = swSandbox;
// OffscreenCanvas is not available in Node; these stand in for the crop pipeline.
swSandbox.createImageBitmap = async () => ({ width: 190, height: 80 });
swSandbox.OffscreenCanvas = class {
  getContext() {
    return { drawImage() {} };
  }
  async convertToBlob() {
    return new Blob([CAPTCHA_PNG], { type: 'image/png' });
  }
};
const swContext = vm.createContext(swSandbox);
swSandbox.importScripts = (...files) => {
  files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), swContext));
};
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), swContext);
const CS = swSandbox.CS;

/* ---------------------------------------------- the page, driven like a user */

const newPage = () => {
  const dom = new JSDOM(PAGE_HTML, {
    url: `${ORIGIN}/f-9bb37f745b211246`,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  const { window } = dom;
  // jsdom loads no images and has no canvas: pretend the picture is already painted.
  Object.defineProperty(window.HTMLImageElement.prototype, 'complete', { get: () => true });
  Object.defineProperty(window.HTMLImageElement.prototype, 'naturalWidth', { get: () => 190 });
  if (!window.CSS.escape) window.CSS.escape = value => String(value);
  window.chrome = {
    runtime: {
      onMessage: { addListener: listener => (contentListener = listener) },
      sendMessage: msg => toBackground(msg)
    },
    storage: { local, session }
  };
  window.eval(read('..', 'shared.js').toString());
  window.eval(read('..', 'content.js').toString());
  return window;
};

const rightClick = (window, selector, menuItemId) => {
  window.document.querySelector(selector).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
  menuListener({ menuItemId, frameId: 0 }, { id: TAB_ID });
  return lastContentCall;
};

/* ------------------------------------------------------------------- suite */

(async () => {
  console.log('\n== shared helpers ==');
  {
    const expected = FIXTURE_MODELS.filter(model => {
      const arch = model.architecture || {};
      return arch.input_modalities?.includes('image') && arch.output_modalities?.includes('text');
    }).map(model => model.id);
    const filtered = CS.filterModels(FIXTURE_MODELS);
    check(
      'filterModels keeps only image-in/text-out models',
      filtered.length === expected.length && filtered.length > 0,
      `${filtered.length} vs ${expected.length}`
    );
    check('filterModels preserves the API order', filtered.map(m => m.id).join() === expected.join());
    check(
      'filterModels exposes pricing and supported params',
      filtered.some(m => m.id === MODEL && m.prompt > 0 && Array.isArray(m.params))
    );

    for (const [raw, want] of [
      [RAW_ANSWER, ANSWER],
      ['"ab12cd"', 'ab12cd'],
      ['Here you go:\nXY7Z', 'XY7Z'],
      ['The answer is 4f9k.', '4f9k'],
      ['  `m3nd`  ', 'm3nd'],
      ['2 5 6 1 8', '25618'], // spacing artefact of the vision model
      ['2, 5, 6, 1, 8', '25618'],
      ['The characters are 25618', '25618'], // reasoning traces phrase it many ways
      ['The digits are 6 4 2 9.', '6429'],
      ['code', 'code'], // a captcha that is a keyword survives
      ['red car', 'red car'], // real words are left alone
      ['', '']
    ]) {
      check(
        `cleanAnswer(${JSON.stringify(raw)}) === ${JSON.stringify(want)}`,
        CS.cleanAnswer(raw) === want,
        CS.cleanAnswer(raw)
      );
    }

    check("formatUsd(0) === '$0'", CS.formatUsd(0) === '$0', CS.formatUsd(0));
    check('formatUsd keeps 4 decimals', CS.formatUsd(0.00021) === '$0.0002', CS.formatUsd(0.00021));

    const model = CS.filterModels(FIXTURE_MODELS).find(m => m.id === MODEL);
    check('costFromUsage prefers the reported cost', CS.costFromUsage({ cost: 0.5, prompt_tokens: 1 }, model) === 0.5);
    check('costFromUsage accepts a string cost', CS.costFromUsage({ cost: '0.25' }, model) === 0.25);
    const fallback = CS.costFromUsage({ cost: 'n/a', prompt_tokens: 1000, completion_tokens: 10 }, model);
    check(
      'costFromUsage falls back to token pricing',
      Math.abs(fallback - (1000 * model.prompt + 10 * model.completion)) < 1e-12,
      fallback
    );
    check('b64 round-trips the image bytes', Buffer.from(CS.b64(CAPTCHA_PNG), 'base64').equals(CAPTCHA_PNG));
  }

  console.log('\n== key validation + model list ==');
  {
    const bad = await toBackground({ type: 'connect', key: 'sk-bad' });
    check('a rejected key is reported', bad.ok === false && /rejected/.test(bad.error), JSON.stringify(bad));
    check('a rejected key is not saved', local.data.apiKey === undefined);

    const good = await toBackground({ type: 'connect', key: 'sk-good' });
    check('a valid key is accepted', good.ok === true, JSON.stringify(good).slice(0, 200));
    check('the key is stored locally', local.data.apiKey === 'sk-good');
    check(`the default model is ${MODEL}`, good.model === MODEL, good.model);
    check('the model list is cached', local.data.modelsCache.items.some(m => m.id === MODEL));
    check(
      'connect without a key reuses the stored key',
      (await toBackground({ type: 'connect', refresh: true })).ok === true
    );
  }

  console.log('\n== marking the elements on the first visit ==');
  {
    const window = newPage();
    await rightClick(window, '#CaptchaImage', 'cs-source');
    await rightClick(window, '#CaptchaInputText', 'cs-input');
    await rightClick(window, 'input[type=submit]', 'cs-submit');

    const site = local.data.sites?.[ORIGIN];
    check('all three roles are remembered', !!(site?.source && site?.input && site?.submit), JSON.stringify(site));
    check('the captcha image is remembered by id', site?.source.label === '<img#CaptchaImage>', site?.source.label);
    check('the input is remembered by id', site?.input.label === '<input#CaptchaInputText>', site?.input.label);
    check('the button is remembered by its text', site?.submit.label === '<input> "Continue to folder"', site?.submit.label);
    check(
      'every remembered selector still resolves',
      ['source', 'input', 'submit'].every(role => window.document.querySelector(site[role].selector))
    );
    check(
      'the real submit button is the one remembered',
      window.document.querySelector(site.submit.selector) === window.document.querySelector('input[type=submit]')
    );
  }

  console.log('\n== auto-solve on the next visit ==');
  {
    calls.length = 0;
    const window = newPage();
    const input = window.document.getElementById('CaptchaInputText');
    const events = [];
    ['input', 'change'].forEach(type => input.addEventListener(type, () => events.push(type)));
    let submitted = false;
    window.document.querySelector('input[type=submit]').addEventListener('click', () => (submitted = true));

    check('the answer is submitted without user interaction', (await waitFor(() => submitted)) === true);
    check(`the model answer "${ANSWER}" lands in the input`, input.value === ANSWER, input.value);
    check('input and change events are dispatched', events.join() === 'input,change', events.join());
    check('the total cost is added up', Math.abs(local.data.totalCost - COST) < 1e-12, String(local.data.totalCost));
    check(
      'the status is recorded for the popup',
      session.data.status?.state === 'done' && session.data.status.text.includes(ANSWER),
      JSON.stringify(session.data.status)
    );
    check('the status is broadcast to the popup', broadcasts.some(b => b.from === 'background' && b.state === 'done'));

    const body = JSON.parse(calls.find(call => call.url.endsWith('/chat/completions')).init.body);
    const content = body.messages.at(-1).content;
    check('the selected model is used', body.model === MODEL, body.model);
    check('the image is sent as a PNG data URL', /^data:image\/png;base64,/.test(content[1].image_url.url));
    check(
      'the exact captcha pixels are sent',
      Buffer.from(content[1].image_url.url.split(',')[1], 'base64').equals(CAPTCHA_PNG)
    );
    check('the default prompt is sent verbatim', content[0].text === CS.DEFAULT_PROMPT, content[0].text);
    check('cost accounting is requested (usage.include)', body.usage?.include === true);
    check(
      'the output cap is the model maximum',
      body.max_tokens === MODEL_INFO.top_provider.max_completion_tokens,
      `${body.max_tokens} vs ${MODEL_INFO.top_provider.max_completion_tokens}`
    );
    check(
      'temperature is sent only if the model supports it',
      (body.temperature === 0) === MODEL_INFO.supported_parameters.includes('temperature')
    );

    // Regression: the captcha is regenerated on every GET, so re-requesting it
    // would send the model a different picture than the one on screen.
    const solveMessage = sent.filter(msg => msg.type === 'solve').at(-1);
    check('the image is not re-requested from the page', !calls.some(call => call.url.includes('/Captcha')));
    check('the capture reports how it was obtained', solveMessage.via === 'screenshot', solveMessage.via);
    check('the capture carries no freshly fetched bytes', solveMessage.bytes === undefined);
    check('the last request is remembered for the popup', local.data.lastRun?.via === 'screenshot' && !!local.data.lastRun.image);
    check(
      'the remembered image is the very picture that was sent',
      local.data.lastRun.image === JSON.parse(calls.at(-1).init.body).messages.at(-1).content[1].image_url.url
    );
  }

  console.log('\n== diagnostics and attempt accounting ==');
  {
    // A failing API call must not use up the retry budget.
    chatStatus = 429;
    const failed = await toBackground({ type: 'solve', origin: 'http://err.test', url: 'data:image/png;base64,' + CAPTCHA_PNG.toString('base64') });
    check('an API error is surfaced', failed.ok === false && /Rate limited/.test(failed.error), JSON.stringify(failed));
    check('an API error costs no attempt', session.data.attempts?.['http://err.test'] === undefined);
    check('the failure is remembered with its image', local.data.lastRun.error === 'Rate limited' && !!local.data.lastRun.image);
    chatStatus = 200;

    const uploaded = 'data:image/png;base64,' + USER_CAPTCHA_PNG.toString('base64');
    const tested = await toBackground({ type: 'solve', origin: '(image test)', url: uploaded, via: 'upload' });
    check('a saved captcha from disk is solved', tested.ok === true && tested.answer === ANSWER, JSON.stringify(tested));
    check(
      'a saved captcha is forwarded pixel for pixel',
      JSON.parse(calls.at(-1).init.body).messages.at(-1).content[1].image_url.url === uploaded
    );
    check('the upload is labelled as such', local.data.lastRun.via === 'upload');
  }

  console.log('\n== editable prompt ==');
  {
    const png = `data:image/png;base64,${CAPTCHA_PNG.toString('base64')}`;
    const sentPrompt = () => JSON.parse(calls.at(-1).init.body).messages.at(-1).content[0].text;

    const ask = () => toBackground({ type: 'solve', origin: 'http://prompt.test', url: png });
    await ask();
    check('the default prompt ships with the extension', sentPrompt() === CS.DEFAULT_PROMPT, sentPrompt());
    check('the default prompt explains the task', /captcha/i.test(CS.DEFAULT_PROMPT) && /without spaces/i.test(CS.DEFAULT_PROMPT));

    local.data.prompt = 'Answer with the digits only.';
    await ask();
    check('an edited prompt replaces the default', sentPrompt() === 'Answer with the digits only.', sentPrompt());

    local.data.prompt = '   ';
    await ask();
    check('a blank prompt falls back to the default', sentPrompt() === CS.DEFAULT_PROMPT, JSON.stringify(sentPrompt()));

    local.data.prompt = 'Answer with the digits only.';
    delete local.data.prompt;
    await ask();
    check('removing the prompt restores the default', sentPrompt() === CS.DEFAULT_PROMPT);
  }

  console.log('\n== reasoning models (reported bug) ==');
  {
    // inclusionai/ling-3.0-flash-vl:free advertises `reasoning` + `include_reasoning`.
    const FREE_VLM = 'inclusionai/ling-3.0-flash-vl:free';
    const png = 'data:image/png;base64,' + USER_CAPTCHA_PNG.toString('base64');
    const ask = () => toBackground({ type: 'solve', origin: 'http://free.test', url: png, via: 'upload' });
    const lastBody = () => JSON.parse(calls.at(-1).init.body);
    const support = FIXTURE_MODELS.find(model => model.id === FREE_VLM).supported_parameters;
    const ling = FIXTURE_MODELS.find(model => model.id === 'inclusionai/ling-3.0-flash-vl:free');
    const lingMax = ling.top_provider.max_completion_tokens; // 32768
    const limits = CS.filterModels(FIXTURE_MODELS);
    check('filterModels exposes the model output limit', limits.find(m => m.id === ling.id).maxTokens === lingMax, String(lingMax));
    check('the budget is not a hardcoded constant', !('MAX_TOKENS' in CS), Object.keys(CS).join());

    local.data.model = FREE_VLM;
    local.data.prompt =
      'Solve this captcha image which contains sequence of numbers. They may be slanted, overlapping or ' +
      'crossed by background lines. Reply with only those numbers, in order, without spaces or explanation.';
    await ask();
    check(`the output cap is the model maximum (${lingMax})`, lastBody().max_tokens === lingMax, JSON.stringify(lastBody().max_tokens));

    local.data.model = '~openai/gpt-astra-latest';
    await ask();
    check('models that renamed the cap get max_completion_tokens', lastBody().max_completion_tokens === 128000 && lastBody().max_tokens === undefined, JSON.stringify({ max_tokens: lastBody().max_tokens, max_completion_tokens: lastBody().max_completion_tokens }));

    local.data.model = 'sakana/fugu-ultra-v2';
    await ask();
    check('a model advertising neither cap gets none', lastBody().max_tokens === undefined && lastBody().max_completion_tokens === undefined);
    local.data.model = FREE_VLM;

    const thinking = 'The image shows five digits.\nLooking closely: 2, 5, 6, 1 and 8.\nThe characters are 25618.';
    const shapes = [
      ['content as a string', { content: '25618' }],
      ['content as text parts', { content: [{ type: 'text', text: '2 5 6 1 8' }] }],
      ['null content with the answer in reasoning', { content: null, reasoning: thinking }],
      ['empty content array with reasoning', { content: [], reasoning: thinking }],
      ['whitespace content with reasoning', { content: '   ', reasoning: thinking }],
      ['reasoning_content instead of reasoning', { content: '', reasoning_content: thinking }],
      ['reasoning_details parts', { content: '', reasoning_details: [{ type: 'reasoning.text', text: thinking }] }]
    ];
    // Fresh budget for the response-shape checks below.
    await toBackground({ type: 'resetAttempts' });
    for (const [label, message] of shapes) {
      chatPayload = () => ({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0 } });
      const result = await ask();
      check(`an answer is found with ${label}`, result.ok === true && result.answer === '25618', JSON.stringify(result));
    }

    // Exactly the reported failure: the budget was eaten by reasoning, nothing in content.
    await toBackground({ type: 'resetAttempts' });
    chatPayload = () => ({
      choices: [{ message: { content: '', reasoning: 'Thinking about the image...' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: lingMax, cost: 0 }
    });
    const starved = await ask();
    check('a starved model is explained, not called "empty"', /no answer/.test(starved.error) && /finish_reason=length/.test(starved.error), starved.error);
    check('the diagnosis names the token budget', new RegExp(`${lingMax}/${lingMax} tokens`).test(starved.error), starved.error);
    check('the diagnosis is kept for the popup', local.data.lastRun.details.finish === 'length' && local.data.lastRun.details.tokens === lingMax, JSON.stringify(local.data.lastRun.details));

    chatPayload = () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 0, cost: 0 } });
    const silent = await ask();
    check('a truly silent model is reported as such', /no text at all/.test(silent.error), silent.error);

    chatPayload = () => ({
      choices: [{ message: { content: '', reasoning: 'Let me think about what those characters could be.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0 }
    });
    const reasoningOnly = await ask();
    check('prose-only reasoning is refused, not typed in', /reasoning text but no answer/.test(reasoningOnly.error), reasoningOnly.error);
    check('a refused reply costs no attempt', session.data.attempts?.['http://free.test'] === undefined);

    // The valuable case: starved mid-thought, but the trace already holds the answer.
    await toBackground({ type: 'resetAttempts' });
    chatPayload = () => ({
      choices: [{ message: { content: '', reasoning: 'Checking each glyph in turn.\nThe characters are 25618' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 900, completion_tokens: lingMax, cost: 0 }
    });
    const recovered = await ask();
    check('an answer is recovered from a starved trace', recovered.ok === true && recovered.answer === '25618', JSON.stringify(recovered));
    check('the recovery is flagged as coming from reasoning', local.data.lastRun.details.source === 'reasoning', JSON.stringify(local.data.lastRun.details));

    check(`the reported budget is the model maximum (${lingMax})`, new RegExp(`${lingMax}/${lingMax} tokens`).test(starved.error), starved.error);
    check('the reasoning model is asked to return its reasoning', support.includes('include_reasoning') && lastBody().include_reasoning === true, JSON.stringify(lastBody().include_reasoning));
    check('the report carries the exact model id', local.data.lastRun.model === FREE_VLM, local.data.lastRun.model);

    chatPayload = () => ({ choices: [{ message: { content: RAW_ANSWER } }], usage: { prompt_tokens: 1180, completion_tokens: 9, cost: COST } });
    local.data.model = MODEL;
    delete local.data.prompt;
  }

  console.log('\n== safety rails ==');
  {
    const png = `data:image/png;base64,${CAPTCHA_PNG.toString('base64')}`;
    await toBackground({ type: 'resetAttempts' }); // start from a known budget
    const before = local.data.totalCost;
    for (let attempt = 1; attempt <= CS.MAX_ATTEMPTS; attempt += 1) {
      const result = await toBackground({ type: 'solve', origin: ORIGIN, url: png });
      check(`solve #${attempt} still runs`, result.ok === true, JSON.stringify(result));
    }
    const blocked = await toBackground({ type: 'solve', origin: ORIGIN, url: png });
    check(
      `solve #${CS.MAX_ATTEMPTS + 1} is refused`,
      blocked.ok === false && /failed/.test(blocked.error),
      JSON.stringify(blocked)
    );
    check(
      'costs accumulate',
      Math.abs(local.data.totalCost - (before + COST * CS.MAX_ATTEMPTS)) < 1e-9,
      String(local.data.totalCost)
    );
    check('the attempt counter is per origin', session.data.attempts?.[ORIGIN]?.count === CS.MAX_ATTEMPTS);

    const unreadable = await toBackground({ type: 'solve', origin: 'http://other.test' });
    check('an unreadable image is reported', unreadable.ok === false && /Could not read/.test(unreadable.error), JSON.stringify(unreadable));
    check('an unreadable image costs no attempt', session.data.attempts?.['http://other.test'] === undefined);

    await toBackground({ type: 'resetCost' });
    check('the total cost can be reset', local.data.totalCost === 0);
    await toBackground({ type: 'resetAttempts' });
    check('the attempt limit can be reset', session.data.attempts === undefined);
  }

  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}\n`);
  process.exit(failures ? 1 : 0);
})();
