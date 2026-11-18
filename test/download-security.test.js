'use strict';
/**
 * Regressionstests für Download-Fortsetzung und Backend-Entfernung.
 *
 * Hintergrund: Ein Server kann einen Range-Request mit 200 (volle Datei) statt
 * 206 beantworten. Dann wird die Zieldatei neu geschrieben — der Byte-Zähler
 * darf nicht bei der alten Dateigröße weiterlaufen. Und removeBackend() darf
 * nur bekannte Backend-IDs löschen, keine Pfade aus dem Renderer.
 *
 * Der lokale HTTPS-Server benutzt ein selbstsigniertes Test-Zertifikat
 * (test/fixtures/, nur für 127.0.0.1, kein Produktivschlüssel).
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const { downloadToFile, removeBackend } = require('../electron/backends.js');
const { downloadFile } = require('../electron/models.js');

const TLS = {
  key: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-cert.pem')),
};

const FULL = Buffer.alloc(1000, 0x41); // "vollständige" Datei
const PRE = Buffer.alloc(100, 0x42);   // bereits heruntergeladener Teil

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = https.createServer(TLS, handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, base: `https://127.0.0.1:${srv.address().port}` });
    });
  });
}

function tmpDest(t, name = 'x.gguf.part') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

/* ---------------- Download: Range wird ignoriert (200) ---------------- */

for (const [label, fn] of [['backends.downloadToFile', downloadToFile], ['models.downloadFile', downloadFile]]) {
  test(`${label}: Server ignoriert Range (200) -> Byte-Zahl == Dateigröße`, async (t) => {
    let seenRange = null;
    const { srv, base } = await startServer((req, res) => {
      seenRange = req.headers.range || null;
      res.writeHead(200, { 'Content-Length': String(FULL.length) });
      res.end(FULL);
    });
    t.after(() => srv.close());
    const dest = tmpDest(t);
    fs.writeFileSync(dest, PRE);

    const res = await fn(`${base}/file`, dest, () => {});
    assert.equal(seenRange, 'bytes=100-', 'Range-Header muss gesendet werden');
    assert.equal(res.bytes, FULL.length, 'gemeldete Bytes dürfen die alte Größe nicht mitzählen');
    assert.equal(fs.statSync(dest).size, FULL.length);
    assert.deepEqual(fs.readFileSync(dest), FULL, 'Datei wird bei 200 komplett neu geschrieben');
  });

  test(`${label}: echte Fortsetzung (206) hängt an und zählt korrekt`, async (t) => {
    const { srv, base } = await startServer((req, res) => {
      const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0;
      const slice = FULL.subarray(from);
      res.writeHead(206, {
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${from}-${FULL.length - 1}/${FULL.length}`,
      });
      res.end(slice);
    });
    t.after(() => srv.close());
    const dest = tmpDest(t);
    fs.writeFileSync(dest, FULL.subarray(0, 100)); // echter Teil der Datei

    const res = await fn(`${base}/file`, dest, () => {});
    assert.equal(res.bytes, FULL.length);
    assert.deepEqual(fs.readFileSync(dest), FULL);
  });

  test(`${label}: relativer Redirect wird gegen die Basis-URL aufgelöst`, async (t) => {
    const { srv, base } = await startServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/ziel' }); // relativ, nicht absolut
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(FULL.length) });
      res.end(FULL);
    });
    t.after(() => srv.close());
    const dest = tmpDest(t);

    const res = await fn(`${base}/start`, dest, () => {});
    assert.equal(res.bytes, FULL.length);
    assert.deepEqual(fs.readFileSync(dest), FULL);
  });
}

test('backends.downloadToFile: 416 meldet die vorhandene Größe als fertig', async (t) => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(416, { 'Content-Range': `bytes */${FULL.length}` });
    res.end();
  });
  t.after(() => srv.close());
  const dest = tmpDest(t);
  fs.writeFileSync(dest, FULL);

  const res = await downloadToFile(`${base}/file`, dest, () => {});
  assert.equal(res.bytes, FULL.length);
  assert.equal(res.resumed, true);
});

/* ---------------- removeBackend: keine Pfade aus dem Renderer ---------------- */

test('removeBackend: "../<nachbar>" wird abgelehnt und löscht nichts', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-rb-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const installRoot = path.join(base, 'backends');
  const victim = path.join(base, 'backends-evil');
  fs.mkdirSync(path.join(installRoot, 'onnx'), { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'wichtig.txt'), 'darf nicht gelöscht werden');

  await assert.rejects(() => removeBackend(installRoot, '../backends-evil'));
  assert.ok(fs.existsSync(path.join(victim, 'wichtig.txt')), 'Nachbarverzeichnis bleibt unangetastet');
  assert.ok(fs.existsSync(path.join(installRoot, 'onnx')), 'Install-Root bleibt bestehen');
});

test('removeBackend: unbekannte IDs und Pfadteile werden abgelehnt', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-rb-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const installRoot = path.join(base, 'backends');
  fs.mkdirSync(installRoot, { recursive: true });

  for (const id of ['..', '.', '../..', 'onnx/../../etc', 'unbekannt', '']) {
    await assert.rejects(() => removeBackend(installRoot, id), `ID ${JSON.stringify(id)} muss abgelehnt werden`);
  }
  assert.ok(fs.existsSync(installRoot));
});

test('removeBackend: bekannte ID löscht genau ihr Verzeichnis', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-rb-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const installRoot = path.join(base, 'backends');
  fs.mkdirSync(path.join(installRoot, 'onnx'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'linux-cpu'), { recursive: true });

  await removeBackend(installRoot, 'onnx');
  assert.ok(!fs.existsSync(path.join(installRoot, 'onnx')));
  assert.ok(fs.existsSync(path.join(installRoot, 'linux-cpu')), 'andere Backends bleiben');
});
