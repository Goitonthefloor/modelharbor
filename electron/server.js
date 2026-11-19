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
  host: null,
  apiKey: '',
  lan: false,
  model: null,
  preset: null,
  startedAt: null,
  error: null,
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

function buildArgs({ serverPath, modelPath, presetId, overrides = {}, ctx, gpuLayers, threads, port, hw, resolved = null, serverConfig = null }) {
  const preset = getPreset(presetId);
  const sampling = { ...preset.sampling, ...(overrides.sampling || {}) };
  const ms = require('./model-settings');
  const sc = serverConfig || {};
  // Effektive Werte: global < modellspezifisch < expliziter Aufruf.
  const r = resolved || ms.resolve({ global: { ctx, gpuLayers, threads }, call: overrides });
  const args = [
    '--model', modelPath,
    // Stabiler Alias: Agenten konfigurieren einmal „ModelHarbor“ und können
    // das Modell wechseln, ohne ihre Konfiguration anzufassen.
    '--alias', overrides.alias || 'ModelHarbor',
    '--host', sc.host || '127.0.0.1',
    '--port', String(port),
    '--ctx-size', String(r.ctx),
    '--n-gpu-layers', String(r.gpuLayers === undefined ? 'all' : r.gpuLayers),
    '--fit', 'on',
    '--jinja',
    '--no-perf',
  ];
  // Server-Zugang für Agenten: API-Key, CORS, parallele Slots.
  // Kein simples --cors in llama.cpp: CORS läuft über --cors-origins
  // (Standard * = alle Origins; „localhost“ = nur same-origin).
  // Der Key wandert NICHT in die Kommandozeile: /proc/<pid>/cmdline ist auf
  // Linux für alle lokalen Benutzer lesbar. llama-server liest ihn aus der
  // Env-Variable LLAMA_API_KEY (startServer setzt sie nur für den Kindprozess).
  if (sc.cors === false) args.push('--cors-origins', 'localhost');
  if (sc.parallel) args.push('--parallel', String(sc.parallel));
  const cpuCount = (require('os').cpus() || []).length || 4;
  const t = r.threads || Math.max(2, cpuCount - 1);
  args.push('--threads', String(t));
  // Flash-Attention + getrennte K/V-Cache-Quantisierung, Batch, mlock/mmap, RoPE
  args.push(...ms.llamaArgs(r));
  // mmproj automatisch, wenn neben dem Modell vorhanden
  try {
    const dir = path.dirname(modelPath);
    const mm = fs.readdirSync(dir).find((f) => /^mmproj.*\.gguf$/i.test(f));
    if (mm) args.push('--mmproj', path.join(dir, mm));
  } catch { /* ignore */ }
  args.push(...samplingArgs(sampling));
  return { args, preset, sampling };
}

/** Prüft, ob ein fester Port frei ist — Agenten brauchen eine stabile Adresse. */
function assertPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', () => {
      try { srv.close(); } catch { /* ignore */ }
      reject(new Error(i18n.t('error.portInUse', { port })));
    });
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

const logger = require('./logger');

async function startServer(opts) {
  if (state.running || state.starting) {
    throw new Error(i18n.t('error.modelAlreadyRunning'));
  }
  const { serverPath, modelPath, presetId = 'balanced', overrides = {}, hw } = opts;
  if (!fs.existsSync(serverPath)) throw new Error(i18n.t('error.backendMissing', { path: serverPath }));
  if (!fs.existsSync(modelPath)) throw new Error(i18n.t('error.modelFileMissing', { path: modelPath }));

  const sc = { ...(opts.serverConfig || {}) };
  // Nie ohne Key starten: der Server wäre sonst für jeden lokalen Prozess und
  // jede Webseite offen, die 127.0.0.1 anfragt. Gilt für llama UND ONNX.
  // Trimmen, weil ein Key aus Leerzeichen sonst als "vorhanden" durchrutscht.
  sc.apiKey = String(sc.apiKey || '').trim();
  if (!sc.apiKey) throw new Error(i18n.t('error.serverKeyRequired'));
  const host = sc.host || '127.0.0.1';
  const fixedPort = opts.port || sc.port || null;
  // Fester Port (Server-Tab): nicht still ausweichen, sondern klar melden.
  if (fixedPort) await assertPortFree(fixedPort, host);
  const port = fixedPort || await freePort(9931);
  const ctx = (opts.resolved && opts.resolved.ctx) || overrides.ctx || 8192;
  const gpuLayers = opts.resolved ? opts.resolved.gpuLayers
    : (overrides.gpuLayers !== undefined ? overrides.gpuLayers : 999);
  const { args: _b, preset, sampling } = buildArgs({ serverPath, modelPath, presetId, overrides, ctx, gpuLayers, threads: overrides.threads, port, hw, resolved: opts.resolved || null, serverConfig: sc });

  // ONNX-Modellordner (GenAI): statt llama-server den OGA-Chat-Server starten.
  // Erkennung: Modellpfad ist ein Verzeichnis mit genai_config.json.
  const isOnnx = (() => {
    try { return fs.statSync(modelPath).isDirectory() && fs.existsSync(path.join(modelPath, 'genai_config.json')); }
    catch { return false; }
  })();
  let executable = serverPath;
  let args = _b;
  const env = { ...process.env, LD_LIBRARY_PATH: [path.dirname(serverPath), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  if (isOnnx) {
    const py = opts.onnxPython;
    if (!py || !fs.existsSync(py)) {
      throw new Error(i18n.t('error.onnxBackendMissing'));
    }
    executable = py;
    // Key über Env statt argv — der app-eigene ONNX-Server liest MH_ONNX_API_KEY.
    env.MH_ONNX_API_KEY = sc.apiKey;
    const maxTok = Math.max(256, Number(overrides.maxTokens || ctx || 8192));
    args = [
      path.join(__dirname, 'onnx_server.py'),
      '--model-dir', modelPath,
      '--host', host,
      '--port', String(port),
      // Gleiche Zugangsregeln wie beim llama-Server: Key-Pflicht (via Env) und CORS.
      '--cors-origins', sc.cors === false ? 'localhost' : '*',
      '--ep', overrides.ep || 'cpu',
      '--max-tokens', String(maxTok),
    ];
    env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH || '';
  } else {
    // Nur der Kindprozess bekommt den Key; process.env bleibt unverändert.
    env.LLAMA_API_KEY = sc.apiKey;
  }

  logs = [];
  setState({ running: false, starting: true, pid: null, port, host, apiKey: sc.apiKey || '', lan: host !== '127.0.0.1', model: modelPath, preset: presetId, startedAt: null, error: null });
  logger.debug(`startServer mode=${isOnnx ? 'onnx' : 'llama'} executable=${path.basename(executable)} argv=${args.join(' ')}`);
  pushLog(`Starte: ${path.basename(executable)} ${args.join(' ')}`, 'info');

  proc = spawn(executable, args, {
    cwd: path.dirname(executable),
    env,
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
    logger.error('server spawn/process error', err);
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
    logger.error(`server health-check fehlgeschlagen nach ${port}`, e);
    await stopServer();
    setState({ error: e.message });
    throw e;
  }

  setState({ running: true, starting: false, startedAt: Date.now(), preset: presetId, sampling });
  logger.info(`model ready on port ${port}`);
  pushLog('Modell geladen — Chat ist bereit.', 'info');
  return { port, pid: proc.pid, model: modelPath, preset: presetId, host, apiKey: sc.apiKey || '', lan: host !== '127.0.0.1' };
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

module.exports = { startServer, stopServer, getState, on, freePort, assertPortFree, buildArgs, waitForHealth, cleanupOrphans };

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
