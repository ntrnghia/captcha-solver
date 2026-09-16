/* Captcha Solver - popup: key gate, model picker, live status, running cost. */
const $ = id => document.getElementById(id);
const STORE_KEYS = ['apiKey', 'model', 'modelsCache', 'sites', 'totalCost', 'autoSolve', 'lastRun', 'prompt'];

let origin = '';

const originOf = url => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

/* ------------------------------------------------------------------ views */

const showKey = () => {
  $('keyView').hidden = false;
  $('mainView').hidden = true;
  $('apiKey').focus();
};

const showMain = () => {
  $('keyView').hidden = true;
  $('mainView').hidden = false;
};

const setKeyMsg = (text, bad = false) => {
  $('keyMsg').textContent = text;
  $('keyMsg').classList.toggle('bad', bad);
};

/* -------------------------------------------------------------- rendering */

const renderModels = (models, selected) => {
  const select = $('model');
  select.replaceChildren(
    ...models.map(model => {
      const option = new Option(model.name, model.id);
      option.title = model.id;
      return option;
    })
  );
  const fallback = models.some(m => m.id === CS.DEFAULT_MODEL) ? CS.DEFAULT_MODEL : models[0]?.id || '';
  select.value = models.some(m => m.id === selected) ? selected : fallback;
  $('modelId').textContent = select.value;
};

const renderStatus = status => {
  const state = status?.state || 'idle';
  const meta = CS.STATES[state] || CS.STATES.idle;
  $('statusIcon').innerHTML = CS.icon(state);
  $('statusIcon').dataset.tone = meta.tone;
  $('statusText').textContent = status?.text || meta.label;
};

const renderCost = total => {
  $('totalCost').textContent = CS.formatUsd(total);
};

const renderRoles = (sites, target = origin) => {
  const config = sites?.[target] || {};
  for (const item of $('roles').children) {
    const record = config[item.dataset.role];
    item.dataset.set = record ? 'yes' : 'no';
    item.querySelector('.rv').textContent = record ? record.label : 'not set';
  }
  $('siteOrigin').textContent = target || 'this page';
  $('solveNow').disabled = !(config.source && config.input && config.submit);
};

// What was actually sent to the model last time, so a wrong answer is diagnosable.
const renderRun = run => {
  $('runView').hidden = !run;
  if (!run) return;
  $('runImage').src = run.image || '';
  $('runImage').hidden = !run.image;
  $('runAnswer').textContent = run.answer ? `"${run.answer}"` : run.error || 'no answer';
  $('runMeta').textContent = [
    run.via && (run.via.includes('fetch') ? `⚠ ${run.via}` : run.via),
    run.model,
    run.details?.finish,
    run.details?.tokens ? `${run.details.tokens} tok` : '',
    run.details?.source === 'reasoning' ? 'from reasoning' : '',
    run.cost ? CS.formatUsd(run.cost) : '',
    run.ms ? `${run.ms} ms` : ''
  ]
    .filter(Boolean)
    .join(' · ');
};

// The prompt is editable; the default is restored by the button next to the label.
const renderPrompt = value => {
  const prompt = value === undefined ? CS.DEFAULT_PROMPT : value;
  $('prompt').value = prompt;
  $('resetPrompt').hidden = prompt.trim() === CS.DEFAULT_PROMPT;
};

const renderAttempts = async () => {
  const { attempts = {} } = await chrome.storage.session.get('attempts');
  const record = attempts[origin];
  const used = record && Date.now() - record.at < CS.ATTEMPT_WINDOW_MS ? record.count : 0;
  $('attempts').textContent = `Answers sent here: ${used}/${CS.MAX_ATTEMPTS} in 10 min`;
  $('resetAttempts').hidden = used === 0;
};

const copy = async text => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    document.body.append(scratch);
    scratch.select();
    document.execCommand('copy');
    scratch.remove();
  }
};

/* --------------------------------------------------------------- actions */

async function connect(refresh = false) {
  const key = $('apiKey').value.trim();
  if (!key && !refresh) return setKeyMsg('Enter your OpenRouter API key.', true);
  setKeyMsg(refresh ? 'Reloading the model list...' : 'Checking the key...');
  const result = await chrome.runtime
    .sendMessage({ type: 'connect', key, refresh })
    .catch(error => ({ ok: false, error: error.message }));
  if (!result?.ok) return setKeyMsg(result?.error || 'Could not reach OpenRouter.', true);
  setKeyMsg('');
  $('apiKey').value = '';
  renderModels(result.models, result.model);
  showMain();
}

/* ------------------------------------------------------------------- init */

async function init() {
  origin = originOf((await activeTab())?.url);
  const stored = await chrome.storage.local.get(STORE_KEYS);
  const { status } = await chrome.storage.session.get('status');

  renderStatus(status);
  renderCost(stored.totalCost);
  renderRoles(stored.sites);
  renderRun(stored.lastRun);
  renderPrompt(stored.prompt);
  renderAttempts();
  $('autoSolve').checked = stored.autoSolve !== false;

  if (!stored.apiKey) return showKey();
  showMain();
  if (stored.modelsCache?.items?.length) renderModels(stored.modelsCache.items, stored.model);
  else connect(true); // first run after install: pull the list
}

/* --------------------------------------------------------------- wiring */

$('keyForm').addEventListener('submit', event => {
  event.preventDefault();
  connect();
});
$('refresh').addEventListener('click', () => connect(true));
$('changeKey').addEventListener('click', showKey);
$('model').addEventListener('change', () => {
  chrome.storage.local.set({ model: $('model').value });
  $('modelId').textContent = $('model').value;
});
let promptTimer = 0;
$('prompt').addEventListener('input', () => {
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => {
    chrome.storage.local.set({ prompt: $('prompt').value });
    renderPrompt($('prompt').value);
  }, 300);
});
$('resetPrompt').addEventListener('click', () => {
  chrome.storage.local.set({ prompt: CS.DEFAULT_PROMPT });
  renderPrompt(CS.DEFAULT_PROMPT);
});
$('resetCost').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'resetCost' });
  renderCost(0);
});
$('autoSolve').addEventListener('change', () => {
  chrome.storage.local.set({ autoSolve: $('autoSolve').checked });
});
$('solveNow').addEventListener('click', async () => {
  const tab = await activeTab();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'solveNow' });
  } catch {
    renderStatus({ state: 'error', text: 'This tab is not reachable - reload the page.' });
  }
});
$('resetAttempts').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'resetAttempts' });
  renderAttempts();
});
$('copyRun').addEventListener('click', async () => {
  const { lastRun } = await chrome.storage.local.get('lastRun');
  const { image, ...details } = lastRun || {};
  await copy(JSON.stringify({ ...details, image: image ? `${image.slice(0, 40)}... (${image.length} bytes)` : '' }, null, 1));
  $('copyRun').textContent = 'copied';
});
// Test the model on a picture from disk (e.g. a captcha saved from the page).
$('testImage').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files?.[0];
  if (!file) return;
  const url = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  $('file').value = '';
  renderStatus({ state: 'requesting', text: `Reading ${file.name}...` });
  const result = await chrome.runtime.sendMessage({ type: 'solve', origin: '(image test)', url, via: 'upload' });
  renderStatus(
    result?.ok
      ? { state: 'done', text: `"${result.answer}" · ${CS.formatUsd(result.cost)} · ${result.ms} ms` }
      : { state: 'error', text: result?.error || 'The request failed.' }
  );
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.totalCost) renderCost(changes.totalCost.newValue);
  if (changes.sites) renderRoles(changes.sites.newValue);
  if (changes.lastRun) renderRun(changes.lastRun.newValue);
  if (changes.attempts) renderAttempts();
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.from === 'background' && msg.type === 'status') renderStatus(msg);
});

init();
