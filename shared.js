/* Captcha Solver - code shared by the service worker, the popup and the content
   script. Defines exactly one global: CS. */
(() => {
  const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
  const API_BASE = 'https://openrouter.ai/api/v1';
  const MODELS_TTL_MS = 24 * 60 * 60 * 1000; // reuse the model list for a day
  const ATTEMPT_WINDOW_MS = 10 * 60 * 1000; // anti-loop guard: ...
  const MAX_ATTEMPTS = 8; // ... submissions per origin per window
  const MAX_ANSWER_LENGTH = 24; // longest tail accepted from a reasoning trace

  const DEFAULT_PROMPT =
    'Read the characters shown in this captcha image. They may be slanted, overlapping or crossed by ' +
    'background lines. Reply with only those characters, in order, without spaces or explanation.';

  // Single source of truth for the status widget (popup + on-page pill).
  const STATES = {
    idle: { icon: 'dot', tone: 'muted', label: 'Idle' },
    capturing: { icon: 'camera', tone: 'busy', label: 'Capturing the image' },
    requesting: { icon: 'send', tone: 'busy', label: 'Asking the model' },
    answering: { icon: 'type', tone: 'busy', label: 'Filling in the answer' },
    submitting: { icon: 'click', tone: 'busy', label: 'Submitting' },
    done: { icon: 'check', tone: 'ok', label: 'Solved' },
    error: { icon: 'cross', tone: 'bad', label: 'Failed' }
  };

  const PATHS = {
    dot: '<circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none"/>',
    camera:
      '<rect x="2" y="5" width="12" height="8" rx="1.5"/><path d="M6 5l1-1.5h2L10 5"/><circle cx="8" cy="9" r="2"/>',
    send: '<path d="M14 2L2 7.2l4.8 1.9L8.6 14z"/><path d="M6.8 9.1L14 2"/>',
    type: '<path d="M3 4.5h10M3 8h6.5M3 11.5h4"/><path d="M12.5 7.5v6"/>',
    click: '<path d="M4.5 2.5l7.5 5.5-3.4.5 1.9 3.5-1.7.9-1.9-3.5-2.4 1.9z"/>',
    check: '<path d="M3 8.5l3.3 3.3L13 5"/>',
    cross: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>'
  };
  const SPIN =
    '<animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/>';

  const icon = state => {
    const meta = STATES[state] || STATES.idle;
    return (
      '<svg viewBox="0 0 16 16" width="100%" height="100%" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      PATHS[meta.icon] +
      (meta.tone === 'busy' ? SPIN : '') +
      '</svg>'
    );
  };

  // OpenRouter's own order is preserved; only vision-in / text-out models survive.
  const modalities = model => {
    const arch = model.architecture || {};
    const [inputs = '', outputs = ''] = String(arch.modality || '').split('->');
    return {
      input: arch.input_modalities || inputs.split('+').filter(Boolean),
      output: arch.output_modalities || outputs.split('+').filter(Boolean)
    };
  };

  const filterModels = list =>
    (list || [])
      .filter(model => {
        const { input, output } = modalities(model);
        return input.includes('image') && output.includes('text');
      })
      .map(model => ({
        id: model.id,
        name: model.name || model.id,
        prompt: Number(model.pricing && model.pricing.prompt) || 0,
        completion: Number(model.pricing && model.pricing.completion) || 0,
        // The model's own output limit, straight from the models API.
        maxTokens: Number(model.top_provider && model.top_provider.max_completion_tokens) || 0,
        params: model.supported_parameters || []
      }));

  // Providers put the text in different places: a string, an array of parts, or -
  // for reasoning models that ran out of budget - only in `reasoning`. Any of them
  // may carry the answer, so read all of them and report where it came from.
  const partsText = value =>
    (Array.isArray(value) ? value : [value])
      .map(part => (typeof part === 'string' ? part : part?.text || ''))
      .join('');

  const extractAnswer = message => {
    const content = partsText(message?.content).trim();
    if (content) return { text: content, from: 'content' };
    const reasoning = partsText(message?.reasoning || message?.reasoning_content || message?.reasoning_details).trim();
    return { text: reasoning, from: reasoning ? 'reasoning' : '' };
  };

  // Models like to wrap the answer in prose, markdown or a "reasoning" paragraph.
  const cleanAnswer = raw => {
    let text = String(raw || '').replace(/```[a-z]*/gi, '').trim();
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length > 1) text = lines[lines.length - 1];
    text = text
      // Drop a lead-in such as "The captcha is: " / "The digits are " - but only when
      // something follows, so a captcha that literally reads "code" survives.
      .replace(
        /^\s*(?:the\s+)?(?:captcha|code|answer|characters?|digits?|numbers?|text|result)\b\s*(?:is|are|:)?[\s:]*(?=\S)/i,
        ''
      )
      .replace(/^["'`\s]+|["'`\s.]+$/g, '')
      .trim();
    // "2 5 6 1 8" is a spacing artefact, "red car" is not: only glue single characters.
    const characters = text.split(/[\s,.]+/);
    return characters.length >= 3 && characters.every(part => part.length === 1) ? characters.join('') : text;
  };

  // OpenRouter reports the exact credit cost when asked (`usage: {include:true}`);
  // otherwise fall back to the pricing from the model list.
  const costFromUsage = (usage, model) => {
    if (usage && usage.cost !== undefined && usage.cost !== null) {
      const reported = Number(usage.cost);
      if (Number.isFinite(reported)) return reported;
    }
    if (!usage || !model) return 0;
    return (
      (usage.prompt_tokens || 0) * model.prompt + (usage.completion_tokens || 0) * model.completion
    );
  };

  const formatUsd = value => {
    const amount = Number(value) || 0;
    return amount ? `$${amount.toFixed(4)}` : '$0';
  };

  // btoa() needs a binary string; images can be bigger than the argument limit.
  const b64 = bytes => {
    const view = new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < view.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };

  globalThis.CS = {
    DEFAULT_MODEL,
    DEFAULT_PROMPT,
    API_BASE,
    MODELS_TTL_MS,
    ATTEMPT_WINDOW_MS,
    MAX_ATTEMPTS,
    MAX_ANSWER_LENGTH,
    STATES,
    icon,
    filterModels,
    extractAnswer,
    cleanAnswer,
    costFromUsage,
    formatUsd,
    b64
  };
})();
