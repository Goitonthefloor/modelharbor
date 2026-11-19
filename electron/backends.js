'use strict';
/**
 * backends.js — llama.cpp-Backend-Binaries für alle Plattformen.
 *
 * Lädt die passenden Builds aus den offiziellen ggml-org/llama.cpp Releases
 * (neuester Build mit Binär-Assets), entpackt sie und findet llama-server.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const zlib = require('zlib');
const yauzl = require('yauzl');
const tar = require('tar');
const i18n = require('../ui/i18n');
const { verifyDownload } = require('./integrity');

const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=25';

/**
 * Grenzen für entpackte Archive. Ohne Budget füllt ein Archiv mit hoher
 * Kompressionsrate oder sehr vielen Einträgen das Installationslaufwerk, bevor
 * eine andere Prüfung greift (Zip-Bomb → ENOSPC, App schreibt nichts mehr).
 * Großzügig genug für echte CUDA/ROCm-Builds, aber endlich.
 */
const ARCHIVE_MAX_TOTAL_BYTES = 16 * 1024 ** 3; // 16 GiB entpackt
const ARCHIVE_MAX_ENTRIES = 20000;

/** Backend-Definitionen: welche Release-Assets gehören dazu. */
const BACKENDS = {
  'win-cuda-12.4': {
    label: 'NVIDIA CUDA 12.4',
    platform: 'win32', arch: 'x64',
    assets: [
      { match: /^llama-.*-bin-win-cuda-12\.4-x64\.zip$/i, required: true },
      { match: /^cudart-llama.*-bin-win-cuda-12\.4-x64\.zip$/i, required: false },
    ],
    note: 'Schnellster Weg für NVIDIA auf Windows. Benötigt aktuellen NVIDIA-Treiber.',
  },
  'win-cuda-13.5': {
    label: 'NVIDIA CUDA 13.5',
    platform: 'win32', arch: 'x64',
    assets: [
      { match: /^llama-.*-bin-win-cuda-13\.5-x64\.zip$/i, required: true },
      { match: /^cudart-llama.*-bin-win-cuda-13\.5-x64\.zip$/i, required: false },
    ],
    note: 'Neueste CUDA-Version — nur mit sehr aktuellem Treiber sinnvoll.',
  },
  'win-vulkan': {
    label: 'Vulkan (NVIDIA/AMD/Intel)',
    platform: 'win32', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-win-vulkan-x64\.zip$/i, required: true }],
    note: 'Universell für alle GPUs, kleiner Download. Etwas langsamer als CUDA/ROCm.',
  },
  'win-rocm': {
    label: 'AMD ROCm/HIP (experimentell)',
    platform: 'win32', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-win-rocm-.*-x64\.zip$/i, required: true }],
    note: 'AMD-Beschleunigung unter Windows. Treiberkompatibilität ist heikel — Vulkan ist der sichere Weg.',
    experimental: true,
  },
  'win-sycl': {
    label: 'Intel SYCL / oneAPI (experimentell)',
    platform: 'win32', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-win-sycl-x64\.zip$/i, required: true }],
    note: 'Für Intel Arc / integrierte Intel-GPUs. Benötigt Intel-Treiber.',
    experimental: true,
  },
  'win-openvino': {
    label: 'Intel OpenVINO / NPU (experimentell)',
    platform: 'win32', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-win-openvino-.*-x64\.zip$/i, required: true }],
    note: 'Kann die Intel-NPU (Core Ultra) nutzen. Nur kleine Modelle, experimentell.',
    experimental: true, npu: true,
  },
  'win-cpu-x64': {
    label: 'CPU (x64)',
    platform: 'win32', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-win-cpu-x64\.zip$/i, required: true }],
    note: 'Läuft immer, auch ohne GPU. Langsam, aber zuverlässig.',
  },
  'win-cpu-arm64': {
    label: 'CPU (ARM64)',
    platform: 'win32', arch: 'arm64',
    assets: [{ match: /^llama-.*-bin-win-cpu-arm64\.zip$/i, required: true }],
    note: 'Für Windows on ARM.',
  },
  'win-vulkan-arm64': {
    label: 'Vulkan (ARM64)',
    platform: 'win32', arch: 'arm64',
    assets: [{ match: /^llama-.*-bin-win-vulkan-arm64\.zip$/i, required: true }],
    note: 'Für Windows-on-ARM-Geräte mit Adreno/Qualcomm-GPU.',
  },
  'win-cuda-13.5-arm64': {
    label: 'NVIDIA CUDA 13.5 (ARM64)',
    platform: 'win32', arch: 'arm64',
    assets: [{ match: /^llama-.*-bin-win-cuda-13\.5-arm64\.zip$/i, required: true }],
    note: 'NVIDIA auf Windows ARM64.',
    experimental: true,
  },
  'linux-cuda-12.8': {
    label: 'NVIDIA CUDA 12.8',
    platform: 'linux', arch: 'x64',
    assets: [
      { match: /^llama-.*-bin-ubuntu-cuda-12\.8-x64\.tar\.gz$/i, required: true },
      { match: /^cudart-llama.*-bin-ubuntu-cuda-12\.8-x64\.tar\.gz$/i, required: false },
    ],
    note: 'Schnellster Weg für NVIDIA unter Linux.',
  },
  'linux-vulkan': {
    label: 'Vulkan (NVIDIA/AMD/Intel)',
    platform: 'linux', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-ubuntu-vulkan-x64\.tar\.gz$/i, required: true }],
    note: 'Universell, kleiner Download, treiberunabhängig.',
  },
  'linux-rocm': {
    label: 'AMD ROCm/HIP',
    platform: 'linux', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-ubuntu-rocm-.*-x64\.tar\.gz$/i, required: true }],
    note: 'AMD-Beschleunigung unter Linux. Benötigt ROCm-Runtime/Treiber.',
  },
  'linux-sycl-fp16': {
    label: 'Intel SYCL / oneAPI (experimentell)',
    platform: 'linux', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-ubuntu-sycl-fp16-x64\.tar\.gz$/i, required: true }],
    note: 'Für Intel Arc unter Linux. Benötigt oneAPI-Runtime.',
    experimental: true,
  },
  'linux-openvino': {
    label: 'Intel OpenVINO / NPU (experimentell)',
    platform: 'linux', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-ubuntu-openvino-.*-x64\.tar\.gz$/i, required: true }],
    note: 'Kann die Intel-NPU nutzen. Nur kleine Modelle, experimentell.',
    experimental: true, npu: true,
  },
  'linux-cpu': {
    label: 'CPU (x64)',
    platform: 'linux', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-ubuntu-x64\.tar\.gz$/i, required: true }],
    note: 'Läuft immer, auch ohne GPU.',
  },
  'linux-cpu-arm64': {
    label: 'CPU (ARM64)',
    platform: 'linux', arch: 'arm64',
    assets: [{ match: /^llama-.*-bin-ubuntu-arm64\.tar\.gz$/i, required: true }],
    note: 'Für ARM64-Linux (Raspberry Pi, Jetson, Server).',
  },
  'linux-vulkan-arm64': {
    label: 'Vulkan (ARM64)',
    platform: 'linux', arch: 'arm64',
    assets: [{ match: /^llama-.*-bin-ubuntu-vulkan-arm64\.tar\.gz$/i, required: true }],
    note: 'Vulkan auf ARM64.',
  },
  'macos-arm64': {
    label: 'macOS Apple Silicon (Metal)',
    platform: 'darwin', arch: 'arm64',
    assets: [{ match: /^llama-.*-bin-macos-arm64\.tar\.gz$/i, required: true }],
    note: 'Metal-Backend für M1/M2/M3/M4 — GPU und Unified Memory werden genutzt.',
  },
  'macos-x64': {
    label: 'macOS Intel (CPU)',
    platform: 'darwin', arch: 'x64',
    assets: [{ match: /^llama-.*-bin-macos-x64\.tar\.gz$/i, required: true }],
    note: 'Für Intel-Macs. Metal-Unterstützung ist dort eingeschränkt.',
  },
  'onnx': {
    label: 'ONNX Runtime (NPU)',
    platform: 'any', arch: 'any',
    onnx: true,
    experimental: true, npu: true,
    note: 'ONNXRuntime GenAI für ONNX-/NPU-Modelle (AMD Ryzen AI, Intel OpenVINO, DirectML, CPU). Braucht Python 3.10–3.12 im System.',
  },
};

/* --------------------------- HTTP-Helfer --------------------------- */

function getJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'ModelHarbor/1.0', 'Accept': 'application/vnd.github+json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getJson(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} bei ${url}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(i18n.t('error.githubInvalidJson'))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(i18n.t('error.githubTimeout'))));
    req.on('error', reject);
  });
}

function downloadToFile(url, dest, onProgress, { resume = true } = {}) {
  return new Promise((resolve, reject) => {
    let start = 0;
    if (resume && fs.existsSync(dest)) {
      try { start = fs.statSync(dest).size; } catch { start = 0; }
    }
    if (!start) { try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* ignore */ } }

    const headers = { 'User-Agent': 'ModelHarbor/1.0' };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const req = https.get(url, { headers, timeout: 60000 }, (res) => {
      // Redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(new URL(res.headers.location, url).toString(), dest, onProgress, { resume }).then(resolve, reject);
        return;
      }
      if (res.statusCode === 416 && start > 0) {
        // Datei war schon vollständig
        res.resume();
        resolve({ bytes: start, resumed: true });
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        reject(new Error(`Download fehlgeschlagen: HTTP ${res.statusCode}`));
        return;
      }
      const totalHeader = res.headers['content-length'];
      const total = totalHeader ? parseInt(totalHeader, 10) + (res.statusCode === 206 ? start : 0) : null;
      // Bei 200 trotz Range-Header wird die Datei neu geschrieben ('w'): der
      // Zähler muss bei 0 beginnen, nicht bei der alten Dateigröße.
      let received = res.statusCode === 206 ? start : 0;
      const flags = res.statusCode === 206 ? 'a' : 'w';
      const out = fs.createWriteStream(dest, { flags });
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total, percent: total ? Math.min(100, (received / total) * 100) : null });
      });
      pipeline(res, out).then(() => resolve({ bytes: received, total })).catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Download')));
    req.on('error', reject);
  });
}

/* --------------------------- Release-Logik --------------------------- */

let releaseCache = null;

async function latestRelease() {
  if (releaseCache && Date.now() - releaseCache.fetchedAt < 30 * 60 * 1000) return releaseCache;
  const releases = await getJson(RELEASES_API);
  if (!Array.isArray(releases)) throw new Error(i18n.t('error.noReleaseList'));
  // Neuester Build mit echten Binär-Assets (die "latest"-Releases enthalten teils nur Tags)
  const withAssets = releases
    .filter((r) => Array.isArray(r.assets) && r.assets.length >= 5)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  if (!withAssets.length) throw new Error(i18n.t('error.noLlamaBuild'));
  const rel = withAssets[0];
  releaseCache = {
    fetchedAt: Date.now(),
    tag: rel.tag_name,
    publishedAt: rel.published_at,
    htmlUrl: rel.html_url,
    assets: rel.assets.map((a) => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
      sha256: (a.digest || '').replace(/^sha256:/, '') || null,
    })),
  };
  return releaseCache;
}

function resolveAssets(release, backendId) {
  const def = BACKENDS[backendId];
  if (!def) throw new Error(i18n.t('error.backendUnknown', { id: backendId }));
  const resolved = [];
  for (const rule of def.assets) {
    const asset = release.assets.find((a) => rule.match.test(a.name));
    if (asset) resolved.push({ ...asset, required: rule.required });
    else if (rule.required) throw new Error(i18n.t('error.assetMissing', { label: def.label, tag: release.tag, match: rule.match }));
  }
  return resolved;
}

function availableBackends(hw, release) {
  const platform = process.platform;
  const arch = process.arch;
  const rec = hw && hw.recommendation ? hw.recommendation : { primary: null, candidates: [] };
  const prio = new Map(rec.candidates.map((c, i) => [c.id, { rank: i, reason: c.reason, experimental: c.experimental }]));
  return Object.entries(BACKENDS)
    .filter(([, d]) => d.onnx || (d.platform === platform && d.arch === arch))
    .map(([id, d]) => {
      let assets = [];
      let size = 0;
      let missing = null;
      if (!d.onnx) {
        try {
          assets = resolveAssets(release, id);
          size = assets.reduce((s, a) => s + (a.size || 0), 0);
        } catch (e) {
          missing = e.message;
        }
      }
      const p = prio.get(id);
      return {
        id,
        label: d.label,
        note: i18n.t(`backendNote.${id}`, null, d.note),
        experimental: !!d.experimental,
        npu: !!d.npu,
        sizeBytes: size,
        sizeLabel: size ? `${(size / 1048576).toFixed(0)} MB` : null,
        assets: assets.map((a) => ({ name: a.name, size: a.size, required: a.required })),
        recommended: rec.primary === id,
        rank: p ? p.rank : 99,
        reason: p ? p.reason : null,
        missing,
      };
    })
    .filter((b) => !b.missing)
    .sort((a, b) => a.rank - b.rank);
}

/* --------------------------- Installation --------------------------- */

/**
 * Entpackt eine ZIP-Datei sicher: jeder Eintrag wird gegen das Zielverzeichnis
 * geprüft (kein Traversal, keine absoluten Pfade), Symlinks werden abgelehnt,
 * und die entpackte Gesamtgröße sowie die Eintragszahl sind begrenzt.
 * Ersetzt extract-zip 2.0.1, dessen Symlink-Behandlung CVEs aufwies
 * (GHSA-7pqw-9j4j-h8q3, GHSA-jmr9-qjv8-65gv).
 *
 * Das Budget wird zweifach geprüft: gegen die deklarierte uncompressedSize
 * (billige Vorabprüfung) UND gegen die tatsächlich geschriebenen Bytes — ein
 * Archiv, dessen Header lügen, kommt sonst am Limit vorbei. Inflatiert wird
 * selbst (yauzl decompress:false), weil yauzl bei lügenden Größenangaben
 * endlos stallt statt einen Fehler zu liefern.
 */
async function extractZipSafe(zipPath, targetDir, opts = {}) {
  const maxTotalBytes = opts.maxTotalBytes || ARCHIVE_MAX_TOTAL_BYTES;
  const maxEntries = opts.maxEntries || ARCHIVE_MAX_ENTRIES;
  const root = path.resolve(targetDir);
  await fsp.mkdir(root, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      let failed = false;
      const fail = (e) => {
        if (failed) return;
        failed = true;
        try { zipfile.close(); } catch { /* ignore */ }
        reject(e);
      };
      const tooLarge = () => new Error(i18n.t('error.archiveTooLarge', {
        limit: `${Math.round(maxTotalBytes / 1073741824)} GB`,
      }));
      zipfile.on('error', fail);
      let entryCount = 0;
      let written = 0;
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (failed) return;
        entryCount += 1;
        if (entryCount > maxEntries) {
          return fail(new Error(i18n.t('error.archiveTooManyEntries', { max: maxEntries })));
        }
        // Nur reguläre Dateien und Verzeichnisse; Symlinks und andere Typen ablehnen.
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const isDir = (mode & 0o170000) === 0o040000 || /\/$/.test(entry.fileName);
        const isSymlink = (mode & 0o170000) === 0o120000;
        if (isSymlink) return fail(new Error(`Symlink im Archiv nicht erlaubt: ${entry.fileName}`));
        // Pfad normalisieren und auf Containment prüfen.
        const entryPath = entry.fileName.replace(/\\/g, '/');
        const target = path.normalize(path.join(root, entryPath));
        if (target !== root && !target.startsWith(root + path.sep)) {
          return fail(new Error(`Archivpfad verlässt Zielverzeichnis: ${entry.fileName}`));
        }
        if (isDir) {
          fsp.mkdir(target, { recursive: true })
            .then(() => { if (!failed) zipfile.readEntry(); })
            .catch(fail);
          return;
        }
        const declared = Number(entry.uncompressedSize) || 0;
        if (written + declared > maxTotalBytes) return fail(tooLarge());
        // Nur Store (0) und Deflate (8) — alles andere (z. B. AES) ablehnen.
        const method = entry.compressionMethod;
        if (method !== 0 && method !== 8) {
          return fail(new Error(i18n.t('error.archiveUnsupportedMethod', { method })));
        }
        fsp.mkdir(path.dirname(target), { recursive: true })
          .then(() => {
            // decompress:false + eigene Inflation. Grund: yauzl bleibt endlos
            // stehen, wenn die deklarierte uncompressedSize KLEINER ist als die
            // real entpackten Daten (lügender Header) — es fließen dann keine
            // Bytes und kein Fehler, die Installation hinge für immer (DoS).
            // Mit eigener Inflation zählen wir die echten Bytes und brechen ab.
            // Für Store-Einträge verbietet yauzl die Option, daher nur bei 8.
            zipfile.openReadStream(entry, method === 8 ? { decompress: false } : {}, (sErr, rawStream) => {
              if (sErr) return fail(sErr);
              if (failed) { rawStream.destroy(); return; }
              // Zählt die real geschriebenen Bytes und bricht bei Überschreitung ab.
              const budget = new Transform({
                transform(chunk, _enc, cb) {
                  written += chunk.length;
                  if (written > maxTotalBytes) return cb(tooLarge());
                  cb(null, chunk);
                },
              });
              const stages = method === 8
                ? [rawStream, zlib.createInflateRaw(), budget, fs.createWriteStream(target)]
                : [rawStream, budget, fs.createWriteStream(target)];
              pipeline(...stages)
                .then(() => { if (!failed) zipfile.readEntry(); })
                .catch(fail);
            });
          })
          .catch(fail);
      });
      zipfile.on('end', () => { if (!failed) resolve(targetDir); });
    });
  });
}

/**
 * Prüft ein tar-Archiv VOR dem Entpacken gegen dasselbe Budget. node-tar
 * schreibt pro Eintrag genau die im Header deklarierte Bytezahl — die Summe der
 * Header-Größen ist damit die tatsächliche entpackte Größe. Zähler statt
 * Liste: konstanter Speicher, auch bei Archiven mit sehr vielen Einträgen.
 */
async function assertTarBudget(archivePath, opts = {}) {
  const maxTotalBytes = opts.maxTotalBytes || ARCHIVE_MAX_TOTAL_BYTES;
  const maxEntries = opts.maxEntries || ARCHIVE_MAX_ENTRIES;
  let total = 0;
  let count = 0;
  await tar.t({
    file: archivePath,
    onReadEntry: (entry) => { count += 1; total += entry.size || 0; },
  });
  if (count > maxEntries) {
    throw new Error(i18n.t('error.archiveTooManyEntries', { max: maxEntries }));
  }
  if (total > maxTotalBytes) {
    throw new Error(i18n.t('error.archiveTooLarge', {
      limit: `${Math.round(maxTotalBytes / 1073741824)} GB`,
    }));
  }
  return { total, count };
}

async function findServerBinary(dir) {
  const names = process.platform === 'win32' ? ['llama-server.exe', 'llama-server'] : ['llama-server', 'llama-server.exe'];
  const results = [];
  async function walk(d, depth) {
    if (depth > 4 || results.length) return;
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (names.includes(e.name)) results.push(p);
    }
  }
  await walk(dir, 0);
  return results[0] || null;
}

async function installBackend(backendId, { installRoot, onProgress = () => {} }) {
  const def = BACKENDS[backendId];
  if (!def) throw new Error(i18n.t('error.backendUnknown', { id: backendId }));
  if (def.platform !== 'any' && (def.platform !== process.platform || def.arch !== process.arch)) {
    throw new Error(i18n.t('error.platformMismatch', { label: def.label, platform: process.platform, arch: process.arch }));
  }
  if (def.onnx) {
    return installOnnxBackend(backendId, { installRoot, onProgress });
  }
  const release = await latestRelease();
  const assets = resolveAssets(release, backendId);

  const targetDir = path.join(installRoot, backendId);
  const tmpDir = path.join(installRoot, '.tmp', `${backendId}-${Date.now()}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  const totalBytes = assets.reduce((s, a) => s + (a.size || 0), 0);
  let doneBytes = 0;

  for (const asset of assets) {
    const filePath = path.join(tmpDir, asset.name);
    onProgress({ phase: 'download', backend: backendId, file: asset.name, doneBytes, totalBytes, percent: totalBytes ? (doneBytes / totalBytes) * 100 : 0 });
    await downloadToFile(asset.url, filePath, (p) => {
      const overall = totalBytes ? ((doneBytes + p.received) / totalBytes) * 100 : null;
      onProgress({
        phase: 'download', backend: backendId, file: asset.name,
        received: p.received, fileTotal: p.total, doneBytes: doneBytes + p.received, totalBytes,
        percent: overall,
      });
    });
    // Integrität VOR dem Entpacken: diese Binaries werden gleich ausgeführt.
    // Die Release-API liefert assets[].digest — ohne Abgleich wäre eine
    // manipulierte Auslieferung nicht von einer echten zu unterscheiden.
    await verifyDownload(filePath, { sha256: asset.sha256 }, asset.name);
    doneBytes += asset.size || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
  }

  onProgress({ phase: 'extract', backend: backendId, percent: 100, doneBytes: totalBytes, totalBytes });
  await fsp.mkdir(targetDir, { recursive: true });
  for (const asset of assets) {
    const filePath = path.join(tmpDir, asset.name);
    if (/\.zip$/i.test(asset.name)) {
      await extractZipSafe(filePath, targetDir);
    } else if (/\.tar\.gz$/i.test(asset.name) || /\.tgz$/i.test(asset.name)) {
      await assertTarBudget(filePath);
      await tar.x({ file: filePath, cwd: targetDir, preservePaths: false });
    }
  }

  // macOS: Gatekeeper-Quarantäne entfernen, sonst startet llama-server nicht
  if (process.platform === 'darwin') {
    await new Promise((resolve) => {
      require('child_process').execFile('xattr', ['-dr', 'com.apple.quarantine', targetDir], { timeout: 15000 }, () => resolve());
    });
  }

  // Ausführbar machen (Linux/macOS)
  if (process.platform !== 'win32') {
    const server = await findServerBinary(targetDir);
    if (server) {
      try { await fsp.chmod(server, 0o755); } catch { /* ignore */ }
      // alle Dateien in llama-* Verzeichnissen ausführbar machen
      try {
        const entries = await fsp.readdir(path.dirname(server));
        for (const e of entries) {
          if (/^llama-|\.so(\.|$)/.test(e)) {
            try { await fsp.chmod(path.join(path.dirname(server), e), 0o755); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  }

  await fsp.rm(tmpDir, { recursive: true, force: true });

  const serverPath = await findServerBinary(targetDir);
  if (!serverPath) throw new Error(i18n.t('error.serverNotFound'));

  const manifest = {
    id: backendId,
    label: def.label,
    release: release.tag,
    releaseUrl: release.htmlUrl,
    installedAt: new Date().toISOString(),
    dir: targetDir,
    serverPath,
    assets: assets.map((a) => a.name),
    experimental: !!def.experimental,
    npu: !!def.npu,
  };
  await fsp.writeFile(path.join(targetDir, 'modelharbor-backend.json'), JSON.stringify(manifest, null, 2), 'utf8');
  onProgress({ phase: 'done', backend: backendId, percent: 100, manifest });
  return manifest;
}

async function listInstalled(installRoot) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(installRoot, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.tmp') continue;
    const manifestPath = path.join(installRoot, e.name, 'modelharbor-backend.json');
    try {
      const raw = await fsp.readFile(manifestPath, 'utf8');
      const m = JSON.parse(raw);
      if (m && m.serverPath && fs.existsSync(m.serverPath)) out.push(m);
    } catch { /* kein Backend-Verzeichnis */ }
  }
  return out;
}

async function removeBackend(installRoot, backendId) {
  // backendId kommt ungeprüft aus dem Renderer. Nur bekannte Backend-IDs sind
  // erlaubt — damit sind '..', Pfadteile und Präfix-Kollisionen ausgeschlossen.
  if (!Object.prototype.hasOwnProperty.call(BACKENDS, backendId)) {
    throw new Error(i18n.t('error.backendUnknown', { id: backendId }));
  }
  const root = path.resolve(installRoot);
  const dir = path.resolve(root, backendId);
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error(i18n.t('error.invalidPath'));
  await fsp.rm(dir, { recursive: true, force: true });
}

/* --------------------------- ONNX-Backend (GenAI) --------------------------- */

/** astral/uv-Assetname je Plattform — Python 3.12 kommt damit ohne System-Python. */
const UV_ASSETS = {
  linux: { x64: 'uv-x86_64-unknown-linux-gnu.tar.gz', arm64: 'uv-aarch64-unknown-linux-gnu.tar.gz' },
  win32: { x64: 'uv-x86_64-pc-windows-msvc.zip', arm64: 'uv-aarch64-pc-windows-msvc.zip' },
  darwin: { x64: 'uv-x86_64-apple-darwin.tar.gz', arm64: 'uv-aarch64-apple-darwin.tar.gz' },
};

/** Passender uv-Release-Assetname (rein funktional, testbar). */
function uvAssetFor(platform, arch) {
  const byArch = UV_ASSETS[platform];
  if (!byArch) return null;
  const key = arch === 'arm64' ? 'arm64' : (arch === 'x64' || arch === 'x86_64' ? 'x64' : null);
  return key ? byArch[key] : null;
}

/** sucht die uv-Binary (uv / uv.exe) im entpackten uv-Archiv. */
async function findUvBinary(dir) {
  const names = process.platform === 'win32' ? ['uv.exe', 'uv'] : ['uv', 'uv.exe'];
  const results = [];
  async function walk(d, depth) {
    if (depth > 4 || results.length) return;
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (names.includes(e.name)) results.push(p);
    }
  }
  await walk(dir, 0);
  return results[0] || null;
}

/**
 * Stellt eine uv-Binary in <installRoot>/onnx-tools bereit (Download des
 * neuesten astral/uv-Releases, einmalig) und gibt ihren Pfad zurück.
 * uv bringt Python 3.12 selbst mit — Voraussetzung für OGA ohne System-Python.
 */
async function ensureUv(installRoot, onProgress = () => {}) {
  const toolsDir = path.join(installRoot, 'onnx-tools');
  const existing = await findUvBinary(toolsDir);
  if (existing) return existing;

  const assetName = uvAssetFor(process.platform, process.arch);
  if (!assetName) throw new Error(i18n.t('error.platformMismatch', { label: 'uv', platform: process.platform, arch: process.arch }));

  onProgress({ phase: 'download', backend: 'onnx', file: 'Python 3.12 (uv)', percent: 15 });
  const release = await getJson('https://api.github.com/repos/astral-sh/uv/releases/latest');
  const asset = Array.isArray(release && release.assets) ? release.assets.find((a) => a.name === assetName) : null;
  if (!asset) throw new Error(i18n.t('error.uvAssetMissing', { asset: assetName }));

  await fsp.mkdir(toolsDir, { recursive: true });
  const archive = path.join(toolsDir, assetName);
  await downloadToFile(asset.browser_download_url, archive, (p) => onProgress({
    phase: 'download', backend: 'onnx', file: 'Python 3.12 (uv)',
    received: p.received, fileTotal: p.total, percent: 15 + (p.percent || 0) * 0.3,
  }));
  // uv wird ausgeführt, um Python zu installieren — gleiche Integritätspflicht.
  await verifyDownload(archive, { sha256: asset.digest }, assetName);

  if (/\.zip$/i.test(assetName)) {
    await extractZipSafe(archive, toolsDir);
  } else {
    await assertTarBudget(archive);
    await tar.x({ file: archive, cwd: toolsDir, preservePaths: false });
  }

  const uvPath = await findUvBinary(toolsDir);
  if (!uvPath) throw new Error(i18n.t('error.uvBinaryMissing'));
  if (process.platform !== 'win32') {
    try { await fsp.chmod(uvPath, 0o755); } catch { /* ignore */ }
  }
  try { await fsp.rm(archive, { force: true }); } catch { /* ignore */ }
  return uvPath;
}

/**
 * Baut das ONNX-Backend als Python-Venv mit onnxruntime-genai.
 * Kein llama.cpp-Asset-Download — das venv selbst ist das "Backend".
 * Bevorzugt ein System-Python 3.10–3.12; fehlt es, wird Python 3.12 über
 * astral/uv heruntergeladen und installiert (keine System-Abhängigkeit mehr).
 */
async function pickSystemPython() {
  const win = process.platform === 'win32';
  const candidates = win
    ? ['py -3.12', 'py -3.11', 'py -3.10', 'python3.12', 'python']
    : ['python3.12', 'python3.11', 'python3.10', 'python3'];
  const { spawnSync } = require('child_process');
  for (const c of candidates) {
    const [exe, ...rest] = c.split(' ');
    // py-Launcher liefert die Version auf stderr, python3 auf stdout — beides lesen.
    const r = spawnSync(exe, [...rest, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.status !== 0) continue;
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = out.match(/(\d+)\.(\d+)/);
    const ver = m ? Number(`${m[1]}.${m[2]}`) : 0;
    if (ver >= 3.10 && ver < 3.13) return c;
  }
  return null; // kein System-Python — installOnnxBackend nutzt dann uv
}

async function installOnnxBackend(backendId, { installRoot, onProgress = () => {} }) {
  const { execFileSync } = require('child_process');
  const isWin = process.platform === 'win32';
  const targetDir = path.join(installRoot, 'onnx');
  const venvDir = path.join(targetDir, 'venv');
  const bin = isWin ? 'Scripts' : 'bin';
  const venvPython = path.join(venvDir, bin, isWin ? 'python.exe' : 'python');
  const venvPip = path.join(venvDir, bin, isWin ? 'pip.exe' : 'pip');

  await fsp.mkdir(targetDir, { recursive: true });
  if (!fs.existsSync(venvPython)) {
    const sysPy = await pickSystemPython();
    if (sysPy) {
      onProgress({ phase: 'download', backend: 'onnx', file: 'Python-Venv anlegen', percent: 15 });
      const [exe, ...rest] = sysPy.split(' ');
      execFileSync(exe, [...rest, '-m', 'venv', venvDir], { stdio: 'ignore', windowsHide: true });
    } else {
      // Kein System-Python 3.10–3.12: uv holen und Python 3.12 mitinstallieren.
      let uv = null;
      try {
        uv = await ensureUv(installRoot, onProgress);
      } catch (e) {
        throw new Error(`${i18n.t('error.onnxPythonMissing')} (${e.message})`);
      }
      onProgress({ phase: 'download', backend: 'onnx', file: 'Python 3.12 (uv)', percent: 30 });
      execFileSync(uv, ['python', 'install', '3.12'], { stdio: 'ignore', windowsHide: true });
      onProgress({ phase: 'download', backend: 'onnx', file: 'Python-Venv anlegen', percent: 40 });
      execFileSync(uv, ['venv', '--python', '3.12', venvDir], { stdio: 'ignore', windowsHide: true });
    }
  }
  onProgress({ phase: 'download', backend: 'onnx', file: 'onnxruntime-genai', percent: 55 });
  if (fs.existsSync(venvPip)) {
    // klassisches venv (System-Python) — pip ist vorhanden
    execFileSync(venvPip, ['install', '-q', 'onnxruntime-genai'], { stdio: 'ignore', windowsHide: true });
  } else {
    // uv-venv hat kein pip — Installation über uv
    const uv = await ensureUv(installRoot, onProgress);
    execFileSync(uv, ['pip', 'install', '--python', venvPython, 'onnxruntime-genai'], { stdio: 'ignore', windowsHide: true });
  }
  onProgress({ phase: 'extract', backend: 'onnx', percent: 100 });

  const manifest = {
    id: 'onnx',
    label: 'ONNX Runtime (NPU)',
    installedAt: new Date().toISOString(),
    dir: targetDir,
    serverPath: venvPython,
    onnx: true,
    experimental: true,
    npu: true,
  };
  await fsp.writeFile(path.join(targetDir, 'modelharbor-backend.json'), JSON.stringify(manifest, null, 2), 'utf8');
  onProgress({ phase: 'done', backend: 'onnx', percent: 100, manifest });
  return manifest;
}

module.exports = {
  BACKENDS,
  latestRelease,
  availableBackends,
  installBackend,
  listInstalled,
  removeBackend,
  getJson,
  downloadToFile,
  extractZipSafe,
  assertTarBudget,
  ARCHIVE_MAX_TOTAL_BYTES,
  ARCHIVE_MAX_ENTRIES,
  uvAssetFor,
  ensureUv,
};
