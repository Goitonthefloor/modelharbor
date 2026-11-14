'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const hardware = require('./hardware');
const backends = require('./backends');
const models = require('./models');
const server = require('./server');
const { PRESETS } = require('./presets');

const isDev = !app.isPackaged;
let win = null;
let hwCache = null;
let hwCacheTime = 0;
let activeDownload = null;

/* --------------------------- Settings --------------------------- */

function userDataDir() { return app.getPath('userData'); }

function defaultSettings() {
  const base = userDataDir();
  return {
    modelsDir: path.join(base, 'models'),
    backendsDir: path.join(base, 'backends'),
    ctx: 8192,
    gpuLayers: 999,
    lastPreset: 'balanced',
    lastModelId: null,
    onboardingDone: false,
    language: 'de',
  };
}

let settings = null;

function loadSettings() {
  const file = path.join(userDataDir(), 'settings.json');
  const defaults = defaultSettings();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    settings = { ...defaults, ...JSON.parse(raw) };
  } catch {
    settings = defaults;
  }
  for (const d of [settings.modelsDir, settings.backendsDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }
  return settings;
}

async function saveSettings(patch) {
  settings = { ...(settings || defaultSettings()), ...patch };
  const file = path.join(userDataDir(), 'settings.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

/* --------------------------- Fenster --------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b0d10',
    show: false,
    title: 'ModelHarbor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

async function scanHardwareCached(force = false) {
  const now = Date.now();
  if (!force && hwCache && now - hwCacheTime < 30000) return hwCache;
  hwCache = await hardware.scanHardware();
  hwCacheTime = now;
  return hwCache;
}

/* --------------------------- IPC --------------------------- */

function throttle(fn, ms) {
  let last = 0;
  let pending = null;
  return (payload) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(payload);
    } else {
      pending = payload;
      setTimeout(() => {
        if (pending) { last = Date.now(); fn(pending); pending = null; }
      }, ms - (now - last));
    }
  };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    userData: userDataDir(),
    modelsDir: settings.modelsDir,
    backendsDir: settings.backendsDir,
    isDev,
  }));

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = await saveSettings(patch || {});
    try { await fsp.mkdir(next.modelsDir, { recursive: true }); } catch { /* ignore */ }
    try { await fsp.mkdir(next.backendsDir, { recursive: true }); } catch { /* ignore */ }
    return next;
  });

  ipcMain.handle('hw:scan', async (_e, force) => {
    const hw = await scanHardwareCached(!!force);
    return hw;
  });

  ipcMain.handle('presets:list', () => PRESETS);

  ipcMain.handle('backends:list', async () => {
    let release = null;
    let error = null;
    try { release = await backends.latestRelease(); } catch (e) { error = e.message; }
    const installed = await backends.listInstalled(settings.backendsDir);
    const hw = await scanHardwareCached();
    const available = release ? backends.availableBackends(hw, release) : [];
    return {
      release: release ? { tag: release.tag, publishedAt: release.publishedAt, url: release.htmlUrl } : null,
      error, available, installed,
      recommended: hw.recommendation ? hw.recommendation.primary : null,
    };
  });

  ipcMain.handle('backends:install', async (_e, backendId) => {
    const onProgress = throttle((p) => send('backend:progress', p), 120);
    const manifest = await backends.installBackend(backendId, { installRoot: settings.backendsDir, onProgress });
    send('backend:progress', { phase: 'done', backend: backendId, percent: 100, manifest });
    return manifest;
  });

  ipcMain.handle('backends:remove', async (_e, backendId) => {
    await backends.removeBackend(settings.backendsDir, backendId);
    return { removed: backendId };
  });

  ipcMain.handle('models:catalog', async () => {
    const hw = await scanHardwareCached();
    return models.catalogWithFit(hw);
  });

  ipcMain.handle('models:search', async (_e, query) => models.searchModels(query));

  ipcMain.handle('models:files', async (_e, repo) => {
    const info = await models.modelFiles(repo);
    const hw = await scanHardwareCached();
    return {
      ...info,
      files: info.files.map((f) => ({
        ...f,
        fit: models.evaluateFit(f.size, f.name, hw, settings.ctx || 8192),
      })),
    };
  });

  ipcMain.handle('models:download', async (_e, { repo, file }) => {
    if (activeDownload) throw new Error('Es läuft bereits ein Download. Bitte warten, bis er fertig ist.');
    activeDownload = { repo, file, startedAt: Date.now() };
    const downloadId = `${repo}::${file}`;
    const onProgress = throttle((p) => send('download:progress', p), 120);
    try {
      const result = await models.downloadModel({ repo, file, modelsDir: settings.modelsDir, onProgress, downloadId });
      // Hardware-Fit für das neue lokale Modell
      const hw = await scanHardwareCached();
      result.fit = models.evaluateFit(result.sizeBytes, result.file, hw, settings.ctx || 8192);
      send('download:progress', { phase: 'done', downloadId, percent: 100, result });
      return result;
    } catch (e) {
      send('download:progress', { phase: 'error', downloadId, message: e.message });
      throw e;
    } finally {
      activeDownload = null;
    }
  });

  ipcMain.handle('models:local', async () => {
    const hw = await scanHardwareCached();
    const list = await models.listLocal(settings.modelsDir);
    return list.map((m) => ({ ...m, fit: models.evaluateFit(m.sizeBytes, m.file, hw, settings.ctx || 8192) }));
  });

  ipcMain.handle('models:delete', async (_e, id) => {
    await models.deleteModel(settings.modelsDir, id);
    return { deleted: id };
  });

  ipcMain.handle('models:reveal', async (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('server:start', async (_e, opts) => {
    const installed = await backends.listInstalled(settings.backendsDir);
    const wanted = opts.backendId || (hwCache && hwCache.recommendation ? hwCache.recommendation.primary : null);
    let backend = installed.find((b) => b.id === wanted) || installed[0];
    if (!backend) throw new Error('Kein Backend installiert. Bitte zuerst im Setup ein Backend einrichten.');
    const result = await server.startServer({
      serverPath: backend.serverPath,
      modelPath: opts.modelPath,
      presetId: opts.preset || settings.lastPreset || 'balanced',
      overrides: { ...(opts.overrides || {}), ctx: opts.ctx || settings.ctx, gpuLayers: opts.gpuLayers !== undefined ? opts.gpuLayers : settings.gpuLayers },
      hw: hwCache,
    });
    await saveSettings({ lastPreset: result.preset, lastModelId: opts.modelId || null });
    return { ...result, backend: backend.id };
  });

  ipcMain.handle('server:stop', async () => server.stopServer());
  ipcMain.handle('server:state', () => server.getState());
  ipcMain.handle('server:logs', () => server.getState().logs);

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (!/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('shell:showModels', async () => {
    shell.openPath(settings.modelsDir);
    return settings.modelsDir;
  });

  // Server-Events an den Renderer weiterreichen
  server.on('log', (entry) => send('server:log', entry));
  server.on('state', (st) => send('server:state', st));
}

/* --------------------------- Lifecycle --------------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.modelharbor.app');
    loadSettings();
    // Nach einem Absturz können llama-server-Prozesse liegenbleiben
    server.cleanupOrphans(settings.backendsDir).catch(() => {});
    registerIpc();
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    try { await server.stopServer(); } catch { /* ignore */ }
  });
}
