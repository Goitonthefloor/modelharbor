'use strict';
/**
 * Regressionstests Audit-Befund F4: Versions-Parsing (Wertematrix) und
 * SHA-256-Prüfung des Update-Downloads.
 * GitHub-Aufrufe werden gemockt, der Download läuft gegen einen lokalen
 * HTTP-Server — es geht kein Netzwerkaufruf nach außen.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const updater = require('../electron/updater.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Lokaler Server, der immer `body` ausliefert (kein Internet nötig). */
function startServer(body) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      res.end(body);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

/**
 * Ersetzt die GitHub-API für die Dauer des Tests. Andere URLs (lokaler
 * Download-Server) gehen an das echte fetch weiter.
 */
function stubGitHub(t, assets, tag = '2.0.0') {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.github.com/')) return original(url, opts);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: tag,
        name: tag,
        body: 'Notizen',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'https://example.invalid/release',
        assets,
      }),
    };
  };
  t.after(() => { global.fetch = original; });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* --------------------------- Versionsmatrix --------------------------- */

test('F4: parseVersion füllt fehlende Segmente auf und verwirft Präfixe', () => {
  const matrix = [
    ['2.0', { major: 2, minor: 0, patch: 0, build: 0, prerelease: '' }],
    ['1.8', { major: 1, minor: 8, patch: 0, build: 0, prerelease: '' }],
    ['v2.0', { major: 2, minor: 0, patch: 0, build: 0, prerelease: '' }],
    ['1.7.4', { major: 1, minor: 7, patch: 4, build: 0, prerelease: '' }],
    ['1.7.4.1', { major: 1, minor: 7, patch: 4, build: 1, prerelease: '' }],
    ['1.7.4-beta.1', { major: 1, minor: 7, patch: 4, build: 0, prerelease: 'beta.1' }],
    ['release-2.0.0', { major: 2, minor: 0, patch: 0, build: 0, prerelease: '' }],
    ['release-2.1', { major: 2, minor: 1, patch: 0, build: 0, prerelease: '' }],
  ];
  for (const [input, want] of matrix) {
    assert.deepEqual(updater.parseVersion(input), want, `parseVersion(${JSON.stringify(input)})`);
  }
  // Nichts Parsebares bleibt null
  for (const input of ['', 'abc', 'latest', null, undefined]) {
    assert.equal(updater.parseVersion(input), null, `parseVersion(${JSON.stringify(input)})`);
  }
});

test('F4: isNewerVersion erkennt auch zweistellige Major-Updates', () => {
  const wahr = [
    ['2.0', '1.7.4'],
    ['2.0', '1.8'],
    ['1.8', '1.7.4'],
    ['release-2.0.0', '1.8.0'],
    ['v2.0.0', '1.8.0'],
    ['1.7.4.1', '1.7.4'],
    ['1.7.4', '1.7.4-beta.1'],
    ['1.7.4-beta.2', '1.7.4-beta.1'],
  ];
  for (const [latest, current] of wahr) {
    assert.equal(updater.isNewerVersion(latest, current), true, `${latest} > ${current}`);
  }
  const falsch = [
    ['1.8', '2.0'],
    ['1.7.4', '1.7.4'],
    ['1.7.4-beta.1', '1.7.4'],
    ['1.8.0', 'release-2.0.0'],
    ['1.7.4', '1.7.4.1'],
    ['garbage', '1.8.0'],
  ];
  for (const [latest, current] of falsch) {
    assert.equal(updater.isNewerVersion(latest, current), false, `${latest} <= ${current}`);
  }
});

test('F4: checkForUpdate meldet ein Update auf Tag "2.0" als verfügbar', async (t) => {
  stubGitHub(t, [{ name: 'ModelHarbor-2.0.0.AppImage', browser_download_url: 'https://example.invalid/a.AppImage', size: 1, digest: 'sha256:' + 'a'.repeat(64) }], '2.0');
  const r = await updater.checkForUpdate({ currentVersion: '1.8.0', platform: 'linux' });
  assert.equal(r.updateAvailable, true);
  assert.equal(r.reason, 'newer');
  assert.equal(r.latest.tag, '2.0');
});

/* --------------------------- Digest-Prüfung --------------------------- */

test('F4: fetchLatestRelease übernimmt den sha256-Digest der Assets', async (t) => {
  const digest = 'b'.repeat(64);
  stubGitHub(t, [{ name: 'ModelHarbor-2.0.0.AppImage', browser_download_url: 'https://example.invalid/a.AppImage', size: 7, digest: `sha256:${digest}` }]);
  const rel = await updater.fetchLatestRelease();
  assert.equal(rel.assets[0].sha256, digest, 'Präfix "sha256:" wird entfernt');
});

test('F4: downloadFile prüft einen explizit übergebenen Digest und löscht bei Abweichung', async (t) => {
  const BODY = Buffer.from('update-paket');
  const { srv, base } = await startServer(BODY);
  t.after(() => srv.close());
  const dir = tmpDir(t);

  // passender Digest (auch mit 'sha256:'-Präfix) wird akzeptiert
  const okDest = path.join(dir, 'ok.exe');
  const res = await updater.downloadFile(`${base}/ok.exe`, okDest, () => {}, { sha256: `sha256:${sha256(BODY)}` });
  assert.equal(res.size, BODY.length);
  assert.deepEqual(fs.readFileSync(okDest), BODY);

  // falscher Digest: Abbruch, Datei wird entfernt, kein 'done'-Event
  const badDest = path.join(dir, 'bad.exe');
  const events = [];
  await assert.rejects(
    () => updater.downloadFile(`${base}/bad.exe`, badDest, (p) => events.push(p), { sha256: 'c'.repeat(64) }),
    /prüfsumme|checksum/i,
  );
  assert.equal(fs.existsSync(badDest), false, 'manipulierte Datei bleibt nicht liegen');
  assert.ok(!events.some((e) => e.phase === 'done'), 'kein Erfolgsevent');
});

test('F4: downloadFile lehnt einen Download ohne Digest ab (fail closed)', async (t) => {
  const { srv, base } = await startServer(Buffer.from('ohne-digest'));
  t.after(() => srv.close());
  const dest = path.join(tmpDir(t), 'ohne.exe');
  await assert.rejects(() => updater.downloadFile(`${base}/ohne.exe`, dest, () => {}), /prüfsumme|checksum/i);
  assert.equal(fs.existsSync(dest), false);
});

test('F4: downloadFile nutzt den Digest aus der Release-API, wenn keiner übergeben wird', async (t) => {
  const BODY = Buffer.from('release-paket');
  const { srv, base } = await startServer(BODY);
  t.after(() => srv.close());
  const url = `${base}/ModelHarbor-2.0.0.AppImage`;
  stubGitHub(t, [{ name: 'ModelHarbor-2.0.0.AppImage', browser_download_url: url, size: BODY.length, digest: `sha256:${sha256(BODY)}` }]);

  const r = await updater.checkForUpdate({ currentVersion: '1.8.0', platform: 'linux' });
  assert.equal(r.asset.url, url);
  const dest = path.join(tmpDir(t), 'update.AppImage');
  const res = await updater.downloadFile(r.asset.url, dest, () => {});
  assert.equal(res.size, BODY.length);
  assert.deepEqual(fs.readFileSync(dest), BODY);
});

test('F4: Digest aus der Release-API schlägt bei Manipulation fehl', async (t) => {
  const BODY = Buffer.from('echtes-paket');
  const { srv, base } = await startServer(Buffer.from('manipuliertes-paket'));
  t.after(() => srv.close());
  const url = `${base}/ModelHarbor-2.0.0.AppImage`;
  stubGitHub(t, [{ name: 'ModelHarbor-2.0.0.AppImage', browser_download_url: url, size: BODY.length, digest: `sha256:${sha256(BODY)}` }]);

  await updater.checkForUpdate({ currentVersion: '1.8.0', platform: 'linux' });
  const dest = path.join(tmpDir(t), 'update.AppImage');
  await assert.rejects(() => updater.downloadFile(url, dest, () => {}), /prüfsumme|checksum/i);
  assert.equal(fs.existsSync(dest), false);
});
