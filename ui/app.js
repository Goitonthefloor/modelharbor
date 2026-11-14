'use strict';
/* ModelHarbor — Renderer-Logik (kein Framework, klassisches Script) */

const bridge = window.api;

const state = {
  info: null,
  settings: null,
  hw: null,
  presets: [],
  backends: null,
  catalog: [],
  local: [],
  searchResults: [],
  filePanel: null,
  server: { running: false, starting: false, port: null, model: null, preset: null, lastModel: null, unloading: false },
  chat: { messages: [], streaming: false, abort: null, pending: null },
  downloads: new Map(),
  backendInstalls: new Map(),
  activeTab: 'catalog',
  view: 'chat',
  booted: false,
};

/* --------------------------- Helfer --------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtGB(bytes) {
  if (!bytes) return '–';
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

let toastSeq = 0; // eindeutige IDs für Popover-Toasts

function toast(message, kind = 'info', ms = 4200) {
  const wrap = $('#toast-wrap');
  const id = `toast-${++toastSeq}`;
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : ''}`;
  el.id = id;
  el.setAttribute('popover', 'manual');
  el.innerHTML = `
    <span class="toast-msg">${esc(message)}</span>
    <button type="button" class="toast-close" popovertarget="${id}" popovertargetaction="hide" aria-label="Schließen">×</button>`;
  wrap.appendChild(el);
  if (typeof el.showPopover === 'function') el.showPopover();

  const closeBtn = el.querySelector('.toast-close');
  const dismiss = () => {
    if (el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => {
      if (typeof el.hidePopover === 'function') { try { el.hidePopover(); } catch { /* bereits zu */ } }
      el.remove();
      stackToasts();
    }, 220);
  };
  closeBtn.addEventListener('click', dismiss);
  // Dismissal pausieren, solange der Fokus in der Meldung liegt
  let timer = setTimeout(dismiss, ms);
  const restart = () => { clearTimeout(timer); timer = setTimeout(dismiss, ms); };
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', restart);
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', restart);
  stackToasts();
  announce(message);
}

// Toasts im Top-Layer stapeln (ignorieren parent-z-index → Abstände selbst setzen)
function stackToasts() {
  const toasts = $$('.toast', $('#toast-wrap')).filter((t) => !t.classList.contains('is-leaving'));
  let bottom = 0;
  for (const t of toasts) {
    bottom += t.offsetHeight + 10;
    t.style.bottom = `${bottom}px`;
  }
}

// Screenreader: ariaNotify() wenn verfügbar, sonst Live-Region
function announce(message) {
  if (typeof Element.prototype.ariaNotify === 'function') {
    document.body.ariaNotify(String(message));
  } else {
    const live = $('#sr-live');
    if (live) live.textContent = String(message);
  }
}

// Entfernt alle aktiven Toasts (z. B. veraltete Lade-Meldungen beim Entladen)
function clearToasts() {
  for (const t of $$('.toast', $('#toast-wrap'))) {
    if (t.classList.contains('is-leaving')) continue;
    t.classList.add('is-leaving');
    setTimeout(() => {
      if (typeof t.hidePopover === 'function') { try { t.hidePopover(); } catch { /* bereits zu */ } }
      t.remove();
      stackToasts();
    }, 200);
  }
}

function confirmDialog({ title, message, okLabel = 'Bestätigen', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#confirm-dialog');
    if (!dlg) { resolve(confirm(message)); return; }
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const ok = $('#confirm-ok');
    ok.textContent = okLabel;
    ok.classList.toggle('btn-danger', danger);
    ok.classList.toggle('btn-primary', !danger);
    dlg.returnValue = '';
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      const val = dlg.returnValue;
      dlg.returnValue = '';
      resolve(val === 'ok');
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    // Bei destruktiven Aktionen liegt der Fokus auf der sicheren Aktion
    if (danger) $('#confirm-cancel').focus();
    else ok.focus();
  });
}

/* --------------------------- Update --------------------------- */

const stateUpdate = {
  info: null,
  downloading: false,
  progress: null,
  assetPath: null,
};

function showUpdateDialog(info) {
  if (!info || !info.latest) return;
  stateUpdate.info = info;
  stateUpdate.downloading = false;
  stateUpdate.progress = null;
  stateUpdate.assetPath = null;
  const dlg = $('#update-dialog');
  const ver = info.latest.tag.replace(/^v/i, '');
  $('#update-sub').textContent = `Version ${ver} ist verfügbar — du hast ${info.currentVersion || 'diese Version'}.`;
  const notes = (info.latest.body || '').trim();
  $('#update-notes').textContent = notes || 'Release-Notes findest du auf der Releases-Seite.';
  $('#update-notes').style.display = notes ? '' : 'none';
  $('#update-progress').classList.add('is-hidden');
  $('#update-progress-fill').style.width = '0%';
  $('#update-progress-text').textContent = 'Wird heruntergeladen …';
  $('#update-progress-pct').textContent = '0 %';
  const noAsset = !info.asset;
  $('#update-now').classList.toggle('is-hidden', noAsset);
  $('#update-open').classList.add('is-hidden');
  $('#update-later').classList.toggle('is-hidden', false);
  $('#update-later').disabled = false;
  $('#update-later').textContent = noAsset ? 'Schließen' : 'Später';
  $('#update-releases').classList.toggle('is-hidden', false);
  dlg.returnValue = '';
  dlg.showModal();
}

async function startUpdateDownload() {
  const info = stateUpdate.info;
  if (!info || !info.asset || stateUpdate.downloading) return;
  stateUpdate.downloading = true;
  const now = $('#update-now');
  const later = $('#update-later');
  now.disabled = true;
  now.textContent = 'Lädt …';
  later.disabled = true;
  $('#update-progress').classList.remove('is-hidden');
  try {
    const res = await bridge.update.download(info.asset.url, info.asset.name);
    stateUpdate.assetPath = res.assetPath;
    stateUpdate.downloading = false;
    $('#update-progress-fill').style.width = '100%';
    $('#update-progress-text').textContent = `Fertig: ${info.asset.name}`;
    $('#update-progress-pct').textContent = fmtGB(res.size);
    now.classList.add('is-hidden');
    const open = $('#update-open');
    open.classList.remove('is-hidden');
    open.disabled = false;
    later.disabled = false;
    later.textContent = 'Schließen';
  } catch (e) {
    stateUpdate.downloading = false;
    now.disabled = false;
    now.textContent = 'Erneut versuchen';
    later.disabled = false;
    $('#update-progress').classList.add('is-hidden');
    toast(`Download fehlgeschlagen: ${e.message}`, 'error', 9000);
  }
}

function fitBadge(fit) {
  if (!fit) return '';
  const cls = fit.verdict === 'gpu' ? 'badge-gpu' : fit.verdict === 'hybrid' ? 'badge-hybrid' : fit.verdict === 'ram' ? 'badge-ram' : 'badge-big';
  return `<span class="badge ${cls}" title="${esc(fit.detail)}">${esc(fit.label)}</span>`;
}

/* --------------------------- Markdown --------------------------- */

function renderMarkdown(src) {
  if (!src) return '';
  const blocks = [];
  let text = String(src);
  // Fenced code blocks zuerst extrahieren
  text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre><code class="lang-${esc(lang || 'text')}">${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000CODE${idx}\u0000`;
  });

  const lines = text.split('\n');
  const out = [];
  let inList = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (inList) { out.push(`</${inList}>`); inList = null; }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => `@@CODE${i}@@`);
    const codeMatch = rawLine.match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) {
      flushPara(); closeList();
      out.push(blocks[Number(codeMatch[1])] || '');
      continue;
    }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flushPara(); closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara(); closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    para.push(line);
  }
  flushPara(); closeList();
  let html = out.join('\n');
  html = html.replace(/@@CODE(\d+)@@/g, (_m, i) => blocks[Number(i)] || '');
  return html;
}

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext="$2">$1</a>');
  return t;
}

/* --------------------------- Navigation --------------------------- */

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${view}`));
  if (view === 'models') refreshModelsView();
  if (view === 'setup') renderSetup();
}

function refreshModelsView() {
  if (state.activeTab === 'local') refreshLocal();
  else if (state.activeTab === 'search') renderSearchResults();
  else refreshCatalog();
}

/* --------------------------- Sidebar --------------------------- */

function renderSidebar() {
  const hw = state.hw;
  const b = state.backends;
  const installed = b && b.installed && b.installed.length ? b.installed : [];
  const el = $('#side-status');
  if (!hw) { el.innerHTML = '<div class="side-hint">Hardware wird erkannt …</div>'; return; }
  const gpu = (hw.gpus || []).filter((g) => g.vramGB).sort((a, b2) => b2.vramGB - a.vramGB)[0];
  const be = installed[0];
  el.innerHTML = `
    <div class="side-block">
      <div class="side-label">Hardware</div>
      <div class="side-value">${esc(gpu ? `${gpu.vendor} · ${gpu.vramGB} GB` : 'CPU only')}</div>
      <div class="side-value side-cpu">${esc(hw.cpuModel.replace(/\(R\)|\(TM\)/g, '').replace(/\s+/g, ' '))}</div>
    </div>
    <div class="side-block">
      <div class="side-label">Backend</div>
      <div class="side-value"><span class="${be ? 'dot-ok' : 'dot-warn'}"></span>${be ? esc(be.label) : 'nicht eingerichtet'}</div>
    </div>
    <div class="side-block">
      <div class="side-label">Modell</div>
      <div class="side-value"><span class="${state.server.running ? 'dot-ok' : state.server.starting ? 'dot-warn' : 'dot-off'}"></span>${state.server.running ? esc(basename(state.server.model || '')) : state.server.starting ? 'lädt …' : 'keins geladen'}</div>
    </div>`;
}

/* --------------------------- Chat --------------------------- */

function currentPreset() {
  return state.presets.find((p) => p.id === (state.server.preset || state.settings?.lastPreset)) || state.presets[0] || null;
}

function renderPresetSelect() {
  const sel = $('#preset-select');
  if (!sel) return;
  const cur = state.server.preset || state.settings?.lastPreset || 'balanced';
  sel.innerHTML = state.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.icon)} ${esc(p.name)}</option>`).join('');
  sel.value = cur;
  sel.title = (state.presets.find((p) => p.id === cur) || {}).description || '';
}

function renderChatState() {
  const chip = $('#chat-model-chip');
  const name = $('#chat-model-name');
  const input = $('#input');
  const send = $('#btn-send');
  const empty = $('#chat-empty');
  const hint = $('#composer-hint');

  chip.classList.toggle('is-live', !!state.server.running);
  chip.classList.toggle('is-loading', !!state.server.starting);
  if (state.server.running) {
    name.textContent = monogram(state.server.model);
  } else if (state.server.starting) {
    name.textContent = 'Modell wird geladen …';
  } else {
    name.textContent = 'Kein Modell geladen';
  }

  const canChat = !!state.server.running && !state.chat.streaming;
  input.disabled = !canChat;
  const ICON_SEND = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4 20-7Z"></path></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
  if (state.chat.streaming) {
    send.disabled = false;
    send.classList.add('is-stop');
    send.innerHTML = ICON_STOP;
    send.title = 'Antwort stoppen (Esc)';
  } else {
    send.disabled = !canChat;
    send.classList.remove('is-stop');
    send.innerHTML = ICON_SEND;
    send.title = 'Senden (Enter)';
  }
  hint.textContent = state.server.running ? 'Enter = senden · Shift+Enter = neue Zeile' : 'Modell laden, um zu chatten';
  if (empty) empty.style.display = state.chat.messages.length ? 'none' : '';
  if (state.server.running && empty) empty.style.display = 'none';

  renderUnloadBtn();
  renderSidebar();
}

const ICON_EJECT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 14h14L12 5l-7 9Z"></path><path d="M5 19h14"></path></svg>';
const ICON_RELOAD = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path></svg>';

// Topbar-Button: läuft ein Modell → rotes „Entladen“; sonst mit letztem Modell → grünes „Letztes Modell laden“
function renderUnloadBtn() {
  const btn = $('#btn-unload');
  if (!btn) return;
  const busy = state.server.starting || state.server.unloading;
  if (state.server.running) {
    btn.className = 'btn btn-danger-ghost';
    btn.disabled = busy;
    btn.title = 'Modell aus dem Speicher entladen';
    btn.innerHTML = state.server.unloading ? 'Entlade …' : `${ICON_EJECT} Entladen`;
  } else if (state.server.lastModel) {
    btn.className = 'btn btn-ok';
    btn.disabled = busy;
    btn.title = 'Zuletzt geladenes Modell wieder laden';
    btn.innerHTML = `${ICON_RELOAD} Letztes Modell laden`;
  } else {
    btn.className = 'btn btn-danger-ghost';
    btn.disabled = true;
    btn.title = 'Kein Modell geladen';
    btn.innerHTML = `${ICON_EJECT} Entladen`;
  }
}

function monogram(p) {
  if (!p) return '—';
  const b = basename(p).replace(/\.gguf$/i, '');
  return b.length > 42 ? b.slice(0, 39) + '…' : b;
}

function reasoningBlock(text) {
  const chars = text.length;
  return `<details class="reasoning"><summary>Gedankengang · ${chars.toLocaleString('de-DE')} Zeichen</summary><pre>${esc(text)}</pre></details>`;
}

function addMessage(role, content, { streaming = false } = {}) {
  const wrap = $('#messages');
  const empty = $('#chat-empty');
  if (empty) empty.style.display = 'none';
  const el = document.createElement('div');
  el.className = `msg msg-${role}`;
  el.innerHTML = `
    <div class="msg-role">${role === 'user'
      ? '<span class="who-user">Du</span>'
      : `<span class="who-ai">${esc(state.server.model ? basename(state.server.model).replace(/\.gguf$/i, '') : 'Assistent')}</span>`}</div>
    <div class="msg-body"></div>
    <div class="msg-actions"></div>`;
  wrap.appendChild(el);
  const body = el.querySelector('.msg-body');
  if (role === 'user') {
    body.innerHTML = `<p>${esc(content).replace(/\n/g, '<br>')}</p>`;
  } else if (streaming) {
    body.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  } else {
    body.innerHTML = renderMarkdown(content);
  }
  scrollChat();
  return { el, body };
}

function scrollChat(force = false) {
  const sc = $('#chat-scroll');
  if (!sc) return;
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
  if (force || nearBottom) sc.scrollTop = sc.scrollHeight;
}

function buildRequestMessages() {
  const preset = currentPreset();
  const msgs = [];
  const sys = (preset && preset.systemPrompt) || '';
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of state.chat.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !state.server.running || state.chat.streaming) return;

  state.chat.messages.push({ role: 'user', content: text });
  addMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  await runCompletion();
}

async function runCompletion() {
  const port = state.server.port;
  if (!port) return;
  const preset = currentPreset();
  const s = (preset && preset.sampling) || {};
  const { el, body } = addMessage('assistant', '', { streaming: true });
  body.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';

  state.chat.streaming = true;
  state.chat.abort = new AbortController();
  renderChatState();

  let full = '';
  let reasoning = '';
  let usage = null;
  let lastRender = 0;
  let tFirstToken = 0; // performance.now() beim ersten Delta
  let tLastToken = 0;  // performance.now() beim letzten Delta
  const paint = (force) => {
    const now = Date.now();
    if (!force && now - lastRender < 55) return;
    lastRender = now;
    body.innerHTML = renderMarkdown(full) + '<span class="cursor-blink"></span>';
    scrollChat();
  };

  try {
    const payload = {
      messages: buildRequestMessages(),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (s.temp !== undefined) payload.temperature = s.temp;
    if (s.topK !== undefined) payload.top_k = s.topK;
    if (s.topP !== undefined) payload.top_p = s.topP;
    if (s.minP !== undefined) payload.min_p = s.minP;
    if (s.repeatPenalty !== undefined) payload.repeat_penalty = s.repeatPenalty;
    if (s.presencePenalty !== undefined) payload.presence_penalty = s.presencePenalty;
    if (s.frequencyPenalty !== undefined) payload.frequency_penalty = s.frequencyPenalty;
    if (s.seed !== undefined) payload.seed = s.seed;

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: state.chat.abort.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Server-Fehler ${res.status}: ${t.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.usage) usage = json.usage;
        const ch = json.choices && json.choices[0];
        const d = ch && ch.delta ? ch.delta : {};
        // Denk-Modelle (Qwen3, R1-Distill) liefern zusätzlich reasoning_content
        if (d.reasoning_content || d.content) {
          const now = performance.now();
          if (!tFirstToken) tFirstToken = now;
          tLastToken = now;
        }
        if (d.reasoning_content) { reasoning += d.reasoning_content; paint(false); }
        if (d.content) { full += d.content; paint(false); }
      }
    }
    paint(true);
    state.chat.messages.push({ role: 'assistant', content: full, reasoning: reasoning || null });
    body.innerHTML = (reasoning ? reasoningBlock(reasoning) : '') + renderMarkdown(full);
    if (usage) {
      const n = usage.completion_tokens || 0;
      const genMs = tFirstToken && tLastToken > tFirstToken ? tLastToken - tFirstToken : 0;
      const tps = tokensPerSecond(n, genMs);
      const tpsText = tps ? ` · ${tps.toFixed(1)} tok/s` : '';
      $('#token-info').textContent =
        `${usage.prompt_tokens || 0} Prompt-Token · ${n} Antwort-Token${tpsText}`;
    }
    addMsgActions(el, full);
  } catch (e) {
    if (e.name === 'AbortError') {
      body.innerHTML = renderMarkdown(full) + '<p class="muted">— gestoppt —</p>';
      if (full) state.chat.messages.push({ role: 'assistant', content: full });
    } else {
      el.classList.add('msg-error');
      body.textContent = `Fehler: ${e.message}`;
      toast(e.message, 'error');
    }
  } finally {
    state.chat.streaming = false;
    state.chat.abort = null;
    renderChatState();
    scrollChat(true);
  }
}

function addMsgActions(msgEl, text) {
  const actions = msgEl.querySelector('.msg-actions');
  if (!actions || !text) return;
  actions.innerHTML = '<button class="msg-action" data-copy>Kopieren</button>';
  actions.querySelector('[data-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); toast('In die Zwischenablage kopiert', 'ok', 1800); }
    catch { toast('Kopieren fehlgeschlagen', 'error'); }
  });
}

function stopGeneration() {
  if (state.chat.abort) state.chat.abort.abort();
}

/* --------------------------- Server --------------------------- */

async function loadModel(model, { presetOverride } = {}) {
  if (!model || !model.path) { toast('Modellpfad fehlt', 'error'); return; }
  if (state.server.running || state.server.starting) {
    const ok = await confirmDialog({
      title: 'Modell wechseln',
      message: 'Es ist bereits ein Modell geladen. Entladen und das neue laden?',
      okLabel: 'Entladen & laden',
    });
    if (!ok) return;
    await unloadModel(true);
  }
  const preset = presetOverride || state.server.preset || state.settings?.lastPreset || 'balanced';
  state.server.starting = true;
  renderChatState();
  clearToasts();
  toast(`Lade ${basename(model.path)} …`, 'info', 8000);
  try {
    const res = await bridge.server.start({
      modelPath: model.path,
      modelId: model.id,
      preset,
      ctx: state.settings.ctx,
      gpuLayers: model.fit ? model.fit.gpuLayers : state.settings.gpuLayers,
    });
    state.server = {
      running: true, starting: false, port: res.port, model: model.path, preset: res.preset,
      unloading: false,
      lastModel: { path: model.path, id: model.id || null, fit: model.fit || null },
    };
    if (res.fit) state.server.fit = res.fit;
    renderChatState();
    renderPresetSelect();
    toast(`Bereit: ${basename(model.path)}`, 'ok');
    setView('chat');
    setTimeout(() => $('#input').focus(), 120);
  } catch (e) {
    state.server.starting = false;
    renderChatState();
    toast(e.message || 'Modell konnte nicht geladen werden', 'error', 9000);
  }
}

async function unloadModel(silent = false) {
  const last = state.server.lastModel;
  if (!silent) {
    // Sofortiges Feedback beim Klick
    state.server.unloading = true;
    renderChatState();
    clearToasts();
    toast('Modell wird entladen …', 'info', 1500);
  }
  try {
    await bridge.server.stop();
    state.server = {
      running: false, starting: false, port: null, model: null,
      preset: state.server.preset, lastModel: last, unloading: false,
    };
    renderChatState();
    if (!silent) {
      clearToasts();
      toast('Modell entladen — bereit zum Neuladen', 'ok');
    }
  } catch (e) {
    state.server.unloading = false;
    renderChatState();
    clearToasts();
    toast(`Entladen fehlgeschlagen: ${e.message}`, 'error');
  }
}

/* --------------------------- Modelle: Katalog --------------------------- */

function modelCard(entry) {
  const fit = entry.fit || {};
  const isLocal = state.local.some((l) => l.repo === entry.repo);
  const dl = entry.downloadId ? state.downloads.get(entry.downloadId) : null;
  const quant = entry.file ? (entry.file.quant || '') : '';
  return `
    <article class="card" data-repo="${esc(entry.repo)}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(entry.name)}</div>
          <div class="card-meta">${esc(entry.params)} · ${esc(entry.family)}${quant ? ' · ' + esc(quant) : ''}</div>
        </div>
        ${fit.verdict ? fitBadge(fit) : '<span class="badge badge-neutral">unbekannt</span>'}
      </div>
      <div class="card-desc">${esc(entry.blurb)}</div>
      <div class="fit-note">${esc(fit.detail || '')}</div>
      <div class="card-foot">
        <span class="card-size">${entry.sizeLabel ? esc(entry.sizeLabel) : '–'}</span>
        ${isLocal
          ? `<button class="btn btn-primary btn-sm" data-act="load-catalog" data-repo="${esc(entry.repo)}">Chat öffnen</button>`
          : `<button class="btn btn-primary btn-sm" data-act="download-catalog" data-repo="${esc(entry.repo)}" ${dl ? 'disabled' : ''}>Herunterladen</button>`}
      </div>
      ${dl ? `<div class="progress"><div class="progress-fill" style="width:${dl.percent || 0}%"></div></div>
              <div class="progress-label"><span>${esc(dl.file || '')}</span><span>${dl.percent ? dl.percent.toFixed(0) + '%' : ''} ${dl.doneBytes ? fmtGB(dl.doneBytes) + ' / ' + fmtGB(dl.totalBytes) : ''}</span></div>` : ''}
    </article>`;
}

function ensureProgressEl(container) {
  let wrap = container.querySelector('.progress');
  if (!wrap) {
    container.insertAdjacentHTML('beforeend',
      '<div class="progress"><div class="progress-fill"></div></div><div class="progress-label"><span></span><span></span></div>');
    wrap = container.querySelector('.progress');
  }
  return { wrap, label: container.querySelector('.progress-label') };
}

function applyProgress(container, p) {
  const { wrap, label } = ensureProgressEl(container);
  const fill = wrap.querySelector('.progress-fill');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  if (label) {
    const left = label.querySelector('span:first-child');
    const right = label.querySelector('span:last-child');
    if (left) left.textContent = p.file || '';
    if (right) right.textContent = `${p.percent ? p.percent.toFixed(0) + ' %' : ''}${p.doneBytes ? ' · ' + fmtGB(p.doneBytes) + ' / ' + fmtGB(p.totalBytes) : ''}`;
  }
}

function renderCatalog() {
  const grid = $('#catalog-grid');
  if (!state.catalog.length) {
    grid.innerHTML = '<div class="empty-note">Katalog wird geladen …</div>';
    return;
  }
  grid.innerHTML = state.catalog.map(modelCard).join('');
}

async function refreshCatalog() {
  try {
    state.catalog = await bridge.models.catalog();
    renderCatalog();
  } catch (e) {
    $('#catalog-grid').innerHTML = `<div class="empty-note">Katalog konnte nicht geladen werden: ${esc(e.message)}</div>`;
  }
}

/* --------------------------- Modelle: Suche --------------------------- */

async function doSearch() {
  const q = $('#search-input').value.trim();
  if (!q) return;
  $('#search-results').innerHTML = '<div class="empty-note"><span class="spin" style="display:inline-block"></span> Suche …</div>';
  try {
    state.searchResults = await bridge.models.search(q);
    renderSearchResults();
  } catch (e) {
    $('#search-results').innerHTML = `<div class="empty-note">Suche fehlgeschlagen: ${esc(e.message)}</div>`;
  }
}

function renderSearchResults() {
  const list = $('#search-results');
  if (!state.searchResults.length) { list.innerHTML = '<div class="empty-note">Keine Treffer.</div>'; return; }
  list.innerHTML = state.searchResults.map((r) => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(r.repo)}</div>
        <div class="row-sub">${r.downloads.toLocaleString('de-DE')} Downloads · ${r.likes.toLocaleString('de-DE')} Likes${r.lastModified ? ' · ' + new Date(r.lastModified).toLocaleDateString('de-DE') : ''}</div>
      </div>
      <div class="row-actions">
        <button class="btn btn-ghost btn-sm" data-act="files" data-repo="${esc(r.repo)}">Dateien ansehen</button>
      </div>
    </div>`).join('');
}

async function openFilePanel(repo) {
  const panel = $('#file-panel');
  panel.classList.remove('is-hidden');
  $('#file-panel-title').textContent = repo;
  $('#file-panel-sub').textContent = 'Lade Dateiliste …';
  $('#file-list').innerHTML = '';
  try {
    const info = await bridge.models.files(repo);
    state.filePanel = { repo, ...info };
    $('#file-panel-sub').textContent = `${info.files.length} Quantisierungen · ${info.downloads?.toLocaleString('de-DE') || '?'} Downloads`;
    $('#file-list').innerHTML = info.files.map((f) => {
      const dl = state.downloads.get(`${repo}::${f.name}`);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-title">${esc(f.name)}</div>
          <div class="row-sub">${esc(f.quant || 'unbekannt')} · ${esc(f.sizeLabel || fmtGB(f.size))}${f.split ? ' · mehrteilig' : ''}</div>
          ${dl ? `<div class="progress"><div class="progress-fill" style="width:${dl.percent || 0}%"></div></div>
                  <div class="progress-label"><span>${esc(dl.file || '')}</span><span>${dl.percent ? dl.percent.toFixed(0) + '%' : ''}</span></div>` : ''}
        </div>
        <div class="row-actions">
          ${fitBadge(f.fit)}
          <button class="btn btn-primary btn-sm" data-act="download-file" data-repo="${esc(repo)}" data-file="${esc(f.name)}" ${dl ? 'disabled' : ''}>Herunterladen</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    $('#file-panel-sub').textContent = `Fehler: ${e.message}`;
  }
}

/* --------------------------- Modelle: Lokal --------------------------- */

function renderLocal() {
  const list = $('#local-list');
  $('#local-count').textContent = state.local.length ? `(${state.local.length})` : '';
  if (!state.local.length) {
    list.innerHTML = '<div class="empty-note">Noch keine Modelle heruntergeladen.<br>Stöbere im Katalog oder auf HuggingFace.</div>';
    return;
  }
  list.innerHTML = state.local.map((m) => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(m.repo)}</div>
        <div class="row-sub">${esc(m.file)} · ${esc(m.sizeLabel)}${m.quant ? ' · ' + esc(m.quant) : ''}</div>
        <div class="fit-note" style="margin-top:4px">${esc((m.fit && m.fit.detail) || '')}</div>
      </div>
      <div class="row-actions">
        ${fitBadge(m.fit)}
        <button class="btn btn-primary btn-sm" data-act="load-local" data-id="${esc(m.id)}">Laden</button>
        <button class="btn btn-ghost btn-sm" data-act="reveal" data-path="${esc(m.path)}" title="Im Ordner zeigen">Ordner</button>
        <button class="btn btn-danger-ghost btn-sm" data-act="delete-local" data-id="${esc(m.id)}">Löschen</button>
      </div>
    </div>`).join('');
}

async function refreshLocal() {
  try {
    state.local = await bridge.models.local();
    renderLocal();
  } catch (e) {
    $('#local-list').innerHTML = `<div class="empty-note">Lokale Modelle konnten nicht gelesen werden: ${esc(e.message)}</div>`;
  }
}

/* --------------------------- Setup --------------------------- */

function renderSetup() {
  const body = $('#setup-body');
  const hw = state.hw;
  if (!hw) { body.innerHTML = '<div class="empty-note">Hardware wird erkannt …</div>'; return; }
  const gpus = hw.gpus || [];
  const npus = hw.npus || [];
  const installed = (state.backends && state.backends.installed) || [];
  const available = (state.backends && state.backends.available) || [];
  const rec = hw.recommendation || { primary: null, candidates: [] };
  const recBackend = available.find((b) => b.id === rec.primary);

  const gpuHtml = gpus.length
    ? gpus.map((g) => `
        <div class="hw-card">
          <div class="hw-label">Grafik</div>
          <div class="hw-value">${esc(g.name)}</div>
          <div class="hw-sub">${esc(g.vendor)}${g.vramLabel ? ' · ' + esc(g.vramLabel) + ' VRAM' : ''}${g.vramApprox ? ' (geschätzt)' : ''}${g.driver ? ' · Treiber ' + esc(g.driver) : ''}</div>
        </div>`).join('')
    : `<div class="hw-card"><div class="hw-label">Grafik</div><div class="hw-value">Keine GPU erkannt</div><div class="hw-sub">Modelle laufen im Arbeitsspeicher (langsamer).</div></div>`;

  const npuHtml = npus.length
    ? `<div class="npu-note">
        <strong>NPU gefunden:</strong> ${npus.map((n) => esc(n.name)).join(', ')}.
        ${npus.some((n) => n.usableBy === 'openvino')
          ? 'Ein OpenVINO-Backend kann sie für kleine Modelle nutzen — als experimentelle Option unten verfügbar.'
          : 'Für llama.cpp ist sie nicht nutzbar; Chats laufen über GPU/CPU.'}
      </div>`
    : '';

  const backendCards = available.length
    ? available.map((b) => {
        const isInst = installed.some((i) => i.id === b.id);
        const inst = state.backendInstalls.get(b.id);
        return `
        <div class="backend-card ${b.recommended ? 'is-rec' : ''} ${isInst ? 'is-installed' : ''}">
          <div class="backend-main">
            <div class="backend-name">
              ${esc(b.label)}
              ${b.recommended ? '<span class="badge badge-gpu">Empfohlen</span>' : ''}
              ${b.experimental ? '<span class="badge badge-exp">experimentell</span>' : ''}
              ${b.npu ? '<span class="badge badge-exp">NPU</span>' : ''}
              ${isInst ? '<span class="badge badge-neutral">installiert</span>' : ''}
            </div>
            <div class="backend-note">${esc(b.note)}${b.reason ? ' — ' + esc(b.reason) : ''}</div>
            ${inst ? `<div class="progress"><div class="progress-fill" style="width:${inst.percent || 0}%"></div></div>
                      <div class="progress-label"><span>${esc(inst.file || inst.phase || '')}</span><span>${inst.percent ? inst.percent.toFixed(0) + '%' : ''}</span></div>` : ''}
          </div>
          <div class="backend-side">
            <span class="card-size">${esc(b.sizeLabel || '')}</span>
            ${isInst
              ? `<button class="btn btn-ghost btn-sm" data-act="remove-backend" data-id="${esc(b.id)}">Entfernen</button>`
              : `<button class="btn btn-primary btn-sm" data-act="install-backend" data-id="${esc(b.id)}" ${inst ? 'disabled' : ''}>Installieren</button>`}
          </div>
        </div>`;
      }).join('')
    : `<div class="empty-note">${state.backends && state.backends.error ? 'Backend-Liste nicht verfügbar: ' + esc(state.backends.error) : 'Backend-Liste wird geladen …'}</div>`;

  body.innerHTML = `
    <section class="setup-section">
      <h3 class="section-title">Dein System</h3>
      <div class="hw-grid">
        <div class="hw-card">
          <div class="hw-label">System</div>
          <div class="hw-value">${esc(hw.osName)}</div>
          <div class="hw-sub">${esc(hw.arch)} · ${esc(hw.cpuCores)} Threads</div>
        </div>
        <div class="hw-card">
          <div class="hw-label">Prozessor</div>
          <div class="hw-value">${esc(hw.cpuModel)}</div>
          <div class="hw-sub">${esc(hw.cpuCores)} Kerne</div>
        </div>
        <div class="hw-card">
          <div class="hw-label">Arbeitsspeicher</div>
          <div class="hw-value">${esc(hw.totalMemGB)} GB</div>
          <div class="hw-sub">${esc(hw.freeMemGB)} GB frei</div>
        </div>
        ${gpuHtml}
      </div>
      <div style="margin-top:12px">${npuHtml}</div>
      ${hw.notes && hw.notes.length ? `<ul class="hw-list" style="margin-top:10px">${hw.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </section>

    <section class="setup-section">
      <h3 class="section-title">Backend (llama.cpp)</h3>
      ${recBackend ? `<div class="rec-banner">
        <div class="rec-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m13 2-9 12h6l-1 8 9-12h-6l1-8Z"></path></svg>
        </div>
        <div><strong>Empfehlung für deine Hardware: ${esc(recBackend.label)}</strong>
        <span>${esc(recBackend.reason || recBackend.note)} · ${esc(recBackend.sizeLabel || '')} Download</span></div>
      </div>` : ''}
      ${backendCards}
      ${state.backends && state.backends.release ? `<div class="muted" style="margin-top:8px">llama.cpp ${esc(state.backends.release.tag)} · ${state.backends.installed.length} installiert</div>` : ''}
    </section>

    <section class="setup-section">
      <h3 class="section-title">Einstellungen</h3>
      <div class="settings-row">
        <div class="settings-label"><strong>Modellordner</strong><span>Hierhin werden GGUF-Dateien geladen</span></div>
        <div class="path-box">${esc(state.settings?.modelsDir || '')}</div>
        <button class="btn btn-ghost btn-sm" data-act="pick-models">Ändern</button>
        <button class="btn btn-ghost btn-sm" data-act="open-models">Öffnen</button>
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>Kontextgröße</strong><span>Tokens, die das Modell gleichzeitig „sieht“ — höher = mehr VRAM</span></div>
        <input type="number" class="num-input" id="set-ctx" min="1024" max="131072" step="1024" value="${esc(state.settings?.ctx || 8192)}">
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>GPU-Layers</strong><span>999 = alles auf die GPU. Bei Speicherproblemen reduzieren.</span></div>
        <input type="number" class="num-input" id="set-ngl" min="0" max="999" step="1" value="${esc(state.settings?.gpuLayers ?? 999)}">
      </div>
    </section>`;
}

/* --------------------------- Events --------------------------- */

function bindEvents() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#btn-open-models').addEventListener('click', () => { setView('models'); setTab('local'); });
  $('#btn-empty-action').addEventListener('click', () => { setView('models'); setTab('catalog'); });
  $('#btn-unload').addEventListener('click', () => {
    if (state.server.running && !state.server.starting && !state.server.unloading) {
      unloadModel();
    } else if (!state.server.running && !state.server.starting && state.server.lastModel) {
      loadModel(state.server.lastModel);
    }
  });
  $('#btn-models-folder').addEventListener('click', () => bridge.shell.showModels());
  $('#btn-check-update').addEventListener('click', async () => {
    try {
      const info = await bridge.update.check();
      if (info.updateAvailable) showUpdateDialog({ ...info, currentVersion: state.info?.version });
      else toast(`Du bist aktuell (v${state.info?.version || '?'}).`, 'ok', 2600);
    } catch (e) {
      toast(`Update-Check fehlgeschlagen: ${e.message}`, 'error', 6000);
    }
  });
  $('#update-now').addEventListener('click', startUpdateDownload);
  $('#update-dialog').addEventListener('close', () => {
    const val = $('#update-dialog').returnValue;
    $('#update-dialog').returnValue = '';
    if (val === 'open' && stateUpdate.assetPath) {
      bridge.update.openFile(stateUpdate.assetPath).catch((e) => toast(e.message, 'error'));
    } else if (val === 'releases') {
      bridge.update.openReleases();
    }
  });
  $('#btn-rescan').addEventListener('click', async () => {
    toast('Erkenne Hardware neu …', 'info', 1800);
    state.hw = await bridge.hw.scan(true);
    state.backends = await bridge.backends.list();
    renderSetup(); renderSidebar(); refreshCatalog();
  });

  $('#preset-select').addEventListener('change', async (e) => {
    const preset = e.target.value;
    state.server.preset = preset;
    await bridge.settings.set({ lastPreset: preset });
    if (state.settings) state.settings.lastPreset = preset;
    const p = state.presets.find((x) => x.id === preset);
    toast(`Preset: ${p ? p.name : preset}`, 'ok', 1800);
    renderPresetSelect();
    renderChatState();
  });

  $('#btn-send').addEventListener('click', () => {
    if (state.chat.streaming) stopGeneration();
    else sendMessage();
  });
  const input = $('#input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // IME-Komposition (z. B. japanisch/chinesisch) nicht als Sendung interpretieren
      if (e.isComposing || e.keyCode === 229) return;
      sendMessage();
    }
  });
  // Auto-Größe per CSS field-sizing: content (styles.css), kein scrollHeight-JS nötig
  // Stream stoppen per Klick auf Senden-Button während Streaming
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.chat.streaming) stopGeneration();
  });

  // Tabs
  $$('#models-tabs .tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  // Selection follows focus (native focusgroup bzw. Fallback unten)
  $('#models-tabs').addEventListener('focusin', (e) => {
    if (e.target && e.target.dataset && e.target.dataset.tab) setTab(e.target.dataset.tab);
  });
  // Fallback-Tastatursteuerung, falls focusgroup nicht unterstützt wird
  if (!('focusGroup' in HTMLElement.prototype)) {
    $('#models-tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const tabs = $$('#models-tabs .tab');
      const idx = tabs.indexOf(document.activeElement);
      if (idx < 0) return;
      e.preventDefault();
      const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      setTab(next.dataset.tab);
    });
  }
  $('#btn-search').addEventListener('click', doSearch);
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) doSearch();
  });
  $('#file-panel-close').addEventListener('click', () => $('#file-panel').classList.add('is-hidden'));

  // Delegierte Klicks
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-ext]');
    if (a) { e.preventDefault(); bridge.shell.openExternal(a.dataset.ext); return; }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'download-catalog') {
      const repo = btn.dataset.repo;
      const entry = state.catalog.find((c) => c.repo === repo);
      if (!entry || !entry.file) return;
      startDownload(repo, entry.file.name, btn);
    }
    if (act === 'download-file') {
      startDownload(btn.dataset.repo, btn.dataset.file, btn);
    }
    if (act === 'load-catalog') {
      const m = state.local.find((l) => l.repo === btn.dataset.repo);
      if (m) loadModel(m);
      else toast('Modell ist lokal nicht gefunden — bitte neu herunterladen.', 'error');
    }
    if (act === 'load-local') {
      const m = state.local.find((l) => l.id === btn.dataset.id);
      if (m) loadModel(m);
    }
    if (act === 'reveal') { bridge.models.reveal(btn.dataset.path); }
    if (act === 'delete-local') {
      const m = state.local.find((l) => l.id === btn.dataset.id);
      if (!m) return;
      const ok = await confirmDialog({
        title: 'Modell wirklich löschen?',
        message: `${m.file}\n${m.sizeLabel}`,
        okLabel: 'Löschen',
        danger: true,
      });
      if (!ok) return;
      try {
        await bridge.models.delete(m.id);
        toast('Modell gelöscht', 'ok');
        await refreshLocal(); refreshCatalog();
      } catch (err) { toast(err.message, 'error'); }
    }
    if (act === 'files') { openFilePanel(btn.dataset.repo); }
    if (act === 'install-backend') {
      const id = btn.dataset.id;
      btn.disabled = true;
      state.backendInstalls.set(id, { phase: 'download', percent: 0 });
      renderSetup();
      try {
        await bridge.backends.install(id);
        toast(`Backend installiert: ${id}`, 'ok');
        state.backends = await bridge.backends.list();
        state.backendInstalls.delete(id);
        renderSetup(); renderSidebar();
      } catch (err) {
        state.backendInstalls.delete(id);
        renderSetup();
        toast(err.message, 'error', 8000);
      }
    }
    if (act === 'remove-backend') {
      const id = btn.dataset.id;
      const ok = await confirmDialog({
        title: 'Backend entfernen?',
        message: `Backend ${id} wirklich entfernen?`,
        okLabel: 'Entfernen',
        danger: true,
      });
      if (!ok) return;
      try {
        await bridge.backends.remove(id);
        state.backends = await bridge.backends.list();
        renderSetup(); renderSidebar();
      } catch (err) { toast(err.message, 'error'); }
    }
    if (act === 'pick-models') {
      const dir = await bridge.dialog.pickFolder();
      if (!dir) return;
      state.settings = await bridge.settings.set({ modelsDir: dir });
      renderSetup();
      toast('Modellordner geändert', 'ok');
    }
    if (act === 'open-models') { bridge.shell.showModels(); }
  });

  // Settings-Inputs (delegiert, weil neu gerendert)
  document.addEventListener('change', async (e) => {
    if (e.target.id === 'set-ctx') {
      const val = Math.max(1024, parseInt(e.target.value, 10) || 8192);
      state.settings = await bridge.settings.set({ ctx: val });
      toast(`Kontext: ${val} Tokens`, 'ok', 1800);
      refreshCatalog();
    }
    if (e.target.id === 'set-ngl') {
      const val = Math.max(0, parseInt(e.target.value, 10) || 0);
      state.settings = await bridge.settings.set({ gpuLayers: val });
      toast(`GPU-Layers: ${val}`, 'ok', 1800);
    }
  });

  // Fortschritts-Events
  bridge.on('download:progress', (p) => {
    if (!p || !p.downloadId) return;
    const prev = state.downloads.get(p.downloadId) || {};
    state.downloads.set(p.downloadId, { ...prev, ...p });
    if (p.phase === 'done') {
      setTimeout(async () => {
        state.downloads.delete(p.downloadId);
        await refreshLocal(); refreshCatalog();
        toast('Download abgeschlossen', 'ok');
        setTab('local');
      }, 500);
    } else if (p.phase === 'error') {
      state.downloads.delete(p.downloadId);
      toast(p.message || 'Download fehlgeschlagen', 'error', 8000);
      renderCatalog();
    } else {
      // Gezielt nur die betroffene Karte/Zeile aktualisieren (kein Voll-Rerender)
      const card = document.querySelector(`.card[data-repo="${(p.repo || '').replace(/["\\]/g, '')}"]`);
      if (card) applyProgress(card, p);
      if (state.filePanel && state.filePanel.repo === p.repo) {
        const row = $$('#file-list .row').find((r) => (r.querySelector('.row-title') || {}).textContent === p.file);
        if (row) applyProgress(row.querySelector('.row-main'), p);
      }
    }
  });

  bridge.on('backend:progress', (p) => {
    if (!p || !p.backend) return;
    state.backendInstalls.set(p.backend, p);
    if (state.view === 'setup') renderSetup();
  });

  bridge.on('update:available', (info) => {
    if (info && info.updateAvailable) showUpdateDialog({ ...info, currentVersion: state.info?.version });
  });

  bridge.on('update:progress', (p) => {
    if (!p) return;
    const fill = $('#update-progress-fill');
    if (!fill) return;
    const pct = Math.max(0, Math.min(100, p.percent || 0));
    fill.style.width = `${pct}%`;
    const pctEl = $('#update-progress-pct');
    if (pctEl) pctEl.textContent = `${pct.toFixed(pct < 10 ? 1 : 0).replace('.', ',')} %`;
    const txt = $('#update-progress-text');
    if (txt) {
      txt.textContent = p.doneBytes ? `${fmtGB(p.doneBytes)} von ${fmtGB(p.totalBytes)}` : 'Wird heruntergeladen …';
    }
  });

  bridge.on('server:log', (entry) => {
    if (!entry) return;
    // Nur relevante Zeilen in die UI spiegeln
    if (window.__showServerLogs) console.log('[llama]', entry.line);
  });

  bridge.on('server:state', (st) => {
    if (!st) return;
    if (st.running) {
      state.server.running = true;
      state.server.starting = false;
      state.server.port = st.port;
      state.server.model = st.model;
      if (st.preset) state.server.preset = st.preset;
      if (!state.server.lastModel) {
        state.server.lastModel = { path: st.model, id: null, fit: null };
      }
    } else if (!state.server.starting) {
      state.server.running = false;
    }
    renderChatState();
  });
}

async function startDownload(repo, file, btn) {
  const id = `${repo}::${file}`;
  state.downloads.set(id, { downloadId: id, phase: 'download', percent: 0, file });
  if (btn) {
    btn.disabled = true;
    const row = btn.closest('.row');
    if (row) applyProgress(row.querySelector('.row-main') || row, { percent: 0, file });
  }
  try {
    const result = await bridge.models.download(repo, file);
    state.downloads.delete(id);
    await refreshLocal();
    await refreshCatalog();
    toast(`Fertig: ${result.file} (${result.sizeLabel})`, 'ok', 5000);
    setTab('local');
  } catch (err) {
    state.downloads.delete(id);
    toast(err.message, 'error', 9000);
    renderCatalog();
  }
}

function setTab(tab) {
  if (state.activeTab === tab) return;
  state.activeTab = tab;
  $$('#models-tabs .tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.toggleAttribute('focusgroupstart', on);
  });
  for (const t of ['catalog', 'search', 'local']) {
    $(`#tab-${t}`).classList.toggle('is-hidden', t !== tab);
  }
  if (tab === 'local') refreshLocal();
  if (tab === 'catalog') refreshCatalog();
}

/* --------------------------- Init --------------------------- */

async function init() {
  bindEvents();
  try {
    state.info = await bridge.info();
    state.settings = await bridge.settings.get();
    state.presets = await bridge.presets();
    renderPresetSelect();

    const st = await bridge.server.state();
    if (st.running) {
      state.server = {
        running: true, starting: false, port: st.port, model: st.model, preset: st.preset,
        lastModel: { path: st.model, id: null, fit: null }, unloading: false,
      };
    }
    renderChatState();

    state.hw = await bridge.hw.scan();
    renderSidebar();
    renderChatState();

    refreshLocal();
    refreshCatalog();

    bridge.backends.list().then((b) => {
      state.backends = b;
      renderSidebar();
      if (state.view === 'setup') renderSetup();
      if (!b.installed || !b.installed.length) {
        setView('setup');
        toast('Willkommen! Richte zuerst ein Backend für deine Hardware ein.', 'info', 7000);
      }
    }).catch((e) => {
      state.backends = { available: [], installed: [], error: e.message };
      if (state.view === 'setup') renderSetup();
    });

    state.booted = true;
  } catch (e) {
    toast(`Startfehler: ${e.message}`, 'error', 10000);
  }
}

document.addEventListener('DOMContentLoaded', init);
