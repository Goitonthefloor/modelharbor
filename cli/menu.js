'use strict';
/* Interaktiver Dialog hinter `model-harbor start`.
 *
 * Zeigt oben, was die Maschine und die Installation hergeben (Modelle, Backends,
 * Ressourcen, Serverzustand) und führt über ein Zahlenmenü zu den Aktionen.
 * Bedienung bewusst nur mit Zahlen — keine versteckten Tastenkürzel, damit die
 * Bedienung auf jeder Tastatur und über SSH gleich funktioniert. */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { createTerminal } = require('./ui-kit');
const hardware = require('../electron/hardware');
const BENCH = require('../ui/bench');

/** Eingabe-Ende (Strg-D) ist kein Fehler: bis nach oben durchreichen, main beendet sauber. */
function isAbort(e) { return !!e && e.name === 'MenuAbort'; }

function fmtGB(n) {
  const v = Number(n) || 0;
  return v >= 10 ? `${v.toFixed(0)} GB` : `${v.toFixed(1)} GB`;
}

function shortName(m) {
  const raw = String((m && (m.name || m.file || m.id)) || '?');
  return raw.length > 42 ? `${raw.slice(0, 39)}…` : raw;
}

function createMenu(options) {
  const core = options.core;
  const term = options.term || createTerminal();
  const version = options.version || '';
  const say = term.write;
  const sayErr = term.writeErr;

  let webHandle = null;   // laufender Web-Server (aus dem Menü gestartet)
  let hw = null;

  /* ----------------------------- Anzeige-Hilfen ----------------------------- */

  function hwLine(scan) {
    const cpu = `${scan.cpuModel || 'CPU'} (${scan.cpuCores || '?'} Kerne)`;
    const ram = `${fmtGB(scan.freeMemGB)} frei / ${fmtGB(scan.totalMemGB)}`;
    const gpus = Array.isArray(scan.gpus) ? scan.gpus.filter((g) => g && !hardware.isIntegrated(g)) : [];
    const gpu = gpus.length
      ? gpus.map((g) => `${g.name || g.model || 'GPU'} ${g.vramGB ? fmtGB(g.vramGB) : ''}`.trim()).join(', ')
      : 'keine dedizierte GPU';
    return { cpu, ram, gpu };
  }

  async function header() {
    hw = await core.scanHardwareCached();
    const h = hwLine(hw);
    const state = await core.invoke('server:state');
    const settings = core.settings;
    const installedBackends = await core.invoke('backends:list').catch(() => ({ installed: [] }));
    const localModels = await core.invoke('models:local').catch(() => []);
    say('');
    say(term.colors.bold(`ModelHarbor ${version} — headless CLI`));
    say(term.hr());
    say(`  ${term.colors.dim('CPU')}     ${h.cpu}`);
    say(`  ${term.colors.dim('RAM')}     ${h.ram}`);
    say(`  ${term.colors.dim('GPU')}     ${h.gpu}`);
    const primary = hw.recommendation ? hw.recommendation.primary : null;
    say(`  ${term.colors.dim('Backend')} ${(installedBackends.installed || []).length} installiert${primary ? ` · Empfehlung: ${primary}` : ''}`);
    say(`  ${term.colors.dim('Modelle')} ${localModels.length} lokal · Ordner: ${settings.modelsDir}`);
    say(`  ${term.colors.dim('Daten')}   ${core.base}`);
    if (state.running) {
      say(`  ${term.colors.dim('Server')}  ${term.colors.ok('läuft')} auf http://127.0.0.1:${state.port}${state.modelPath ? ` · ${path.basename(state.modelPath)}` : ''}`);
    } else {
      say(`  ${term.colors.dim('Server')}  ${term.colors.dim('gestoppt')}`);
    }
    if (webHandle) say(`  ${term.colors.dim('Web')}     ${term.colors.ok('läuft')} auf ${webHandle.url}`);
    say(term.hr());
    return { localModels, installedBackends, state };
  }

  async function errText(e) {
    return e && e.message ? e.message : String(e);
  }

  /* ------------------------------- Hauptmenü ------------------------------- */

  async function main() {
    for (;;) {
      const { localModels, installedBackends, state } = await header();
      const running = !!state.running;
      const pick = await term.choose('Was möchtest du tun?', [
        { label: 'Modelle', hint: `${localModels.length} lokal — laden, löschen, Einstellungen` },
        { label: 'Backends', hint: `${(installedBackends.installed || []).length} installiert — herunterladen, entfernen` },
        { label: running ? 'Server stoppen' : 'Server starten', hint: running ? `läuft auf Port ${state.port}` : 'Modell auswählen und API-Server starten' },
        { label: 'Modell suchen & herunterladen', hint: 'HuggingFace-Suche (GGUF/ONNX)' },
        { label: 'Backend herunterladen', hint: 'llama.cpp-Varianten für diese Maschine' },
        { label: 'Benchmark', hint: 'Tokens/s, Prefill und TTFT messen' },
        { label: 'Einstellungen', hint: 'Kontext, GPU-Layers, Ordner, Port, Key' },
        { label: 'Web-Oberfläche', hint: webHandle ? `läuft: ${webHandle.url}` : 'UI im Browser bereitstellen' },
        { label: 'Status & Logs', hint: 'Hardware, Modellordner, Server-Log' },
      ], { backLabel: 'Beenden' });

      try {
        if (pick === 0) return;
        if (pick === 1) await modelsMenu();
        else if (pick === 2) await backendsMenu();
        else if (pick === 3) { if (running) await stopServerFlow(); else await startServerFlow(); }
        else if (pick === 4) await searchMenu();
        else if (pick === 5) await backendsDownloadFlow();
        else if (pick === 6) await benchMenu();
        else if (pick === 7) await settingsMenu();
        else if (pick === 8) await webMenu();
        else if (pick === 9) await statusMenu();
      } catch (e) {
        if (isAbort(e)) throw e;
        say('');
        sayErr(`  ${term.colors.err('Fehler:')} ${await errText(e)}`);
        await term.ask('Weiter mit Enter');
      }
    }
  }

  /* -------------------------------- Modelle -------------------------------- */

  async function loadLocalModels() {
    return core.invoke('models:local');
  }

  async function modelsMenu() {
    for (;;) {
      const list = await loadLocalModels();
      say('');
      if (!list.length) {
        say(term.colors.warn('Noch keine Modelle vorhanden.'));
        const go = await term.confirm('Jetzt ein Modell suchen?', true);
        if (go) await searchMenu();
        return;
      }
      const rows = list.map((m, i) => [
        String(i + 1),
        shortName(m),
        hardware.formatBytes(m.sizeBytes),
        m.isOnnx ? 'ONNX' : 'GGUF',
        m.fit ? (m.fit.label || m.fit.verdict || '—') : '—',
        `${m.fitCtx || '?'} ctx`,
      ]);
      say(term.table(['#', 'Modell', 'Größe', 'Typ', 'Fit', 'Kontext'], rows, { align: ['right'] }));
      const pick = await term.choose('', list.map((m) => ({
        label: `${m.fit && m.fit.verdict === 'no' ? '✗ ' : ''}${shortName(m)}`,
        hint: m.isOnnx ? 'ONNX-Modell' : `${hardware.formatBytes(m.sizeBytes)}`,
      })), { backLabel: 'Zurück' });
      if (pick === 0) return;
      await modelDetail(list[pick - 1]);
    }
  }

  async function modelDetail(m) {
    const state = await core.invoke('server:state');
    const running = !!state.running;
    for (;;) {
      say('');
      say(term.colors.bold(shortName(m)));
      say(term.hr());
      say(`  Pfad      ${m.path}`);
      say(`  Größe     ${hardware.formatBytes(m.sizeBytes)} · Typ ${m.isOnnx ? 'ONNX' : 'GGUF'}${m.quant ? ` · ${m.quant}` : ''}`);
      if (m.fit) {
        const need = m.fit.needGB ? ` · Bedarf ${fmtGB(m.fit.needGB)}` : '';
        const detail = m.fit.detail ? ` (${m.fit.detail})` : '';
        say(`  Fit       ${m.fit.label || m.fit.verdict}${need}${detail}`);
      }
      if (m.settingsSummary) say(`  Eigenwerte ${m.settingsSummary}`);
      const pick = await term.choose('Aktion', [
        { label: running ? 'Server mit diesem Modell neu starten' : 'Server mit diesem Modell starten' },
        { label: 'Modell-Einstellungen', hint: 'Kontext, GPU-Layers, KV-Cache' },
        { label: 'Fit neu berechnen', hint: 'Hardware neu scannen' },
        { label: 'Modell löschen', hint: 'Datei vom Datenträger entfernen' },
      ], { backLabel: 'Zurück' });
      if (pick === 0) return;
      if (pick === 1) { await startServerFlow(m); return; }
      if (pick === 2) { await modelSettingsFlow(m); continue; }
      if (pick === 3) { await core.invoke('hw:scan', true); const next = (await loadLocalModels()).find((x) => x.path === m.path); if (next) m = next; continue; }
      if (pick === 4) {
        const sure = await term.confirm(`„${shortName(m)}“ wirklich löschen?`, false);
        if (!sure) continue;
        await core.invoke('models:delete', m.id);
        say(`  ${term.colors.ok('✓')} gelöscht`);
        return;
      }
    }
  }

  async function modelSettingsFlow(m) {
    const info = await core.invoke('modelSettings:get', m.id);
    const schema = await core.invoke('modelSettings:schema');
    for (;;) {
      const r = info.resolved || {};
      say('');
      say(term.colors.bold(`Einstellungen: ${shortName(m)}`));
      say(`  Kontext      ${r.ctx}`);
      if (!m.isOnnx) {
        say(`  GPU-Layers   ${r.gpuLayers}`);
        say(`  KV-Cache     ${r.cacheTypeK || schema.defaultCache}/${
          r.cacheTypeV || schema.defaultCache
        }${info.summary ? ` · ${info.summary}` : ''}`);
      }
      const pick = await term.choose('Ändern', [
        { label: 'Kontextgröße', hint: `aktuell ${r.ctx}` },
        { label: m.isOnnx ? 'ONNX: keine weiteren Optionen' : 'GPU-Layers', hint: `aktuell ${r.gpuLayers}`, disabled: !!m.isOnnx },
        { label: 'KV-Cache-Typ', hint: `aktuell ${r.cacheTypeK || schema.defaultCache}`, disabled: !!m.isOnnx },
        { label: 'Modellwerte zurücksetzen' },
      ], { backLabel: 'Zurück' });
      if (pick === 0) return;
      if (pick === 1) {
        const raw = await term.ask('Kontextgröße (Tokens, 512–1048576)', { default: String(r.ctx) });
        const ctx = Number.parseInt(raw, 10);
        if (!Number.isFinite(ctx) || ctx < 512) { sayErr(term.colors.err('  Ungültige Größe.')); continue; }
        info.resolved = (await core.invoke('modelSettings:set', m.id, { ctx })).resolved;
        say(`  ${term.colors.ok('✓')} gespeichert`);
      } else if (pick === 2) {
        const raw = await term.ask('GPU-Layers (0 = CPU, 999 = alle)', { default: String(r.gpuLayers) });
        const layers = Number.parseInt(raw, 10);
        if (!Number.isFinite(layers) || layers < 0) { sayErr(term.colors.err('  Ungültige Zahl.')); continue; }
        info.resolved = (await core.invoke('modelSettings:set', m.id, { gpuLayers: layers })).resolved;
        say(`  ${term.colors.ok('✓')} gespeichert`);
      } else if (pick === 3) {
        const types = Object.keys(schema.cacheTypes || {});
        const sel = await term.choose('KV-Cache', types.map((t) => ({ label: t, hint: (schema.cacheTypes[t] && schema.cacheTypes[t].hint) || '' })), { backLabel: 'Zurück' });
        if (!sel) continue;
        const type = types[sel - 1];
        info.resolved = (await core.invoke('modelSettings:set', m.id, { cacheTypeK: type, cacheTypeV: type })).resolved;
        say(`  ${term.colors.ok('✓')} gespeichert`);
      } else if (pick === 4) {
        info.resolved = (await core.invoke('modelSettings:reset', m.id)).resolved;
        say(`  ${term.colors.ok('✓')} zurückgesetzt`);
      }
    }
  }

  /* ----------------------------- Modellsuche ------------------------------ */

  async function searchMenu() {
    const query = await term.ask('Suchbegriff für HuggingFace (leer = Katalog)', { default: '' });
    say('');
    say(term.colors.dim('  Suche läuft …'));
    let hits;
    try {
      hits = query ? await core.invoke('models:search', query) : await core.invoke('models:catalog');
    } catch (e) {
      if (isAbort(e)) throw e;
      sayErr(`  ${term.colors.err('Suche fehlgeschlagen:')} ${await errText(e)}`);
      return;
    }
    if (!hits || !hits.length) {
      say(term.colors.warn('Keine Treffer.'));
      return;
    }
    const list = hits.slice(0, 25);
    const rows = list.map((h, i) => [
      String(i + 1),
      String(h.repo || h.id || '').slice(0, 46),
      h.downloads ? String(h.downloads) : '',
      h.fit ? (h.fit.label || h.fit.verdict || '') : '',
    ]);
    say(term.table(['#', 'Repository', 'Downloads', 'Fit'], rows, { align: ['right'] }));
    const pick = await term.choose('', list.map((h) => ({ label: String(h.repo || h.id || ''), hint: h.fit ? (h.fit.label || '') : '' })), { backLabel: 'Zurück' });
    if (!pick) return;
    await filesFlow(list[pick - 1]);
  }

  async function filesFlow(hit) {
    const repo = hit.repo || hit.id;
    say('');
    say(term.colors.dim(`  Lade Dateiliste für ${repo} …`));
    let info;
    try {
      info = await core.invoke('models:files', repo);
    } catch (e) {
      if (isAbort(e)) throw e;
      sayErr(`  ${term.colors.err('Dateiliste fehlgeschlagen:')} ${await errText(e)}`);
      return;
    }
    const files = (info.files || []).slice(0, 30);
    if (!files.length) { say(term.colors.warn('Keine passenden Dateien gefunden.')); return; }
    const rows = files.map((f, i) => [
      String(i + 1),
      String(f.name).slice(0, 52),
      hardware.formatBytes(f.size),
      f.fit ? (f.fit.label || f.fit.verdict || '') : '',
    ]);
    say(term.table(['#', 'Datei', 'Größe', 'Fit'], rows, { align: ['right'] }));
    const pick = await term.choose('', files.map((f) => ({
      label: String(f.name),
      hint: `${hardware.formatBytes(f.size)}${f.fit && f.fit.label ? ` · ${f.fit.label}` : ''}`,
    })), { backLabel: 'Zurück' });
    if (!pick) return;
    const file = files[pick - 1];
    const ok = await term.confirm(`„${file.name}“ (${hardware.formatBytes(file.size)}) herunterladen?`, true);
    if (!ok) return;
    await downloadFlow({ repo, file: file.name, isOnnx: !!info.isOnnx || !!file.isOnnx });
  }

  async function downloadFlow(opts) {
    const bar = term.progress('Download');
    const off = core.on('download:progress', (p) => bar.update(p));
    try {
      const result = await core.invoke('models:download', opts);
      bar.done(`${path.basename(result.path || result.file || '')} → ${hardware.formatBytes(result.sizeBytes)}${result.fit && result.fit.label ? ` · ${result.fit.label}` : ''}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      bar.fail(await errText(e));
    } finally {
      off();
    }
    await term.ask('Weiter mit Enter');
  }

  /* ------------------------------- Backends ------------------------------- */

  async function backendsList() {
    return core.invoke('backends:list');
  }

  async function backendsMenu() {
    for (;;) {
      const info = await backendsList();
      say('');
      const installed = info.installed || [];
      if (installed.length) {
        const rows = installed.map((b, i) => [String(i + 1), b.id, b.version || b.release || '', b.serverPath ? path.basename(b.serverPath) : '']);
        say(term.table(['#', 'Backend', 'Version', 'Programm'], rows, { align: ['right'] }));
      } else {
        say(term.colors.warn('Kein Backend installiert — ohne Backend kann kein Modell laufen.'));
      }
      if (info.error) say(term.colors.dim(`  Release-Abfrage: ${info.error}`));
      const pick = await term.choose('Aktionen', [
        { label: 'Backend herunterladen', hint: info.recommended ? `Empfehlung: ${info.recommended}` : 'llama.cpp-Builds' },
        { label: 'Installiertes Backend entfernen', disabled: !installed.length },
      ], { backLabel: 'Zurück' });
      if (pick === 0) return;
      if (pick === 1) { await backendsDownloadFlow(); continue; }
      if (pick === 2) {
        const sel = await term.choose('Welches entfernen?', installed.map((b) => ({ label: b.id, hint: b.version || '' })), { backLabel: 'Zurück' });
        if (!sel) continue;
        const target = installed[sel - 1].id;
        if (await term.confirm(`Backend „${target}“ entfernen?`, false)) {
          await core.invoke('backends:remove', target);
          say(`  ${term.colors.ok('✓')} entfernt`);
        }
      }
    }
  }

  async function backendsDownloadFlow() {
    const info = await backendsList();
    if (info.error) {
      sayErr(`  ${term.colors.err('Release-Liste nicht abrufbar:')} ${info.error}`);
      return;
    }
    const available = (info.available || []).filter((b) => !b.installed);
    const all = info.available || [];
    const pool = available.length ? available : all;
    if (!pool.length) { say(term.colors.warn('Keine Backends verfügbar.')); return; }
    say('');
    const rows = pool.map((b, i) => [
      String(i + 1),
      b.id,
      b.recommended ? 'ja' : '',
      b.experimental ? 'experimentell' : '',
      b.reason || b.description || '',
    ]);
    say(term.table(['#', 'Backend', 'Empfohlen', 'Hinweis', 'Grund'], rows, { align: ['right'] }));
    const pick = await term.choose('', pool.map((b) => ({
      label: b.id,
      hint: `${b.recommended ? 'empfohlen · ' : ''}${b.experimental ? 'experimentell' : ''}`.trim(),
    })), { backLabel: 'Zurück' });
    if (!pick) return;
    const target = pool[pick - 1];
    if (!(await term.confirm(`Backend „${target.id}“ herunterladen und installieren?`, true))) return;
    const bar = term.progress('Backend');
    const off = core.on('backend:progress', (p) => bar.update(p));
    try {
      const manifest = await core.invoke('backends:install', target.id);
      bar.done(`${target.id} installiert${manifest && manifest.version ? ` (${manifest.version})` : ''}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      bar.fail(await errText(e));
    } finally {
      off();
    }
    await term.ask('Weiter mit Enter');
  }

  /* -------------------------------- Server -------------------------------- */

  async function startServerFlow(preselected) {
    let model = preselected;
    if (!model) {
      const list = await loadLocalModels();
      if (!list.length) {
        say(term.colors.warn('Keine Modelle vorhanden.'));
        if (await term.confirm('Jetzt ein Modell suchen?', true)) await searchMenu();
        const after = await loadLocalModels();
        if (!after.length) return;
        model = await pickModel(after);
      } else {
        model = await pickModel(list);
      }
      if (!model) return;
    }
    const state = await core.invoke('server:state');
    if (state.running) {
      const sure = await term.confirm(`Server läuft (Port ${state.port}) — mit „${shortName(model)}“ neu starten?`, true);
      if (!sure) return;
      await core.invoke('server:stop');
    }
    say('');
    say(term.colors.dim(`  Starte ${shortName(model)} …`));
    try {
      const res = await core.invoke('server:start', { modelPath: model.path, modelId: model.id, isOnnx: model.isOnnx });
      const info = await core.invoke('server:config');
      say(`  ${term.colors.ok('✓')} Server läuft auf http://${info.host || '127.0.0.1'}:${res.port}`);
      say(`    Backend ${res.backend} · Preset ${res.preset || '—'} · ctx ${res.settings ? res.settings.ctx : '?'}`);
      say(term.colors.dim(`    ${info.examples && info.examples.curl ? info.examples.curl.split('\n')[0] : ''}`));
    } catch (e) {
      if (isAbort(e)) throw e;
      sayErr(`  ${term.colors.err('Start fehlgeschlagen:')} ${await errText(e)}`);
    }
    await term.ask('Weiter mit Enter');
  }

  async function pickModel(list) {
    const pick = await term.choose('Modell wählen', list.map((m) => ({
      label: shortName(m),
      hint: `${hardware.formatBytes(m.sizeBytes)}${m.fit && m.fit.label ? ` · ${m.fit.label}` : ''}`,
    })), { backLabel: 'Abbrechen' });
    return pick ? list[pick - 1] : null;
  }

  async function stopServerFlow() {
    if (!(await term.confirm('Server stoppen?', true))) return;
    await core.invoke('server:stop');
    say(`  ${term.colors.ok('✓')} gestoppt`);
  }

  async function serverConfigFlow() {
    for (;;) {
      const info = await core.invoke('server:config');
      const cfg = info.config || {};
      say('');
      say(term.colors.bold('Server-Konfiguration'));
      say(`  Host      ${cfg.host || '127.0.0.1'}${cfg.lan ? ' (LAN freigegeben)' : ''}`);
      say(`  Port      ${cfg.port}`);
      say(`  API-Key   ${cfg.apiKey ? `${String(cfg.apiKey).slice(0, 6)}…` : '—'}`);
      const pick = await term.choose('Ändern', [
        { label: 'Port', hint: `aktuell ${cfg.port}` },
        { label: cfg.lan ? 'LAN-Zugriff abschalten' : 'LAN-Zugriff freigeben' },
        { label: 'Neuen API-Key erzeugen' },
      ], { backLabel: 'Zurück' });
      if (pick === 0) return;
      if (pick === 1) {
        const raw = await term.ask('Port (1024–65535)', { default: String(cfg.port) });
        const port = Number.parseInt(raw, 10);
        if (!Number.isFinite(port) || port < 1024 || port > 65535) { sayErr(term.colors.err('  Ungültiger Port.')); continue; }
        await core.invoke('server:setConfig', { port });
        say(`  ${term.colors.ok('✓')} Port gespeichert (greift beim nächsten Start)`);
      } else if (pick === 2) {
        await core.invoke('server:setConfig', { lan: !cfg.lan });
        say(`  ${term.colors.ok('✓')} ${cfg.lan ? 'LAN abgeschaltet' : 'LAN freigegeben'}`);
      } else if (pick === 3) {
        const { key } = await core.invoke('server:generateKey');
        await core.invoke('server:setConfig', { apiKey: key });
        say(`  ${term.colors.ok('✓')} neuer Key: ${term.colors.bold(key)}`);
      }
    }
  }

  /* ------------------------------- Benchmark ------------------------------ */

  async function benchMenu() {
    const state = await core.invoke('server:state');
    if (!state.running) {
      say(term.colors.warn('Für den Benchmark muss der Server laufen.'));
      if (!(await term.confirm('Server jetzt starten?', true))) return;
      await startServerFlow();
      const after = await core.invoke('server:state');
      if (!after.running) return;
    }
    const st = await core.invoke('server:state');
    const info = await core.invoke('server:config');
    const apiKey = (info.config && info.config.apiKey) || undefined;
    const modelName = st.modelPath ? path.basename(st.modelPath) : '';
    say('');
    say(`  ${term.colors.dim('Messe gegen')} http://127.0.0.1:${st.port} ${modelName ? `· ${modelName}` : ''}`);
    const bar = term.progress('Benchmark');
    let i = 0;
    try {
      const result = await BENCH.run({
        port: st.port,
        apiKey,
        model: modelName,
        onCase: (c) => {
          i += 1;
          bar.update({ percent: Math.round(((i - 1) / BENCH.CASES.length) * 100), phase: c.id });
        },
      });
      bar.done(`fertig · ${BENCH.CASES.length} Lastfälle`);
      const rows = result.results.map((r) => [
        r.case || r.c,
        String(Math.round(r.ttftMs)),
        String(BENCH.round2(r.prefillTps)),
        String(BENCH.round2(r.genTps)),
        String(r.completionTokens || r.tokens || ''),
      ]);
      say('');
      say(term.table(['Fall', 'TTFT ms', 'Prefill tok/s', 'Gen tok/s', 'Tokens'], rows, { align: ['right'] }));
      say('');
      say(`  ${term.colors.bold('Mittel')}  ${BENCH.round2(result.genTps)} tok/s · Prefill ${BENCH.round2(result.prefillTps)} tok/s · TTFT ${result.ttftMs} ms`);
      const entry = {
        model: modelName || 'unbekannt',
        modelId: st.modelPath || null,
        backend: st.backendId || state.backendId || null,
        engine: 'llama.cpp',
        genTps: result.genTps,
        prefillTps: result.prefillTps,
        ttftMs: result.ttftMs,
        results: result.results,
      };
      const saved = await core.invoke('bench:add', entry);
      const savedId = Array.isArray(saved) && saved[0] ? saved[0].id : (saved && saved.id);
      say(`  ${term.colors.ok('✓')} im Verlauf gespeichert${savedId ? ` (${savedId})` : ''}`);
    } catch (e) {
      if (isAbort(e)) throw e;
      bar.fail(await errText(e));
    }
    await term.ask('Weiter mit Enter');
  }

  /* ----------------------------- Einstellungen ---------------------------- */

  async function settingsMenu() {
    for (;;) {
      const s = core.settings;
      say('');
      say(term.colors.bold('Einstellungen'));
      say(`  Kontext        ${s.ctx}`);
      say(`  GPU-Layers     ${s.gpuLayers}`);
      say(`  Sprache        ${s.language}`);
      say(`  Backend-Wahl   ${s.backendPreference}`);
      say(`  Modellordner   ${s.modelsDir}`);
      say(`  Zusatzordner   ${(s.extraModelDirs || []).length ? (s.extraModelDirs || []).join(', ') : '—'}`);
      const pick = await term.choose('Ändern', [
        { label: 'Kontextgröße (global)', hint: `${s.ctx} Tokens` },
        { label: 'GPU-Layers (global)', hint: `${s.gpuLayers}` },
        { label: 'Sprache der Oberfläche', hint: s.language },
        { label: 'Bevorzugtes Backend', hint: s.backendPreference },
        { label: 'Haupt-Modellordner', hint: s.modelsDir },
        { label: 'Zusatz-Modellordner verwalten' },
        { label: 'Server-Konfiguration (Port, LAN, Key)' },
      ], { backLabel: 'Zurück' });
      if (pick === 0) return;
      if (pick === 1) {
        const raw = await term.ask('Kontextgröße in Tokens', { default: String(s.ctx) });
        const ctx = Number.parseInt(raw, 10);
        if (!Number.isFinite(ctx) || ctx < 512) { sayErr(term.colors.err('  Ungültig.')); continue; }
        await core.invoke('settings:set', { ctx });
      } else if (pick === 2) {
        const raw = await term.ask('GPU-Layers (0 = CPU, 999 = alle)', { default: String(s.gpuLayers) });
        const gpuLayers = Number.parseInt(raw, 10);
        if (!Number.isFinite(gpuLayers) || gpuLayers < 0) { sayErr(term.colors.err('  Ungültig.')); continue; }
        await core.invoke('settings:set', { gpuLayers });
      } else if (pick === 3) {
        const sel = await term.choose('Sprache', [{ label: 'Deutsch', hint: 'de' }, { label: 'English', hint: 'en' }], { backLabel: 'Zurück' });
        if (!sel) continue;
        await core.invoke('settings:set', { language: sel === 1 ? 'de' : 'en' });
      } else if (pick === 4) {
        const info = await core.invoke('backends:list');
        const items = [{ label: 'Automatisch (Hardware-Empfehlung)', hint: info.recommended || '' }]
          .concat((info.installed || []).map((b) => ({ label: b.id, hint: b.version || '' })));
        const sel = await term.choose('Backend', items, { backLabel: 'Zurück' });
        if (!sel) continue;
        await core.invoke('settings:set', { backendPreference: sel === 1 ? 'auto' : info.installed[sel - 2].id });
      } else if (pick === 5) {
        const raw = await term.ask('Pfad zum Haupt-Modellordner', { default: s.modelsDir });
        const dir = path.resolve(raw);
        if (!fs.existsSync(dir)) {
          if (!(await term.confirm(`Ordner ${dir} existiert nicht — anlegen?`, true))) continue;
          await fsp.mkdir(dir, { recursive: true });
        }
        await core.invoke('settings:set', { modelsDir: dir });
        say(`  ${term.colors.ok('✓')} gespeichert`);
      } else if (pick === 6) {
        await sourcesFlow();
      } else if (pick === 7) {
        await serverConfigFlow();
      }
    }
  }

  async function sourcesFlow() {
    for (;;) {
      const sources = await core.invoke('models:sources');
      say('');
      if (sources.length) {
        say(term.table(['#', 'Ordner', 'erreichbar'], sources.map((s, i) => [String(i + 1), s.dir, s.exists ? 'ja' : 'nein']), { align: ['right'] }));
      } else {
        say(term.colors.dim('  Keine Zusatzordner eingetragen.'));
      }
      const pick = await term.choose('Zusatzordner', [
        { label: 'Ordner hinzufügen' },
        { label: 'Ordner entfernen', disabled: !sources.length },
      ], { backLabel: 'Zurück' });
      if (pick === 0) return;
      if (pick === 1) {
        const raw = await term.ask('Pfad zum Modellordner', { default: '' });
        if (!raw) continue;
        try {
          const res = await core.invoke('models:addSource', path.resolve(raw));
          say(`  ${term.colors.ok('✓')} eingetragen · ${res.count} Modell(e) gefunden`);
        } catch (e) {
          if (isAbort(e)) throw e;
          sayErr(`  ${term.colors.err('Fehler:')} ${await errText(e)}`);
        }
      } else if (pick === 2) {
        const sel = await term.choose('Entfernen', sources.map((s) => ({ label: s.dir })), { backLabel: 'Zurück' });
        if (!sel) continue;
        // Nur der Eintrag verschwindet — die Dateien im Ordner bleiben.
        await core.invoke('models:removeSource', sources[sel - 1].dir);
        say(`  ${term.colors.ok('✓')} entfernt`);
      }
    }
  }

  /* ------------------------------- Webmodus ------------------------------- */

  async function webMenu() {
    if (webHandle) {
      say('');
      say(`  Web-Oberfläche läuft auf ${term.colors.bold(webHandle.url)}`);
      const stop = await term.confirm('Web-Server stoppen?', false);
      if (stop) {
        await webHandle.close();
        webHandle = null;
        say(`  ${term.colors.ok('✓')} gestoppt`);
      }
      return;
    }
    const rawPort = await term.ask('Port für die Web-Oberfläche', { default: '8787' });
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isFinite(port) || port < 1024 || port > 65535) { sayErr(term.colors.err('  Ungültiger Port.')); return; }
    const lan = await term.confirm('Auch aus dem LAN erreichbar machen?', false);
    const { startWebServer } = require('./web/server');
    try {
      webHandle = await startWebServer({ core, port, host: lan ? '0.0.0.0' : '127.0.0.1', version });
      say('');
      say(`  ${term.colors.ok('✓')} Web-Oberfläche: ${term.colors.bold(webHandle.url)}`);
      if (lan) {
        const sc = require('../electron/server-config');
        const addrs = sc.lanAddresses().map((a) => `http://${a}:${port}`);
        if (addrs.length) say(term.colors.dim(`    im LAN: ${addrs.join(' · ')}`));
      }
      say(term.colors.dim('    Das Menü bleibt nutzbar; Strg-C beendet alles.'));
    } catch (e) {
      if (isAbort(e)) throw e;
      webHandle = null;
      sayErr(`  ${term.colors.err('Web-Server fehlgeschlagen:')} ${await errText(e)}`);
    }
  }

  /* -------------------------------- Status -------------------------------- */

  async function statusMenu() {
    const scan = await core.scanHardwareCached(true);
    const h = hwLine(scan);
    const state = await core.invoke('server:state');
    say('');
    say(term.colors.bold('Status'));
    say(term.hr());
    say(`  System     ${scan.osName || process.platform} ${scan.arch} · ${scan.cpuModel} (${scan.cpuCores} Kerne)`);
    say(`  RAM        ${h.ram} · Modellbudget ${fmtGB(scan.modelBudgetGB || 0)}`);
    say(`  GPU        ${h.gpu}`);
    say(`  Empfehlung ${scan.recommendation ? scan.recommendation.primary : '—'}`);
    say(`  Modelle    ${core.settings.modelsDir}`);
    const sources = await core.invoke('models:sources');
    for (const s of sources) say(`             + ${s.dir}${s.exists ? '' : term.colors.err(' (fehlt)')}`);
    say(`  Backends   ${core.settings.backendsDir}`);
    say(`  Server     ${state.running ? `läuft auf Port ${state.port}` : 'gestoppt'}`);
    const info = await core.invoke('server:config');
    say(`             ${info.baseUrl || ''}`);
    if (state.logs && state.logs.length) {
      say('');
      say(term.colors.bold('Letzte Server-Logzeilen'));
      for (const entry of state.logs.slice(-12)) {
        const stamp = new Date(entry.t).toLocaleTimeString('de-DE');
        say(term.colors.dim(`  ${stamp} ${entry.stream === 'err' ? '!' : '·'} ${entry.line}`));
      }
    }
    await term.ask('Weiter mit Enter');
  }

  async function run() {
    await main();
  }

  return { run, main, modelsMenu, backendsMenu, searchMenu, benchMenu, settingsMenu, webMenu, statusMenu, startServerFlow };
}

module.exports = { createMenu, fmtGB, shortName };
