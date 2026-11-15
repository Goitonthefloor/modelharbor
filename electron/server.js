'use strict';
/**
 * server.js — verwaltet den llama-server-Prozess (Start, Health-Check, Stop, Logs).
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const i18n = require('../ui/i18n');
const fs = require('fs');
const http = require('http');
const { samplingArgs, getPreset } = require('./presets');

let proc = null;
let state = {
  running: false,
  starting: false,
  pid: null,
  port: null,
  model: null,
  preset: null,
  startedAt: null,
  error: null,
  argv: [],
};
let logs = [];
const MAX_LOGS = 500;
let listeners = { log: [], state: [] };

function on(event, fn) { (listeners[event] || (listeners[event] = [])).push(fn); }
function emit(event, payload) { for (const fn of listeners[event] || []) { try { fn(payload); } catch { /* ignore */ } } }
function pushLog(line, stream = 'out') {
  const entry = { t: Date.now(), stream, line };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  emit('log', entry);
}
function setState(patch) {
  state = { ...state, ...patch };
  emit('state', state);
}
function getState() { return { ...state, logs: logs.slice(-200) }; }

function freePort(start = 9931) {
  return new Promise((resolve, reject) => {
    let port = start;
    let attempts = 0;
    const tryPort = () => {
      if (attempts++ > 60) { reject(new Error(i18n.t('error.noFreePort'))); return; }
      const srv = net.createServer();
      srv.once('error', () => { try { srv.close(); } catch { /* ignore */ } port++; tryPort(); });
      srv.once('listening', () => {
        srv.close(() => resolve(port));
      });
      srv.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

async function waitForHealth(port, { timeoutMs = 180000, onTick } = {}) {
  const start = Date.now();
  let lastStatus = 0;
  while (Date.now() - start < timeoutMs) {
    if (!proc) throw new Error(i18n.t('error.serverExited'));
    const res = await httpGet(`http://127.0.0.1:${port}/health`);
    lastStatus = res.status;
    if (res.status === 200) return true;
    if (onTick) onTick({ elapsedMs: Date.now() - start, status: res.status });
    await new Promise((r) => setTimeout(r, 700));
  }
  const tail = logs.slice(-12).map((l) => l.line).join('\n');
  throw new Error(i18n.t('error.modelLoadFailed', { status: lastStatus, tail }));
}

function buildArgs({ serverPath, modelPath, presetId, overrides = {}, ctx, gpuLayers, threads, port, hw }) {
  const preset = getPreset(presetId);
  const sampling = { ...preset.sampling, ...(overrides.sampling || {}) };
  const args = [
    '--model', modelPath,
    '--alias', overrides.alias || 'ModelHarbor',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', String(ctx || overrides.ctx || 8192),
    '--n-gpu-layers', String(gpuLayers === undefined ? 'all' : gpuLayers),
    '--fit', 'on',
    '--jinja',
    '--no-perf',
  ];
  const cpuCount = (require('os').cpus() || []).length || 4;
  const t = threads || overrides.threads || Math.max(2, cpuCount - 1);
  args.push('--threads', String(t));
  if (overrides.flashAttn !== false) args.push('--flash-attn', 'auto');
  if (overrides.cacheTypeKV) {
    args.push('--cache-type-k', overrides.cacheTypeKV, '--cache-type-v', overrides.cacheTypeKV);
  }
  // mmproj automatisch, wenn neben dem Modell vorhanden
  try {
    const dir = path.dirname(modelPath);
    const mm = fs.readdirSync(dir).find((f) => /^mmproj.*\.gguf$/i.test(f));
    if (mm) args.push('--mmproj', path.join(dir, mm));
  } catch { /* ignore */ }
  args.push(...samplingArgs(sampling));
  return { args, preset, sampling };
}

async function startServer(opts) {
  if (state.running || state.starting) {
    throw new Error(i18n.t('error.modelAlreadyRunning'));
  }
  const { serverPath, modelPath, presetId = 'balanced', overrides = {}, hw } = opts;
  if (!fs.existsSync(serverPath)) throw new Error(i18n.t('error.backendMissing', { path: serverPath }));
  if (!fs.existsSync(modelPath)) throw new Error(i18n.t('error.modelFileMissing', { path: modelPath }));

  const port = opts.port || await freePort(9931);
  const ctx = overrides.ctx || 8192;
  const gpuLayers = overrides.gpuLayers !== undefined ? overrides.gpuLayers : 999;
  const { args, preset, sampling } = buildArgs({ serverPath, modelPath, presetId, overrides, ctx, gpuLayers, threads: overrides.threads, port, hw });

  logs = [];
  setState({ running: false, starting: true, pid: null, port, model: modelPath, preset: presetId, startedAt: null, error: null, argv: args });
  pushLog(`Starte: ${path.basename(serverPath)} ${args.join(' ')}`, 'info');

  proc = spawn(serverPath, args, {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      // Wichtig für AMD/Intel-Backends unter Linux
      LD_LIBRARY_PATH: [path.dirname(serverPath), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    },
    windowsHide: true,
  });

  const handleChunk = (stream) => (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) pushLog(line.trimEnd(), stream);
    }
  };
  proc.stdout.on('data', handleChunk('out'));
  proc.stderr.on('data', handleChunk('err'));
  proc.on('error', (err) => {
    pushLog(`Prozessfehler: ${err.message}`, 'err');
    setState({ starting: false, running: false, error: err.message });
    proc = null;
  });
  proc.on('exit', (code, signal) => {
    pushLog(`Prozess beendet (Code ${code}${signal ? `, Signal ${signal}` : ''})`, 'info');
    setState({ running: false, starting: false, pid: null, error: code && code !== 0 ? `Server beendet mit Code ${code}` : null });
    proc = null;
  });

  setState({ pid: proc.pid });

  try {
    await waitForHealth(port, {
      timeoutMs: 240000,
      onTick: (t) => {
        if (t.elapsedMs % 5000 < 800) pushLog(`Warte auf Modell-Ladevorgang … ${(t.elapsedMs / 1000).toFixed(0)}s (HTTP ${t.status})`, 'info');
      },
    });
  } catch (e) {
    await stopServer();
    setState({ error: e.message });
    throw e;
  }

  setState({ running: true, starting: false, startedAt: Date.now(), preset: presetId, sampling });
  pushLog('Modell geladen — Chat ist bereit.', 'info');
  return { port, pid: proc.pid, model: modelPath, preset: presetId };
}

async function stopServer() {
  if (!proc) {
    setState({ running: false, starting: false, pid: null });
    return { stopped: true, alreadyStopped: true };
  }
  const p = proc;
  const pid = p.pid;
  pushLog('Stoppe Server …', 'info');
  return new Promise((resolve) => {
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      proc = null;
      setState({ running: false, starting: false, pid: null });
      resolve({ stopped: true, how });
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
          p.kill('SIGKILL');
        }
      } catch { /* ignore */ }
      finish('kill');
    }, 8000);
    p.once('exit', () => { clearTimeout(timer); finish('sigterm'); });
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T'], { windowsHide: true });
      } else {
        p.kill('SIGTERM');
      }
    } catch {
      clearTimeout(timer);
      finish('error');
    }
  });
}

module.exports = { startServer, stopServer, getState, on, freePort, buildArgs, waitForHealth, cleanupOrphans };

/**
 * Beendet llama-server-Prozesse, die zu unserem Backend-Verzeichnis gehören
 * (z. B. nach einem Absturz der App liegengeblieben sind).
 */
async function cleanupOrphans(backendsDir) {
  const { execFile } = require('child_process');
  const killed = [];
  try {
    if (process.platform === 'win32') {
      const out = await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"],
        { timeout: 10000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
      });
      if (!out.trim()) return killed;
      let list = [];
      try { const p = JSON.parse(out.trim()); list = Array.isArray(p) ? p : [p]; } catch { return killed; }
      for (const p of list) {
        if (p && p.ExecutablePath && p.ExecutablePath.toLowerCase().startsWith(backendsDir.toLowerCase())) {
          try { process.kill(p.ProcessId, 'SIGKILL'); killed.push(p.ProcessId); } catch { /* ignore */ }
        }
      }
    } else {
      const out = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid=,args='], { timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
      });
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const args = m[2];
        if (!args.includes('llama-server')) continue;
        if (!args.includes(backendsDir)) continue;
        if (pid === process.pid) continue;
        try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch { /* ignore */ }
      }
    }
  } catch { /* Aufräumen ist best effort */ }
  return killed;
}
