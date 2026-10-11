// A chat page over a Claude Code session in its structured mode
// (`claude -p --input-format stream-json --output-format stream-json`).
// The host relays the CLI's events with window.chat.events() and the
// session's past with window.chat.history(); the page sends what the user
// does through ChatBridge.post() (bridge.js). See PROTOCOL.md.
(function () {
  'use strict';

  const DEFAULT_STRINGS = {
    placeholder: 'Message Claude…', send: 'Send', stop: 'Stop', copy: 'Copy', copied: 'Copied',
    working: 'Working', empty: 'Ask anything. This session keeps its history.',
    permission: '{tool} wants permission', allow: 'Allow', always: 'Always allow', deny: 'Deny',
    allowed: 'Allowed', allowedAlways: 'Allowed from now on', denied: 'Denied',
    stopped: 'Stopped.', exited: 'The session ended. Sending a message starts it again.',
  };
  const T = Object.assign({}, DEFAULT_STRINGS, window.CHAT_STRINGS || {});
  const OPTIONS = Object.assign({ hostClipboard: false }, window.CHAT_OPTIONS || {});

  const post = message => window.ChatBridge.post(message);
  const $ = selector => document.querySelector(selector);
  const list = $('#list'), input = $('#input'), sendButton = $('#send'), stopButton = $('#stop'), status = $('#status');
  input.placeholder = T.placeholder;
  sendButton.title = T.send; sendButton.setAttribute('aria-label', T.send);
  stopButton.title = T.stop; stopButton.setAttribute('aria-label', T.stop);

  marked.setOptions({ gfm: true, breaks: true });
  // The text can carry what third parties wrote: sanitized before it shows.
  const md = text => DOMPurify.sanitize(marked.parse(text || ''));
  const fromBase64 = b64 => {
    const s = atob(b64); const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };
  // A host may hand an array, a JSON string or base64 of a JSON string.
  const decode = payload => {
    if (Array.isArray(payload)) return payload;
    if (typeof payload !== 'string') return [payload];
    const text = /^\s*[\[{]/.test(payload) ? payload : fromBase64(payload);
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  };

  let busy = false, streaming = null, streamText = '', pending = false, model = '', cost = 0;
  const tools = {};

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  function add(el) { const stick = nearBottom(); list.appendChild(el); if (stick) list.scrollTop = list.scrollHeight; }
  function div(cls, text) { const d = document.createElement('div'); d.className = cls; if (text !== undefined) d.textContent = text; return d; }
  function copyText(text) {
    if (!OPTIONS.hostClipboard && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => post({ t: 'copy', d: text }));
    else post({ t: 'copy', d: text });
  }
  function flash(button) { const before = button.textContent; button.textContent = T.copied; setTimeout(() => { button.textContent = before; }, 1200); }
  function copyButton(cls, text) {
    const b = document.createElement('button'); b.className = cls; b.textContent = T.copy;
    b.onclick = e => { e.stopPropagation(); copyText(text()); flash(b); };
    return b;
  }
  function decorate(el) {
    el.querySelectorAll('pre').forEach(pre => {
      if (!pre.querySelector('.copy')) { const code = pre.querySelector('code'); pre.appendChild(copyButton('copy', () => (code || pre).innerText)); }
    });
  }
  function clearEmpty() { const e = list.querySelector('.empty'); if (e) e.remove(); }
  function updateStatus() { status.textContent = [model, cost ? 'US$ ' + cost.toFixed(2) : ''].filter(Boolean).join(' · '); }
  function working() { const w = div('working'); w.setAttribute('aria-label', T.working); w.append(document.createElement('i'), document.createElement('i'), document.createElement('i')); return w; }
  // While the session works, Stop stands where Send was.
  function setBusy(on) {
    busy = on; stopButton.style.display = on ? '' : 'none'; sendButton.style.display = on ? 'none' : '';
    const w = list.querySelector('.working'); if (w) w.remove();
    if (on) add(working());
  }
  function moveWorkingDown() { const w = list.querySelector('.working'); if (w) { w.remove(); add(w); } }

  function userBubble(text) { clearEmpty(); const d = div('msg user'); const span = document.createElement('span'); span.textContent = text; d.appendChild(span); add(d); }
  function assistantBlock(text, el) {
    clearEmpty();
    const d = el || div('msg assistant');
    d.classList.remove('streaming'); d.innerHTML = md(text); decorate(d);
    d.appendChild(copyButton('copy-msg', () => text));
    if (!el) add(d);
    moveWorkingDown();
  }
  function summary(toolInput) {
    if (!toolInput) return '';
    const v = toolInput.command || toolInput.file_path || toolInput.path || toolInput.pattern || toolInput.url
      || toolInput.query || toolInput.skill || toolInput.description || toolInput.prompt || JSON.stringify(toolInput);
    return String(v).split('\n')[0].slice(0, 160);
  }
  function toolName(name) { return String(name || '').replace(/^mcp__claude_ai_/, '').replace(/^mcp__/, '').replace(/__/g, ' · '); }
  function toolRow(id, name, toolInput) {
    clearEmpty();
    const d = document.createElement('details'); d.className = 'tool';
    const s = document.createElement('summary');
    const dot = document.createElement('span'); dot.className = 'dot';
    const n = document.createElement('span'); n.className = 'name'; n.textContent = toolName(name);
    const a = document.createElement('span'); a.className = 'arg'; a.textContent = summary(toolInput);
    s.append(dot, n, a); d.appendChild(s);
    const body = document.createElement('pre'); body.className = 'result'; d.appendChild(body);
    tools[id] = d; add(d); moveWorkingDown();
  }
  function toolResult(id, content, isError) {
    const d = tools[id]; if (!d) return;
    const text = typeof content === 'string' ? content
      : (content || []).map(c => (c.type === 'text' ? c.text : '[' + c.type + ']')).join('\n');
    d.querySelector('.result').textContent = text.slice(0, 20000);
    d.classList.add('done'); if (isError) d.classList.add('error');
  }
  function note(text, error) { clearEmpty(); add(div(error ? 'note error' : 'note', text)); moveWorkingDown(); }
  function permission(ev) {
    clearEmpty();
    const r = ev.request, card = div('card');
    card.appendChild(div('title', T.permission.replace('{tool}', toolName(r.display_name || r.tool_name))));
    card.appendChild(div('what', r.description ? r.description + '\n' + summary(r.input) : summary(r.input)));
    const row = div('row');
    const answer = (allow, always) => {
      post({ t: 'perm', id: ev.request_id, allow, always });
      row.remove(); card.appendChild(div('done', allow ? (always ? T.allowedAlways : T.allowed) : T.denied));
    };
    const pill = (label, primary, fn) => { const b = document.createElement('button'); b.className = primary ? 'pill primary' : 'pill'; b.textContent = label; b.onclick = fn; row.appendChild(b); };
    pill(T.allow, true, () => answer(true, false));
    if ((r.permission_suggestions || []).length) pill(T.always, false, () => answer(true, true));
    pill(T.deny, false, () => answer(false, false));
    card.appendChild(row); add(card); moveWorkingDown();
  }

  function handle(ev) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') { model = ev.model || model; updateStatus(); }
        break;
      case 'stream_event': {
        const e = ev.event || {};
        if (e.type === 'message_start') { streaming = null; streamText = ''; }
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          streamText += e.delta.text;
          if (!streaming) { clearEmpty(); streaming = div('msg assistant streaming'); add(streaming); moveWorkingDown(); }
          if (!pending) {
            pending = true;
            requestAnimationFrame(() => {
              pending = false;
              if (streaming) { const stick = nearBottom(); streaming.innerHTML = md(streamText); if (stick) list.scrollTop = list.scrollHeight; }
            });
          }
        }
        break;
      }
      case 'assistant':
        for (const block of (ev.message && ev.message.content) || []) {
          if (block.type === 'text' && block.text) { assistantBlock(block.text, streaming); streaming = null; streamText = ''; }
          else if (block.type === 'tool_use') toolRow(block.id, block.name, block.input);
        }
        break;
      case 'user':
        for (const block of (ev.message && Array.isArray(ev.message.content) ? ev.message.content : [])) {
          if (block.type === 'tool_result') toolResult(block.tool_use_id, block.content, block.is_error);
        }
        break;
      case 'control_request':
        if (ev.request && ev.request.subtype === 'can_use_tool') permission(ev);
        break;
      case 'result':
        if (typeof ev.total_cost_usd === 'number') { cost = ev.total_cost_usd; updateStatus(); }
        if (streaming && streamText) { assistantBlock(streamText, streaming); streaming = null; streamText = ''; }
        setBusy(false);
        if (ev.is_error && ev.subtype === 'error_during_execution') note(T.stopped);
        else if (ev.is_error && ev.result) note(String(ev.result), true);
        break;
      case 'exited':
        setBusy(false); note(T.exited);
        break;
      case 'error':
        setBusy(false); note(ev.text, true);
        break;
    }
  }

  function history(record) {
    const content = record.message && record.message.content;
    if (record.type === 'user') {
      if (typeof content === 'string') { if (content.trim()) userBubble(content); return; }
      for (const block of content || []) {
        if (block.type === 'text' && block.text.trim()) userBubble(block.text);
        else if (block.type === 'tool_result') toolResult(block.tool_use_id, block.content, block.is_error);
      }
    } else if (record.type === 'assistant') {
      for (const block of content || []) {
        if (block.type === 'text' && block.text) assistantBlock(block.text);
        else if (block.type === 'tool_use') toolRow(block.id, block.name, block.input);
      }
    }
  }

  function grow() {
    input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 240) + 'px';
    sendButton.disabled = !input.value.trim();
  }
  function submit() {
    const text = input.value.trim(); if (!text) return;
    userBubble(text); post({ t: 'send', text }); input.value = ''; grow();
    list.scrollTop = list.scrollHeight; if (!busy) setBusy(true);
  }

  window.chat = {
    events: payload => decode(payload).forEach(handle),
    history: payload => { decode(payload).forEach(history); list.scrollTop = list.scrollHeight; },
    insert: text => { const s = input.selectionStart, e = input.selectionEnd; input.setRangeText(text, s, e, 'end'); grow(); },
    focus: () => input.focus(),
  };

  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape' && busy) post({ t: 'stop' });
    // Some embedded web views have no clipboard of their own: the host's.
    if (OPTIONS.hostClipboard && (e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase(), s = input.selectionStart, end = input.selectionEnd;
      if (k === 'v') { e.preventDefault(); post({ t: 'paste' }); }
      else if (k === 'c' && end > s) { e.preventDefault(); post({ t: 'copy', d: input.value.slice(s, end) }); }
      else if (k === 'x' && end > s) { e.preventDefault(); post({ t: 'copy', d: input.value.slice(s, end) }); input.setRangeText('', s, end, 'end'); grow(); }
    }
  });
  document.addEventListener('keydown', e => {
    if (e.target !== input && e.key === 'Escape' && busy) post({ t: 'stop' });
  });
  document.addEventListener('click', e => {
    const a = e.target.closest('a'); if (a && a.href) { e.preventDefault(); post({ t: 'link', d: a.href }); }
  });
  sendButton.onclick = submit;
  stopButton.onclick = () => post({ t: 'stop' });
  stopButton.style.display = 'none';
  list.appendChild(div('empty', T.empty));
  grow();
  post({ t: 'ready' });
})();
