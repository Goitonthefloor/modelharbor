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
const extractZip = require('extract-zip');
const tar = require('tar');

const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=25';

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
        getJson(res.headers.location, timeoutMs).then(resolve, reject);
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
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Ungültige JSON-Antwort von GitHub')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung bei GitHub')));
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
        downloadToFile(res.headers.location, dest, onProgress, { resume }).then(resolve, reject);
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
      let received = start;
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
  if (!Array.isArray(releases)) throw new Error('GitHub-API lieferte keine Release-Liste');
  // Neuester Build mit echten Binär-Assets (die "latest"-Releases enthalten teils nur Tags)
  const withAssets = releases
    .filter((r) => Array.isArray(r.assets) && r.assets.length >= 5)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  if (!withAssets.length) throw new Error('Kein llama.cpp-Build mit Binärdateien gefunden');
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
  if (!def) throw new Error(`Unbekanntes Backend: ${backendId}`);
  const resolved = [];
  for (const rule of def.assets) {
    const asset = release.assets.find((a) => rule.match.test(a.name));
    if (asset) resolved.push({ ...asset, required: rule.required });
    else if (rule.required) throw new Error(`Asset für ${def.label} fehlt im Release ${release.tag} (${rule.match})`);
  }
  return resolved;
}

function availableBackends(hw, release) {
  const platform = process.platform;
  const arch = process.arch;
  const rec = hw && hw.recommendation ? hw.recommendation : { primary: null, candidates: [] };
  const prio = new Map(rec.candidates.map((c, i) => [c.id, { rank: i, reason: c.reason, experimental: c.experimental }]));
  return Object.entries(BACKENDS)
    .filter(([, d]) => d.platform === platform && d.arch === arch)
    .map(([id, d]) => {
      let assets = [];
      let size = 0;
      let missing = null;
      try {
        assets = resolveAssets(release, id);
        size = assets.reduce((s, a) => s + (a.size || 0), 0);
      } catch (e) {
        missing = e.message;
      }
      const p = prio.get(id);
      return {
        id,
        label: d.label,
        note: d.note,
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
  if (!def) throw new Error(`Unbekanntes Backend: ${backendId}`);
  if (def.platform !== process.platform || def.arch !== process.arch) {
    throw new Error(`${def.label} passt nicht zu dieser Plattform (${process.platform}/${process.arch})`);
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
    doneBytes += asset.size || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
  }

  onProgress({ phase: 'extract', backend: backendId, percent: 100, doneBytes: totalBytes, totalBytes });
  await fsp.mkdir(targetDir, { recursive: true });
  for (const asset of assets) {
    const filePath = path.join(tmpDir, asset.name);
    if (/\.zip$/i.test(asset.name)) {
      await extractZip(filePath, { dir: targetDir });
    } else if (/\.tar\.gz$/i.test(asset.name) || /\.tgz$/i.test(asset.name)) {
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
  if (!serverPath) throw new Error('llama-server wurde im entpackten Paket nicht gefunden');

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
  const dir = path.join(installRoot, backendId);
  if (!dir.startsWith(installRoot)) throw new Error('Ungültiger Pfad');
  await fsp.rm(dir, { recursive: true, force: true });
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
};
