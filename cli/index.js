'use strict';
/* Einstiegspunkt der headless CLI: Argumente auswerten, Subkommando ausführen.
 *
 * Ohne Argument (oder mit `start`) läuft der Dialog aus cli/menu.js. Alles andere
 * ist skriptbar (`--json` für maschinenlesbare Ausgabe) — nützlich für Server,
 * Container und Cronjobs, wo ein Zahlenmenü nichts verloren hat. */

const path = require('path');
const { createCore } = require('./core');
const { createTerminal } = require('./ui-kit');
const { userDataDir } = require('./paths');
const hardware = require('../electron/hardware');
const pkg = require('../package.json');

const HELP = `ModelHarbor ${pkg.version} — lokale Modelle hosten, headless bedienbar

AUFRUF
  model-harbor                     Dialog mit Modellen, Backends und Ressourcen
  model-harbor start               dasselbe, ausdrücklich
  model-harbor serve [Optionen]    Web-Oberfläche für den Browser bereitstellen

OPTIONEN von serve
  --port <n>        Port (Standard 8787)
  --lan             im LAN erreichbar (bindet 0.0.0.0, verlangt Zugriffs-Token)
  --host <addr>     Bindeadresse (Standard 127.0.0.1)

MODELLE
  model-harbor models                    installierte Modelle
  model-harbor models search <begriff>   HuggingFace durchsuchen
  model-harbor models files <repo>       Dateien eines Repos zeigen
  model-harbor models download <repo> <datei> [--onnx <unterordner>]
  model-harbor models delete <id>
  model-harbor models sources            Zusatzordner
  model-harbor models add-source <ordner>
  model-harbor models remove-source <ordner>

BACKENDS
  model-harbor backends                  installierte und verfügbare Builds
  model-harbor backends install <id>
  model-harbor backends remove <id>

SERVER
  model-harbor server status
  model-harbor server start --model <pfad> [--backend <id>] [--ctx <n>]
  model-harbor server stop
  model-harbor server config [--key neu|--port <n>|--lan an|aus]

WEITERES
  model-harbor bench [--port <n>]        Tokens/s gegen den laufenden Server messen
  model-harbor config get                Einstellungen zeigen
  model-harbor config set <key> <wert>   z. B. ctx 16384 / language en
  model-harbor status                    Hardware, Ordner, Serverzustand
  model-harbor --version | --help

GLOBAL
  --json            Ausgabe als JSON (für Skripte)
  --home <ordner>   anderes Datenverzeichnis (Standard: ${userDataDir()})
`;

let outStream = process.stdout;
let errStream = process.stderr;

/** Zeile auf den (ggf. injizierten) Ausgabestrom — Tests ersetzen ihn. */
function emitText(text) { outStream.write(`${text}\n`); }

/** JSON für Skripte: eine Quelle für alle `--json`-Ausgaben. */
function emitJson(data) { outStream.write(`${JSON.stringify(data, null, 2)}\n`); }

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--lan') flags.lan = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--version' || arg === '-v') flags.version = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else rest.push(arg);
  }
  return { flags, rest };
}

function tableOrJson(term, flags, headers, rows, align) {
  if (flags.json) { emitJson(rows); return; }
  term.write(term.table(headers, rows, { align }));
}

async function main(argv = process.argv.slice(2), io = {}) {
  outStream = io.stdout || process.stdout;
  errStream = io.stderr || process.stderr;
  const { flags, rest } = parseArgs(argv);
  if (flags.version) { emitText(`ModelHarbor ${pkg.version}`); return 0; }
  if (flags.help) { emitText(HELP); return 0; }
  if (flags.home) process.env.MODELHARBOR_HOME = path.resolve(String(flags.home));

  const term = createTerminal({ isTTY: flags.json ? false : undefined });
  const core = createCore({ version: pkg.version, base: flags.home ? path.resolve(String(flags.home)) : undefined });
  try { await core.saveSettings({}); } catch { /* nur sicherstellen, dass Ordner existieren */ }

  const [cmd, sub, ...args] = rest;
  const bold = term.colors.bold;

  try {
    if (!cmd || cmd === 'start') {
      const { createMenu } = require('./menu');
      const menu = createMenu({ core, term, version: pkg.version });
      await menu.run();
      term.close();
      return 0;
    }

    if (cmd === 'serve') {
      const { startWebServer } = require('./web/server');
      const port = Number.parseInt(String(flags.port || '8787'), 10);
      const host = flags.lan ? '0.0.0.0' : String(flags.host || '127.0.0.1');
      const handle = await startWebServer({ core, port, host, version: pkg.version });
      term.write(`${bold('ModelHarbor')} Web-Oberfläche: ${handle.url}`);
      if (flags.lan) term.write(term.colors.dim(`  LAN: ${require('./web/server').lanAddresses().map((a) => `http://${a}:${handle.port}/?token=${handle.token}`).join(' · ')}`));
      term.write(term.colors.dim('  Beenden mit Strg-C'));
      await new Promise((resolve) => {
        const stop = async () => { await handle.close(); resolve(); };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      return 0;
    }

    if (cmd === 'models') return await modelsCommand({ core, term, flags, sub, args });
    if (cmd === 'backends') return await backendsCommand({ core, term, flags, sub, args });
    if (cmd === 'server') return await serverCommand({ core, term, flags, sub, args });
    if (cmd === 'bench') return await benchCommand({ core, term, flags });
    if (cmd === 'config') return await configCommand({ core, term, flags, sub, args });
    if (cmd === 'status') return await statusCommand({ core, term, flags });

    term.writeErr(`Unbekannter Befehl: ${cmd}\n`);
    term.writeErr('Hilfe: model-harbor --help');
    return 2;
  } catch (e) {
    // Eingabe-Ende (Strg-D) ist ein sauberer Abbruch, kein Fehlerfall.
    if (e && e.name === 'MenuAbort') { term.write('Beendet.'); return 0; }
    term.writeErr(`${term.colors.err('Fehler:')} ${e && e.message ? e.message : e}`);
    return 1;
  } finally {
    term.close();
  }
}

/* ------------------------------- Subkommandos ------------------------------- */

async function modelsCommand({ core, term, flags, sub, args }) {
  if (!sub || sub === 'list') {
    const list = await core.invoke('models:local');
    if (flags.json) { emitJson(list); return 0; }
    if (!list.length) { term.write('Keine Modelle installiert.'); return 0; }
    tableOrJson(term, flags, ['#', 'Modell', 'Größe', 'Typ', 'Fit', 'Kontext', 'Pfad'],
      list.map((m, i) => [
        String(i + 1),
        m.name || m.file,
        hardware.formatBytes(m.sizeBytes),
        m.isOnnx ? 'ONNX' : 'GGUF',
        m.fit ? (m.fit.label || m.fit.verdict || '—') : '—',
        String(m.fitCtx || ''),
        m.path,
      ]), ['right']);
    return 0;
  }
  if (sub === 'search') {
    const query = args.join(' ');
    const hits = query ? await core.invoke('models:search', query) : await core.invoke('models:catalog');
    if (flags.json) { emitJson(hits); return 0; }
    tableOrJson(term, flags, ['Repository', 'Downloads', 'Fit'],
      hits.slice(0, 40).map((h) => [h.repo || h.id, h.downloads || '', h.fit ? (h.fit.label || '') : '']), ['left', 'right']);
    return 0;
  }
  if (sub === 'files') {
    const repo = args[0];
    if (!repo) throw new Error('Repository fehlt: model-harbor models files <repo>');
    const info = await core.invoke('models:files', repo);
    if (flags.json) { emitJson(info); return 0; }
    tableOrJson(term, flags, ['Datei', 'Größe', 'Fit'],
      (info.files || []).map((f) => [f.name, hardware.formatBytes(f.size), f.fit ? (f.fit.label || '') : '']), ['left', 'right']);
    return 0;
  }
  if (sub === 'download') {
    const [repo, file] = args;
    if (!repo) throw new Error('Repository fehlt: model-harbor models download <repo> <datei>');
    const bar = term.progress('Download');
    const off = core.on('download:progress', (p) => bar.update(p));
    try {
      const result = await core.invoke('models:download', { repo, file, isOnnx: !!flags.onnx, onnxSub: flags.onnx || undefined });
      bar.done(`${result.file || file} · ${hardware.formatBytes(result.sizeBytes)}${result.fit && result.fit.label ? ` · ${result.fit.label}` : ''}`);
      if (flags.json) emitJson(result);
    } finally { off(); }
    return 0;
  }
  if (sub === 'delete') {
    const id = args[0];
    if (!id) throw new Error('Modell-id fehlt: model-harbor models delete <id>');
    await core.invoke('models:delete', id);
    term.write(`Gelöscht: ${id}`);
    return 0;
  }
  if (sub === 'sources') {
    const sources = await core.invoke('models:sources');
    if (flags.json) { emitJson(sources); return 0; }
    if (!sources.length) { term.write('Keine Zusatzordner eingetragen.'); return 0; }
    tableOrJson(term, flags, ['#', 'Ordner', 'erreichbar'], sources.map((s, i) => [String(i + 1), s.dir, s.exists ? 'ja' : 'nein']), ['right']);
    return 0;
  }
  if (sub === 'add-source') {
    const dir = args[0];
    if (!dir) throw new Error('Ordner fehlt: model-harbor models add-source <ordner>');
    const res = await core.invoke('models:addSource', path.resolve(dir));
    term.write(`Eingetragen: ${res.dir} (${res.count} Modell(e) gefunden)`);
    return 0;
  }
  if (sub === 'remove-source') {
    const dir = args[0];
    if (!dir) throw new Error('Ordner fehlt: model-harbor models remove-source <ordner>');
    await core.invoke('models:removeSource', path.resolve(dir));
    term.write(`Entfernt: ${dir}`);
    return 0;
  }
  throw new Error(`Unbekannter Unterbefehl: models ${sub}`);
}

async function backendsCommand({ core, term, flags, sub, args }) {
  if (!sub || sub === 'list') {
    const info = await core.invoke('backends:list');
    if (flags.json) { emitJson(info); return 0; }
    term.write(term.colors.bold(`Installiert (${(info.installed || []).length})`));
    if ((info.installed || []).length) {
      tableOrJson(term, flags, ['Backend', 'Version', 'Programm'],
        info.installed.map((b) => [b.id, b.version || b.release || '', b.serverPath ? path.basename(b.serverPath) : '']));
    } else term.write(term.colors.dim('  keines'));
    if (info.error) term.write(term.colors.dim(`Release-Abfrage: ${info.error}`));
    term.write('');
    term.write(term.colors.bold(`Verfügbar (${(info.available || []).length})${info.recommended ? ` · Empfehlung: ${info.recommended}` : ''}`));
    tableOrJson(term, flags, ['Backend', 'Empfohlen', 'Hinweis'],
      (info.available || []).map((b) => [b.id, b.recommended ? 'ja' : '', b.experimental ? 'experimentell' : '']));
    return 0;
  }
  if (sub === 'install') {
    const id = args[0];
    if (!id) throw new Error('Backend-id fehlt: model-harbor backends install <id>');
    const bar = term.progress('Backend');
    const off = core.on('backend:progress', (p) => bar.update(p));
    try {
      const manifest = await core.invoke('backends:install', id);
      bar.done(`${id} installiert${manifest && manifest.version ? ` (${manifest.version})` : ''}`);
    } finally { off(); }
    return 0;
  }
  if (sub === 'remove') {
    const id = args[0];
    if (!id) throw new Error('Backend-id fehlt: model-harbor backends remove <id>');
    await core.invoke('backends:remove', id);
    term.write(`Entfernt: ${id}`);
    return 0;
  }
  throw new Error(`Unbekannter Unterbefehl: backends ${sub}`);
}

async function serverCommand({ core, term, flags, sub, args }) {
  if (!sub || sub === 'status') {
    const state = await core.invoke('server:state');
    const info = await core.invoke('server:config');
    if (flags.json) { emitJson({ state, info }); return 0; }
    term.write(state.running
      ? `Server läuft auf ${info.baseUrl || `Port ${state.port}`}${state.modelPath ? ` · ${path.basename(state.modelPath)}` : ''}`
      : 'Server gestoppt.');
    return 0;
  }
  if (sub === 'start') {
    let modelPath = flags.model;
    if (!modelPath) {
      const list = await core.invoke('models:local');
      if (list.length === 1) modelPath = list[0].path;
      else throw new Error('--model <pfad> fehlt (mehrere Modelle vorhanden).');
    }
    const res = await core.invoke('server:start', {
      modelPath: path.resolve(String(modelPath)),
      backendId: flags.backend,
      ctx: flags.ctx ? Number.parseInt(String(flags.ctx), 10) : undefined,
    });
    const info = await core.invoke('server:config');
    if (flags.json) { emitJson({ ...res, info }); return 0; }
    term.write(`Server läuft auf ${info.baseUrl || `Port ${res.port}`} (Backend ${res.backend})`);
    if (info.examples && info.examples.curl) term.write(term.colors.dim(info.examples.curl.split('\n')[0]));
    return 0;
  }
  if (sub === 'stop') {
    await core.invoke('server:stop');
    term.write('Server gestoppt.');
    return 0;
  }
  if (sub === 'config') {
    if (flags.key === 'neu' || flags.key === 'new') {
      const { key } = await core.invoke('server:generateKey');
      await core.invoke('server:setConfig', { apiKey: key });
      term.write(`Neuer API-Key: ${key}`);
      return 0;
    }
    const patch = {};
    if (flags.port) patch.port = Number.parseInt(String(flags.port), 10);
    if (flags.lan !== undefined) {
      if (flags.lan === true) patch.lan = true;
      else if (flags.lan === 'an' || flags.lan === 'on') patch.lan = true;
      else if (flags.lan === 'aus' || flags.lan === 'off') patch.lan = false;
    }
    if (Object.keys(patch).length) await core.invoke('server:setConfig', patch);
    const info = await core.invoke('server:config');
    if (flags.json) { emitJson(info); return 0; }
    const c = info.config || {};
    term.write(`Host     ${c.host || '127.0.0.1'}${c.lan ? ' (LAN)' : ''}`);
    term.write(`Port     ${c.port}`);
    term.write(`API-Key  ${c.apiKey ? `${String(c.apiKey).slice(0, 6)}…` : '—'}`);
    term.write(`Basis    ${info.baseUrl || ''}`);
    return 0;
  }
  throw new Error(`Unbekannter Unterbefehl: server ${sub}`);
}

async function benchCommand({ core, term, flags }) {
  const BENCH = require('../ui/bench');
  const state = await core.invoke('server:state');
  if (!state.running) throw new Error('Server läuft nicht — vorher: model-harbor server start --model <pfad>');
  const info = await core.invoke('server:config');
  const apiKey = (info.config && info.config.apiKey) || undefined;
  const bar = term.progress('Benchmark');
  let i = 0;
  const result = await BENCH.run({
    port: state.port,
    apiKey,
    model: state.modelPath ? path.basename(state.modelPath) : '',
    onCase: (c) => { i += 1; bar.update({ percent: Math.round(((i - 1) / BENCH.CASES.length) * 100), phase: c.id }); },
  });
  bar.done('fertig');
  const entry = {
    model: state.modelPath ? path.basename(state.modelPath) : 'unbekannt',
    modelId: state.modelPath || null,
    backend: state.backendId || null,
    engine: 'llama.cpp',
    genTps: result.genTps,
    prefillTps: result.prefillTps,
    ttftMs: result.ttftMs,
    results: result.results,
  };
  await core.invoke('bench:add', entry);
  if (flags.json) { emitJson(entry); return 0; }
  tableOrJson(term, flags, ['Fall', 'TTFT ms', 'Prefill tok/s', 'Gen tok/s'],
    result.results.map((r) => [r.case || '', String(Math.round(r.ttftMs)), String(BENCH.round2(r.prefillTps)), String(BENCH.round2(r.genTps))]),
    ['left', 'right', 'right', 'right']);
  term.write('');
  term.write(`Mittel: ${BENCH.round2(result.genTps)} tok/s · Prefill ${BENCH.round2(result.prefillTps)} tok/s · TTFT ${result.ttftMs} ms`);
  return 0;
}

async function configCommand({ core, term, flags, sub, args }) {
  const ALLOWED = ['ctx', 'gpuLayers', 'language', 'backendPreference', 'modelsDir', 'backendsDir', 'debugLog'];
  if (!sub || sub === 'get') {
    const s = core.settings;
    if (flags.json) { emitJson(s); return 0; }
    term.write(`Daten       ${core.base}`);
    term.write(`Modelle     ${s.modelsDir}`);
    term.write(`Backends    ${s.backendsDir}`);
    term.write(`Kontext     ${s.ctx}`);
    term.write(`GPU-Layers  ${s.gpuLayers}`);
    term.write(`Sprache     ${s.language}`);
    term.write(`Backend     ${s.backendPreference}`);
    term.write(`Zusatz      ${(s.extraModelDirs || []).join(', ') || '—'}`);
    return 0;
  }
  if (sub === 'set') {
    const [key, ...rest] = args;
    const value = rest.join(' ');
    if (!ALLOWED.includes(key)) throw new Error(`Unbekannter Schlüssel: ${key} (erlaubt: ${ALLOWED.join(', ')})`);
    let parsed = value;
    if (['ctx', 'gpuLayers'].includes(key)) {
      parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Zahl erwartet');
    }
    if (key === 'debugLog') parsed = value === 'true' || value === '1' || value === 'an';
    if (key === 'modelsDir' || key === 'backendsDir') {
      parsed = path.resolve(value);
      await require('fs/promises').mkdir(parsed, { recursive: true });
    }
    await core.invoke('settings:set', { [key]: parsed });
    term.write(`${key} = ${parsed}`);
    return 0;
  }
  throw new Error(`Unbekannter Unterbefehl: config ${sub}`);
}

async function statusCommand({ core, term, flags }) {
  const scan = await core.invoke('hw:scan', true);
  const state = await core.invoke('server:state');
  const info = await core.invoke('server:config');
  const local = await core.invoke('models:local');
  const backendsInfo = await core.invoke('backends:list');
  if (flags.json) {
    emitJson({ hw: scan, server: state, config: info, models: local.length, backends: backendsInfo.installed });
    return 0;
  }
  term.write(term.colors.bold('System'));
  term.write(`  ${scan.osName || process.platform} ${scan.arch} · ${scan.cpuModel}`);
  term.write(`  Kerne ${scan.cpuCores} · RAM ${Number(scan.totalMemGB).toFixed(1)} GB (${Number(scan.freeMemGB).toFixed(1)} GB frei)`);
  term.write(`  Modellbudget ${Number(scan.modelBudgetGB || 0).toFixed(1)} GB · Empfehlung ${scan.recommendation ? scan.recommendation.primary : '—'}`);
  term.write(term.colors.bold('Installation'));
  term.write(`  Daten      ${core.base}`);
  term.write(`  Modelle    ${local.length} in ${core.settings.modelsDir}`);
  term.write(`  Backends   ${(backendsInfo.installed || []).length} in ${core.settings.backendsDir}`);
  term.write(`  Server     ${state.running ? `läuft auf ${info.baseUrl || state.port}` : 'gestoppt'}`);
  return 0;
}

module.exports = { main, parseArgs, HELP };

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    process.stderr.write(`Fehler: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
