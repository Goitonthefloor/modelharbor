'use strict';
/**
 * updater.js — prüft GitHub-Releases, vergleicht Versionen und lädt Update-Pakete.
 * Absichtlich Electron-frei (nur fetch/fs/path), damit in Node-Tests lauffähig.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const i18n = require('../ui/i18n');

const DEFAULT_REPO = 'Goitonthefloor/modelharbor';
const API = 'https://api.github.com';

/* --------------------------- Versionen --------------------------- */

function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function isNewerVersion(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch > b.patch;
}

/* --------------------------- Asset-Auswahl --------------------------- */

// Bestes Update-Asset je Plattform (Reihenfolge = Präferenz)
function pickAsset(assets, platform) {
  const list = Array.isArray(assets) ? assets : [];
  const patterns = {
    linux: [/\.AppImage$/i],
    win32: [/Setup.*\.exe$/i, /\.exe$/i],
    darwin: [/\.dmg$/i],
  };
  const pats = patterns[platform] || patterns.linux;
  for (const pat of pats) {
    const hit = list.find((a) => pat.test(a.name || ''));
    if (hit) return hit;
  }
  return null;
}

/* --------------------------- GitHub-Release --------------------------- */

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
    return {
      tag: data.tag_name || '',
      name: data.name || data.tag_name || '',
      body: (data.body || '').slice(0, 2000),
      publishedAt: data.published_at || null,
      htmlUrl: data.html_url || '',
      assets: (data.assets || []).map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size || 0,
      })),
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

async function downloadFile(url, destPath, onProgress = () => {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error(i18n.t('error.invalidDownloadUrl'));
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': 'ModelHarbor' } });
  if (!res.ok || !res.body) throw new Error(i18n.t('error.updateDownloadFailed', { status: res.status }));
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastEmit = 0;
  const reader = res.body.getReader();
  const out = fs.createWriteStream(destPath);
  try {
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      if (value && value.length) {
        done += value.length;
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
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
      }
    }
    out.end();
    await new Promise((r) => out.once('finish', r));
  } catch (e) {
    out.destroy();
    try { await fsp.unlink(destPath); } catch { /* ignore */ }
    throw e;
  }
  onProgress({ phase: 'done', percent: 100, doneBytes: done, totalBytes: total });
  return { destPath, size: done };
}

module.exports = { parseVersion, isNewerVersion, pickAsset, fetchLatestRelease, checkForUpdate, downloadFile, DEFAULT_REPO };