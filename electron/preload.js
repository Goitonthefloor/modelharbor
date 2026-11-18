'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set([
  'download:progress',
  'backend:progress',
  'server:log',
  'server:state',
  'update:available',
  'update:progress',
]);

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  hw: {
    scan: (force) => ipcRenderer.invoke('hw:scan', force),
  },
  presets: () => ipcRenderer.invoke('presets:list'),
  backends: {
    list: () => ipcRenderer.invoke('backends:list'),
    install: (id) => ipcRenderer.invoke('backends:install', id),
    remove: (id) => ipcRenderer.invoke('backends:remove', id),
  },
  models: {
    catalog: () => ipcRenderer.invoke('models:catalog'),
    search: (q) => ipcRenderer.invoke('models:search', q),
    files: (repo) => ipcRenderer.invoke('models:files', repo),
    download: (repo, file, opts) => ipcRenderer.invoke('models:download', { repo, file, ...(opts || {}) }),
    local: () => ipcRenderer.invoke('models:local'),
    delete: (id) => ipcRenderer.invoke('models:delete', id),
    reveal: (p) => ipcRenderer.invoke('models:reveal', p),
    sources: () => ipcRenderer.invoke('models:sources'),
    addSource: () => ipcRenderer.invoke('models:addSource'),
    removeSource: (dir) => ipcRenderer.invoke('models:removeSource', dir),
  },
  modelSettings: {
    schema: () => ipcRenderer.invoke('modelSettings:schema'),
    get: (modelId) => ipcRenderer.invoke('modelSettings:get', modelId),
    set: (modelId, patch) => ipcRenderer.invoke('modelSettings:set', modelId, patch),
    reset: (modelId) => ipcRenderer.invoke('modelSettings:reset', modelId),
  },
  server: {
    start: (opts) => ipcRenderer.invoke('server:start', opts),
    stop: () => ipcRenderer.invoke('server:stop'),
    state: () => ipcRenderer.invoke('server:state'),
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    showModels: () => ipcRenderer.invoke('shell:showModels'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (url, name) => ipcRenderer.invoke('update:download', { url, name }),
    openFile: (filePath) => ipcRenderer.invoke('update:openFile', filePath),
    openReleases: () => ipcRenderer.invoke('update:openReleases'),
  },
  on: (channel, callback) => {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`Unerlaubter Event-Kanal: ${channel}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
