'use strict';
/* ModelHarbor — Renderer-Logik (kein Framework, klassisches Script) */

const bridge = window.api;
const i18n = window.I18N;
const t = (key, vars, fallback) => i18n.t(key, vars, fallback);

const state = {
  info: null,
  settings: null,
  hw: null,
  presets: [],
  backends: null,
  catalog: [],
  local: [],
  modelSources: [],
  serverConfig: null,
  serverInfo: null,
  serverModelId: '',
  serverPreset: '',
  serverLogs: [],
  srvCopy: {},
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

// Fire-and-forget-IPC: Fehler als Toast statt unbehandelter Promise-Rejection
function ipc(p) {
  Promise.resolve(p).catch((e) => toast(e && e.message ? e.message : String(e), 'error', 7000));
}

function fmtGB(bytes) {
  if (!bytes) return '–';
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

// Wendet alle statischen Übersetzungen aus index.html an (Text, title, placeholder, aria-label)
function applyStaticText() {
  document.documentElement.lang = i18n.getLang();
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of $$('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of $$('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
}

// Baut alle dynamischen Bereiche neu auf — nötig nach einem Sprachwechsel
function rerenderAll() {
  renderPresetSelect();
  renderChatState();
  if (state.view === 'setup') renderSetup();
  if (state.activeTab === 'local') renderLocal();
  else if (state.activeTab === 'search') renderSearchResults();
  else renderCatalog();
  renderMessages();
}

// Stellt die Chat-Historie in der aktiven Sprache wieder her
function renderMessages() {
  const wrap = $('#messages');
  if (!wrap) return;
  wrap.querySelectorAll('.msg').forEach((m) => m.remove());
  for (const m of state.chat.messages) {
    const { el, body } = addMessage(m.role, m.content);
    if (m.role === 'assistant') {
      body.innerHTML = (m.reasoning ? reasoningBlock(m.reasoning) : '') + renderMarkdown(m.content);
      addMsgActions(el, m.content);
    }
  }
  renderChatState();
}

async function setLanguage(next, { persist = true } = {}) {
  const lang = i18n.setLang(next);
  if (persist) {
    try { state.settings = await bridge.settings.set({ language: lang }); }
    catch { /* Anzeige trotzdem umstellen */ }
  } else if (state.settings) {
    state.settings.language = lang;
  }
  applyStaticText();
  rerenderAll();
  const name = (i18n.LANGS.find((l) => l.id === lang) || {}).label || lang;
  announce(t('toast.languageChanged', { language: name }));
  // Notizen, Begründungen und Modelltexte erzeugt der Main-Prozess in der aktiven Sprache
  await refreshLanguageData();
}

// Holt hardware-/backend-/modellbezogene Texte neu, damit sie in der neuen Sprache erscheinen
async function refreshLanguageData() {
  try { state.hw = await bridge.hw.scan(true); } catch { /* alten Stand behalten */ }
  try { if (state.backends) state.backends = await bridge.backends.list(); } catch { /* alten Stand behalten */ }
  rerenderAll();
  refreshLocal();
  refreshCatalog();
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
    <button type="button" class="toast-close" popovertarget="${id}" popovertargetaction="hide" aria-label="${esc(t('common.close'))}">×</button>`;
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

function confirmDialog({ title, message, okLabel = t('common.confirm'), danger = false }) {
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
  $('#update-sub').textContent = t('update.subtitle', {
    version: ver,
    current: info.currentVersion || t('update.thisVersion'),
  });
  const notes = (info.latest.body || '').trim();
  $('#update-notes').textContent = notes || t('update.noNotes');
  $('#update-notes').style.display = notes ? '' : 'none';
  $('#update-progress').classList.add('is-hidden');
  $('#update-progress-fill').style.width = '0%';
  $('#update-progress-text').textContent = t('update.downloading');
  $('#update-progress-pct').textContent = '0 %';
  const noAsset = !info.asset;
  $('#update-now').classList.toggle('is-hidden', noAsset);
  $('#update-open').classList.add('is-hidden');
  $('#update-later').classList.toggle('is-hidden', false);
  $('#update-later').disabled = false;
  $('#update-later').textContent = noAsset ? t('common.close') : t('update.later');
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
  now.textContent = t('update.loading');
  later.disabled = true;
  $('#update-progress').classList.remove('is-hidden');
  try {
    const res = await bridge.update.download(info.asset.url, info.asset.name);
    stateUpdate.assetPath = res.assetPath;
    stateUpdate.downloading = false;
    $('#update-progress-fill').style.width = '100%';
    $('#update-progress-text').textContent = t('update.done', { name: info.asset.name });
    $('#update-progress-pct').textContent = fmtGB(res.size);
    now.classList.add('is-hidden');
    const open = $('#update-open');
    open.classList.remove('is-hidden');
    open.disabled = false;
    later.disabled = false;
    later.textContent = t('common.close');
  } catch (e) {
    stateUpdate.downloading = false;
    now.disabled = false;
    now.textContent = t('update.retry');
    later.disabled = false;
    $('#update-progress').classList.add('is-hidden');
    toast(t('update.downloadFailed', { message: e.message }), 'error', 9000);
  }
}

function fitBadge(fit) {
  if (!fit) return '';
  const cls = fit.verdict === 'gpu' ? 'badge-gpu' : fit.verdict === 'hybrid' ? 'badge-hybrid' : fit.verdict === 'ram' ? 'badge-ram' : 'badge-big';
  return `<span class="badge ${cls}" title="${esc(fitDetail(fit))}">${esc(fitLabel(fit))}</span>`;
}

// Übersetzte Fit-Texte: Deutsch kommt aus dem Main-Prozess, Englisch wird aus den Messwerten gebaut
const FIT_KEYS = { gpu: 'gpu', hybrid: 'hybrid', ram: 'ram', 'too-big': 'tooBig' };

function fitLabel(fit) {
  const key = FIT_KEYS[fit && fit.verdict];
  return key ? t(`fit.${key}.label`, null, fit.label) : (fit && fit.label) || '';
}

function fitDetail(fit) {
  if (!fit) return '';
  const key = FIT_KEYS[fit.verdict];
  if (!key || i18n.getLang() === 'de') return fit.detail || '';
  const need = fit.needGB != null ? Number(fit.needGB).toFixed(1) : '?';
  if (fit.verdict === 'gpu') {
    const gpus = (state.hw && state.hw.gpus ? state.hw.gpus : []).filter((g) => g.vramGB);
    const best = gpus.sort((a, b) => b.vramGB - a.vramGB)[0];
    return t('fit.gpu.detail', { need, vram: fit.vramGB, gpu: best ? best.name : '' });
  }
  if (fit.verdict === 'hybrid') return t('fit.hybrid.detail', { need, vram: fit.vramGB });
  if (fit.verdict === 'ram') return t('fit.ram.detail', { need });
  const available = Math.max(fit.vramGB || 0, Math.round((fit.ramGB || 8) * 0.75));
  return t('fit.tooBig.detail', { need, available });
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
  if (view === 'server') refreshServerView();
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
  if (!hw) { el.innerHTML = `<div class="side-hint">${esc(t('sidebar.detecting'))}</div>`; return; }
  const gpu = (hw.gpus || []).filter((g) => g.vramGB).sort((a, b2) => b2.vramGB - a.vramGB)[0];
  const be = installed[0];
  el.innerHTML = `
    <div class="side-block">
      <div class="side-label">${esc(t('sidebar.hardware'))}</div>
      <div class="side-value">${esc(gpu ? `${gpu.vendor} · ${gpu.vramGB} GB` : t('sidebar.cpuOnly'))}</div>
      <div class="side-value side-cpu">${esc(hw.cpuModel.replace(/\(R\)|\(TM\)/g, '').replace(/\s+/g, ' '))}</div>
    </div>
    <div class="side-block">
      <div class="side-label">${esc(t('sidebar.backend'))}</div>
      <div class="side-value"><span class="${be ? 'dot-ok' : 'dot-warn'}"></span>${be ? esc(be.label) : esc(t('sidebar.notConfigured'))}</div>
    </div>
    <div class="side-block">
      <div class="side-label">${esc(t('sidebar.model'))}</div>
      <div class="side-value"><span class="${state.server.running ? 'dot-ok' : state.server.starting ? 'dot-warn' : 'dot-off'}"></span>${state.server.running ? esc(basename(state.server.model || '')) : esc(state.server.starting ? t('sidebar.loading') : t('sidebar.noneLoaded'))}</div>
    </div>`;
}

/* --------------------------- Chat --------------------------- */

function currentPreset() {
  return state.presets.find((p) => p.id === (state.server.preset || state.settings?.lastPreset)) || state.presets[0] || null;
}

function presetName(p) {
  return p ? t(`preset.${p.id}.name`, null, p.name) : '';
}

function presetDescription(p) {
  return p ? t(`preset.${p.id}.desc`, null, p.description) : '';
}

function renderPresetSelect() {
  const sel = $('#preset-select');
  if (!sel) return;
  const cur = state.server.preset || state.settings?.lastPreset || 'balanced';
  sel.innerHTML = state.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.icon)} ${esc(presetName(p))}</option>`).join('');
  sel.value = cur;
  const curPreset = state.presets.find((p) => p.id === cur);
  sel.title = curPreset ? presetDescription(curPreset) : '';
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
  const msBtn = $('#btn-model-settings');
  if (msBtn) {
    msBtn.classList.toggle('is-hidden', !state.server.running);
    msBtn.title = t('ms.title');
    msBtn.setAttribute('aria-label', t('ms.title'));
  }
  if (state.server.running) {
    name.textContent = monogram(state.server.model);
  } else if (state.server.starting) {
    name.textContent = t('chat.modelLoading');
  } else {
    name.textContent = t('chat.noModel');
  }

  const canChat = !!state.server.running && !state.chat.streaming;
  // Das Textfeld bleibt auch während des Streamens editierbar: ein disabled-Feld
  // verliert den Fokus und gibt ihn nicht zurück — Enter soll im Feld bleiben.
  const wasDisabled = input.disabled;
  input.disabled = !state.server.running;
  // Gerade nutzbar geworden (Modell geladen): Fokus direkt ins Feld legen.
  if (wasDisabled && !input.disabled && state.view === 'chat') input.focus();
  const ICON_SEND = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4 20-7Z"></path></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
  if (state.chat.streaming) {
    send.disabled = false;
    send.classList.add('is-stop');
    send.innerHTML = ICON_STOP;
    send.title = t('chat.stopTitle');
  } else {
    send.disabled = !canChat;
    send.classList.remove('is-stop');
    send.innerHTML = ICON_SEND;
    send.title = t('chat.sendTitle');
  }
  hint.textContent = state.server.running ? t('chat.enterHint') : t('chat.loadToChat');
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
    btn.title = t('chat.unloadTitle');
    btn.innerHTML = state.server.unloading ? esc(t('chat.unloading')) : `${ICON_EJECT} ${esc(t('chat.unload'))}`;
  } else if (state.server.lastModel) {
    btn.className = 'btn btn-ok';
    btn.disabled = busy;
    btn.title = t('chat.reloadTitle');
    btn.innerHTML = `${ICON_RELOAD} ${esc(t('chat.reload'))}`;
  } else {
    btn.className = 'btn btn-danger-ghost';
    btn.disabled = true;
    btn.title = t('chat.noModel');
    btn.innerHTML = `${ICON_EJECT} ${esc(t('chat.unload'))}`;
  }
}

function monogram(p) {
  if (!p) return '—';
  const b = basename(p).replace(/\.gguf$/i, '');
  return b.length > 42 ? b.slice(0, 39) + '…' : b;
}

function reasoningBlock(text) {
  const chars = text.length;
  return `<details class="reasoning"><summary>${esc(t('chat.reasoning', { count: chars.toLocaleString(i18n.locale()) }))}</summary><pre>${esc(text)}</pre></details>`;
}

function addMessage(role, content, { streaming = false } = {}) {
  const wrap = $('#messages');
  const empty = $('#chat-empty');
  if (empty) empty.style.display = 'none';
  const el = document.createElement('div');
  el.className = `msg msg-${role}`;
  el.innerHTML = `
    <div class="msg-role">${role === 'user'
      ? `<span class="who-user">${esc(t('chat.you'))}</span>`
      : `<span class="who-ai">${esc(state.server.model ? basename(state.server.model).replace(/\.gguf$/i, '') : t('chat.assistant'))}</span>`}</div>
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

function restoreComposerFocus() {
  // Nach dem Senden/Streamen gehoert der Fokus zurueck ins Textfeld. Ein
  // disabled-Feld (kurzer Server-State-Flap) oder ein Button, der den Fokus
  // behalten hat, laesst ihn sonst auf <body> zurueck — dann muss man vor
  // jeder Nachricht neu ins Feld klicken.
  if (state.view !== 'chat' || !state.server.running) return;
  const input = $('#input');
  if (!input || input.disabled) return;
  const a = document.activeElement;
  const stray = !a || a === document.body || a === document.documentElement
    || a === $('#btn-send') || a === $('#btn-unload');
  if (stray) input.focus({ preventScroll: true });
}

async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !state.server.running || state.chat.streaming) return;

  state.chat.messages.push({ role: 'user', content: text });
  addMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  input.focus();   // Fokus bleibt nach dem Senden im Eingabefeld
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
      headers: {
        'Content-Type': 'application/json',
        // Ist ein API-Key gesetzt, prüft llama-server ihn auch für den Chat.
        ...(state.server.apiKey ? { Authorization: `Bearer ${state.server.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: state.chat.abort.signal,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(t('chat.serverError', { status: res.status, body: errBody.slice(0, 300) }));
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const handle = (json) => {
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
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parsed = parseSseChunk(buf);
      buf = parsed.rest;
      for (const json of parsed.payloads) handle(json);
    }
    // Stream-Ende: Decoder flushen und die letzte Zeile auch ohne abschließendes
    // Newline auswerten — sonst geht das letzte Delta (oft der Usage-Block) verloren.
    buf += dec.decode();
    for (const json of parseSseChunk(buf, true).payloads) handle(json);
    paint(true);
    state.chat.messages.push({ role: 'assistant', content: full, reasoning: reasoning || null });
    body.innerHTML = (reasoning ? reasoningBlock(reasoning) : '') + renderMarkdown(full);
    if (usage) {
      const n = usage.completion_tokens || 0;
      const genMs = tFirstToken && tLastToken > tFirstToken ? tLastToken - tFirstToken : 0;
      const tps = tokensPerSecond(n, genMs);
      const tpsText = tps ? ` · ${tps.toFixed(1)} tok/s` : '';
      $('#token-info').textContent = t('chat.tokenInfo', {
        prompt: usage.prompt_tokens || 0,
        completion: n,
        tps: tpsText,
      });
    }
    addMsgActions(el, full);
  } catch (e) {
    if (e.name === 'AbortError') {
      body.innerHTML = renderMarkdown(full) + `<p class="muted">${esc(t('chat.stopped'))}</p>`;
      if (full) state.chat.messages.push({ role: 'assistant', content: full });
    } else {
      el.classList.add('msg-error');
      body.textContent = t('chat.error', { message: e.message });
      toast(e.message, 'error');
    }
  } finally {
    state.chat.streaming = false;
    state.chat.abort = null;
    renderChatState();
    scrollChat(true);
    restoreComposerFocus();
  }
}

function addMsgActions(msgEl, text) {
  const actions = msgEl.querySelector('.msg-actions');
  if (!actions || !text) return;
  actions.innerHTML = `<button class="msg-action" data-copy>${esc(t('common.copy'))}</button>`;
  actions.querySelector('[data-copy]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); toast(t('toast.copied'), 'ok', 1800); }
    catch { toast(t('toast.copyFailed'), 'error'); }
  });
}

function stopGeneration() {
  if (state.chat.abort) state.chat.abort.abort();
}

/* --------------------------- Server --------------------------- */

async function loadModel(model, { presetOverride, stay } = {}) {
  if (!model || !model.path) { toast(t('toast.noModelPath'), 'error'); return; }
  if (state.server.running || state.server.starting) {
    const ok = await confirmDialog({
      title: t('chat.switchModelTitle'),
      message: t('chat.switchModelMessage'),
      okLabel: t('chat.unloadAndLoad'),
    });
    if (!ok) return;
    await unloadModel(true);
  }
  const preset = presetOverride || state.server.preset || state.settings?.lastPreset || 'balanced';
  state.server.starting = true;
  renderChatState();
  clearToasts();
  toast(t('toast.loading', { file: basename(model.path) }), 'info', 8000);
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
      apiKey: res.apiKey || '', host: res.host || '127.0.0.1', lan: !!res.lan,
      lastModel: { path: model.path, id: model.id || null, fit: model.fit || null },
    };
    if (res.fit) state.server.fit = res.fit;
    renderChatState();
    renderPresetSelect();
    toast(t('toast.ready', { file: basename(model.path) }), 'ok');
    if (stay) {
      // Vom Server-Tab gestartet: dort bleiben und die Ansicht auffrischen.
      await refreshServerConfig();
      renderServer();
    } else {
      setView('chat');
      setTimeout(() => $('#input').focus(), 120);
    }
  } catch (e) {
    state.server.starting = false;
    renderChatState();
    toast(e.message || t('toast.loadFailed'), 'error', 9000);
    if (stay) renderServer();
  }
}

async function unloadModel(silent = false) {
  const last = state.server.lastModel;
  if (!silent) {
    // Sofortiges Feedback beim Klick
    state.server.unloading = true;
    renderChatState();
    clearToasts();
    toast(t('toast.unloading'), 'info', 1500);
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
      toast(t('toast.unloaded'), 'ok');
    }
  } catch (e) {
    state.server.unloading = false;
    renderChatState();
    clearToasts();
    toast(t('toast.unloadFailed', { message: e.message }), 'error');
  }
}

/* --------------------------- Modelle: Katalog --------------------------- */

function modelCard(entry) {
  const fit = entry.fit || {};
  const isOnnx = !!(entry.isOnnx || entry.onnx);
  const isLocal = state.local.some((l) => l.repo === entry.repo);
  const dlId = isOnnx ? `${entry.repo}::onnx` : entry.downloadId;
  const dl = dlId ? state.downloads.get(dlId) : null;
  const quant = entry.file ? (entry.file.quant || '') : '';
  // ONNX-Einträge zeigen keine Quant/Datei, sondern ihre Kennzeichnung
  // (NPU/ONNX bzw. Ryzen AI).
  const meta = isOnnx ? (entry.tag || t('models.onnxBadge')) : quant;
  return `
    <article class="card" data-repo="${esc(entry.repo)}">
      <div class="card-top">
        <div>
          <div class="card-title">${esc(entry.name)}</div>
          <div class="card-meta">${esc(entry.params)} · ${esc(entry.family)}${meta ? ' · ' + esc(meta) : ''}</div>
        </div>
        ${fit.verdict ? fitBadge(fit) : `<span class="badge badge-neutral">${esc(t('common.unknown'))}</span>`}
      </div>
      <div class="card-desc">${esc(i18n.modelBlurb(entry.repo, entry.blurb))}</div>
      <div class="fit-note">${esc(fitDetail(fit))}</div>
      <div class="card-foot">
        <span class="card-size">${entry.sizeLabel ? esc(entry.sizeLabel) : '–'}</span>
        ${isLocal
          ? `<button class="btn btn-primary btn-sm" data-act="load-catalog" data-repo="${esc(entry.repo)}">${esc(t('models.openChat'))}</button>`
          : `<button class="btn btn-primary btn-sm" data-act="download-catalog" data-repo="${esc(entry.repo)}"${isOnnx ? ' data-onnx="1"' : ''} ${dl ? 'disabled' : ''}>${esc(t('models.download'))}</button>`}
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
    grid.innerHTML = `<div class="empty-note">${esc(t('models.catalogLoading'))}</div>`;
    return;
  }
  grid.innerHTML = state.catalog.map(modelCard).join('');
}

async function refreshCatalog() {
  try {
    state.catalog = await bridge.models.catalog();
    renderCatalog();
  } catch (e) {
    $('#catalog-grid').innerHTML = `<div class="empty-note">${esc(t('models.catalogError', { message: e.message }))}</div>`;
  }
}

/* --------------------------- Modelle: Suche --------------------------- */

async function doSearch() {
  const q = $('#search-input').value.trim();
  if (!q) return;
  $('#search-results').innerHTML = `<div class="empty-note"><span class="spin" style="display:inline-block"></span> ${esc(t('models.searching'))}</div>`;
  try {
    state.searchResults = await bridge.models.search(q);
    renderSearchResults();
  } catch (e) {
    $('#search-results').innerHTML = `<div class="empty-note">${esc(t('models.searchError', { message: e.message }))}</div>`;
  }
}

function renderSearchResults() {
  const list = $('#search-results');
  if (!state.searchResults.length) { list.innerHTML = `<div class="empty-note">${esc(t('models.noResults'))}</div>`; return; }
  const row = (r) => {
    const dlId = r.onnx ? `${r.repo}::onnx` : null;
    const dl = dlId ? state.downloads.get(dlId) : null;
    return `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(r.repo)}${r.onnx ? ` <span class="badge badge-exp">${esc(t('models.onnxBadge'))}</span>` : ''}</div>
        <div class="row-sub">${esc(t('models.rowMeta', { downloads: i18n.num(r.downloads), likes: i18n.num(r.likes) }))}${r.lastModified ? ' · ' + new Date(r.lastModified).toLocaleDateString(i18n.locale()) : ''}</div>
        ${dl ? `<div class="progress"><div class="progress-fill" style="width:${dl.percent || 0}%"></div></div>
                <div class="progress-label"><span>${esc(dl.file || '')}</span><span>${dl.percent ? dl.percent.toFixed(0) + '%' : ''}</span></div>` : ''}
      </div>
      <div class="row-actions">
        ${r.onnx
          ? `<button class="btn btn-primary btn-sm" data-act="download-search-onnx" data-repo="${esc(r.repo)}" ${dl ? 'disabled' : ''}>${esc(t('models.download'))}</button>`
          : `<button class="btn btn-ghost btn-sm" data-act="files" data-repo="${esc(r.repo)}">${esc(t('models.showFiles'))}</button>`}
      </div>
    </div>`;
  };
  const gguf = state.searchResults.filter((r) => !r.onnx);
  const onnx = state.searchResults.filter((r) => r.onnx);
  list.innerHTML = [
    gguf.length ? `<div class="section-title">${esc(t('models.groupGguf'))}</div>${gguf.map(row).join('')}` : '',
    onnx.length ? `<div class="section-title">${esc(t('models.groupOnnx'))}</div>${onnx.map(row).join('')}` : '',
  ].join('');
}

async function openFilePanel(repo) {
  const panel = $('#file-panel');
  panel.classList.remove('is-hidden');
  $('#file-panel-title').textContent = repo;
  $('#file-panel-sub').textContent = t('models.loadingFiles');
  $('#file-list').innerHTML = '';
  try {
    const info = await bridge.models.files(repo);
    state.filePanel = { repo, ...info };
    $('#file-panel-sub').textContent = t('models.filePanelSub', {
      count: info.files.length,
      downloads: info.downloads != null ? i18n.num(info.downloads) : '?',
    });
    $('#file-list').innerHTML = info.files.map((f) => {
      const dl = state.downloads.get(`${repo}::${f.name}`);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-title">${esc(f.name)}</div>
          <div class="row-sub">${esc(f.quant || t('common.unknown'))} · ${esc(f.sizeLabel || fmtGB(f.size))}${f.split ? ' · ' + esc(t('models.split')) : ''}</div>
          ${dl ? `<div class="progress"><div class="progress-fill" style="width:${dl.percent || 0}%"></div></div>
                  <div class="progress-label"><span>${esc(dl.file || '')}</span><span>${dl.percent ? dl.percent.toFixed(0) + '%' : ''}</span></div>` : ''}
        </div>
        <div class="row-actions">
          ${fitBadge(f.fit)}
          <button class="btn btn-primary btn-sm" data-act="download-file" data-repo="${esc(repo)}" data-file="${esc(f.name)}" ${dl ? 'disabled' : ''}>${esc(t('models.download'))}</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    $('#file-panel-sub').textContent = t('common.error', { message: e.message });
  }
}

/* --------------------------- Modelle: Lokal --------------------------- */

function renderLocal() {
  const list = $('#local-list');
  $('#local-count').textContent = state.local.length ? `(${state.local.length})` : '';
  if (!state.local.length) {
    list.innerHTML = `<div class="empty-note">${t('models.localEmpty')}</div>`;
    return;
  }
  list.innerHTML = state.local.map((m) => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(m.repo)}${m.external ? ` <span class="badge badge-neutral" title="${esc(t('models.externalTitle'))}">${esc(t('models.externalBadge'))}</span>` : ''}${m.settingsSummary ? ` <span class="badge badge-custom" title="${esc(t('ms.badgeTitle', { summary: m.settingsSummary }))}">${esc(t('ms.custom'))}</span>` : ''}</div>
        <div class="row-sub">${esc(m.file)} · ${esc(m.sizeLabel)}${m.quant ? ' · ' + esc(m.quant) : ''}${m.settingsSummary ? ' · ' + esc(m.settingsSummary) : ''}${m.external && m.sourceDir ? ' · ' + esc(t('models.fromFolder', { dir: m.sourceDir })) : ''}</div>
        <div class="fit-note" style="margin-top:4px">${esc(fitDetail(m.fit))}</div>
      </div>
      <div class="row-actions">
        ${fitBadge(m.fit)}
        <button class="btn btn-primary btn-sm" data-act="load-local" data-id="${esc(m.id)}">${esc(t('models.load'))}</button>
        <button class="btn btn-ghost btn-sm" data-act="model-settings" data-id="${esc(m.id)}" title="${esc(t('ms.title'))}" aria-label="${esc(t('ms.title'))}">⚙</button>
        <button class="btn btn-ghost btn-sm" data-act="reveal" data-path="${esc(m.path)}" title="${esc(t('models.revealTitle'))}">${esc(t('models.folder'))}</button>
        ${m.external ? '' : `<button class="btn btn-danger-ghost btn-sm" data-act="delete-local" data-id="${esc(m.id)}">${esc(t('common.delete'))}</button>`}
      </div>
    </div>`).join('');
}

async function refreshLocal() {
  try {
    state.local = await bridge.models.local();
    renderLocal();
  } catch (e) {
    $('#local-list').innerHTML = `<div class="empty-note">${esc(t('models.localError', { message: e.message }))}</div>`;
  }
}

// Zusätzliche Modellordner (Quelle der „Extern“-Modelle)
async function refreshModelSources() {
  try {
    state.modelSources = (await bridge.models.sources()) || [];
  } catch {
    state.modelSources = [];
  }
}

/* ------------------- Modellspezifische Einstellungen ------------------- */

const MS_NUM_FIELDS = [
  { key: 'ctx', label: 'ms.ctx', hint: 'ms.ctxHint', min: 512, max: 1048576, step: 512 },
  { key: 'gpuLayers', label: 'ms.gpuLayers', hint: 'ms.gpuLayersHint', min: 0, max: 999, step: 1 },
  { key: 'batchSize', label: 'ms.batchSize', min: 32, max: 8192, step: 32, adv: true },
  { key: 'ubatchSize', label: 'ms.ubatchSize', min: 16, max: 8192, step: 16, adv: true },
  { key: 'threads', label: 'ms.threads', min: 1, max: 256, step: 1, adv: true },
  { key: 'ropeFreqBase', label: 'ms.ropeFreqBase', min: 0, max: 10000000, step: 1000, adv: true },
  { key: 'ropeFreqScale', label: 'ms.ropeFreqScale', min: 0, max: 128, step: 0.125, adv: true },
];
const MS_BOOL_FIELDS = [
  { key: 'mlock', label: 'ms.mlock', adv: true },
  { key: 'noMmap', label: 'ms.noMmap', adv: true },
];

let msModel = null;
let msSchema = null;

/** Nur ausgefüllte Felder werden zu Overrides — leere Felder = Standard. */
function collectMsPatch() {
  const patch = {};
  for (const el of $$('#ms-fields [data-ms]')) {
    const key = el.dataset.ms;
    if (el.type === 'checkbox') { if (el.checked) patch[key] = true; continue; }
    const raw = el.value;
    if (raw === '' || raw === null || raw === undefined) continue;
    if (key === 'flashAttn') { patch.flashAttn = raw === 'on'; continue; }
    if (key === 'cacheTypeK' || key === 'cacheTypeV') { patch[key] = raw; continue; }
    const n = Number(raw);
    if (Number.isFinite(n)) patch[key] = n;
  }
  return patch;
}

function updateMsPreview() {
  const kv = window.KVCACHE;
  if (!kv || !msModel) return;
  const patch = collectMsPatch();
  const k = patch.cacheTypeK || kv.DEFAULT_CACHE;
  const v = patch.cacheTypeV || kv.DEFAULT_CACHE;
  const baseCtx = msModel.fitCtx || state.settings?.ctx || 8192;
  const ctx = patch.ctx !== undefined ? patch.ctx : baseCtx;
  const gb = kv.kvEstimateGB(msModel.kvBaseGB || 0, baseCtx, ctx, k, v);
  $('#ms-kv').textContent = t('ms.kvEstimate', { ctx, gb: gb.toFixed(2), pct: Math.round(kv.kvFactor(k, v) * 100) });
  const note = $('#ms-note');
  const notes = [];
  // Quantisierter V-Cache braucht Flash-Attention — das Backend erzwingt es.
  if (kv.isQuantized(v)) notes.push(t('ms.vNeedsFa'));
  // Über dem trainierten Kontextfenster wird die Qualität schlechter (RoPE kann helfen).
  if (msModel.nativeCtx && ctx > msModel.nativeCtx) notes.push(t('ms.ctxExceeds', { ctx: msModel.nativeCtx }));
  if (notes.length) { note.textContent = notes.join(' '); note.classList.remove('is-hidden'); }
  else { note.textContent = ''; note.classList.add('is-hidden'); }
}

function renderModelSettings(info) {
  const kv = window.KVCACHE;
  const stored = (info && info.stored) || {};
  const types = (msSchema && msSchema.cacheTypes) || kv.CACHE_TYPES;
  $('#ms-model').textContent = `${msModel.repo || ''} · ${msModel.file || basename(msModel.path || '')}`;
  const isLoaded = state.server.running && state.server.model === msModel.path;
  $('#ms-hint').textContent = t(isLoaded ? 'ms.hintLoaded' : 'ms.hint');

  const cacheOptions = (selected) => `<option value="">${esc(t('ms.default'))} (f16)</option>`
    + types.map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
  const faVal = stored.flashAttn === true ? 'on' : stored.flashAttn === false ? 'off' : '';
  const num = (f) => {
    // Beim Kontextfenster die native Größe des Modells mit anzeigen (aus der GGUF gelesen).
    let hint = f.hint ? t(f.hint) : '';
    if (f.key === 'ctx') {
      hint += ' — ' + (msModel.nativeCtx
        ? t('ms.nativeCtx', { ctx: msModel.nativeCtx })
        : t('ms.nativeCtxUnknown'));
    }
    return `<div class="ms-row">
      <label for="ms-${f.key}">${esc(t(f.label))}${hint ? `<span>${esc(hint)}</span>` : ''}</label>
      <input type="number" class="num-input" id="ms-${f.key}" data-ms="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}"
        value="${stored[f.key] !== undefined ? esc(stored[f.key]) : ''}" placeholder="${esc(t('ms.default'))}">
    </div>`;
  };
  const bool = (f) => `<div class="ms-row">
      <label for="ms-${f.key}">${esc(t(f.label))}</label>
      <input type="checkbox" id="ms-${f.key}" data-ms="${f.key}"${stored[f.key] ? ' checked' : ''}>
    </div>`;

  $('#ms-fields').innerHTML = `
    <div class="ms-section">${esc(t('ms.cacheSection'))}</div>
    <p class="ms-section-hint">${esc(t('ms.cacheHint'))}</p>
    <div class="ms-row">
      <label for="ms-cacheTypeK">${esc(t('ms.cacheK'))}</label>
      <select id="ms-cacheTypeK" data-ms="cacheTypeK">${cacheOptions(stored.cacheTypeK)}</select>
    </div>
    <div class="ms-row">
      <label for="ms-cacheTypeV">${esc(t('ms.cacheV'))}</label>
      <select id="ms-cacheTypeV" data-ms="cacheTypeV">${cacheOptions(stored.cacheTypeV)}</select>
    </div>
    <div class="ms-row">
      <label for="ms-flashAttn">${esc(t('ms.flashAttn'))}<span>${esc(t('ms.flashAttnHint'))}</span></label>
      <select id="ms-flashAttn" data-ms="flashAttn">
        <option value=""${faVal === '' ? ' selected' : ''}>${esc(t('ms.auto'))}</option>
        <option value="on"${faVal === 'on' ? ' selected' : ''}>${esc(t('ms.on'))}</option>
        <option value="off"${faVal === 'off' ? ' selected' : ''}>${esc(t('ms.off'))}</option>
      </select>
    </div>
    ${MS_NUM_FIELDS.filter((f) => !f.adv).map(num).join('')}
    <div class="ms-section">${esc(t('ms.advanced'))}</div>
    ${MS_NUM_FIELDS.filter((f) => f.adv).map(num).join('')}
    ${MS_BOOL_FIELDS.map(bool).join('')}`;

  for (const el of $$('#ms-fields [data-ms]')) {
    el.addEventListener('input', updateMsPreview);
    el.addEventListener('change', updateMsPreview);
  }
  updateMsPreview();
}

async function openModelSettings(model) {
  if (!model || !model.id) { toast(t('toast.noModelPath'), 'error'); return; }
  msModel = model;
  try {
    if (!msSchema) msSchema = await bridge.modelSettings.schema();
    const info = await bridge.modelSettings.get(model.id);
    renderModelSettings(info);
    $('#model-settings-dialog').showModal();
  } catch (err) { toast(err.message, 'error', 8000); }
}

async function saveModelSettings() {
  if (!msModel) return;
  try {
    const patch = collectMsPatch();
    await bridge.modelSettings.set(msModel.id, patch);
    const isLoaded = state.server.running && state.server.model === msModel.path;
    toast(t(isLoaded ? 'ms.savedLoaded' : 'ms.saved'), 'ok', 6000);
    $('#model-settings-dialog').close();
    await refreshLocal();
  } catch (err) { toast(err.message, 'error', 8000); }
}

async function resetModelSettings() {
  if (!msModel) return;
  try {
    await bridge.modelSettings.reset(msModel.id);
    toast(t('ms.resetDone'), 'ok', 5000);
    $('#model-settings-dialog').close();
    await refreshLocal();
  } catch (err) { toast(err.message, 'error', 8000); }
}

/** Zahnrad am Chat-Header: Einstellungen des gerade geladenen Modells. */
async function openLoadedModelSettings() {
  const path = state.server.model || (state.server.lastModel && state.server.lastModel.path);
  if (!path) return;
  let m = state.local.find((x) => x.path === path);
  if (!m) { await refreshLocal(); m = state.local.find((x) => x.path === path); }
  if (!m) {
    const lm = state.server.lastModel || {};
    m = { id: lm.id || path, path, repo: basename(path), file: basename(path), fit: lm.fit || null };
  }
  await openModelSettings(m);
}

/* ------------------- Server-Tab: API-Server für Agenten ------------------- */

async function refreshServerConfig() {
  try {
    const res = await bridge.server.config();
    state.serverConfig = res.config;
    state.serverInfo = res.info;
  } catch { /* beim allerersten Start noch nicht verfügbar */ }
}

/** Wirksame Zugangsdaten: im Betrieb zählt der laufende Server, sonst die Konfiguration. */
function serverAccess() {
  const cfg = state.serverConfig || { port: 1234, lan: false, apiKey: '', cors: true, parallel: 4 };
  const running = !!state.server.running;
  return {
    cfg,
    running,
    port: running ? (state.server.port || cfg.port) : cfg.port,
    lan: running ? !!state.server.lan : !!cfg.lan,
    apiKey: running ? (state.server.apiKey || '') : (cfg.apiKey || ''),
    ips: (state.serverInfo && state.serverInfo.ips) || [],
  };
}

/** Key maskiert darstellen: erste 6 Zeichen + '…' + letzte 4 (kurze Keys gar nicht). */
function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 12) return '••••••••';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

/** Neustart-Hinweis: nur wenn das Backend restartRequired meldet (ältere Backends kennen es nicht). */
function renderServerRestart() {
  const host = $('#srv-restart');
  if (!host) return;
  const info = state.serverInfo || {};
  if (info.restartRequired !== true) { host.innerHTML = ''; return; }
  host.innerHTML = `<p class="srv-restart">
      <span>${esc(t('server.restartRequired'))}</span>
      <button class="btn btn-ghost btn-sm" data-act="srv-restart">${esc(t('server.restartNow'))}</button>
    </p>`;
}

/** Key-Feld zwischen Klartext und Punkten umschalten (Anzeige, nicht der gespeicherte Wert). */
function toggleServerKeyVisibility() {
  const input = $('#srv-key');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  const btn = $('[data-act="srv-reveal"]');
  if (!btn) return;
  const label = t(show ? 'server.hideKey' : 'server.revealKey');
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.classList.toggle('is-on', show);
}

function renderServerStatus() {
  const pill = $('#srv-status');
  if (!pill) return;
  const running = !!state.server.running;
  const starting = !!state.server.starting;
  pill.className = `srv-pill ${running ? 'is-live' : starting ? 'is-loading' : 'is-off'}`;
  pill.textContent = running ? t('server.running') : starting ? t('server.starting') : t('server.stopped');
}

/** Warnung + Agenten-Karte auffrischen, ohne die Eingabefelder neu zu bauen (Fokus bleibt). */
function updateServerAccessUi() {
  renderServerStatus();
  renderServerRestart();
  const a = serverAccess();
  renderServerAgents();
  const start = $('#srv-start');
  const stop = $('#srv-stop');
  if (start) start.disabled = !!state.server.starting;
  if (stop) stop.disabled = !state.server.running || !!state.server.starting;
}

function renderServerAgents() {
  const box = $('#srv-agents');
  if (!box) return;
  const snip = window.SERVER_SNIPPETS;
  const a = serverAccess();
  const cfg = { port: a.port, apiKey: a.apiKey };
  const localUrl = snip.baseUrl('127.0.0.1', a.port);
  const lanUrls = a.lan ? a.ips.map((ip) => snip.baseUrl(ip, a.port)) : [];
  const firstLan = lanUrls[0] || null;
  const exampleIp = a.lan && firstLan ? firstLan.replace(/^http:\/\//, '').replace(/:\d+\/v1$/, '') : '127.0.0.1';

  // Kopierinhalte zentral ablegen — die Buttons referenzieren nur einen Schlüssel.
  state.srvCopy = {
    localUrl,
    lanUrl: firstLan || '',
    model: snip.MODEL_ALIAS,
    key: a.apiKey,
    curl: snip.curlExample(cfg, exampleIp),
    python: snip.pythonExample(cfg, exampleIp),
    json: snip.agentJson(cfg, exampleIp),
  };
  const copyBtn = (key) => `<button class="btn btn-ghost btn-sm" data-act="srv-copy" data-copy-key="${key}">${esc(t('server.copy'))}</button>`;
  const row = (label, value, key, hint, cls) => `
    <div class="srv-kv${cls ? ' ' + cls : ''}">
      <div class="srv-kv-label">${esc(label)}${hint ? `<span>${esc(hint)}</span>` : ''}</div>
      <code class="srv-value">${esc(value)}</code>
      ${value ? copyBtn(key) : ''}
    </div>`;
  const endpoints = (state.serverInfo && state.serverInfo.endpoints) || [];
  const snippet = (label, key) => `
    <div class="srv-snippet-head"><span>${esc(label)}</span>${copyBtn(key)}</div>
    <pre class="srv-snippet">${esc(state.srvCopy[key])}</pre>`;

  box.innerHTML = `
    <p class="srv-hint">${esc(t('server.agentsHint'))}</p>
    ${a.running ? '' : `<p class="srv-note">${esc(t('server.notRunningHint'))}</p>`}
    ${row(t('server.baseUrl'), localUrl, 'localUrl')}
    ${a.lan ? lanUrls.map((u, i) => row(`${t('server.baseUrlLan')}${lanUrls.length > 1 ? ' ' + (i + 1) : ''}`, u, i === 0 ? 'lanUrl' : '')).join('') : ''}
    ${row(t('server.modelName'), snip.MODEL_ALIAS, 'model', t('server.modelNameHint'))}
    ${a.apiKey ? row(t('server.apiKey'), maskSecret(a.apiKey), 'key', '', 'srv-kv-key') : ''}
    <div class="srv-kv">
      <div class="srv-kv-label">${esc(t('server.endpoints'))}</div>
      <div class="srv-endpoints">${endpoints.map((e) => `<code>${esc(e.method)} ${esc(e.path)}</code>`).join('')}</div>
    </div>
    ${snippet(t('server.exampleCurl'), 'curl')}
    ${snippet(t('server.examplePython'), 'python')}
    ${snippet(t('server.exampleJson'), 'json')}`;
}

function renderServerLogs() {
  const pre = $('#srv-log');
  if (!pre) return;
  const lines = state.serverLogs.slice(-200);
  pre.textContent = lines.length ? lines.map((l) => l.line).join('\n') : t('server.logsEmpty');
  pre.scrollTop = pre.scrollHeight;
}

function renderServer() {
  const body = $('#server-body');
  if (!body) return;
  const cfg = state.serverConfig || { port: 1234, lan: false, apiKey: '', cors: true, parallel: 4 };
  const models = state.local || [];
  if (!state.serverModelId) {
    const loaded = models.find((m) => m.path === state.server.model);
    state.serverModelId = (loaded && loaded.id) || (models[0] && models[0].id) || '';
  }
  const presetId = state.serverPreset || state.settings?.lastPreset || 'balanced';
  const modelOptions = models.map((m) => `<option value="${esc(m.id)}"${m.id === state.serverModelId ? ' selected' : ''}>${esc(m.repo)} · ${esc(m.file)}${m.external ? ` (${esc(t('models.externalBadge'))})` : ''}</option>`).join('');
  const presetOptions = (state.presets || []).map((p) => `<option value="${esc(p.id)}"${p.id === presetId ? ' selected' : ''}>${esc(p.name || p.id)}</option>`).join('');

  body.innerHTML = `
    <div class="card srv-card">
      <div class="card-title">${esc(t('server.model'))}</div>
      ${models.length ? `
      <div class="srv-controls">
        <select id="srv-model" class="srv-select" aria-label="${esc(t('server.model'))}">
          <option value="">${esc(t('server.modelPlaceholder'))}</option>${modelOptions}
        </select>
        <select id="srv-preset" class="srv-select srv-preset" aria-label="${esc(t('server.preset'))}">${presetOptions}</select>
        <button class="btn btn-primary" id="srv-start" data-act="srv-start">${esc(t('server.start'))}</button>
        <button class="btn btn-danger-ghost" id="srv-stop" data-act="srv-stop">${esc(t('server.stop'))}</button>
      </div>` : `<p class="srv-note">${esc(t('server.noModels'))}</p>`}
      <p class="srv-hint">${esc(t('server.chatUsesSame'))}</p>
    </div>

    <div class="card srv-card">
      <div class="card-title">${esc(t('server.access'))}</div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('server.port'))}</strong><span>${esc(t('server.portHint'))}</span></div>
        <input type="number" class="num-input" id="srv-port" min="1024" max="65535" step="1" value="${esc(cfg.port)}">
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('server.lan'))}</strong><span>${esc(t('server.lanHint'))}</span></div>
        <input type="checkbox" id="srv-lan"${cfg.lan ? ' checked' : ''}>
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('server.apiKey'))}</strong><span>${esc(t('server.apiKeyHint'))}</span></div>
        <input type="password" class="srv-key" id="srv-key" value="${esc(cfg.apiKey || '')}" placeholder="${esc(t('server.apiKeyPlaceholder'))}" autocomplete="off" spellcheck="false">
        <button class="btn btn-ghost btn-sm srv-key-eye" data-act="srv-reveal" aria-pressed="false" aria-label="${esc(t('server.revealKey'))}" title="${esc(t('server.revealKey'))}">👁</button>
        <button class="btn btn-ghost btn-sm" data-act="srv-genkey">${esc(t('server.generateKey'))}</button>
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('server.cors'))}</strong><span>${esc(t('server.corsHint'))}</span></div>
        <input type="checkbox" id="srv-cors"${cfg.cors !== false ? ' checked' : ''}>
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('server.corsOrigins'))}</strong><span>${esc(t('server.corsOriginsHint'))}</span></div>
        <input type="text" class="srv-key srv-origins" id="srv-cors-origins" value="${esc(cfg.corsOrigins || '')}" placeholder="${esc(t('server.corsOriginsPlaceholder'))}" autocomplete="off" spellcheck="false">
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('server.parallel'))}</strong><span>${esc(t('server.parallelHint'))}</span></div>
        <input type="number" class="num-input" id="srv-parallel" min="1" max="64" step="1" value="${esc(cfg.parallel)}">
      </div>
      <p class="srv-hint">${esc(t('server.applyHint'))}</p>
      <div id="srv-restart"></div>
    </div>

    <div class="card srv-card">
      <div class="card-title">${esc(t('server.agents'))}</div>
      <div id="srv-agents"></div>
    </div>

    <div class="card srv-card">
      <div class="card-title">${esc(t('server.logs'))}</div>
      <pre class="srv-log" id="srv-log"></pre>
    </div>`;

  // Eingaben wirken sofort (change/blur), nicht bei jedem Tastendruck.
  const port = $('#srv-port');
  const parallel = $('#srv-parallel');
  const key = $('#srv-key');
  if (port) port.addEventListener('change', () => applyServerConfig({ port: Number(port.value) }));
  if (parallel) parallel.addEventListener('change', () => applyServerConfig({ parallel: Number(parallel.value) }));
  if (key) key.addEventListener('change', () => applyServerConfig({ apiKey: key.value }));
  const lan = $('#srv-lan');
  const cors = $('#srv-cors');
  if (lan) lan.addEventListener('change', () => applyServerConfig({ lan: lan.checked }));
  if (cors) cors.addEventListener('change', () => applyServerConfig({ cors: cors.checked }));
  const corsOrigins = $('#srv-cors-origins');
  if (corsOrigins) corsOrigins.addEventListener('change', () => applyServerConfig({ corsOrigins: corsOrigins.value.trim() }));
  const modelSel = $('#srv-model');
  if (modelSel) modelSel.addEventListener('change', () => { state.serverModelId = modelSel.value; });
  const presetSel = $('#srv-preset');
  if (presetSel) presetSel.addEventListener('change', () => { state.serverPreset = presetSel.value; });

  renderServerAgents();
  renderServerLogs();
  updateServerAccessUi();
}

async function refreshServerView() {
  await Promise.all([refreshServerConfig(), refreshLocal()]);
  renderServer();
}

async function applyServerConfig(patch) {
  try {
    const res = await bridge.server.setConfig(patch);
    state.serverConfig = res.config;
    state.serverInfo = res.info;
    state.settings = { ...(state.settings || {}), server: res.config };
    updateServerAccessUi();
  } catch (err) { toast(err.message, 'error', 8000); }
}

async function startServerFromTab() {
  const model = state.local.find((m) => m.id === state.serverModelId);
  if (!model) { toast(t('server.selectModelFirst'), 'error', 6000); return; }
  await loadModel(model, { presetOverride: state.serverPreset || undefined, stay: true });
}

async function stopServerFromTab() {
  await unloadModel(true);
  toast(t('server.stoppedToast'), 'ok', 4000);
  await refreshServerConfig();
  renderServer();
}

/** Server mit der gespeicherten Konfiguration neu starten (Änderungen greifen nur beim Start). */
async function restartServerFromTab() {
  if (!state.server.running) {
    await refreshServerConfig();
    renderServer();
    toast(t('server.notRunningHint'), 'error', 6000);
    return;
  }
  const modelId = state.serverModelId;
  const preset = state.serverPreset || undefined;
  const model = state.local.find((m) => m.id === modelId);
  await unloadModel(true);
  await refreshServerConfig();
  if (!model) {
    renderServer();
    toast(t('server.selectModelFirst'), 'error', 6000);
    return;
  }
  await loadModel(model, { presetOverride: preset, stay: true });
  await refreshServerConfig();
  renderServer();
  toast(t('server.restartedToast'), 'ok', 4000);
}

async function generateServerKey() {
  try {
    const res = await bridge.server.generateKey();
    const input = $('#srv-key');
    if (input) input.value = res.key;
    await applyServerConfig({ apiKey: res.key });
    toast(t('server.keyGenerated'), 'ok', 4000);
  } catch (err) { toast(err.message, 'error', 8000); }
}

async function copyServerValue(key) {
  const text = (state.srvCopy || {})[key];
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(t('server.copied'), 'ok', 1800);
  } catch { toast(text, 'info', 6000); }
}

function appendServerLog(entry) {
  state.serverLogs.push(entry);
  if (state.serverLogs.length > 400) state.serverLogs = state.serverLogs.slice(-400);
  if (state.view === 'server') renderServerLogs();
}

/* --------------------------- Setup --------------------------- */

function renderSetup() {
  const body = $('#setup-body');
  const hw = state.hw;
  if (!hw) { body.innerHTML = `<div class="empty-note">${esc(t('sidebar.detecting'))}</div>`; return; }
  const gpus = hw.gpus || [];
  const npus = hw.npus || [];
  const installed = (state.backends && state.backends.installed) || [];
  const available = (state.backends && state.backends.available) || [];
  const rec = hw.recommendation || { primary: null, candidates: [] };
  const recBackend = available.find((b) => b.id === rec.primary);

  const gpuHtml = gpus.length
    ? gpus.map((g) => `
        <div class="hw-card">
          <div class="hw-label">${esc(t('setup.graphics'))}</div>
          <div class="hw-value">${esc(g.name)}</div>
          <div class="hw-sub">${esc(g.vendor)}${g.vramLabel ? ' · ' + esc(t('setup.vram', { label: g.vramLabel })) : ''}${g.vramApprox ? ' ' + esc(t('setup.estimated')) : ''}${g.driver ? ' · ' + esc(t('setup.driver', { version: g.driver })) : ''}</div>
        </div>`).join('')
    : `<div class="hw-card"><div class="hw-label">${esc(t('setup.graphics'))}</div><div class="hw-value">${esc(t('setup.noGpu'))}</div><div class="hw-sub">${esc(t('setup.noGpuHint'))}</div></div>`;

  const npuHtml = npus.length
    ? `<div class="npu-note">
        <strong>${esc(t('setup.npuFound'))}</strong> ${npus.map((n) => esc(n.name)).join(', ')}.
        ${npus.some((n) => n.usableBy === 'openvino')
          ? esc(t('setup.npuOpenvino'))
          : npus.some((n) => n.usableBy === 'ryzenai')
            ? esc(t('setup.npuRyzenai'))
            : esc(t('setup.npuUnusable'))}
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
              ${b.recommended ? `<span class="badge badge-gpu">${esc(t('setup.recommendedBadge'))}</span>` : ''}
              ${b.experimental ? `<span class="badge badge-exp">${esc(t('setup.experimentalBadge'))}</span>` : ''}
              ${b.npu ? '<span class="badge badge-exp">NPU</span>' : ''}
              ${isInst ? `<span class="badge badge-neutral">${esc(t('setup.installedBadge'))}</span>` : ''}
            </div>
            <div class="backend-note">${esc(i18n.backendNote(b.id, b.note))}${b.reason ? ' — ' + esc(i18n.reasonText(b.reason, b.reason)) : ''}</div>
            ${inst ? `<div class="progress"><div class="progress-fill" style="width:${inst.percent || 0}%"></div></div>
                      <div class="progress-label"><span>${esc(inst.file || inst.phase || '')}</span><span>${inst.percent ? inst.percent.toFixed(0) + '%' : ''}</span></div>` : ''}
          </div>
          <div class="backend-side">
            <span class="card-size">${esc(b.sizeLabel || '')}</span>
            ${isInst
              ? `<button class="btn btn-ghost btn-sm" data-act="remove-backend" data-id="${esc(b.id)}">${esc(t('setup.remove'))}</button>`
              : `<button class="btn btn-primary btn-sm" data-act="install-backend" data-id="${esc(b.id)}" ${inst ? 'disabled' : ''}>${esc(t('setup.install'))}</button>`}
          </div>
        </div>`;
      }).join('')
    : `<div class="empty-note">${state.backends && state.backends.error ? esc(t('setup.backendListError', { message: state.backends.error })) : esc(t('setup.backendListLoading'))}</div>`;

  const langOptions = i18n.LANGS
    .map((l) => `<option value="${esc(l.id)}" ${l.id === i18n.getLang() ? 'selected' : ''}>${esc(l.label)}</option>`)
    .join('');

  const onboardingHtml = state.settings && state.settings.onboardingDone === false
    ? `<section class="setup-section" id="onboarding-card">
        <h3 class="section-title">${esc(t('setup.welcomeTitle'))}</h3>
        <div class="settings-row">
          <div class="settings-label"><strong>${esc(t('setup.language'))}</strong><span>${esc(t('setup.welcomeText'))}</span></div>
          <select class="select" id="onboard-language" aria-label="${esc(t('setup.language'))}">${langOptions}</select>
          <button class="btn btn-primary btn-sm" data-act="onboarding-done">${esc(t('setup.welcomeContinue'))}</button>
        </div>
      </section>`
    : '';

  body.innerHTML = `
    ${onboardingHtml}
    <section class="setup-section">
      <h3 class="section-title">${esc(t('setup.yourSystem'))}</h3>
      <div class="hw-grid">
        <div class="hw-card">
          <div class="hw-label">${esc(t('setup.system'))}</div>
          <div class="hw-value">${esc(hw.osName)}</div>
          <div class="hw-sub">${esc(hw.arch)} · ${esc(t('setup.threads', { count: hw.cpuCores }))}</div>
        </div>
        <div class="hw-card">
          <div class="hw-label">${esc(t('setup.cpu'))}</div>
          <div class="hw-value">${esc(hw.cpuModel)}</div>
          <div class="hw-sub">${esc(t('setup.cores', { count: hw.cpuCores }))}</div>
        </div>
        <div class="hw-card">
          <div class="hw-label">${esc(t('setup.memory'))}</div>
          <div class="hw-value">${esc(hw.totalMemGB)} GB</div>
          <div class="hw-sub">${esc(t('setup.freeMem', { size: hw.freeMemGB }))}</div>
        </div>
        ${gpuHtml}
      </div>
      <div style="margin-top:12px">${npuHtml}</div>
      ${hw.notes && hw.notes.length ? `<ul class="hw-list" style="margin-top:10px">${hw.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </section>

    <section class="setup-section">
      <h3 class="section-title">${esc(t('setup.backendSection'))}</h3>
      ${recBackend ? `<div class="rec-banner">
        <div class="rec-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m13 2-9 12h6l-1 8 9-12h-6l1-8Z"></path></svg>
        </div>
        <div><strong>${esc(t('setup.recommendation', { name: recBackend.label }))}</strong>
        <span>${esc(t('setup.recommendationMeta', {
          reason: i18n.reasonText(recBackend.reason, i18n.backendNote(recBackend.id, recBackend.note)),
          size: recBackend.sizeLabel || '',
        }))}</span></div>
      </div>` : ''}
      ${backendCards}
      ${state.backends && state.backends.release ? `<div class="muted" style="margin-top:8px">${esc(t('setup.releaseInfo', { tag: state.backends.release.tag, count: state.backends.installed.length }))}</div>` : ''}
    </section>

    <section class="setup-section">
      <h3 class="section-title">${esc(t('setup.settings'))}</h3>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('setup.language'))}</strong><span>${esc(t('setup.languageHint'))}</span></div>
        <select class="select" id="set-language" aria-label="${esc(t('setup.language'))}">${langOptions}</select>
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('setup.modelsDir'))}</strong><span>${esc(t('setup.modelsDirHint'))}</span></div>
        <div class="path-box">${esc(state.settings?.modelsDir || '')}</div>
        <button class="btn btn-ghost btn-sm" data-act="pick-models">${esc(t('setup.change'))}</button>
        <button class="btn btn-ghost btn-sm" data-act="open-models">${esc(t('setup.open'))}</button>
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('setup.extraDirs'))}</strong><span>${esc(t('setup.extraDirsHint'))}</span></div>
        <button class="btn btn-primary btn-sm" data-act="add-source">${esc(t('setup.addSource'))}</button>
      </div>
      ${state.modelSources.length ? state.modelSources.map((s) => `
      <div class="settings-row">
        <div class="path-box">${esc(s.dir)}${s.exists ? '' : ` — ${esc(t('setup.sourceMissing'))}`}</div>
        <button class="btn btn-ghost btn-sm" data-act="remove-source" data-dir="${esc(s.dir)}">${esc(t('setup.removeSource'))}</button>
      </div>`).join('') : `<div class="settings-row"><div class="muted">${esc(t('setup.noSources'))}</div></div>`}
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('setup.ctxLabel'))}</strong><span>${esc(t('setup.ctxHint'))}</span></div>
        <input type="number" class="num-input" id="set-ctx" min="1024" max="131072" step="1024" value="${esc(state.settings?.ctx || 8192)}">
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('setup.gpuLayersLabel'))}</strong><span>${esc(t('setup.gpuLayersHint'))}</span></div>
        <input type="number" class="num-input" id="set-ngl" min="0" max="999" step="1" value="${esc(state.settings?.gpuLayers ?? 999)}">
      </div>
      <div class="settings-row">
        <div class="settings-label"><strong>${esc(t('setup.debugLogLabel'))}</strong><span>${esc(t('setup.debugLogHint'))}</span></div>
        <input type="checkbox" id="set-debuglog" ${state.settings?.debugLog ? 'checked' : ''}>
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
  $('#btn-models-folder').addEventListener('click', () => ipc(bridge.shell.showModels()));
  $('#btn-check-update').addEventListener('click', async () => {
    try {
      const info = await bridge.update.check();
      if (info.updateAvailable) showUpdateDialog({ ...info, currentVersion: state.info?.version });
      else toast(t('toast.upToDate', { version: state.info?.version || '?' }), 'ok', 2600);
    } catch (e) {
      toast(t('toast.updateCheckFailed', { message: e.message }), 'error', 6000);
    }
  });
  $('#update-now').addEventListener('click', startUpdateDownload);
  $('#ms-save').addEventListener('click', saveModelSettings);
  $('#ms-reset').addEventListener('click', resetModelSettings);
  $('#update-dialog').addEventListener('close', () => {
    const val = $('#update-dialog').returnValue;
    $('#update-dialog').returnValue = '';
    if (val === 'open' && stateUpdate.assetPath) {
      bridge.update.openFile(stateUpdate.assetPath).catch((e) => toast(e.message, 'error'));
    } else if (val === 'releases') {
      ipc(bridge.update.openReleases());
    }
  });
  $('#btn-rescan').addEventListener('click', async () => {
    toast(t('toast.rescanning'), 'info', 1800);
    try {
      state.hw = await bridge.hw.scan(true);
      state.backends = await bridge.backends.list();
      renderSetup(); renderSidebar(); refreshCatalog();
    } catch (err) { toast(err.message, 'error', 7000); }
  });

  $('#preset-select').addEventListener('change', async (e) => {
    const preset = e.target.value;
    state.server.preset = preset;
    try {
      await bridge.settings.set({ lastPreset: preset });
    } catch { /* Preset gilt trotzdem für diese Sitzung */ }
    if (state.settings) state.settings.lastPreset = preset;
    const p = state.presets.find((x) => x.id === preset);
    toast(t('toast.preset', { name: p ? presetName(p) : preset }), 'ok', 1800);
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
    if (a) { e.preventDefault(); ipc(bridge.shell.openExternal(a.dataset.ext)); return; }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'download-catalog') {
      const repo = btn.dataset.repo;
      const entry = state.catalog.find((c) => c.repo === repo);
      if (!entry) {
        toast(t('toast.modelUnavailable', { repo }), 'error', 7000);
        if (btn) btn.disabled = true;
        return;
      }
      if (entry.onnx || entry.isOnnx) {
        // ONNX-/OGA-Eintrag: ganzer Ordner (genai_config.json + *.onnx) statt Einzeldatei
        startDownload(repo, null, btn, { isOnnx: true, onnxSub: entry.onnxSub });
        return;
      }
      if (!entry.file) {
        // Kein Download, wenn keine nutzbare Datei (Bad Connection / nicht verfügbar):
        // dem User sichtbar melden statt still zu schweigen.
        toast(t('toast.fileUnavailable', { repo: entry.name || repo }), 'error', 8000);
        if (btn) btn.disabled = true;
        return;
      }
      startDownload(repo, entry.file.name, btn);
    }
    if (act === 'download-search-onnx') {
      // ONNX-/Ryzen-AI-Treffer aus der Suche: kompletter Ordner (Repo-Root)
      startDownload(btn.dataset.repo, null, btn, { isOnnx: true, onnxSub: null });
      return;
    }
    if (act === 'download-file') {
      if (!btn?.dataset?.file) {
        toast(t('toast.fileUnavailable', { repo: btn?.dataset?.repo || '' }), 'error', 8000);
        return;
      }
      startDownload(btn.dataset.repo, btn.dataset.file, btn);
    }
    if (act === 'load-catalog') {
      const m = state.local.find((l) => l.repo === btn.dataset.repo);
      if (m) loadModel(m);
      else toast(t('toast.modelMissing'), 'error');
    }
    if (act === 'load-local') {
      const m = state.local.find((l) => l.id === btn.dataset.id);
      if (m) loadModel(m);
    }
    if (act === 'reveal') { ipc(bridge.models.reveal(btn.dataset.path)); }
    if (act === 'delete-local') {
      const m = state.local.find((l) => l.id === btn.dataset.id);
      if (!m) return;
      const ok = await confirmDialog({
        title: t('models.deleteTitle'),
        message: `${m.file}\n${m.sizeLabel}`,
        okLabel: t('common.delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await bridge.models.delete(m.id);
        toast(t('toast.modelDeleted'), 'ok');
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
        toast(t('toast.backendInstalled', { id }), 'ok');
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
        title: t('setup.removeBackendTitle'),
        message: t('setup.removeBackendMessage', { id }),
        okLabel: t('setup.remove'),
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
      try {
        const dir = await bridge.dialog.pickFolder();
        if (!dir) return;
        state.settings = await bridge.settings.set({ modelsDir: dir });
        renderSetup();
        toast(t('toast.modelsDirChanged'), 'ok');
      } catch (err) { toast(err.message, 'error', 7000); }
    }
    if (act === 'model-settings') {
      const m = state.local.find((x) => x.id === btn.dataset.id);
      if (m) await openModelSettings(m);
    }
    if (act === 'model-settings-loaded') { await openLoadedModelSettings(); }
    if (act === 'srv-start') { await startServerFromTab(); }
    if (act === 'srv-stop') { await stopServerFromTab(); }
    if (act === 'srv-genkey') { await generateServerKey(); }
    if (act === 'srv-reveal') { toggleServerKeyVisibility(); }
    if (act === 'srv-restart') { await restartServerFromTab(); }
    if (act === 'srv-copy') { await copyServerValue(btn.dataset.copyKey); }
    if (act === 'open-models') { ipc(bridge.shell.showModels()); }
    if (act === 'add-source') {
      try {
        const res = await bridge.models.addSource();
        if (res && !res.canceled) {
          toast(t('toast.sourceAdded', { count: res.count }), 'ok', 6000);
          await refreshModelSources();
          await refreshLocal();
          renderSetup();
        }
      } catch (err) { toast(err.message, 'error', 8000); }
    }
    if (act === 'remove-source') {
      try {
        await bridge.models.removeSource(btn.dataset.dir);
        toast(t('toast.sourceRemoved'), 'ok', 5000);
        await refreshModelSources();
        await refreshLocal();
        renderSetup();
      } catch (err) { toast(err.message, 'error', 8000); }
    }
    if (act === 'onboarding-done') {
      try {
        state.settings = await bridge.settings.set({ onboardingDone: true });
        renderSetup();
      } catch (err) { toast(err.message, 'error', 7000); }
    }
  });

  // Settings-Inputs (delegiert, weil neu gerendert)
  document.addEventListener('change', async (e) => {
    try {
      if (e.target.id === 'set-ctx') {
        // Ober- UND Untergrenze durchsetzen: das max-Attribut allein hält keine
        // manuell eingetippte Zahl ab — ein zu großer ctx sprengt den KV-Cache.
        const val = Math.min(131072, Math.max(1024, parseInt(e.target.value, 10) || 8192));
        e.target.value = String(val);
        state.settings = await bridge.settings.set({ ctx: val });
        toast(t('toast.ctx', { value: val }), 'ok', 1800);
        refreshCatalog();
      }
      if (e.target.id === 'set-ngl') {
        const val = Math.min(999, Math.max(0, parseInt(e.target.value, 10) || 0));
        e.target.value = String(val);
        state.settings = await bridge.settings.set({ gpuLayers: val });
        toast(t('toast.gpuLayers', { value: val }), 'ok', 1800);
      }
      if (e.target.id === 'set-debuglog') {
        const val = !!e.target.checked;
        state.settings = await bridge.settings.set({ debugLog: val });
        toast(t('toast.debugLog', { value: val ? 'an' : 'aus' }), 'ok', 1800);
      }
      if (e.target.id === 'set-language' || e.target.id === 'onboard-language') {
        await setLanguage(e.target.value);
      }
    } catch (err) {
      toast(t('common.error', { message: err.message }), 'error', 7000);
    }
  });

  // Fortschritts-Events
  bridge.on('download:progress', (p) => {
    if (!p || !p.downloadId) return;
    const prev = state.downloads.get(p.downloadId) || {};
    state.downloads.set(p.downloadId, { ...prev, ...p });
    if (p.phase === 'done') {
      // Toast, Refresh und Tab-Wechsel macht bereits startDownload — hier nur
      // den Fortschritts-Eintrag entfernen, sonst erscheint alles doppelt.
      state.downloads.delete(p.downloadId);
    } else if (p.phase === 'error') {
      state.downloads.delete(p.downloadId);
      toast(p.message || t('toast.downloadFailed'), 'error', 8000);
      renderCatalog();
    } else {
      // Gezielt nur die betroffene Karte/Zeile aktualisieren (kein Voll-Rerender).
      // Kein CSS-Selektor mit Repo-Namen: Sonderzeichen könnten ihn brechen.
      const card = $$('.card').find((c) => c.dataset.repo === p.repo);
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
      txt.textContent = p.doneBytes
        ? t('update.progressOf', { done: fmtGB(p.doneBytes), total: fmtGB(p.totalBytes) })
        : t('update.downloading');
    }
  });

  bridge.on('server:log', (entry) => {
    if (!entry) return;
    appendServerLog(entry);
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
      // Zugangsdaten des laufenden Servers (für Chat-Header und Server-Tab)
      state.server.apiKey = st.apiKey || '';
      state.server.host = st.host || '127.0.0.1';
      state.server.lan = !!st.lan;
      if (st.preset) state.server.preset = st.preset;
      if (!state.server.lastModel) {
        state.server.lastModel = { path: st.model, id: null, fit: null };
      }
    } else if (!state.server.starting) {
      state.server.running = false;
    }
    renderChatState();
    restoreComposerFocus();
    if (state.view === 'server') updateServerAccessUi();
  });
}

async function startDownload(repo, file, btn, opts = {}) {
  const isOnnx = !!opts.isOnnx;
  const id = isOnnx ? `${repo}::onnx` : `${repo}::${file}`;
  const label = isOnnx ? t('models.onnxFolder') : file;
  state.downloads.set(id, { downloadId: id, phase: 'download', percent: 0, file: label });
  if (btn) {
    btn.disabled = true;
    const row = btn.closest('.row');
    if (row) applyProgress(row.querySelector('.row-main') || row, { percent: 0, file: label });
  }
  try {
    const result = await bridge.models.download(repo, file, {
      isOnnx,
      onnxSub: opts.onnxSub,
      downloadId: id,
    });
    state.downloads.delete(id);
    await refreshLocal();
    await refreshCatalog();
    if (isOnnx) {
      toast(t('toast.onnxDownloadFinished', { file: result.file, size: result.sizeLabel, files: result.files }), 'ok', 6000);
    } else {
      toast(t('toast.downloadFinished', { file: result.file, size: result.sizeLabel }), 'ok', 5000);
    }
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
    i18n.setLang(state.settings && state.settings.language ? state.settings.language : i18n.DEFAULT_LANG);
    applyStaticText();
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

    refreshModelSources();
    refreshServerConfig();
    refreshLocal();
    refreshCatalog();

    bridge.backends.list().then((b) => {
      state.backends = b;
      renderSidebar();
      if (state.view === 'setup') renderSetup();
      if (!b.installed || !b.installed.length) {
        setView('setup');
        toast(t('toast.welcome'), 'info', 7000);
      }
    }).catch((e) => {
      state.backends = { available: [], installed: [], error: e.message };
      if (state.view === 'setup') renderSetup();
    });

    state.booted = true;
  } catch (e) {
    toast(t('toast.startError', { message: e.message }), 'error', 10000);
  }
}

document.addEventListener('DOMContentLoaded', init);
