'use strict';
/**
 * Regressionstests Runde 2: SSE-Stream-Rest, Update-Download (Stream-Fehler,
 * Timeout), Pfad-Guards für Renderer-Werte und Log-Rotation zur Laufzeit.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const https = require('https');

const { parseSseChunk } = require('../ui/sse.js');
const updater = require('../electron/updater.js');
const { childPath, withinRoot, isWithin } = require('../electron/paths.js');
const logger = require('../electron/logger.js');
const { estimateVramFromName, pciAddressMatches } = require('../electron/hardware.js');

const TLS = {
  key: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-cert.pem')),
};

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = https.createServer(TLS, handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `https://127.0.0.1:${srv.address().port}` }));
  });
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-hard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ---------------- SSE ---------------- */

test('parseSseChunk: liefert Payloads und behält unvollständige Restzeile', () => {
  const r = parseSseChunk('data: {"a":1}\ndata: {"b":');
  assert.deepEqual(r.payloads, [{ a: 1 }]);
  assert.equal(r.rest, 'data: {"b":');
  // Rest wird im nächsten Chunk vervollständigt
  const r2 = parseSseChunk(r.rest + '2}\n');
  assert.deepEqual(r2.payloads, [{ b: 2 }]);
  assert.equal(r2.rest, '');
});

test('parseSseChunk: letzte Zeile OHNE Newline geht ohne final verloren (alter Bug)', () => {
  const streamEnd = 'data: {"usage":{"completion_tokens":7}}';
  assert.deepEqual(parseSseChunk(streamEnd).payloads, [], 'ohne final bleibt die Zeile im Rest');
  assert.deepEqual(parseSseChunk(streamEnd, true).payloads, [{ usage: { completion_tokens: 7 } }]);
});

test('parseSseChunk: [DONE], Leerzeilen, Kommentare und kaputtes JSON werden übersprungen', () => {
  const buf = ': keep-alive\n\ndata: [DONE]\ndata: {kaputt\ndata: {"ok":true}\n';
  assert.deepEqual(parseSseChunk(buf).payloads, [{ ok: true }]);
});

test('parseSseChunk: CRLF und mehrere Deltas in einem Chunk', () => {
  const buf = 'data: {"i":1}\r\ndata: {"i":2}\r\n\r\n';
  assert.deepEqual(parseSseChunk(buf).payloads, [{ i: 1 }, { i: 2 }]);
});

test('parseSseChunk: leerer/null Puffer crasht nicht', () => {
  assert.deepEqual(parseSseChunk('').payloads, []);
  assert.deepEqual(parseSseChunk(null, true).payloads, []);
});

/* ---------------- Update-Download ---------------- */

test('updater.downloadFile: Schreibfehler (Ziel ist Verzeichnis) wird abgefangen, kein Crash', async (t) => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '100' });
    res.end(Buffer.alloc(100, 0x41));
  });
  t.after(() => srv.close());
  const dir = tmpDir(t);
  const dest = path.join(dir, 'ist-ein-verzeichnis');
  fs.mkdirSync(dest);

  await assert.rejects(() => updater.downloadFile(`${base}/update.exe`, dest, () => {}));
  assert.ok(fs.existsSync(dest), 'Verzeichnis bleibt bestehen');
});

test('updater.downloadFile: schreibt korrekt und meldet Größe + done', async (t) => {
  const FULL = Buffer.alloc(4096, 0x42);
  const sha256 = crypto.createHash('sha256').update(FULL).digest('hex');
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': String(FULL.length) });
    res.end(FULL);
  });
  t.after(() => srv.close());
  const dest = path.join(tmpDir(t), 'update.exe');
  const events = [];

  const res = await updater.downloadFile(`${base}/update.exe`, dest, (p) => events.push(p), { sha256 });
  assert.equal(res.size, FULL.length);
  assert.deepEqual(fs.readFileSync(dest), FULL);
  assert.equal(events[events.length - 1].phase, 'done');
  assert.equal(events[events.length - 1].percent, 100);
});

test('updater.downloadFile: Inaktivitäts-Timeout bricht einen hängenden Download ab', async (t) => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '1000000' });
    res.write(Buffer.alloc(10, 0x41));
    // sendet nie den Rest und beendet die Antwort nicht
  });
  t.after(() => srv.close());
  const dest = path.join(tmpDir(t), 'haengt.exe');

  await assert.rejects(() => updater.downloadFile(`${base}/x`, dest, () => {}, { timeoutMs: 250 }));
  assert.ok(!fs.existsSync(dest), 'unvollständige Datei wird entfernt');
});

test('updater.downloadFile: Nicht-HTTP-URL wird abgelehnt', async (t) => {
  const dest = path.join(tmpDir(t), 'x.exe');
  await assert.rejects(() => updater.downloadFile('file:///etc/passwd', dest, () => {}));
});

/* ---------------- Pfad-Guards ---------------- */

test('childPath: verwirft Verzeichnisteile und Traversal', () => {
  const root = path.resolve('/tmp/beispiel/downloads');
  assert.equal(childPath(root, 'ModelHarbor-Setup-1.4.3.exe'), path.join(root, 'ModelHarbor-Setup-1.4.3.exe'));
  assert.equal(childPath(root, '../../../../tmp/boese.exe'), path.join(root, 'boese.exe'));
  assert.equal(childPath(root, '..\\..\\boese.exe'), path.join(root, 'boese.exe'));
  for (const bad of ['..', '.', '', null, undefined, '/']) {
    assert.throws(() => childPath(root, bad), `Name ${JSON.stringify(bad)} muss abgelehnt werden`);
  }
});

test('withinRoot: erlaubt verschachtelte Pfade im Root, lehnt Ausbruch und Präfix-Kollision ab', () => {
  const root = path.resolve('/tmp/beispiel/models');
  assert.equal(withinRoot(root, path.join(root, 'repo__name', 'model.gguf')), path.join(root, 'repo__name', 'model.gguf'));
  assert.throws(() => withinRoot(root, '/tmp/beispiel/models-evil/x.gguf'));
  assert.throws(() => withinRoot(root, '/etc/passwd'));
  assert.throws(() => withinRoot(root, path.join(root, '..', 'models-evil', 'x')));
  assert.throws(() => withinRoot(root, ''));
  assert.throws(() => withinRoot(root, null));
});

test('isWithin: echtes Präfix-Verhalten statt String-Vergleich', () => {
  assert.equal(isWithin('/a/b', '/a/b/c'), true);
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b', '/a/bc'), false);
  assert.equal(isWithin('/a/b', '/a'), false);
});

/* ---------------- Log-Rotation ---------------- */

test('logger: rotiert auch während der Laufzeit, nicht nur beim Start', (t) => {
  const dir = tmpDir(t);
  logger.configure({ debug: true, dir });
  const logPath = path.join(dir, 'logs', 'modelharbor-debug.log');
  const line = 'x'.repeat(200);
  for (let i = 0; i < 1200; i++) logger.debug(line); // ~240 KB > 150 KB Limit
  assert.ok(fs.existsSync(`${logPath}.old`), 'Rotation muss eine .old-Datei erzeugen');
  assert.ok(fs.statSync(logPath).size <= 150 * 1024, 'aktuelle Logdatei bleibt unter dem Limit');
  logger.configure({ debug: false, dir: null });
});

/* ---------------- Hardware: VRAM-Zuordnung ---------------- */

test('pciAddressMatches: sysfs-Adresse mit Domain passt zur lspci-Adresse ohne Domain', () => {
  const dev = '/sys/devices/pci0000:00/0000:00:03.1/0000:03:00.0';
  assert.equal(pciAddressMatches(dev, '03:00.0'), true);
  assert.equal(pciAddressMatches(dev, '0000:03:00.0'), true);
  assert.equal(pciAddressMatches(dev, '01:00.0'), false, 'andere Karte darf nicht treffen');
  assert.equal(pciAddressMatches(dev, ''), false);
  assert.equal(pciAddressMatches('', '03:00.0'), false);
  assert.equal(pciAddressMatches(null, null), false);
});

test('estimateVramFromName: explizite GB-Angabe im Namen schlägt die Tabelle', () => {
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4060 Ti 16GB'), 16);
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4070 12GB'), 12);
  assert.equal(estimateVramFromName('AMD Radeon RX 7600 XT 16GB'), 16);
  // Ohne Angabe bleibt die Tabelle maßgeblich
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4060 Ti'), 8);
  // Explizite Geräteangabe schlägt auch die Mobil-Tabelle (Gerät meldet echten Speicher)
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4060 Ti Laptop GPU 16GB'), 16);
  // Integrierte Grafik bleibt null, auch wenn "8GB" im Namen steht (Shared Memory)
  assert.equal(estimateVramFromName('AMD Radeon Graphics 8GB'), null);
});
