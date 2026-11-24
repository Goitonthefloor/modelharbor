'use strict';
/* Gemeinsamer Kern für CLI und Web-Oberfläche.
 *
 * Die Desktop-App verdrahtet dieselben Bausteine in electron/main.js über IPC.
 * Hier gibt es statt IPC eine Kanaltabelle (`invoke`), damit
 *   - das Zahlenmenü der CLI,
 *   - die Subkommandos (model-harbor models/backends/serve …) und
 *   - die REST-Bridge des Web-Servers (ui/webapi.js)
 * exakt dieselbe Logik benutzen. Keine zweite Wahrheit für Pfade, Fit-Werte,
 * Backend-Wahl oder Serverstart.
 *
 * Bewusst frei von Electron-Abhängigkeiten: die Desktop-Module unter electron/
 * sind reine Node-Module, nur main.js und preload.js brauchen Electron. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const cfg = require('./config');
const { userDataDir } = require('./paths');
const models = require('../electron/models');
const backends = require('../electron/backends');
const hardware = require('../electron/hardware');
const server = require('../electron/server');
const sc = require('../electron/server-config');
const ms = require('../electron/model-settings');
const benchmarks = require('../electron/benchmarks');
const attachments = require('../electron/attachments');

const HW_CACHE_MS = 30000;

function createCore(options = {}) {
  const base = options.base || userDataDir();
  const listeners = new Map();
  let settings = cfg.load(base);
  let hwCache = null;
  let hwCacheTime = 0;
  let activeDownload = null;
  let modelSettingsStore = null;

  function emit(event, payload) {
    for (const fn of listeners.get(event) || []) {
      try { fn(payload); } catch { /* ein kaputter Zuhörer darf nichts kippen */ }
    }
  }

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return () => {
      const list = listeners.get(event) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /* --------------------------- Pfade & Einstellungen --------------------------- */

  function modelRoots() {
    return [settings.modelsDir, ...(settings.extraModelDirs || [])].filter(Boolean);
  }

  function modelSettingsFile() { return path.join(base, 'model-settings.json'); }

  function modelSettings() {
    if (!modelSettingsStore) modelSettingsStore = ms.readStore(modelSettingsFile());
    return modelSettingsStore;
  }

  function resolveModelSettings(modelId, call = {}) {
    const key = ms.modelKey(modelId);
    return ms.resolve({
      global: { ctx: settings.ctx, gpuLayers: settings.gpuLayers },
      model: modelSettings()[key] || {},
      call,
    });
  }

  async function saveSettings(patch) {
    settings = await cfg.save(base, patch);
    emit('settings', settings);
    return settings;
  }

  async function scanHardwareCached(force = false) {
    const now = Date.now();
    if (!force && hwCache && now - hwCacheTime < HW_CACHE_MS) return hwCache;
    hwCache = await hardware.scanHardware();
    hwCacheTime = now;
    return hwCache;
  }

  /** Modellpfad muss aus einem eingerichteten Modellordner stammen. */
  function withinAnyRoot(roots, candidate) {
    const target = path.resolve(String(candidate || ''));
    for (const root of roots) {
      const rel = path.relative(path.resolve(root), target);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return target;
    }
    throw new Error(`Pfad liegt außerhalb der Modellordner: ${candidate}`);
  }

  function isOnnxModelDir(dir) {
    try { return fs.existsSync(path.join(dir, 'genai_config.json')); } catch { return false; }
  }

  function serverInfo() {
    const config = sc.resolve(settings.server);
    const state = server.getState();
    const info = sc.connectionInfo(config, sc.lanAddresses());
    return {
      ...info,
      // `baseUrl` ist die Adresse, die die Oberfläche zum Verbinden anzeigt;
      // connectionInfo liefert sie als `localUrl`.
      baseUrl: info.localUrl,
      config,
      state: { running: state.running, port: state.port, modelPath: state.modelPath || null },
      examples: {
        curl: sc.curlExample(config),
        python: sc.pythonExample(config),
      },
    };
  }

  /* --------------------------- Kanaltabelle --------------------------- */

  const channels = {
    'app:info': () => ({
      version: options.version || require('../package.json').version,
      platform: process.platform,
      arch: process.arch,
      mode: 'headless',
      userData: base,
      modelsDir: settings.modelsDir,
      backendsDir: settings.backendsDir,
    }),

    'settings:get': () => settings,
    'settings:set': async (patch) => {
      const next = await saveSettings(patch || {});
      await cfg.ensureDirs(next);
      return next;
    },

    'hw:scan': (force) => scanHardwareCached(!!force),
    'presets:list': () => require('../electron/presets').PRESETS,

    'backends:list': async () => {
      let release = null;
      let error = null;
      try { release = await backends.latestRelease(); } catch (e) { error = e.message; }
      const installed = await backends.listInstalled(settings.backendsDir);
      const hw = await scanHardwareCached();
      const available = release ? backends.availableBackends(hw, release) : [];
      return {
        release: release ? { tag: release.tag, publishedAt: release.publishedAt, url: release.htmlUrl } : null,
        error,
        available,
        installed,
        recommended: hw.recommendation ? hw.recommendation.primary : null,
      };
    },

    'backends:install': async (backendId) => {
      const manifest = await backends.installBackend(backendId, {
        installRoot: settings.backendsDir,
        onProgress: (p) => emit('backend:progress', p),
      });
      emit('backend:progress', { phase: 'done', backend: backendId, percent: 100, manifest });
      return manifest;
    },

    'backends:remove': async (backendId) => {
      await backends.removeBackend(settings.backendsDir, backendId);
      return { removed: backendId };
    },

    'models:catalog': async () => models.catalogWithFit(await scanHardwareCached()),
    'models:search': async (query) => models.searchModels(query),

    'models:files': async (repo) => {
      const info = await models.modelFiles(repo);
      const hw = await scanHardwareCached();
      return {
        ...info,
        files: info.files.map((f) => ({
          ...f,
          fit: models.evaluateFit(f.size, f.name, hw, settings.ctx || 8192),
        })),
      };
    },

    'models:download': async (opts = {}) => {
      const { repo, file } = opts;
      if (activeDownload) throw new Error(`Es läuft bereits ein Download: ${activeDownload.repo}`);
      activeDownload = { repo, file, startedAt: Date.now() };
      const isOnnx = !!opts.isOnnx;
      const onnxSub = opts.onnxSub || (models.CATALOG.find((c) => c.repo === repo) || {}).onnxSub;
      const downloadId = opts.downloadId || `${repo}::${isOnnx ? 'onnx' : file}`;
      try {
        const result = isOnnx
          ? await models.downloadOnnxModel({ repo, onnxSub, modelsDir: settings.modelsDir, onProgress: (p) => emit('download:progress', p), downloadId })
          : await models.downloadModel({ repo, file, modelsDir: settings.modelsDir, onProgress: (p) => emit('download:progress', p), downloadId });
        const hw = await scanHardwareCached();
        result.fit = models.evaluateFit(result.sizeBytes, result.file, hw, settings.ctx || 8192);
        emit('download:progress', { phase: 'done', downloadId, percent: 100, result });
        return result;
      } catch (e) {
        emit('download:progress', { phase: 'error', downloadId, message: e.message });
        throw e;
      } finally {
        activeDownload = null;
      }
    },

    'models:local': async () => {
      const hw = await scanHardwareCached();
      const list = await models.listLocal(settings.modelsDir, settings.extraModelDirs);
      return list.map((m) => {
        const stored = modelSettings()[ms.modelKey(m.id)] || {};
        const r = resolveModelSettings(m.id);
        return {
          ...m,
          fit: models.evaluateFit(m.sizeBytes, m.file, hw, r.ctx, { cacheTypeK: r.cacheTypeK, cacheTypeV: r.cacheTypeV }),
          kvBaseGB: models.kvCacheGB(m.sizeBytes, m.file, r.ctx),
          fitCtx: r.ctx,
          modelSettings: stored,
          settingsSummary: Object.keys(stored).length ? ms.summary(r) : '',
        };
      });
    },

    'models:delete': async (id) => {
      await models.deleteModel(settings.modelsDir, id);
      return { deleted: id };
    },

    'models:sources': async () => (settings.extraModelDirs || []).map((dir, index) => ({
      index, dir, exists: fs.existsSync(dir),
    })),

    'models:addSource': async (dir) => {
      const target = path.resolve(String(dir || ''));
      let st = null;
      try { st = await fsp.stat(target); } catch { /* fehlt */ }
      if (!st || !st.isDirectory()) throw new Error(`Kein Ordner: ${dir}`);
      if (target === path.resolve(settings.modelsDir)) throw new Error('Das ist bereits der Haupt-Modellordner.');
      const list = settings.extraModelDirs || [];
      if (list.some((d) => path.resolve(d) === target)) throw new Error('Ordner ist schon eingetragen.');
      const next = [...list, target];
      await saveSettings({ extraModelDirs: next });
      const found = await models.scanModelRoot(target, { external: true, sourceIndex: next.length - 1, maxDepth: 2 });
      return { canceled: false, dir: target, count: found.length, sources: next };
    },

    'models:removeSource': async (dir) => {
      const target = path.resolve(String(dir || ''));
      const next = (settings.extraModelDirs || []).filter((d) => path.resolve(d) !== target);
      await saveSettings({ extraModelDirs: next });
      return { removed: dir, sources: next };
    },

    'modelSettings:schema': async () => ({
      cacheTypes: ms.CACHE_TYPES,
      defaultCache: ms.DEFAULT_CACHE,
      limits: ms.LIMITS,
      keys: ms.ALL_KEYS,
    }),

    'modelSettings:get': async (modelId) => {
      const key = ms.modelKey(modelId);
      const resolved = resolveModelSettings(modelId);
      return { key, stored: modelSettings()[key] || {}, resolved, summary: ms.summary(resolved) };
    },

    'modelSettings:set': async (modelId, patch) => {
      const key = ms.modelKey(modelId);
      if (!key) throw new Error('Ungültiger Modellpfad');
      const clean = ms.normalize(patch);
      const store = modelSettings();
      if (Object.keys(clean).length) store[key] = clean;
      else delete store[key];
      await ms.writeStore(modelSettingsFile(), store);
      const resolved = resolveModelSettings(modelId);
      return { key, stored: store[key] || {}, resolved, summary: ms.summary(resolved) };
    },

    'modelSettings:reset': async (modelId) => {
      const key = ms.modelKey(modelId);
      const store = modelSettings();
      delete store[key];
      await ms.writeStore(modelSettingsFile(), store);
      return { key, stored: {}, resolved: resolveModelSettings(modelId) };
    },

    'server:start': async (opts = {}) => {
      const installed = await backends.listInstalled(settings.backendsDir);
      const modelPath = withinAnyRoot(modelRoots(), opts.modelPath);
      const isOnnx = !!(opts.isOnnx || isOnnxModelDir(modelPath));
      const pref = opts.backendId
        || (settings.backendPreference && settings.backendPreference !== 'auto' ? settings.backendPreference : null);
      const hw = await scanHardwareCached();
      const primary = pref || (hw.recommendation ? hw.recommendation.primary : null);
      const backend = backends.pickForModel(installed, { primary, isOnnx });
      if (!backend) {
        throw new Error(isOnnx
          ? 'Für ONNX-Modelle fehlt das ONNX-Runtime-Backend.'
          : 'Kein llama.cpp-Backend installiert.');
      }
      const callOverrides = { ...(opts.overrides || {}) };
      const resolved = ms.resolve({
        global: {
          ctx: opts.ctx || settings.ctx,
          gpuLayers: opts.gpuLayers !== undefined ? opts.gpuLayers : settings.gpuLayers,
        },
        model: modelSettings()[ms.modelKey(opts.modelId || modelPath)] || {},
        call: callOverrides,
      });
      const result = await server.startServer({
        serverPath: backend.serverPath,
        modelPath,
        presetId: opts.preset || settings.lastPreset || 'balanced',
        onnxPython: backend.id === 'onnx' ? backend.serverPath : undefined,
        overrides: callOverrides,
        resolved,
        serverConfig: sc.resolve(settings.server),
        hw,
      });
      await saveSettings({ lastPreset: result.preset, lastModelId: opts.modelId || modelPath });
      return { ...result, backend: backend.id, settings: resolved };
    },

    'server:stop': async () => server.stopServer(),
    'server:state': () => server.getState(),
    'server:logs': () => server.getState().logs,
    'server:config': async () => serverInfo(),

    'server:setConfig': async (patch) => {
      const clean = sc.normalize(patch);
      await saveSettings({ server: clean });
      return serverInfo();
    },

    'server:generateKey': async () => ({ key: sc.generateKey() }),

    'attachments:read': async (paths) => {
      const list = Array.isArray(paths) ? paths : [];
      const out = [];
      for (const p of list) {
        try {
          out.push(await attachments.readAttachment(p));
        } catch (e) {
          out.push({ name: path.basename(String(p)), error: e.message });
        }
      }
      return out;
    },

    'bench:list': async () => benchmarks.list(base),
    'bench:add': async (entry) => benchmarks.add(base, entry || {}),
    'bench:remove': async (id) => benchmarks.remove(base, String(id || '')),
    'bench:clear': async () => benchmarks.clear(base),
  };

  // Server-Ereignisse an CLI/Web weiterreichen (eine Quelle für Live-Anzeigen).
  server.on('state', (state) => emit('server:state', state));
  server.on('log', (entry) => emit('server:log', entry));

  /** Zentrale Ausführung: genau ein Einstiegspunkt für CLI und Web-Bridge. */
  async function invoke(channel, ...args) {
    const fn = channels[channel];
    if (!fn) throw new Error(`Unbekannter Kanal: ${channel}`);
    return fn(...args);
  }

  return {
    base,
    get settings() { return settings; },
    reloadSettings() { settings = cfg.load(base); return settings; },
    saveSettings,
    invoke,
    channels: Object.keys(channels),
    on,
    emit,
    modelRoots,
    modelSettings,
    resolveModelSettings,
    scanHardwareCached,
    withinAnyRoot,
    isOnnxModelDir,
    serverInfo,
  };
}

module.exports = { createCore };
