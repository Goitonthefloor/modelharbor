'use strict';
/* Tests der headless CLI: Argumente, Einstellungen, Kanaltabelle, Terminal-Bausteine,
 * Menüablauf und Web-Bridge. Netzwerkaufrufe (HuggingFace, GitHub) werden nicht
 * gebraucht — geprüft wird alles, was ohne Download/Server läuft. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { parseArgs, main } = require('../cli/index');
const cfg = require('../cli/config');
const { createCore } = require('../cli/core');
const { createTerminal } = require('../cli/ui-kit');
const { createMenu } = require('../cli/menu');
const { startWebServer } = require('../cli/web/server');
const { userDataDir } = require('../cli/paths');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cli-'));
  return dir;
}

/* ------------------------------- Argumente ------------------------------- */

test('parseArgs trennt Schalter, Werte und Positionen', () => {
  const { flags, rest } = parseArgs(['serve', '--port', '9000', '--lan', '--json']);
  assert.deepStrictEqual(rest, ['serve']);
  assert.strictEqual(flags.port, '9000');
  assert.strictEqual(flags.lan, true);
  assert.strictEqual(flags.json, true);
});

test('parseArgs behandelt einen Schalter ohne Wert als true', () => {
  const { flags } = parseArgs(['models', 'download', 'repo/x', 'f.gguf', '--onnx']);
  assert.strictEqual(flags.onnx, true);
});

test('userDataDir folgt MODELHARBOR_HOME', () => {
  const prev = process.env.MODELHARBOR_HOME;
  process.env.MODELHARBOR_HOME = '/tmp/mh-test-home';
  try {
    assert.strictEqual(userDataDir(), '/tmp/mh-test-home');
  } finally {
    if (prev === undefined) delete process.env.MODELHARBOR_HOME;
    else process.env.MODELHARBOR_HOME = prev;
  }
});

test('userDataDir nutzt den Plattform-Standard ohne Override', () => {
  const dir = userDataDir({});
  assert.ok(dir.includes('ModelHarbor'), dir);
});

/* ----------------------------- Einstellungen ----------------------------- */

test('config: Standardwerte, Speichern und tiefes Mergen des Server-Teils', async () => {
  const home = tempHome();
  const def = cfg.load(home);
  assert.strictEqual(def.backendPreference, 'auto');
  assert.ok(def.modelsDir.startsWith(home));
  assert.ok(def.server.port > 0);

  const saved = await cfg.save(home, { ctx: 16384 });
  assert.strictEqual(saved.ctx, 16384);
  assert.strictEqual(saved.server.port, def.server.port, 'Port darf nicht verloren gehen');

  const partServer = await cfg.save(home, { server: { lan: true } });
  assert.strictEqual(partServer.server.lan, true);
  assert.strictEqual(partServer.ctx, 16384, 'andere Felder bleiben erhalten');
  assert.strictEqual(partServer.server.port, def.server.port);

  const reloaded = cfg.load(home);
  assert.strictEqual(reloaded.server.lan, true);
});

test('config: kaputtes JSON fällt auf Standardwerte zurück', async () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'settings.json'), '{kaputt', 'utf8');
  const loaded = cfg.load(home);
  assert.strictEqual(loaded.ctx, 8192);
});

/* ------------------------------- Kernkanäle ------------------------------- */

test('core: app:info meldet Modus, Pfade und Version', async () => {
  const home = tempHome();
  const core = createCore({ base: home });
  const info = await core.invoke('app:info');
  assert.strictEqual(info.mode, 'headless');
  assert.strictEqual(info.userData, home);
  assert.ok(info.modelsDir.endsWith('models'));
  assert.ok(/^\d+\.\d+\.\d+/.test(info.version));
});

test('core: unbekannter Kanal wird abgelehnt', async () => {
  const core = createCore({ base: tempHome() });
  await assert.rejects(() => core.invoke('gibt:es:nicht'), /Unbekannter Kanal/);
});

test('core: settings:set schreibt und liefert die neuen Werte', async () => {
  const home = tempHome();
  const core = createCore({ base: home });
  const next = await core.invoke('settings:set', { ctx: 4096, language: 'en' });
  assert.strictEqual(next.ctx, 4096);
  assert.strictEqual(next.language, 'en');
  assert.strictEqual(cfg.load(home).ctx, 4096);
});

test('core: Zusatzordner eintragen, erkennen und entfernen', async () => {
  const home = tempHome();
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-extra-'));
  const core = createCore({ base: home });
  const added = await core.invoke('models:addSource', extra);
  assert.strictEqual(added.dir, path.resolve(extra));
  const sources = await core.invoke('models:sources');
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].exists, true);
  await assert.rejects(() => core.invoke('models:addSource', extra), /schon eingetragen/);
  await core.invoke('models:removeSource', extra);
  assert.strictEqual((await core.invoke('models:sources')).length, 0);
});

test('core: Zusatzordner muss existieren', async () => {
  const core = createCore({ base: tempHome() });
  await assert.rejects(() => core.invoke('models:addSource', '/gibt/es/nicht'), /Kein Ordner/);
});

test('core: Modelle außerhalb der Modellordner werden beim Start abgelehnt', async () => {
  const core = createCore({ base: tempHome() });
  await assert.rejects(() => core.invoke('server:start', { modelPath: '/etc/passwd' }), /außerhalb der Modellordner/);
});

test('core: Benchmark-Verlauf schreiben, lesen und leeren', async () => {
  const home = tempHome();
  const core = createCore({ base: home });
  assert.deepStrictEqual(await core.invoke('bench:list'), []);
  const saved = await core.invoke('bench:add', { model: 'probe.gguf', genTps: 12.5, prefillTps: 40, ttftMs: 120 });
  assert.ok(Array.isArray(saved), 'Verlauf kommt als Liste zurück');
  assert.ok(saved[0].id, 'Eintrag bekommt eine id');
  const list = await core.invoke('bench:list');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].model, 'probe.gguf');
  await core.invoke('bench:remove', saved[0].id);
  assert.strictEqual((await core.invoke('bench:list')).length, 0);
  await core.invoke('bench:add', { model: 'x', genTps: 1 });
  await core.invoke('bench:clear');
  assert.deepStrictEqual(await core.invoke('bench:list'), []);
});

test('core: server:config liefert Basis-URL und Beispiele', async () => {
  const core = createCore({ base: tempHome() });
  const info = await core.invoke('server:config');
  assert.ok(info.config.port > 0);
  assert.ok(typeof info.baseUrl === 'string' && info.baseUrl.startsWith('http://'));
  assert.ok(info.examples.curl.includes('/v1/chat/completions'));
});

test('core: server:setConfig speichert Teil-Patches ohne Key-Verlust', async () => {
  const home = tempHome();
  const core = createCore({ base: home });
  const before = await core.invoke('server:config');
  const keyBefore = before.config.key;
  const after = await core.invoke('server:setConfig', { lan: true });
  assert.strictEqual(after.config.lan, true);
  assert.strictEqual(after.config.key, keyBefore, 'API-Key bleibt erhalten');
  assert.strictEqual(after.config.port, before.config.port);
  assert.strictEqual(cfg.load(home).server.lan, true);
});

test('core: Ereignisse werden an Zuhörer verteilt, Fehler eines Zuhörers stören nicht', () => {
  const core = createCore({ base: tempHome() });
  const seen = [];
  const off = core.on('download:progress', (p) => { seen.push(p.percent); });
  core.on('download:progress', () => { throw new Error('kaputt'); });
  core.emit('download:progress', { percent: 42 });
  off();
  core.emit('download:progress', { percent: 100 });
  assert.deepStrictEqual(seen, [42]);
});

/* ---------------------------- Terminal-Bausteine ---------------------------- */

test('Terminal: ask nutzt Standardwert bei leerer Eingabe', async () => {
  const out = [];
  const term = createTerminal({ answers: [''], isTTY: false, output: { write: (s) => out.push(s), columns: 90 }, errorOutput: { write: () => {} } });
  assert.strictEqual(await term.ask('Port', { default: '8787' }), '8787');
});

test('Terminal: confirm versteht j/n und Standard', async () => {
  const mk = (answers) => createTerminal({ answers, isTTY: false, output: { write: () => {}, columns: 90 }, errorOutput: { write: () => {} } });
  assert.strictEqual(await mk(['j']).confirm('sicher?', false), true);
  assert.strictEqual(await mk(['n']).confirm('sicher?', true), false);
  assert.strictEqual(await mk(['']).confirm('sicher?', true), true);
  assert.strictEqual(await mk(['yes']).confirm('sicher?', false), true);
});

test('Terminal: choose liefert Index, 0 für zurück und fragt bei Unsinn erneut', async () => {
  const term = createTerminal({
    answers: ['abc', '9', '2'],
    isTTY: false,
    output: { write: () => {}, columns: 90 },
    errorOutput: { write: () => {} },
  });
  const pick = await term.choose('Titel', [{ label: 'eins' }, { label: 'zwei' }], { backLabel: 'Zurück' });
  assert.strictEqual(pick, 2);

  const termZero = createTerminal({ answers: ['0'], isTTY: false, output: { write: () => {}, columns: 90 }, errorOutput: { write: () => {} } });
  assert.strictEqual(await termZero.choose('Titel', [{ label: 'eins' }], { backLabel: 'Zurück' }), 0);
});

test('Terminal: gesperrte Einträge werden nicht angenommen', async () => {
  const term = createTerminal({
    answers: ['1', '2'],
    isTTY: false,
    output: { write: () => {}, columns: 90 },
    errorOutput: { write: () => {} },
  });
  const pick = await term.choose('T', [{ label: 'gesperrt', disabled: true }, { label: 'frei' }], { backLabel: 'Zurück' });
  assert.strictEqual(pick, 2);
});

test('Terminal: Tabelle richtet Spalten aus und kürzt nichts weg', () => {
  const lines = [];
  const term = createTerminal({ isTTY: false, output: { write: (s) => lines.push(s), columns: 90 }, errorOutput: { write: () => {} } });
  const text = term.table(['Name', 'Größe'], [['a.gguf', '1 GB'], ['langer-name.gguf', '12 GB']], { align: ['left', 'right'] });
  const rows = text.split('\n');
  assert.ok(rows[0].includes('Name'));
  assert.ok(rows[2].includes('a.gguf'));
  assert.ok(rows[3].trimEnd().endsWith('12 GB'));
});

/* --------------------------------- Menü --------------------------------- */

test('Menü: Kopfzeile zeigt Ressourcen, dann beendet 0 den Dialog', async () => {
  const out = [];
  const term = createTerminal({
    answers: ['0'],
    isTTY: false,
    output: { write: (s) => out.push(s), columns: 100 },
    errorOutput: { write: () => {} },
  });
  const core = createCore({ base: tempHome() });
  const menu = createMenu({ core, term, version: '9.9.9' });
  await menu.run();
  const text = out.join('\n');
  assert.ok(text.includes('ModelHarbor 9.9.9'), text.slice(0, 300));
  assert.ok(text.includes('Modelle'), 'Modellzeile im Kopf');
  assert.ok(text.includes('Backends'), 'Backendzeile im Kopf');
  assert.ok(text.includes('Beenden'));
});

test('Menü: Modellliste ohne Modelle bietet die Suche an (abgelehnt)', async () => {
  const out = [];
  const err = [];
  const term = createTerminal({
    answers: ['1', '0', 'n', '0'],
    isTTY: false,
    output: { write: (s) => out.push(s), columns: 100 },
    errorOutput: { write: (s) => err.push(s) },
  });
  const core = createCore({ base: tempHome() });
  const menu = createMenu({ core, term, version: '9.9.9' });
  await menu.run();
  const text = [...out, ...err].join('\n');
  assert.ok(text.includes('Noch keine Modelle vorhanden'), text.slice(-400));
  assert.ok(text.includes('Jetzt ein Modell suchen?'));
});

test('Kein-Backend-Situation: backends:list meldet fehlendes Backend ohne Absturz', async () => {
  const core = createCore({ base: tempHome() });
  const info = await core.invoke('backends:list');
  assert.ok(Array.isArray(info.installed));
  assert.ok(Array.isArray(info.available));
});

/* ------------------------------- Web-Bridge ------------------------------- */

test('Web-Server: health, statische Oberfläche und invoke', async () => {
  const core = createCore({ base: tempHome() });
  const handle = await startWebServer({ core, port: 0, host: '127.0.0.1', version: '9.9.9' });
  try {
    const health = await fetch(`http://127.0.0.1:${handle.port}/api/health`).then((r) => r.json());
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.mode, 'headless');
    assert.strictEqual(health.version, '9.9.9');
    assert.ok(health.channels > 20);

    const html = await fetch(`http://127.0.0.1:${handle.port}/`);
    assert.strictEqual(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const body = await html.text();
    assert.ok(body.includes('webapi.js'), 'Brücke wird mitgeladen');

    const js = await fetch(`http://127.0.0.1:${handle.port}/app.js`);
    assert.match(js.headers.get('content-type'), /javascript/);

    const invoke = await fetch(`http://127.0.0.1:${handle.port}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'settings:get' }),
    }).then((r) => r.json());
    assert.strictEqual(invoke.ok, true);
    assert.ok(invoke.result.modelsDir);

    const bad = await fetch(`http://127.0.0.1:${handle.port}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'nix:da' }),
    });
    assert.strictEqual(bad.status, 404);

    const err = await fetch(`http://127.0.0.1:${handle.port}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'server:start', args: [{ modelPath: '/etc/passwd' }] }),
    }).then((r) => r.json());
    assert.strictEqual(err.ok, false);
    assert.match(err.error, /außerhalb der Modellordner/);
  } finally {
    await handle.close();
  }
});

test('Web-Server: Pfade außerhalb von ui/ werden abgewiesen', async () => {
  const core = createCore({ base: tempHome() });
  const handle = await startWebServer({ core, port: 0, host: '127.0.0.1' });
  const http = require('http');
  // Rohe Anfrage: fetch normalisiert ".." weg, deshalb direkt über http.
  const raw = (rawPath) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: handle.port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/../cli/index.js']) {
      const res = await raw(p);
      assert.ok([403, 404].includes(res.status), `${p} → Status ${res.status}`);
      assert.ok(!res.body.includes('"devDependencies"'), `${p} darf package.json nicht liefern`);
    }
    const ok = await raw('/app.js');
    assert.strictEqual(ok.status, 200);
  } finally {
    await handle.close();
  }
});

test('Web-Server: SSE-Kanal meldet Ereignisse des Kerns', async () => {
  const core = createCore({ base: tempHome() });
  const handle = await startWebServer({ core, port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/events`, { signal: controller.signal });
    assert.strictEqual(res.status, 200);
    const reader = res.body.getReader();
    await reader.read(); // retry-Zeile
    core.emit('download:progress', { phase: 'file', percent: 55, downloadId: 'x' });
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.ok(text.includes('event: download:progress'), text);
    assert.ok(text.includes('"percent":55'), text);
  } finally {
    controller.abort();
    await handle.close();
  }
});

test('webapi.js baut window.api auf HTTP nach (ohne Electron)', async () => {
  const core = createCore({ base: tempHome() });
  const handle = await startWebServer({ core, port: 0, host: '127.0.0.1' });
  try {
    const code = fs.readFileSync(path.join(__dirname, '..', 'ui', 'webapi.js'), 'utf8');
    const base = `http://127.0.0.1:${handle.port}`;
    const sandbox = {
      console,
      URLSearchParams,
      location: { search: '' },
      localStorage: { getItem: () => '', setItem: () => {} },
      EventSource: class { constructor() {} addEventListener() {} },
      open: () => {},
      fetch: (url, opts) => fetch(url.startsWith('http') ? url : `${base}${url}`, opts),
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    const api = sandbox.api;
    assert.ok(api, 'window.api wurde gesetzt');
    const settings = await api.settings.get();
    assert.ok(settings.modelsDir);
    const info = await api.info();
    assert.strictEqual(info.mode, 'headless');
    await assert.rejects(() => api.attachments.pick(), /Desktop-App/);
    await assert.rejects(() => api.models.delete('nichts'), /.+/);
    assert.throws(() => api.on('beliebig', () => {}), /Unerlaubter Event-Kanal/);
  } finally {
    await handle.close();
  }
});

test('webapi.js überschreibt eine vorhandene Electron-Brücke nicht', async () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'ui', 'webapi.js'), 'utf8');
  const existing = { settings: { get: () => 'electron' } };
  const sandbox = { console, URLSearchParams, api: existing, location: { search: '' }, localStorage: { getItem: () => '' }, fetch: () => {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  assert.strictEqual(sandbox.api, existing);
});

/* -------------------------------- Hauptprogramm -------------------------------- */

test('main: --version und --help enden mit Code 0', async () => {
  const writes = [];
  const io = { stdout: { write: (s) => { writes.push(String(s)); return true; } } };
  assert.strictEqual(await main(['--version'], io), 0);
  assert.strictEqual(await main(['--help'], io), 0);
  const text = writes.join('');
  assert.match(text, /ModelHarbor \d+\.\d+\.\d+/);
  assert.ok(text.includes('model-harbor serve'));
});

test('main: unbekannter Befehl endet mit Code 2', async () => {
  const io = { stderr: { write: () => true } };
  assert.strictEqual(await main(['gibtsnicht'], io), 2);
});

test('main: config get zeigt die Pfade', async () => {
  const home = tempHome();
  const writes = [];
  const io = { stdout: { write: (s) => { writes.push(String(s)); return true; } } };
  assert.strictEqual(await main(['config', 'get', '--json', '--home', home], io), 0);
  const parsed = JSON.parse(writes.join(''));
  assert.strictEqual(parsed.modelsDir, path.join(home, 'models'));
});

test('main: config set speichert Zahlen und lehnt unbekannte Schlüssel ab', async () => {
  const home = tempHome();
  const io = { stdout: { write: () => true }, stderr: { write: () => true } };
  assert.strictEqual(await main(['config', 'set', 'ctx', '16384', '--home', home], io), 0);
  assert.strictEqual(cfg.load(home).ctx, 16384);
  assert.strictEqual(await main(['config', 'set', 'quatsch', '1', '--home', home], io), 1);
});

test('main: server status für einen gestoppten Server', async () => {
  const home = tempHome();
  const writes = [];
  const io = { stdout: { write: (s) => { writes.push(String(s)); return true; } } };
  assert.strictEqual(await main(['server', 'status', '--json', '--home', home], io), 0);
  const parsed = JSON.parse(writes.join(''));
  assert.strictEqual(parsed.state.running, false);
});

test('ui-kit: Eingabe-Ende (EOF) bricht mit MenuAbort ab, statt readline zu crashen', async () => {
  const { PassThrough } = require('stream');
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const term = createTerminal({ input, output, isTTY: false });
  const pending = term.ask('Frage');
  input.end('');           // sofortiges EOF (wie `cmd < /dev/null` oder Pipe zu Ende)
  await assert.rejects(pending, (e) => e && e.name === 'MenuAbort');
  term.close();
});

test('main: start beendet sich bei EOF sauber mit Code 0 und ohne Fehlermeldung', () => {
  const { spawnSync } = require('child_process');
  const home = tempHome();
  const bin = path.join(__dirname, '..', 'bin', 'model-harbor.js');
  const res = spawnSync(process.execPath, [bin, 'start'], {
    input: '',                       // stdin sofort zu
    env: { ...process.env, MODELHARBOR_HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60000,
  });
  const all = `${res.stdout || ''}${res.stderr || ''}`;
  assert.strictEqual(res.status, 0, all);
  assert.ok(/Beendet\./.test(all), all);
  assert.ok(!/readline was closed/.test(all), all);
  assert.ok(!/Fehler:/.test(all), all);
});
