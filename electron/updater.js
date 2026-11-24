'use strict';
/**
 * updater.js — prüft GitHub-Releases, vergleicht Versionen und lädt Update-Pakete.
 * Absichtlich Electron-frei (nur fetch/fs/path), damit in Node-Tests lauffähig.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const i18n = require('../ui/i18n');
const { verifyDownload } = require('./integrity');

const DEFAULT_REPO = 'Goitonthefloor/modelharbor';
const API = 'https://api.github.com';

/* --------------------------- Versionen --------------------------- */

/**
 * Tag → { major, minor, patch, build, prerelease }.
 * Akzeptiert 'v2.0', '2.0', '1.8', '1.7.4.1', '1.7.4-beta.1', 'release-2.0.0'.
 * Fehlende Segmente werden mit 0 aufgefüllt (ein Release-Tag '2.0' ist ein
 * echtes Major-Update und darf nicht als „up-to-date“ durchfallen).
 * Alles ohne Zahl ergibt null.
 */
function parseVersion(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  // Erster Ziffernblock zählt; Präfixe wie 'v' oder 'release-' fallen dadurch weg.
  const m = s.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] || 0),
    patch: Number(m[3] || 0),
    build: Number(m[4] || 0),
    prerelease: m[5] || '',
  };
}

/** Vergleich zweier geparster Versionen: -1, 0 oder 1. */
function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch', 'build']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // '1.7.4-beta.1' ist älter als '1.7.4'; zwei Vorabversionen vergleichen wir als Text.
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  return compareVersions(a, b) > 0;
}

/* --------------------------- Asset-Auswahl --------------------------- */

// Bestes Update-Asset je Plattform (Reihenfolge = Präferenz).
// Nur bekannte Plattformen werden bedient: ein unbekanntes System (z. B. freebsd)
// darf nicht stillschweigend das Linux-AppImage bekommen.
const ASSET_PATTERNS = {
  linux: [/\.AppImage$/i],
  // NSIS-Installer heißen '…Setup….exe'; beliebige .exe (Helfer, Uninstaller) sind es nicht.
  win32: [/Setup.*\.exe$/i],
  darwin: [/\.dmg$/i],
};

function pickAsset(assets, platform) {
  const list = Array.isArray(assets) ? assets : [];
  const pats = ASSET_PATTERNS[platform];
  if (!pats) return null;
  for (const pat of pats) {
    const hit = list.find((a) => pat.test(a.name || ''));
    if (hit) return hit;
  }
  return null;
}

/* --------------------------- GitHub-Release --------------------------- */

// Digest der zuletzt geholten Release-Assets (Download-URL → sha256). Damit prüft
// downloadFile auch dann, wenn der Aufrufer keinen Digest mitschickt.
const releaseDigests = new Map();

async function fetchLatestRelease({ repo = DEFAULT_REPO, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ModelHarbor' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status === 404) return null; // noch kein Release
      throw new Error(`GitHub-Antwort ${res.status}`);
    }
    const data = await res.json();
    const assets = (data.assets || []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size || 0,
      // GitHub liefert 'sha256:<hex>'; ohne Digest bleibt das Feld null.
      sha256: (a.digest || '').replace(/^sha256:/i, '') || null,
    }));
    releaseDigests.clear();
    for (const a of assets) if (a.url && a.sha256) releaseDigests.set(a.url, a.sha256);
    return {
      tag: data.tag_name || '',
      name: data.name || data.tag_name || '',
      body: (data.body || '').slice(0, 2000),
      publishedAt: data.published_at || null,
      htmlUrl: data.html_url || '',
      assets,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------- Check --------------------------- */

async function checkForUpdate({ currentVersion, repo = DEFAULT_REPO, platform = process.platform } = {}) {
  const latest = await fetchLatestRelease({ repo });
  if (!latest) return { updateAvailable: false, reason: 'no-release', latest: null, asset: null };
  const available = isNewerVersion(latest.tag, currentVersion);
  return {
    updateAvailable: available,
    reason: available ? 'newer' : 'up-to-date',
    latest,
    asset: available ? pickAsset(latest.assets, platform) : null,
  };
}

/* --------------------------- Download mit Fortschritt --------------------------- */

/**
 * Lädt ein Update-Paket und prüft es gegen den SHA-256-Digest.
 * @param {string} url
 * @param {string} destPath
 * @param {(p: object) => void} onProgress
 * @param {{timeoutMs?: number, sha256?: string}} [opts]
 *   `sha256` kommt aus den Release-Assets; fehlt er, wird der Digest der zuletzt
 *   geholten Release-Assets zur URL genommen. Ohne Digest schlägt der Download
 *   fehl (fail closed wie in integrity.js) — eine ungeprüfte Datei wird nie als
 *   fertig gemeldet.
 */
async function downloadFile(url, destPath, onProgress = () => {}, { timeoutMs = 60000, sha256 } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error(i18n.t('error.invalidDownloadUrl'));
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  // Inaktivitäts-Timeout: bricht nur ab, wenn keine Daten mehr fließen
  // (ein Gesamt-Timeout würde große Installer mitten im Download abbrechen).
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), timeoutMs); };
  let wrote = false;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ModelHarbor' }, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(i18n.t('error.updateDownloadFailed', { status: res.status }));
    const total = Number(res.headers.get('content-length')) || 0;
    let done = 0;
    let lastEmit = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bump();
        done += chunk.length;
        const now = Date.now();
        if (now - lastEmit > 150 || done === total) {
          lastEmit = now;
          onProgress({
            phase: 'download',
            percent: total ? Math.min(100, (done / total) * 100) : 0,
            doneBytes: done,
            totalBytes: total,
          });
        }
        cb(null, chunk);
      },
    });
    // pipeline behandelt Fehler jeder Stream-Stufe (z. B. EISDIR/ENOSPC beim
    // Schreiben) und zerstört die Streams — sonst crasht ein 'error'-Event die App.
    const out = fs.createWriteStream(destPath);
    wrote = true;
    await pipeline(Readable.fromWeb(res.body), counter, out);
    // Erst prüfen, dann „fertig“ melden: verifyDownload wirft bei fehlendem oder
    // abweichendem Digest und entfernt die Datei wieder.
    const label = path.basename(destPath);
    const expected = sha256 || releaseDigests.get(url) || null;
    await verifyDownload(destPath, { sha256: expected }, label);
    onProgress({ phase: 'done', percent: 100, doneBytes: done, totalBytes: total });
    return { destPath, size: done };
  } catch (e) {
    if (wrote) { try { await fsp.unlink(destPath); } catch { /* ignore */ } }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  parseVersion, isNewerVersion, compareVersions, pickAsset, fetchLatestRelease,
  checkForUpdate, downloadFile, DEFAULT_REPO,
};