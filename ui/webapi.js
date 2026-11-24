/* Web-Brücke für den headless Betrieb (`model-harbor serve`).
 *
 * In der Desktop-App liefert das Electron-Preload `window.api` über IPC. Im
 * Browser gibt es kein Preload — dieses Skript baut dieselbe Oberfläche
 * (`window.api.<bereich>.<methode>()`) auf HTTP: jeder Aufruf geht als
 * {channel, args} an /api/invoke, Live-Ereignisse kommen über Server-Sent Events.
 *
 * Dadurch bleibt `ui/app.js` unverändert für beide Betriebsarten zuständig —
 * eine Oberfläche, zwei Transporte. Ist bereits ein `window.api` vorhanden
 * (Electron), tut dieses Skript nichts. */
(function (root) {
  'use strict';
  if (!root || typeof root.fetch !== 'function') return;
  if (root.api) return;

  // Muss zu electron/preload.js (ALLOWED_EVENTS) und cli/web/server.js passen:
  // die Oberfläche abonniert dieselben Kanäle, egal über welchen Transport sie läuft.
  const EVENTS = [
    'download:progress', 'backend:progress', 'server:state', 'server:log',
    'update:available', 'update:progress',
  ];
  const Params = root.URLSearchParams;
  const params = Params ? new Params(root.location.search) : null;
  const fromUrl = (params && params.get('token')) || '';
  const storageKey = 'modelharbor.token';
  let token = fromUrl;
  try {
    if (fromUrl) root.localStorage.setItem(storageKey, fromUrl);
    else token = root.localStorage.getItem(storageKey) || '';
  } catch { /* Privatmodus ohne localStorage */ }

  function headers() {
    const head = { 'Content-Type': 'application/json' };
    if (token) head['X-MH-Token'] = token;
    return head;
  }

  async function invoke(channel, ...args) {
    let res;
    try {
      res = await root.fetch('/api/invoke', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ channel, args }),
      });
    } catch (e) {
      throw new Error(`Server nicht erreichbar: ${e.message}`);
    }
    let data = null;
    try { data = await res.json(); } catch { /* leer */ }
    if (!data) throw new Error(`HTTP ${res.status} ohne Antwort`);
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.result;
  }

  const listeners = new Map();
  let source = null;

  function connect() {
    if (source || typeof root.EventSource !== 'function') return;
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    source = new root.EventSource(`/api/events${query}`);
    for (const event of EVENTS) {
      source.addEventListener(event, (msg) => {
        let payload = null;
        try { payload = JSON.parse(msg.data); } catch { /* leer */ }
        for (const fn of listeners.get(event) || []) {
          try { fn(payload); } catch { /* ein Zuhörer darf nichts kippen */ }
        }
      });
    }
  }

  function on(channel, callback) {
    if (!EVENTS.includes(channel)) throw new Error(`Unerlaubter Event-Kanal: ${channel}`);
    if (!listeners.has(channel)) listeners.set(channel, []);
    listeners.get(channel).push(callback);
    connect();
    return () => {
      const list = listeners.get(channel) || [];
      const i = list.indexOf(callback);
      if (i >= 0) list.splice(i, 1);
    };
  }

  const notInBrowser = (what) => async () => {
    throw new Error(`${what} gibt es nur in der Desktop-App.`);
  };

  root.api = {
    // Transport-Kennzeichen: Oberfläche und Tests können unterscheiden, ob sie über
    // IPC (Desktop) oder HTTP (headless Server) mit dem Kern sprechen.
    __via: 'http',
    info: () => invoke('app:info'),
    settings: {
      get: () => invoke('settings:get'),
      set: (patch) => invoke('settings:set', patch),
    },
    hw: { scan: (force) => invoke('hw:scan', force) },
    presets: () => invoke('presets:list'),
    backends: {
      list: () => invoke('backends:list'),
      install: (id) => invoke('backends:install', id),
      remove: (id) => invoke('backends:remove', id),
    },
    models: {
      catalog: () => invoke('models:catalog'),
      search: (q) => invoke('models:search', q),
      files: (repo) => invoke('models:files', repo),
      download: (repo, file, opts) => invoke('models:download', { repo, file, ...(opts || {}) }),
      local: () => invoke('models:local'),
      delete: (id) => invoke('models:delete', id),
      reveal: notInBrowser('„Im Ordner zeigen“'),
      sources: () => invoke('models:sources'),
      addSource: notInBrowser('Einen Ordner auswählen'),
      removeSource: (dir) => invoke('models:removeSource', dir),
    },
    modelSettings: {
      schema: () => invoke('modelSettings:schema'),
      get: (modelId) => invoke('modelSettings:get', modelId),
      set: (modelId, patch) => invoke('modelSettings:set', modelId, patch),
      reset: (modelId) => invoke('modelSettings:reset', modelId),
    },
    server: {
      start: (opts) => invoke('server:start', opts),
      stop: () => invoke('server:stop'),
      config: () => invoke('server:config'),
      setConfig: (patch) => invoke('server:setConfig', patch),
      generateKey: () => invoke('server:generateKey'),
      state: () => invoke('server:state'),
    },
    attachments: {
      pick: notInBrowser('Der Datei-Dialog'),
      // Lokaler Pfad-Zugriff: im headless Betrieb liest der Server die Datei
      // (funktioniert, solange Browser und Server dieselbe Maschine meinen).
      read: (paths) => invoke('attachments:read', paths),
      pathForFile: () => '',
    },
    bench: {
      list: () => invoke('bench:list'),
      add: (entry) => invoke('bench:add', entry),
      remove: (id) => invoke('bench:remove', id),
      clear: () => invoke('bench:clear'),
    },
    dialog: { pickFolder: notInBrowser('Die Ordnerauswahl') },
    shell: {
      openExternal: async (url) => {
        if (!/^https?:\/\//i.test(url)) return false;
        root.open(url, '_blank', 'noopener');
        return true;
      },
      showModels: notInBrowser('„Im Ordner zeigen“'),
    },
    update: {
      check: async () => null,
      download: notInBrowser('Der eingebaute Updater'),
      openFile: notInBrowser('Der eingebaute Updater'),
      openReleases: async () => { root.open('https://github.com/Goitonthefloor/modelharbor/releases', '_blank', 'noopener'); return true; },
    },
    on,
  };
})(typeof window !== 'undefined' ? window : undefined);
