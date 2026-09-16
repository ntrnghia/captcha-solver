/* Captcha Solver - content script (every frame).
   Marks the right-clicked elements, captures the captcha, pastes the answer, submits. */
(() => {
  const ORIGIN = location.origin;
  const ROLE_LABEL = { source: 'Captcha image', input: 'Answer input', submit: 'Continue button' };
  const TONE_COLOR = { muted: '#9ca3af', busy: '#60a5fa', ok: '#4ade80', bad: '#f87171' };

  let contextTarget = null; // element under the last right-click in this frame
  let solving = false;
  let pill = null;
  let pillIcon = null;
  let pillText = null;
  let pillTimer = 0;

  document.addEventListener('contextmenu', event => (contextTarget = event.target), true);

  /* ------------------------------------------------------------- elements */

  const cssPath = element => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      const id = `#${CSS.escape(node.id)}`;
      if (node.id && document.querySelectorAll(id).length === 1) {
        parts.unshift(id);
        break;
      }
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(child => child.tagName === node.tagName)
        : [];
      parts.unshift(node.tagName.toLowerCase() + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''));
    }
    return parts.join(' > ');
  };

  const describe = element => {
    const record = {
      selector: cssPath(element),
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      name: element.getAttribute('name') || '',
      text: (element.value || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    };
    record.label = `<${record.tag}${record.id ? `#${record.id}` : record.name ? `[name="${record.name}"]` : ''}>`;
    if (record.text) record.label += ` ${JSON.stringify(record.text)}`;
    return record;
  };

  // A CSS path, then the cheap attributes, then the button text - the page may re-render.
  const find = record => {
    const strategies = [
      () => {
        try {
          return document.querySelector(record.selector);
        } catch {
          return null;
        }
      },
      () => record.id && document.getElementById(record.id),
      () => record.name && document.querySelector(`[name="${CSS.escape(record.name)}"]`),
      () =>
        record.text &&
        [...document.querySelectorAll('input[type=submit],button,a')].find(
          node => (node.value || node.textContent || '').replace(/\s+/g, ' ').trim() === record.text
        )
    ];
    for (const strategy of strategies) {
      const element = strategy();
      if (element) return element;
    }
    return null;
  };

  /* -------------------------------------------------------------- capture */

  // Exact pixels of the picture the user is looking at (throws for cross-origin images).
  const paintedDataUrl = element => {
    try {
      const image = element.tagName === 'IMG' ? element : element.querySelector('img');
      if (!image || !image.complete || !image.naturalWidth) return null;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  };

  const imageUrl = element => {
    if (element.tagName === 'IMG') return element.currentSrc || element.src || '';
    const match = /url\((['"]?)(.*?)\1\)/.exec(getComputedStyle(element).backgroundImage || '');
    if (match) return match[2];
    const image = element.querySelector('img');
    return image ? image.currentSrc || image.src || '' : '';
  };

  // Rectangle in top-level coordinates, used as the last-resort screenshot crop.
  const rectInTop = element => {
    const rect = element.getBoundingClientRect();
    let x = rect.left;
    let y = rect.top;
    let view = window;
    while (view !== view.parent) {
      try {
        const frame = view.frameElement;
        if (!frame) return null;
        const frameRect = frame.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
        view = view.parent;
      } catch {
        return null; // cross-origin frame: cropping from the top page is impossible
      }
    }
    return { x, y, w: rect.width, h: rect.height, dpr: window.devicePixelRatio || 1 };
  };

  // Never re-request an image URL before trying the pixels we can already see:
  // protected.to regenerates the captcha on every GET, so a fresh request would
  // show the model a different picture than the one on screen.
  const grab = async element => {
    const painted = paintedDataUrl(element);
    if (painted) return { url: painted, via: 'canvas' };
    const url = imageUrl(element);
    const crop = rectInTop(element);
    if (crop) return { url: url || null, crop, via: 'screenshot' };
    if (!url) return { url: null, via: null };
    if (/^data:/i.test(url)) return { url, via: 'data-url' };
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        return { url, bytes: await res.arrayBuffer(), mime: res.headers.get('content-type') || '', via: 'page-fetch' };
      }
    } catch {
      /* blocked by CORS - let the worker retry */
    }
    return { url: /^https?:/i.test(url) ? url : null, via: 'url-fetch' };
  };

  /* --------------------------------------------------------------- status */

  const showStatus = (state, text) => {
    chrome.runtime.sendMessage({ type: 'status', state, text, origin: ORIGIN }).catch(() => {});
    if (!pill) {
      pill = document.createElement('div');
      pill.style.cssText =
        'position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;opacity:1;' +
        'transition:opacity .6s;font:13px/1.4 system-ui,"Segoe UI",sans-serif';
      const shadow = pill.attachShadow({ mode: 'open' });
      const box = document.createElement('div');
      box.style.cssText =
        'display:flex;align-items:center;gap:8px;max-width:360px;padding:8px 12px;border-radius:999px;' +
        'background:#111827e6;color:#f9fafb;box-shadow:0 4px 14px #00000059';
      pillIcon = document.createElement('span');
      pillIcon.style.cssText = 'display:flex;flex:0 0 16px;width:16px;height:16px';
      pillText = document.createElement('span');
      box.append(pillIcon, pillText);
      shadow.append(box);
      document.documentElement.append(pill);
    }
    const meta = CS.STATES[state] || CS.STATES.idle;
    pillIcon.innerHTML = CS.icon(state);
    pillIcon.style.color = TONE_COLOR[meta.tone];
    pillText.textContent = text || meta.label;
    pill.style.opacity = '1';
    clearTimeout(pillTimer);
    if (state === 'done') {
      pillTimer = setTimeout(() => (pill.style.opacity = '0'), 6000);
    }
  };

  /* ---------------------------------------------------------------- solve */

  const waitFor = async (check, timeout = 20000, step = 250) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = check();
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await new Promise(resolve => setTimeout(resolve, step));
    }
  };

  const decoded = element =>
    element.tagName !== 'IMG' || element.complete
      ? Promise.resolve()
      : new Promise(resolve => {
          element.addEventListener('load', resolve, { once: true });
          element.addEventListener('error', resolve, { once: true });
        });

  // React/Angular inputs ignore `element.value = x`, so go through the native setter.
  const fill = (element, value) => {
    if (element.isContentEditable) {
      element.focus();
      element.textContent = value;
    } else {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const solve = async () => {
    if (solving) return;
    const { sites } = await chrome.storage.local.get('sites');
    const config = sites?.[ORIGIN];
    if (!config?.source || !config?.input || !config?.submit) {
      return showStatus('error', 'Mark the captcha image, the input and the button first.');
    }
    const source = find(config.source);
    const input = find(config.input);
    const submit = find(config.submit);
    if (!source || !input || !submit) {
      return showStatus('error', 'The marked elements are not on this page.');
    }

    solving = true;
    try {
      showStatus('capturing', 'Capturing the captcha image...');
      await decoded(source.tagName === 'IMG' ? source : source.querySelector('img') || source);
      const payload = await grab(source);

      const { model } = await chrome.storage.local.get('model');
      showStatus('requesting', `Asking ${model || CS.DEFAULT_MODEL}...`);
      const result = await chrome.runtime.sendMessage({ type: 'solve', origin: ORIGIN, ...payload });
      if (!result?.ok) return showStatus('error', result?.error || 'The request failed.');

      showStatus('answering', 'Filling in the answer...');
      fill(input, result.answer);
      showStatus('submitting', 'Submitting...');
      submit.focus?.();
      submit.click();
      showStatus('done', `"${result.answer}" - ${CS.formatUsd(result.cost)}${result.via ? ` (${result.via})` : ''}`);
    } finally {
      solving = false;
    }
  };

  /* --------------------------------------------------------------- wiring */

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.type === 'mark') {
      const target = contextTarget;
      if (!target) return respond({ ok: false, error: 'Right-click directly on the element.' });
      (async () => {
        const { sites = {} } = await chrome.storage.local.get('sites');
        const site = { ...(sites[ORIGIN] || {}), [msg.role]: describe(target), updatedAt: Date.now() };
        await chrome.storage.local.set({ sites: { ...sites, [ORIGIN]: site } });
        showStatus('done', `${ROLE_LABEL[msg.role]} saved: ${site[msg.role].label}`);
        respond({ ok: true });
      })();
      return true;
    }
    if (msg?.type === 'solveNow') {
      solve();
      respond({ ok: true });
      return true;
    }
  });

  // Auto-solve the moment the configured page has all three elements.
  (async () => {
    const { sites = {}, autoSolve } = await chrome.storage.local.get(['sites', 'autoSolve']);
    const config = sites[ORIGIN];
    if (autoSolve === false || !config?.source || !config?.input || !config?.submit) return;
    const ready = await waitFor(
      () => find(config.source) && find(config.input) && find(config.submit),
      25000,
      500
    );
    if (ready) solve();
  })();
})();
