'use strict';
/**
 * Regressionstests Security-Runde 3 (Deep-Scan fb05ca9, behoben auf 1.7.x):
 *  1. Integrität: heruntergeladene Backends/Modelle werden per Hash geprüft
 *     (GitHub assets[].digest, HF lfs.sha256 bzw. blobId) — fail closed.
 *  2. Renderer-Navigation/IPC: nur die eigene App-Datei ist vertrauenswürdig.
 *  3. Archive: ZIP und tar haben ein Größen- und Eintrags-Budget (Zip-Bomb).
 *
 * Jeder Test hat eine Gegenprobe: der Angriff muss scheitern UND legitimes
 * Verhalten muss durch denselben Guard weiterhin funktionieren.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const tar = require('tar');

const integrity = require('../electron/integrity.js');
const { isAppUrl } = require('../electron/window-guard.js');
const backends = require('../electron/backends.js');
const models = require('../electron/models.js');

const TLS = {
  key: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'localhost-cert.pem')),
};

function tmpDir(t, prefix = 'mh-sec3-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const blobSha1 = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

/* ==================== 1. Integrität (Finding 1) ==================== */

test('sha256File/gitBlobSha1File liefern die erwarteten Hashes', async (t) => {
  const dir = tmpDir(t);
  const data = Buffer.from('ModelHarbor integrity probe\n', 'utf8');
  const f = path.join(dir, 'probe.bin');
  await fsp.writeFile(f, data);
  assert.equal(await integrity.sha256File(f), sha256(data));
  assert.equal(await integrity.gitBlobSha1File(f), blobSha1(data));
});

test('verifyDownload akzeptiert passenden sha256 (mit/ohne Präfix, Großschreibung)', async (t) => {
  const dir = tmpDir(t);
  const data = Buffer.alloc(4096, 7);
  const f = path.join(dir, 'asset.zip');
  await fsp.writeFile(f, data);
  const hex = sha256(data);
  assert.equal(await integrity.verifyDownload(f, { sha256: hex }, 'asset.zip'), hex);
  assert.equal(await integrity.verifyDownload(f, { sha256: `sha256:${hex}` }, 'asset.zip'), hex);
  assert.equal(await integrity.verifyDownload(f, { sha256: hex.toUpperCase() }, 'asset.zip'), hex);
  assert.ok(fs.existsSync(f), 'legitime Datei bleibt liegen');
});

test('ANGRIFF: manipulierte Datei mit passender Größe wird verworfen und gelöscht', async (t) => {
  const dir = tmpDir(t);
  const original = Buffer.alloc(8192, 1);
  const f = path.join(dir, 'backend.zip');
  // Gleiche Länge, anderer Inhalt — die alte Größenprüfung hätte das akzeptiert.
  const tampered = Buffer.alloc(8192, 2);
  await fsp.writeFile(f, tampered);
  await assert.rejects(
    () => integrity.verifyDownload(f, { sha256: sha256(original) }, 'backend.zip'),
    /Prüfsumme|checksum/i,
  );
  assert.equal(fs.existsSync(f), false, 'manipulierte Datei wird nicht für Resume liegen gelassen');
});

test('ANGRIFF (alternativ): kleiner Nicht-LFS-Inhalt mit gleicher Länge, falscher blobId', async (t) => {
  const dir = tmpDir(t);
  const good = Buffer.from('{"a":1}', 'utf8');
  const evil = Buffer.from('{"a":2}', 'utf8');
  assert.equal(good.length, evil.length);
  const f = path.join(dir, 'genai_config.json');
  await fsp.writeFile(f, evil);
  await assert.rejects(() => integrity.verifyDownload(f, { blobId: blobSha1(good) }, 'genai_config.json'));
  assert.equal(fs.existsSync(f), false);
  // Gegenprobe: unveränderter Inhalt besteht
  await fsp.writeFile(f, good);
  assert.equal(await integrity.verifyDownload(f, { blobId: blobSha1(good) }, 'genai_config.json'), blobSha1(good));
});

test('fail closed: ohne erwarteten Digest wird die Datei abgelehnt', async (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'model.gguf');
  await fsp.writeFile(f, Buffer.from('GGUF'));
  for (const meta of [{}, { sha256: null }, { sha256: 'kaputt' }, { sha256: 'ab'.repeat(31) }, { blobId: 'xyz' }, null]) {
    await assert.rejects(() => integrity.verifyDownload(f, meta, 'model.gguf'), /Keine Prüfsumme|No checksum/i);
  }
});

test('normalizeSha256/normalizeSha1 lassen nur gültige Hex-Digests durch', () => {
  const hex = 'a'.repeat(64);
  assert.equal(integrity.normalizeSha256(`sha256:${hex}`), hex);
  assert.equal(integrity.normalizeSha256(`SHA256:${hex.toUpperCase()}`), hex);
  assert.equal(integrity.normalizeSha256('a'.repeat(63)), null);
  assert.equal(integrity.normalizeSha256('g'.repeat(64)), null);
  assert.equal(integrity.normalizeSha256(123), null);
  assert.equal(integrity.normalizeSha1('b'.repeat(40)), 'b'.repeat(40));
  assert.equal(integrity.normalizeSha1('b'.repeat(41)), null);
});

/* ============ 1b. Modell-Download Ende-zu-Ende über lokalen HTTPS-Server ============ */

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = https.createServer(TLS, handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** Leitet alle huggingface.co-Aufrufe (API + Datei) auf den lokalen Server um. */
function stubHf(port) {
  const real = https.get;
  https.get = function (url, ...rest) {
    if (typeof url === 'string' && url.startsWith('https://huggingface.co')) {
      const u = new URL(url);
      return real.call(https, `https://127.0.0.1:${port}${u.pathname}${u.search}`, ...rest);
    }
    return real.call(https, url, ...rest);
  };
  return () => { https.get = real; };
}

/**
 * Fährt downloadModel gegen einen lokalen Server. `siblings` bestimmt die
 * Metadaten (und damit die erwarteten Hashes), `payload` die ausgelieferten Bytes.
 */
async function runModelDownload(t, { siblings, payload, file = 'test-model-Q4_K_M.gguf' }) {
  const dir = tmpDir(t, 'mh-dl-');
  const modelsDir = path.join(dir, 'models');
  const { srv, port } = await startServer((req, res) => {
    if (req.url.startsWith('/api/models/')) {
      const body = JSON.stringify({ siblings, downloads: 1, likes: 0, tags: [] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length });
    res.end(payload);
  });
  const restore = stubHf(port);
  t.after(() => { restore(); srv.close(); });
  return models.downloadModel({ repo: 'test/repo', file, modelsDir });
}

test('downloadModel: legitimer GGUF-Download mit passendem lfs.sha256 landet im Modellordner', async (t) => {
  const payload = Buffer.alloc(65536, 3);
  const res = await runModelDownload(t, {
    siblings: [{ rfilename: 'test-model-Q4_K_M.gguf', size: payload.length, lfs: { sha256: sha256(payload), size: payload.length } }],
    payload,
  });
  assert.ok(fs.existsSync(res.path), 'Modelldatei existiert');
  assert.equal(sha256(fs.readFileSync(res.path)), sha256(payload));
  assert.equal(fs.existsSync(`${res.path}.part`), false, 'kein Rest-Part');
});

test('ANGRIFF: gleich großer, inhaltlich anderer GGUF wird NICHT als Modell übernommen', async (t) => {
  const declared = Buffer.alloc(65536, 3);
  const served = Buffer.alloc(65536, 9); // gleiche Größe, anderer Inhalt
  await assert.rejects(() => runModelDownload(t, {
    siblings: [{ rfilename: 'test-model-Q4_K_M.gguf', size: declared.length, lfs: { sha256: sha256(declared), size: declared.length } }],
    payload: served,
  }), /Prüfsumme|checksum/i);
});

test('ANGRIFF (alternativ): Metadaten ohne Hash → downloadModel lehnt ab (fail closed)', async (t) => {
  const payload = Buffer.alloc(4096, 5);
  await assert.rejects(() => runModelDownload(t, {
    siblings: [{ rfilename: 'test-model-Q4_K_M.gguf', size: payload.length }],
    payload,
  }), /Keine Prüfsumme|No checksum/i);
});

test('downloadOnnxModel: Gewichte per sha256, kleine Config per blobId — beide geprüft', async (t) => {
  const dir = tmpDir(t, 'mh-onnx-');
  const modelsDir = path.join(dir, 'models');
  const weights = Buffer.alloc(32768, 4);
  const config = Buffer.from('{"model_type":"test"}', 'utf8');
  const siblings = [
    { rfilename: 'model.onnx', size: weights.length, lfs: { sha256: sha256(weights), size: weights.length } },
    { rfilename: 'genai_config.json', size: config.length, blobId: blobSha1(config) },
    { rfilename: 'README.md', size: 10 },
  ];
  const { srv, port } = await startServer((req, res) => {
    if (req.url.startsWith('/api/models/')) {
      const body = JSON.stringify({ siblings });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    const data = req.url.includes('genai_config') ? config : weights;
    res.writeHead(200, { 'content-length': data.length });
    res.end(data);
  });
  const restore = stubHf(port);
  t.after(() => { restore(); srv.close(); });
  const res = await models.downloadOnnxModel({ repo: 'test/onnx', onnxSub: null, modelsDir });
  assert.equal(sha256(fs.readFileSync(path.join(res.dir, 'model.onnx'))), sha256(weights));
  assert.equal(fs.readFileSync(path.join(res.dir, 'genai_config.json'), 'utf8'), config.toString());
});

test('ANGRIFF: manipulierte ONNX-Config (gleiche Länge) wird verworfen', async (t) => {
  const dir = tmpDir(t, 'mh-onnx-');
  const modelsDir = path.join(dir, 'models');
  const good = Buffer.from('{"model_type":"test"}', 'utf8');
  const evil = Buffer.from('{"model_type":"evil"}', 'utf8');
  assert.equal(good.length, evil.length);
  const siblings = [{ rfilename: 'genai_config.json', size: good.length, blobId: blobSha1(good) }];
  const { srv, port } = await startServer((req, res) => {
    if (req.url.startsWith('/api/models/')) {
      const body = JSON.stringify({ siblings });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'content-length': evil.length });
    res.end(evil);
  });
  const restore = stubHf(port);
  t.after(() => { restore(); srv.close(); });
  await assert.rejects(() => models.downloadOnnxModel({ repo: 'test/onnx', onnxSub: null, modelsDir }), /Prüfsumme|checksum/i);
  assert.equal(fs.existsSync(path.join(modelsDir, 'onnx', 'genai_config.json')), false);
});

test('parseOnnxFiles/parseOnnxFolderFiles reichen lfs.sha256 und blobId durch', () => {
  const hex = 'c'.repeat(64);
  const blob = 'd'.repeat(40);
  const siblings = [
    { rfilename: 'sub/model.onnx', size: 5, lfs: { sha256: hex, size: 5 } },
    { rfilename: 'sub/config.json', size: 2, blobId: blob },
    { rfilename: 'model.onnx', size: 7, lfs: { sha256: hex, size: 7 } },
    { rfilename: 'tokenizer.json', size: 3, blobId: blob },
  ];
  const sub = models.parseOnnxFiles(siblings, 'sub');
  assert.equal(sub.find((f) => f.name === 'model.onnx').sha256, hex);
  assert.equal(sub.find((f) => f.name === 'config.json').blobId, blob);
  const root = models.parseOnnxFolderFiles(siblings);
  assert.equal(root.find((f) => f.name === 'model.onnx').sha256, hex);
  assert.equal(root.find((f) => f.name === 'tokenizer.json').blobId, blob);
});

/* ==================== 2. Fenster-/IPC-Guard (Finding 2) ==================== */

test('isAppUrl akzeptiert nur die eigene App-Datei', (t) => {
  const dir = tmpDir(t, 'mh-guard-');
  const appFile = path.join(dir, 'ui', 'index.html');
  const appUrl = pathToFileURL(appFile).href;
  assert.equal(isAppUrl(appUrl, appFile), true);
  // Gegenprobe: kodierte Pfade (Leerzeichen/Umlaute) müssen ebenfalls gehen
  const spaced = path.join(dir, 'mit leerzeichen', 'ü', 'index.html');
  assert.equal(isAppUrl(pathToFileURL(spaced).href, spaced), true);
});

test('ANGRIFF: fremde Dokumente bekommen die API nicht (Navigation/IPC abgelehnt)', (t) => {
  const dir = tmpDir(t, 'mh-guard-');
  const appFile = path.join(dir, 'ui', 'index.html');
  const foreign = [
    pathToFileURL(path.join(dir, 'evil.html')).href,          // Datei-Drop
    pathToFileURL(path.join(dir, 'ui', 'evil.html')).href,    // gleiche Ebene, anderer Name
    pathToFileURL(path.join(dir, 'ui-evil', 'index.html')).href, // Präfix-Kollision
    'https://example.invalid/index.html',
    'http://127.0.0.1:8080/',
    'about:blank',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    `file://${path.join(dir, 'ui', '..', 'evil.html')}`,       // Traversal
    '', null, undefined, 42, {},
  ];
  for (const url of foreign) {
    assert.equal(isAppUrl(url, appFile), false, `abgelehnt: ${String(url)}`);
  }
  // Legitimes Verhalten bleibt erlaubt
  assert.equal(isAppUrl(pathToFileURL(appFile).href, appFile), true);
});

/* ==================== 3. Archiv-Budgets (Finding 3) ==================== */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * ZIP-Builder mit Store (0) und Deflate (8). `declaredSize` erlaubt absichtlich
 * falsche Header (Zip-Bomb mit lügender uncompressedSize).
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data || Buffer.alloc(0);
    const method = e.method || 0;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const declared = e.declaredSize == null ? raw.length : e.declaredSize;
    const crc = crc32(raw);
    const mode = (e.unixMode || 0o100644) << 16;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(declared, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(declared, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(mode >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

async function withZip(t, entries, fn, opts) {
  const dir = tmpDir(t, 'mh-zip3-');
  const zipPath = path.join(dir, 'test.zip');
  const out = path.join(dir, 'out');
  await fsp.writeFile(zipPath, buildZip(entries));
  try {
    return await fn(zipPath, out, opts);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test('extractZipSafe: legitimes Archiv wird weiterhin vollständig entpackt', async (t) => {
  await withZip(t, [
    { name: 'bin/llama-server', data: Buffer.from('#!/bin/sh\necho ok\n'), unixMode: 0o100755 },
    { name: 'bin/libllama.so', data: Buffer.alloc(2048, 1) },
  ], async (zip, out) => {
    await backends.extractZipSafe(zip, out);
    assert.equal(fs.readFileSync(path.join(out, 'bin', 'llama-server'), 'utf8'), '#!/bin/sh\necho ok\n');
    assert.equal(fs.statSync(path.join(out, 'bin', 'libllama.so')).size, 2048);
  });
});

test('ANGRIFF: hoch komprimiertes Archiv über Budget wird abgebrochen (Zip-Bomb)', async (t) => {
  const bomb = Buffer.alloc(4 * 1024 * 1024, 0); // 4 MB Nullen → wenige KB komprimiert
  await withZip(t, [{ name: 'bomb.bin', data: bomb, method: 8 }], async (zip, out) => {
    await assert.rejects(
      () => backends.extractZipSafe(zip, out, { maxTotalBytes: 64 * 1024 }),
      /Limit|limit/,
    );
    const written = fs.existsSync(path.join(out, 'bomb.bin')) ? fs.statSync(path.join(out, 'bomb.bin')).size : 0;
    assert.ok(written <= 64 * 1024, `nicht mehr als das Budget geschrieben (${written})`);
  });
});

test('ANGRIFF (alternativ): lügender Header — deklariert klein, tatsächlich groß', async (t) => {
  const bomb = Buffer.alloc(2 * 1024 * 1024, 0);
  await withZip(t, [{ name: 'liar.bin', data: bomb, method: 8, declaredSize: 16 }], async (zip, out) => {
    await assert.rejects(() => backends.extractZipSafe(zip, out, { maxTotalBytes: 64 * 1024 }));
    const written = fs.existsSync(path.join(out, 'liar.bin')) ? fs.statSync(path.join(out, 'liar.bin')).size : 0;
    assert.ok(written <= 64 * 1024, `tatsächliche Bytes werden gezählt (${written})`);
  });
});

test('ANGRIFF: viele Einträge — Summe sprengt das Budget, obwohl jeder Eintrag passt', async (t) => {
  const entries = [];
  for (let i = 0; i < 6; i++) entries.push({ name: `f${i}.bin`, data: Buffer.alloc(600, i) });
  await withZip(t, entries, async (zip, out) => {
    // Jeder Eintrag (600 B) passt allein, die Summe (3600 B) nicht.
    await assert.rejects(() => backends.extractZipSafe(zip, out, { maxTotalBytes: 1000 }), /Limit|limit/);
  });
});

test('ANGRIFF: Eintragszahl über Limit wird abgebrochen', async (t) => {
  const entries = [];
  for (let i = 0; i < 8; i++) entries.push({ name: `f${i}.txt`, data: Buffer.from('x') });
  await withZip(t, entries, async (zip, out) => {
    await assert.rejects(() => backends.extractZipSafe(zip, out, { maxEntries: 3 }), /Einträge|entries/);
  });
  // Gegenprobe: mit ausreichendem Limit geht dasselbe Archiv durch
  await withZip(t, entries, async (zip, out) => {
    await backends.extractZipSafe(zip, out, { maxEntries: 8 });
    assert.equal(fs.readdirSync(out).length, 8);
  });
});

test('extractZipSafe: Traversal und Symlinks bleiben abgelehnt (kein Regress)', async (t) => {
  await withZip(t, [{ name: '../evil.txt', data: Buffer.from('x') }], async (zip, out) => {
    // yauzl lehnt '../' schon in validateFileName ab — jede Ablehnung zählt,
    // entscheidend ist: außerhalb des Zielverzeichnisses entsteht nichts.
    await assert.rejects(() => backends.extractZipSafe(zip, out));
    await assert.rejects(() => fsp.stat(path.join(path.dirname(out), 'evil.txt')), { code: 'ENOENT' });
  });
  await withZip(t, [{ name: 'a//../../evil.txt', data: Buffer.from('x') }], async (zip, out) => {
    await assert.rejects(() => backends.extractZipSafe(zip, out));
    await assert.rejects(() => fsp.stat(path.join(path.dirname(out), 'evil.txt')), { code: 'ENOENT' });
  });
  await withZip(t, [{ name: 'link', data: Buffer.from('/etc/passwd'), unixMode: 0o120777 }], async (zip, out) => {
    await assert.rejects(() => backends.extractZipSafe(zip, out), /Symlink/);
  });
});

test('assertTarBudget: legitimes tar.gz besteht, Übergröße/zu viele Einträge scheitern', async (t) => {
  const dir = tmpDir(t, 'mh-tar3-');
  const src = path.join(dir, 'src');
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(src, 'small.bin'), Buffer.alloc(500, 1));
  await fsp.writeFile(path.join(src, 'big.bin'), Buffer.alloc(5000, 2));
  const okTar = path.join(dir, 'ok.tar.gz');
  const bigTar = path.join(dir, 'big.tar.gz');
  await tar.c({ file: okTar, cwd: src, gzip: true }, ['small.bin']);
  await tar.c({ file: bigTar, cwd: src, gzip: true }, ['small.bin', 'big.bin']);

  const ok = await backends.assertTarBudget(okTar, { maxTotalBytes: 1000 });
  assert.equal(ok.count, 1);
  assert.equal(ok.total, 500);

  await assert.rejects(() => backends.assertTarBudget(bigTar, { maxTotalBytes: 1000 }), /Limit|limit/);
  await assert.rejects(() => backends.assertTarBudget(bigTar, { maxEntries: 1 }), /Einträge|entries/);
  // Gegenprobe: mit passendem Budget geht dasselbe Archiv durch
  const pass = await backends.assertTarBudget(bigTar, { maxTotalBytes: 10000, maxEntries: 5 });
  assert.equal(pass.total, 5500);
});

test('Budget-Konstanten sind endlich und großzügig genug für echte Builds', () => {
  assert.ok(Number.isFinite(backends.ARCHIVE_MAX_TOTAL_BYTES));
  assert.ok(backends.ARCHIVE_MAX_TOTAL_BYTES >= 4 * 1024 ** 3, 'echte CUDA/ROCm-Builds passen');
  assert.ok(Number.isFinite(backends.ARCHIVE_MAX_ENTRIES) && backends.ARCHIVE_MAX_ENTRIES > 0);
});
