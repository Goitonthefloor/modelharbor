'use strict';
/**
 * models.js — HuggingFace-Anbindung, Modell-Katalog, Hardware-Fit und Download.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const i18n = require('../ui/i18n');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');

const HF = 'https://huggingface.co';

/** Quantisierung: Bits pro Gewicht (grob, inkl. Overhead) */
const QUANT_BITS = {
  F32: 32, F16: 16, BF16: 16,
  Q8_0: 8.5, Q8_K: 8.4,
  Q6_K: 6.6, Q6_K_L: 6.7,
  Q5_K_M: 5.7, Q5_K_S: 5.5, Q5_K_L: 5.8, Q5_0: 5.5, Q5_1: 5.6,
  Q4_K_M: 4.8, Q4_K_S: 4.6, Q4_K_L: 4.9, Q4_0: 4.5, Q4_1: 4.7, IQ4_XS: 4.3, IQ4_NL: 4.5,
  Q3_K_M: 3.9, Q3_K_S: 3.5, Q3_K_L: 4.1, IQ3_M: 3.7, IQ3_XS: 3.3,
  Q2_K: 3.0, IQ2_M: 2.7, IQ2_XS: 2.4, IQ1_S: 1.6,
};

/** Kuratierter Katalog — nur Repos, die live verifiziert existieren. */
const CATALOG = [
  {
    repo: 'ggml-org/gemma-3-1b-it-GGUF', name: 'Gemma 3 1B', params: '1B', family: 'Gemma',
    tag: 'Einsteiger', blurb: 'Läuft auf praktisch jeder Hardware. Ideal zum Ausprobieren.',
    preferQuant: 'Q4_K_M', minGB: 0,
  },
  {
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', name: 'Qwen 2.5 0.5B', params: '0.5B', family: 'Qwen',
    tag: 'Winzig', blurb: 'Sehr klein und schnell — gut für schwache Geräte und Tests.',
    preferQuant: 'q4_k_m', minGB: 0,
  },
  {
    repo: 'Qwen/Qwen3-1.7B-GGUF', name: 'Qwen 3 1.7B', params: '1.7B', family: 'Qwen',
    tag: 'Klein', blurb: 'Kompakt mit Denk-Modus. Solide für 4–8 GB VRAM.',
    preferQuant: 'Q8_0', minGB: 0,
  },
  {
    repo: 'Qwen/Qwen3-4B-GGUF', name: 'Qwen 3 4B', params: '4B', family: 'Qwen',
    tag: 'Allrounder', blurb: 'Bester Kompromiss aus Qualität und Größe für 8-GB-Grafikkarten.',
    preferQuant: 'Q4_K_M', minGB: 0,
  },
  {
    repo: 'Qwen/Qwen3-8B-GGUF', name: 'Qwen 3 8B', params: '8B', family: 'Qwen',
    tag: 'Allrounder', blurb: 'Der Standard für 12-GB-Karten. Starkes Deutsch, gutes Reasoning.',
    preferQuant: 'Q4_K_M', minGB: 0,
  },
  {
    repo: 'Qwen/Qwen3-14B-GGUF', name: 'Qwen 3 14B', params: '14B', family: 'Qwen',
    tag: 'Qualität', blurb: 'Deutlich stärker — braucht 12–16 GB VRAM oder viel RAM.',
    preferQuant: 'Q4_K_M', minGB: 8,
  },
  {
    repo: 'Qwen/Qwen3-30B-A3B-GGUF', name: 'Qwen 3 30B-A3B', params: '30B (MoE, 3B aktiv)', family: 'Qwen',
    tag: 'MoE', blurb: 'Große Qualität, aber nur 3B Parameter pro Token aktiv — schnell, wenn es in den Speicher passt.',
    preferQuant: 'Q4_K_M', minGB: 16,
  },
  {
    repo: 'unsloth/Llama-3.2-3B-Instruct-GGUF', name: 'Llama 3.2 3B', params: '3B', family: 'Llama',
    tag: 'Klein', blurb: 'Meta-Llama, kompakt und flott. Gute Alternative zu Qwen 3 4B.',
    preferQuant: 'Q4_K_M', minGB: 0,
  },
  {
    repo: 'unsloth/Llama-3.1-8B-Instruct-GGUF', name: 'Llama 3.1 8B', params: '8B', family: 'Llama',
    tag: 'Allrounder', blurb: 'Der Klassiker unter den offenen 8B-Modellen.',
    preferQuant: 'Q4_K_M', minGB: 6,
  },
  {
    repo: 'google/gemma-3-4b-it-qat-q4_0-gguf', name: 'Gemma 3 4B (QAT)', params: '4B', family: 'Gemma',
    tag: 'Klein', blurb: 'Von Google quantisiert (QAT) — gute Qualität bei nur 2,9 GB.',
    preferQuant: 'q4_0', minGB: 0,
  },
  {
    repo: 'google/gemma-3-12b-it-qat-q4_0-gguf', name: 'Gemma 3 12B (QAT)', params: '12B', family: 'Gemma',
    tag: 'Qualität', blurb: 'Googles 12B-Klasse, QAT-quantisiert auf 7,5 GB.',
    preferQuant: 'q4_0', minGB: 8,
  },
  {
    repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', name: 'Qwen 2.5 Coder 7B', params: '7B', family: 'Qwen',
    tag: 'Code', blurb: 'Spezialisiert auf Programmierung — mit dem Preset „Code“ kombinieren.',
    preferQuant: 'q4_k_m', minGB: 6,
  },
  {
    repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF', name: 'Mistral 7B Instruct v0.3', params: '7B', family: 'Mistral',
    tag: 'Klassiker', blurb: 'Solides Allzweckmodell mit gutem Englisch.',
    preferQuant: 'Q4_K_M', minGB: 6,
  },
  {
    repo: 'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF', name: 'DeepSeek R1 Distill 7B', params: '7B', family: 'DeepSeek',
    tag: 'Reasoning', blurb: 'Denkt in Schritten — stark bei Mathe und Logik, langsamer im Alltag.',
    preferQuant: 'Q5_K_M', minGB: 6,
  },
];

/* --------------------------- HTTP --------------------------- */

function getJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ModelHarbor/1.0', 'Accept': 'application/json' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getJson(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(i18n.t('error.hfRestricted')));
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HuggingFace antwortet mit HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch { reject(new Error(i18n.t('error.hfInvalidResponse'))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(i18n.t('error.hfTimeout'))));
    req.on('error', reject);
  });
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let start = 0;
    if (fs.existsSync(dest)) {
      try { start = fs.statSync(dest).size; } catch { start = 0; }
    }
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* ignore */ }
    const headers = { 'User-Agent': 'ModelHarbor/1.0' };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const req = https.get(url, { headers, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode === 416 && start > 0) { res.resume(); resolve({ bytes: start, alreadyComplete: true }); return; }
      if (res.statusCode === 401 || res.statusCode === 403) {
        res.resume();
        reject(new Error(i18n.t('error.downloadRefused')));
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        reject(new Error(i18n.t('error.downloadFailedHttp', { status: res.statusCode })));
        return;
      }
      const total = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) + (res.statusCode === 206 ? start : 0) : null;
      let received = start;
      const out = fs.createWriteStream(dest, { flags: res.statusCode === 206 ? 'a' : 'w' });
      res.on('data', (c) => {
        received += c.length;
        if (onProgress) onProgress({ received, total, percent: total ? Math.min(100, (received / total) * 100) : null });
      });
      pipeline(res, out).then(() => resolve({ bytes: received, total })).catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(i18n.t('error.downloadTimeout'))));
    req.on('error', reject);
  });
}

/* --------------------------- Hilfsfunktionen --------------------------- */

function quantFromName(file) {
  const base = path.basename(file).toLowerCase();
  // Erkennt auch Unsloth-UD-Quants (UD-Q4_K_XL), IQ-Varianten und MXFP4
  const m = base.match(/(?:^|[-_.])((?:ud-)?(?:i?q\d+(?:_[a-z0-9]+)*)|f16|bf16|f32|mxfp4)(?:[-_.]|$)/i);
  if (m) {
    const q = m[1].toUpperCase().replace(/^UD-/, '');
    if (QUANT_BITS[q]) return q;
    if (['F16', 'BF16', 'F32', 'MXFP4'].includes(q)) return q;
    return q; // z. B. IQ2_XXS oder Q4_K_XL — Name bleibt erhalten
  }
  const candidates = Object.keys(QUANT_BITS).sort((a, b) => b.length - a.length);
  for (const q of candidates) {
    const norm = q.toLowerCase();
    if (base.includes(`-${norm}.`) || base.includes(`_${norm}.`) || base.includes(`-${norm}-`) || base.includes(`.${norm}.`)) return q;
  }
  if (/\bf16\b/.test(base)) return 'F16';
  if (/\bbf16\b/.test(base)) return 'BF16';
  if (/\bf32\b/.test(base)) return 'F32';
  return null;
}

/** Bits pro Gewicht, auch für nicht exakt gelistete Quantnamen. */
function quantBits(q) {
  if (!q) return 4.8;
  const key = String(q).toUpperCase().replace(/^UD-/, '');
  if (QUANT_BITS[key]) return QUANT_BITS[key];
  if (/MXFP4/.test(key)) return 4.3;
  if (/F32/.test(key)) return 32;
  if (/BF16|F16/.test(key)) return 16;
  const m = key.match(/Q(\d)/);
  if (m) return { 1: 1.8, 2: 3.0, 3: 3.9, 4: 4.6, 5: 5.6, 6: 6.6, 8: 8.5 }[Number(m[1])] || 4.6;
  return 4.8;
}

function isSplitPart(file) {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(file);
}

function splitKey(file) {
  return file.replace(/-\d{5}-of-\d{5}(\.gguf)$/i, '$1');
}

function isAuxiliary(file) {
  const b = path.basename(file).toLowerCase();
  return b.startsWith('mmproj') || b.endsWith('.md') || b.includes('imatrix') || b.includes('readme');
}

function bytesFromSizeEntry(s) {
  if (!s) return 0;
  if (typeof s.size === 'number') return s.size;
  if (s.lfs && typeof s.lfs.size === 'number') return s.lfs.size;
  return 0;
}

async function modelFiles(repo) {
  const data = await getJson(`${HF}/api/models/${repo}?blobs=true`);
  const siblings = Array.isArray(data.siblings) ? data.siblings : [];
  const files = [];
  for (const s of siblings) {
    const name = s.rfilename;
    if (!name || !name.toLowerCase().endsWith('.gguf')) continue;
    files.push({
      name,
      size: bytesFromSizeEntry(s),
      quant: quantFromName(name),
      auxiliary: isAuxiliary(name),
      split: isSplitPart(name),
    });
  }
  // Splits gruppieren
  const groups = new Map();
  for (const f of files) {
    if (f.auxiliary) continue;
    const key = splitKey(f.name);
    if (!groups.has(key)) groups.set(key, { name: key, size: 0, quant: f.quant, parts: [], auxiliary: false, split: false });
    const g = groups.get(key);
    g.parts.push(f.name);
    g.size += f.size;
    if (f.split) g.split = true;
  }
  const out = [...groups.values()].map((g) => ({
    ...g,
    parts: g.parts.sort(),
    sizeLabel: g.size ? `${(g.size / 1073741824).toFixed(2)} GB` : null,
  }));
  out.sort((a, b) => b.size - a.size); // bester/größter Quant zuerst
  return { repo, files: out, allFiles: files, downloads: data.downloads, likes: data.likes, tags: data.tags || [] };
}

/** Wählt den besten Quant für ein Budget. budgetGB = VRAM (oder RAM-Anteil) */
function pickBestQuant(files, budgetGB, preferQuant) {
  const usable = files.filter((f) => !f.auxiliary);
  if (!usable.length) return null;
  const budget = budgetGB || 0;
  // Qualitätsdeckel: sehr große Quants (Q8/F16) nur, wenn viel Luft bleibt —
  // sonst leidet die Geschwindigkeit stärker als die Qualität gewinnt.
  const qualityCap = budget * 0.65;
  const roomy = usable.filter((f) => f.size / 1073741824 <= qualityCap);
  const fits = usable.filter((f) => f.size / 1073741824 <= budget * 0.88);
  const pool = roomy.length ? roomy : (fits.length ? fits : usable);
  if (preferQuant) {
    const exact = pool.find((f) => (f.quant || '').toLowerCase() === preferQuant.toLowerCase());
    if (exact) return exact;
  }
  // größter Quant, der passt — aber nicht F32/F16 (Platzverschwendung), außer es passt nur das
  const sensible = pool.filter((f) => !['F32', 'F16', 'BF16'].includes(f.quant));
  const candidates = sensible.length ? sensible : pool;
  return candidates.sort((a, b) => b.size - a.size)[0];
}

function estimateParamsBillions(fileName, sizeBytes) {
  const q = quantFromName(fileName) || 'Q4_K_M';
  const bits = quantBits(q);
  const bytesPerParam = bits / 8;
  const size = sizeBytes / 1073741824;
  return Math.max(0.1, size / bytesPerParam);
}

/** Speicherbedarf schätzen und gegen Hardware prüfen. */
function evaluateFit(sizeBytes, fileName, hw, ctx) {
  const fileGB = sizeBytes / 1073741824;
  const paramsB = estimateParamsBillions(fileName, sizeBytes);
  const context = ctx || 8192;
  const kvGB = paramsB * 0.045 * (context / 4096);
  const overheadGB = 0.6;
  const needGB = fileGB + kvGB + overheadGB;

  const gpus = (hw.gpus || []).filter((g) => g.vramGB);
  const best = gpus.sort((a, b) => b.vramGB - a.vramGB)[0] || null;
  const vram = best ? best.vramGB : 0;
  const ram = hw.totalMemGB || 8;

  let verdict, label, detail, gpuLayers;
  const need = needGB.toFixed(1);
  if (vram && needGB <= vram * 0.9) {
    verdict = 'gpu';
    label = i18n.t('fit.gpu.label');
    detail = i18n.t('fit.gpu.detail', { need, vram, gpu: best.name });
    gpuLayers = 999;
  } else if (vram && needGB <= vram * 1.9 && needGB <= ram * 0.8) {
    verdict = 'hybrid';
    label = i18n.t('fit.hybrid.label');
    detail = i18n.t('fit.hybrid.detail', { need, vram });
    gpuLayers = 999; // llama.cpp offloadet so viel wie möglich, Rest CPU
  } else if (needGB <= ram * 0.75) {
    verdict = 'ram';
    label = i18n.t('fit.ram.label');
    detail = i18n.t('fit.ram.detail', { need });
    gpuLayers = 0;
  } else {
    verdict = 'too-big';
    label = i18n.t('fit.tooBig.label');
    detail = i18n.t('fit.tooBig.detail', { need, available: Math.max(vram, Math.round(ram * 0.75)) });
    gpuLayers = 0;
  }
  return { verdict, label, detail, needGB: Math.round(needGB * 10) / 10, gpuLayers, vramGB: vram || null, ramGB: ram };
}

/* --------------------------- Suche --------------------------- */

async function searchModels(query, limit = 25) {
  const q = encodeURIComponent(query || '');
  const url = `${HF}/api/models?search=${q}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
  const list = await getJson(url);
  if (!Array.isArray(list)) return [];
  return list.map((m) => ({
    repo: m.id,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    lastModified: m.lastModified || null,
    tags: (m.tags || []).filter((t) => /gguf|q\d|awq|gptq|mlx|it$|instruct/i.test(t)).slice(0, 6),
  }));
}

async function catalogWithFit(hw) {
  const out = [];
  for (const entry of CATALOG) {
    let info = null;
    try { info = await modelFiles(entry.repo); } catch { /* Katalog-Eintrag bleibt sichtbar, aber ohne Dateien */ }
    const files = info ? info.files : [];
    const best = pickBestQuant(files, hw.modelBudgetGB, entry.preferQuant);
    const fit = best ? evaluateFit(best.size, best.name, hw, 8192) : null;
    out.push({
      ...entry,
      blurb: i18n.t(`modelBlurb.${entry.repo}`, null, entry.blurb),
      file: best,
      files,
      fit,
      downloads: info ? info.downloads : null,
      sizeLabel: best && best.size ? `${(best.size / 1073741824).toFixed(2)} GB` : null,
    });
  }
  // passende zuerst
  const rank = { gpu: 0, hybrid: 1, ram: 2, 'too-big': 3 };
  out.sort((a, b) => {
    const ra = a.fit ? rank[a.fit.verdict] : 4;
    const rb = b.fit ? rank[b.fit.verdict] : 4;
    if (ra !== rb) return ra - rb;
    return (b.downloads || 0) - (a.downloads || 0);
  });
  return out;
}

/* --------------------------- Download --------------------------- */

async function downloadModel({ repo, file, modelsDir, onProgress = () => {}, downloadId = null }) {
  const info = await modelFiles(repo);
  const entry = info.files.find((f) => f.name === file);
  if (!entry) throw new Error(i18n.t('error.fileNotInRepo', { file }));
  const parts = entry.parts && entry.parts.length ? entry.parts : [entry.name];
  const folder = path.join(modelsDir, repo.replace(/[\\/]/g, '__'));
  await fsp.mkdir(folder, { recursive: true });

  const totalExpected = entry.size || 0;
  let doneBytes = 0;
  for (const part of parts) {
    const url = `${HF}/${repo}/resolve/main/${encodePath(part)}?download=true`;
    const finalPath = path.join(folder, path.basename(part));
    const partPath = `${finalPath}.part`;
    const size = (info.allFiles.find((f) => f.name === part) || {}).size || 0;
    onProgress({
      phase: 'download', downloadId, repo, file: part, parts,
      received: 0, fileTotal: size, doneBytes, totalBytes: totalExpected, percent: totalExpected ? (doneBytes / totalExpected) * 100 : null,
    });
    const res = await downloadFile(url, partPath, (p) => {
      onProgress({
        phase: 'download', downloadId, repo, file: part, parts,
        received: p.received, fileTotal: p.total, doneBytes: doneBytes + p.received, totalBytes: totalExpected,
        percent: totalExpected ? Math.min(100, ((doneBytes + p.received) / totalExpected) * 100) : p.percent,
      });
    });
    if (res.alreadyComplete || (res.bytes && size && res.bytes === size)) {
      try { await fsp.rename(partPath, finalPath); } catch { /* existiert schon */ }
    } else if (size && res.bytes !== size) {
      throw new Error(i18n.t('error.downloadIncomplete', {
        got: (res.bytes / 1073741824).toFixed(2),
        expected: (size / 1073741824).toFixed(2),
      }));
    } else {
      try { await fsp.rename(partPath, finalPath); } catch { /* ignore */ }
    }
    doneBytes += size || (fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0);
  }
  onProgress({ phase: 'done', downloadId, repo, file, percent: 100, doneBytes, totalBytes: totalExpected });

  return {
    repo,
    file: entry.name,
    path: path.join(folder, path.basename(parts[0])),
    parts: parts.map((p) => path.join(folder, path.basename(p))),
    sizeBytes: entry.size,
    sizeLabel: entry.sizeLabel,
  };
}

/* --------------------------- Lokale Modelle --------------------------- */

async function listLocal(modelsDir) {
  const out = [];
  let repos = [];
  try { repos = await fsp.readdir(modelsDir, { withFileTypes: true }); } catch { return out; }
  for (const d of repos) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(modelsDir, d.name);
    let files = [];
    try { files = await fsp.readdir(dirPath); } catch { continue; }
    const ggufs = files.filter((f) => f.toLowerCase().endsWith('.gguf')).sort();
    if (!ggufs.length) {
      // ONNX-/GenAI-Modellordner: genai_config.json + .onnx(date)
      const hasOnnx = files.includes('genai_config.json') && files.some((f) => /\.onnx(\.data)?$/i.test(f));
      if (!hasOnnx) continue;
      let size = 0;
      for (const f of files) {
        if (!/\.onnx(\.data)?$/i.test(f)) continue;
        try { size += (await fsp.stat(path.join(dirPath, f))).size; } catch { /* ignore */ }
      }
      out.push({
        id: `${d.name}/onnx`,
        repo: d.name.replace(/__/g, '/'),
        file: `ONNX-${d.name}`,
        isOnnx: true,
        parts: [],
        path: dirPath,
        sizeBytes: size,
        sizeLabel: `${(size / 1073741824).toFixed(2)} GB`,
        quant: null,
        dir: dirPath,
      });
      continue;
    }
    // Splits gruppieren
    const groups = new Map();
    for (const f of ggufs) {
      const key = splitKey(f);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    for (const [key, parts] of groups) {
      let size = 0;
      for (const p of parts) { try { size += (await fsp.stat(path.join(dirPath, p))).size; } catch { /* ignore */ } }
      out.push({
        id: `${d.name}/${key}`,
        repo: d.name.replace(/__/g, '/'),
        file: key,
        parts: parts.map((p) => path.join(dirPath, p)),
        path: path.join(dirPath, parts[0]),
        sizeBytes: size,
        sizeLabel: `${(size / 1073741824).toFixed(2)} GB`,
        quant: quantFromName(key),
        dir: dirPath,
      });
    }
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo));
  return out;
}

async function deleteModel(modelsDir, modelId) {
  const [dirName] = modelId.split('/');
  const dirPath = path.join(modelsDir, dirName);
  if (!path.resolve(dirPath).startsWith(path.resolve(modelsDir))) throw new Error(i18n.t('error.invalidPath'));
  await fsp.rm(dirPath, { recursive: true, force: true });
}

module.exports = {
  CATALOG, QUANT_BITS, HF,
  searchModels, modelFiles, catalogWithFit, pickBestQuant, evaluateFit,
  downloadModel, listLocal, deleteModel, quantFromName, quantBits, getJson,
};
