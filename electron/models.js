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
const { isWithin, isWithinReal } = require('./paths');
const { verifyDownload } = require('./integrity');

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
  /* --- ONNX / NPU: OnnxRuntime-GenAI-Modelle (Ordner mit genai_config.json) ---
   * `onnxSub` ist der Unterordner im Repo, in dem genai_config.json + *.onnx liegen
   * (per HF-API verifiziert). Diese Einträge werden nicht als einzelne GGUF-Datei
   * geladen, sondern als kompletter Ordner flach nach <modelsDir>/<repo-name>. */
  {
    repo: 'microsoft/Phi-3-mini-4k-instruct-onnx', name: 'Phi-3 Mini 4K', params: '3.8B', family: 'Phi',
    tag: 'NPU/ONNX', onnx: true, onnxSub: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4',
    blurb: 'OGA-nativ (GenAI). Der Start-Hebel für ONNX/NPU.',
    preferQuant: null, minGB: 0,
  },
  {
    repo: 'microsoft/Phi-4-mini-instruct-onnx', name: 'Phi-4 Mini', params: '3.8B', family: 'Phi',
    tag: 'NPU/ONNX', onnx: true, onnxSub: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4',
    blurb: 'Aktuelles Phi, OGA-int4 für CPU/NPU.',
    preferQuant: null, minGB: 0,
  },
  {
    repo: 'onnx-community/Llama-3.2-1B-ONNX', name: 'Llama 3.2 1B', params: '1B', family: 'Llama',
    tag: 'NPU/ONNX', onnx: true, onnxSub: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4',
    blurb: 'Kleinstes OGA-Modell — läuft überall, auch auf der NPU.',
    preferQuant: null, minGB: 0,
  },
  /* --- Ryzen AI / NPU: genai_config.json im Repo-ROOT, Download des ganzen Ordners ---
   * `onnxSub: null` bedeutet: kein Unterordner — es werden alle Dateien im Root
   * (ohne README/LICENSE/Logs/cache-Unterordner) flach geladen. Diese Builds
   * (WGS/Ryzen-AI, Dateien wie dd_metastate_*.fconst/.state oder model_jit.onnx)
   * laufen über die Ryzen-AI-Software, nicht über llama.cpp. */
  {
    repo: 'amd/Qwen3.5_9B_rai_1.9.0_npu', name: 'Qwen 3.5 9B (Ryzen AI)', params: '9B', family: 'Qwen',
    tag: 'Ryzen AI', onnx: true, onnxSub: null, rai: true,
    blurb: 'AMD-Ryzen-AI-Build (RAI 1.9.0) für NPU/iGPU — genai_config.json im Root, ~15 GB Ordner-Download.',
    preferQuant: null, minGB: 21,
  },
  {
    repo: 'amd/Qwen3-8B-awq-quant-onnx-hybrid', name: 'Qwen 3 8B (Ryzen AI)', params: '8B', family: 'Qwen',
    tag: 'Ryzen AI', onnx: true, onnxSub: null, rai: true,
    blurb: 'AMD-ONNX-Build für Ryzen AI (Hybrid aus NPU und iGPU/CPU), ~8,8 GB Ordner-Download.',
    preferQuant: null, minGB: 9,
  },
  {
    repo: 'amd/Phi-4-mini-instruct-onnx-ryzenai-hybrid', name: 'Phi-4 Mini (Ryzen AI)', params: '3.8B', family: 'Phi',
    tag: 'Ryzen AI', onnx: true, onnxSub: null, rai: true,
    blurb: 'Kompakter Ryzen-AI-Hybrid-Build von Phi-4 Mini — kleinster Einstieg in NPU-Beschleunigung.',
    preferQuant: null, minGB: 6,
  },
];

/* --------------------------- HTTP --------------------------- */

function getJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ModelHarbor/1.0', 'Accept': 'application/json' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // HF leitet teils relativ um (z. B. umbenannte Repos) — gegen die Basis-URL auflösen
        getJson(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
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
        downloadFile(new URL(res.headers.location, url).toString(), dest, onProgress).then(resolve, reject);
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
      // Liefert der Server trotz Range-Header ein 200 (Range ignoriert), wird die
      // Datei mit 'w' neu geschrieben — dann darf nicht ab `start` weitergezählt
      // werden, sonst melden wir mehr Bytes als die Datei hat.
      let received = res.statusCode === 206 ? start : 0;
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

/** Echte Modelldatei (GGUF, kein mmproj/imatrix/README)? */
function isModelGguf(file) {
  return /\.gguf$/i.test(file) && !isAuxiliary(file);
}

/** mmproj-Projektor (Vision-Anteil) eines GGUF-Modells. */
function isVisionProjector(file) {
  const b = path.basename(file).toLowerCase();
  return b.startsWith('mmproj') && b.endsWith('.gguf');
}

/** Vision-Projektor (mmproj) in einem Modellordner — null, wenn keiner liegt. */
function findVisionProjector(dirPath, files) {
  const list = files || (() => { try { return fs.readdirSync(dirPath); } catch { return []; } })();
  return list.find(isVisionProjector) || null;
}

function bytesFromSizeEntry(s) {
  if (!s) return 0;
  if (typeof s.size === 'number') return s.size;
  if (s.lfs && typeof s.lfs.size === 'number') return s.lfs.size;
  return 0;
}

/**
 * Erwartete Inhalts-Hashes eines HF-siblings (?blobs=true):
 *  - LFS-Dateien (GGUF, ONNX-Gewichte): lfs.sha256
 *  - kleine Nicht-LFS-Dateien (config/tokenizer): blobId = Git-Blob-SHA1
 * Beide werden nach dem Download geprüft; fehlt keiner von beiden, wird die
 * Datei abgelehnt (fail closed) statt nur auf die Größe zu vertrauen.
 */
function digestsFromEntry(s) {
  return {
    sha256: (s && s.lfs && s.lfs.sha256) || null,
    blobId: (s && s.blobId) || null,
  };
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
      ...digestsFromEntry(s),
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

/** KV-Cache-Bedarf in GB bei f16 (Basis für die Quantisierungsrechnung). */
function kvCacheGB(sizeBytes, fileName, ctx) {
  const paramsB = estimateParamsBillions(fileName, sizeBytes);
  return paramsB * 0.045 * ((ctx || 8192) / 4096);
}

/** Speicherbedarf schätzen und gegen Hardware prüfen. */
function evaluateFit(sizeBytes, fileName, hw, ctx, kv = {}) {
  const fileGB = sizeBytes / 1073741824;
  const context = ctx || 8192;
  // KV-Cache schrumpft mit der Quantisierung (K und V getrennt gewichtet).
  const factor = require('./model-settings').kvFactor(kv.cacheTypeK, kv.cacheTypeV);
  const kvGB = kvCacheGB(sizeBytes, fileName, context) * factor;
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

/* --------------------------- ONNX / OGA --------------------------- */

/** Dateien, die ein OnnxRuntime-GenAI-Modellordner braucht (flach, ohne Unterpfade). */
const ONNX_FILE_RE = /(\.onnx(\.data)?|genai_config\.json|tokenizer\.json|tokenizer_config\.json|tokenizer\.model|added_tokens\.json|special_tokens_map\.json|config\.json|vocab\.json|merges\.txt)$/i;

/**
 * Filtert aus den HF-siblings die Dateien des OGA-Unterordners `onnxSub` und gibt
 * sie FLACH zurück (Pfad-Prefix entfernt) — so entsteht ein Ordner, den
 * listLocal als ONNX-Modell erkennt (genai_config.json im Root).
 * Rein funktional (kein Netz), damit testbar.
 */
function parseOnnxFiles(siblings, onnxSub) {
  const sub = String(onnxSub || '').replace(/^\/+|\/+$/g, '');
  const prefix = sub ? `${sub}/` : '';
  const out = [];
  for (const s of Array.isArray(siblings) ? siblings : []) {
    const rfilename = s && s.rfilename;
    if (!rfilename || !rfilename.startsWith(prefix)) continue;
    const rel = rfilename.slice(prefix.length);
    if (!rel || rel.includes('/')) continue; // nur Dateien direkt in onnxSub
    if (!ONNX_FILE_RE.test(rel)) continue;
    out.push({ name: rel, repoPath: rfilename, size: bytesFromSizeEntry(s), ...digestsFromEntry(s) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Dateien, die beim Ordner-Download eines Ryzen-AI-/GenAI-Repos NICHT mitkommen:
 * Git-Kram, Doku, Logs und alles in Unterordnern (cache/, partitioned/ ...).
 */
const ONNX_FOLDER_SKIP_RE = /^(?:\.?gitattributes|readme[^/]*|license[^/]*|.*\.log|.*\.md)$/i;

/**
 * Dateiliste für einen Repo-weiten Ordner-Download (`onnxSub === null`, z. B.
 * amd-Ryzen-AI-Repos mit genai_config.json im Root). Nur Dateien DIREKT im Root,
 * ohne Doku/Logs — Dateinamen bleiben die Basenames im Zielordner.
 * Rein funktional (kein Netz), damit testbar.
 */
function parseOnnxFolderFiles(siblings) {
  const out = [];
  for (const s of Array.isArray(siblings) ? siblings : []) {
    const rfilename = s && s.rfilename;
    if (!rfilename) continue;
    if (rfilename.includes('/')) continue; // Root only — cache/, partitioned/ usw. raus
    if (ONNX_FOLDER_SKIP_RE.test(rfilename)) continue;
    out.push({ name: path.basename(rfilename), repoPath: rfilename, size: bytesFromSizeEntry(s), ...digestsFromEntry(s) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Dateiliste + Gesamtgröße eines ONNX-Katalog-Eintrags (ein HF-API-Aufruf). */
async function onnxModelFiles(repo, onnxSub) {
  const data = await getJson(`${HF}/api/models/${repo}?blobs=true`);
  const flat = onnxSub == null || String(onnxSub).trim() === '';
  const files = flat ? parseOnnxFolderFiles(data.siblings) : parseOnnxFiles(data.siblings, onnxSub);
  const size = files.reduce((s, f) => s + (f.size || 0), 0);
  return { repo, onnxSub: flat ? null : onnxSub, files, size, downloads: data.downloads || 0, likes: data.likes || 0 };
}

/* --------------------------- Suche --------------------------- */

/**
 * Repo-Namen, die nach ONNX/NPU-/Ryzen-AI-Build aussehen (amd/Qwen…_rai_…_npu,
 * …-onnx-ryzenai-npu, …-onnx-hybrid …). Grundlage für die zweite Suchgruppe.
 */
const ONNX_REPO_RE = /(?:^|[-_.])(?:onnx|ryzenai|rai|npu|oga|genai)(?:[-_.]|$)/i;

/** Zweite, fire-and-forget-Suche: ONNX-/NPU-Modelle (Ordner-Download, onnxSub unbekannt). */
async function searchOnnxModels(query, limit = 10) {
  const q = encodeURIComponent(query || '');
  const url = `${HF}/api/models?search=${q}&filter=onnx&sort=downloads&direction=-1&limit=${limit * 3}`;
  const list = await getJson(url);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    if (!m || !m.id) continue;
    if (!ONNX_REPO_RE.test(m.id)) continue; // nur Repos mit ONNX/NPU-Muster im Namen
    out.push({
      repo: m.id,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      lastModified: m.lastModified || null,
      onnx: true,
      onnxSub: null, // unbekannt -> kompletter Ordner (Repo-Root) wird geladen
      tags: (m.tags || []).filter((t) => /onnx|ryzenai|npu|hybrid|rai/i.test(t)).slice(0, 6),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Suche in zwei Gruppen: erst GGUF-Treffer (Einzeldatei-Download), darunter
 * ONNX-/Ryzen-AI-Treffer (Ordner-Download). Fällt die ONNX-Suche aus (Netz,
 * Rate-Limit), bleiben die GGUF-Treffer nutzbar.
 */
async function searchModels(query, limit = 25) {
  const q = encodeURIComponent(query || '');
  const url = `${HF}/api/models?search=${q}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;
  const onnxPromise = searchOnnxModels(query, 10).catch(() => []);
  const list = await getJson(url);
  const gguf = (Array.isArray(list) ? list : []).map((m) => ({
    repo: m.id,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    lastModified: m.lastModified || null,
    onnx: false,
    onnxSub: null,
    tags: (m.tags || []).filter((t) => /gguf|q\d|awq|gptq|mlx|it$|instruct/i.test(t)).slice(0, 6),
  }));
  const seen = new Set(gguf.map((r) => r.repo));
  const onnx = (await onnxPromise).filter((r) => !seen.has(r.repo));
  return [...gguf, ...onnx];
}

async function catalogWithFit(hw) {
  const out = [];
  for (const entry of CATALOG) {
    if (entry.onnx) {
      // ONNX-/OGA-Eintrag: kein Quant, keine Einzeldatei — Ordner mit genai_config.json
      // (onnxSub gesetzt = Unterordner, onnxSub null = kompletter Repo-Root).
      let info = null;
      try { info = await onnxModelFiles(entry.repo, entry.onnxSub); } catch { /* Eintrag bleibt sichtbar */ }
      const size = info ? info.size : 0;
      const fit = size ? evaluateFit(size, 'model.onnx', hw, 8192) : null;
      out.push({
        ...entry,
        isOnnx: true,
        rai: !!entry.rai,
        blurb: i18n.t(`modelBlurb.${entry.repo}`, null, entry.blurb),
        file: null,
        files: [],
        onnxFileCount: info ? info.files.length : 0,
        fit,
        downloads: info ? info.downloads : null,
        sizeLabel: size ? `${(size / 1073741824).toFixed(2)} GB` : null,
      });
      continue;
    }
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
    const meta = info.allFiles.find((f) => f.name === part) || {};
    const size = meta.size || 0;
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
    // Größe zuerst (billig), dann zwingend der Inhalts-Hash: eine gleich große,
    // aber inhaltlich andere GGUF-Datei darf nicht als Modell durchgehen.
    if (!res.alreadyComplete && size && res.bytes !== size) {
      throw new Error(i18n.t('error.downloadIncomplete', {
        got: (res.bytes / 1073741824).toFixed(2),
        expected: (size / 1073741824).toFixed(2),
      }));
    }
    await verifyDownload(partPath, meta, part);
    try { await fsp.rename(partPath, finalPath); } catch { /* existiert schon */ }
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

/**
 * Lädt ein ONNX-/OGA-Modell und legt alle Dateien FLACH in
 * <modelsDir>/<letzter-Repo-Teil> ab — genau die Form, die listLocal als
 * ONNX-Modell erkennt.
 *  - `onnxSub` gesetzt: nur die Dateien dieses Unterordners (OGA-Unterpfad).
 *  - `onnxSub === null`: kompletter Repo-Root (Ryzen-AI-Builds, deren
 *    genai_config.json direkt im Root liegt) ohne README/Logs/Unterordner.
 * Rückgabe: { bytes, total, files } (+ Zusatzinfos für die UI).
 */
async function downloadOnnxModel({ repo, onnxSub, modelsDir, onProgress = () => {}, downloadId = null }) {
  const flat = onnxSub == null || String(onnxSub).trim() === '';
  const data = await getJson(`${HF}/api/models/${repo}?blobs=true`);
  const files = flat ? parseOnnxFolderFiles(data.siblings) : parseOnnxFiles(data.siblings, onnxSub);
  if (!files.length) {
    throw new Error(i18n.t('error.onnxFilesMissing', { repo, sub: flat ? 'root' : onnxSub }));
  }

  const dirName = repo.split('/').pop();
  const folder = path.join(modelsDir, dirName);
  await fsp.mkdir(folder, { recursive: true });

  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  let doneBytes = 0;
  for (const f of files) {
    const url = `${HF}/${repo}/resolve/main/${encodePath(f.repoPath)}?download=true`;
    const dest = path.join(folder, f.name);
    onProgress({
      phase: 'download', downloadId, repo, file: f.name, files: files.length,
      received: 0, fileTotal: f.size, doneBytes, totalBytes,
      percent: totalBytes ? (doneBytes / totalBytes) * 100 : null,
    });
    const res = await downloadFile(url, dest, (p) => {
      onProgress({
        phase: 'download', downloadId, repo, file: f.name, files: files.length,
        received: p.received, fileTotal: p.total, doneBytes: doneBytes + p.received, totalBytes,
        percent: totalBytes ? Math.min(100, ((doneBytes + p.received) / totalBytes) * 100) : p.percent,
      });
    });
    const got = res.alreadyComplete ? (f.size || 0) : res.bytes;
    if (f.size && got !== f.size) {
      throw new Error(i18n.t('error.onnxDownloadIncomplete', {
        file: f.name, got: (got / 1048576).toFixed(1), expected: (f.size / 1048576).toFixed(1),
      }));
    }
    // Gleiche Integritätspflicht wie bei GGUF: Gewichte per sha256, kleine
    // Config-Dateien per Git-Blob-SHA1 (blobId).
    await verifyDownload(dest, f, f.name);
    doneBytes += f.size || got || 0;
  }

  onProgress({ phase: 'done', downloadId, repo, file: dirName, files: files.length, percent: 100, doneBytes, totalBytes });

  return {
    repo,
    isOnnx: true,
    onnxSub: flat ? null : onnxSub,
    file: dirName,
    path: folder,
    dir: folder,
    bytes: doneBytes,
    total: totalBytes,
    files: files.length,
    sizeBytes: totalBytes,
    sizeLabel: `${(totalBytes / 1073741824).toFixed(2)} GB`,
  };
}

/* --------------------------- Lokale Modelle --------------------------- */

/**
 * Modelldateien, die einen GenAI-/Ryzen-AI-Ordner ausmachen. Ryzen-AI-Builds
 * (WGS) haben oft KEIN .onnx, sondern dd_metastate_*.fconst/.state.
 */
const ONNX_MODEL_FILE_RE = /\.(onnx(\.data)?|fconst|state)$/i;
const ONNX_MIN_MODEL_BYTES = 50 * 1024 * 1024; // config-only-Ordner aussortieren

/** Kennung fuer Modelle aus zusaetzlichen Ordnern: ext<Index>:<relDir>/<key> */
const EXTERNAL_ID_RE = /^ext(\d+):/;
function isExternalId(id) { return EXTERNAL_ID_RE.test(String(id || '')); }

/** Modelle in EINEM Verzeichnis: GGUF-Gruppen (inkl. Splits) oder ein ONNX-Ordner. */
async function modelsInDir(dirPath, relDir, { external, sourceIndex, sourceDir }) {
  const out = [];
  const dirName = path.basename(dirPath);
  let files = [];
  try { files = await fsp.readdir(dirPath); } catch { return out; }
  // mmproj/imatrix & Co. sind Hilfsdateien, keine eigenstaendigen Modelle
  const ggufs = files.filter((f) => f.toLowerCase().endsWith('.gguf') && !isAuxiliary(f)).sort();
  const visionProjector = findVisionProjector(dirPath, files);
  const repo = (relDir || dirName).replace(/__/g, '/');
  const mkId = (key) => (external
    ? `ext${sourceIndex}:${relDir ? relDir + '/' : ''}${key}`
    : `${dirName}/${key}`);
  const origin = external ? { external: true, sourceIndex, sourceDir } : { external: false };

  if (!ggufs.length) {
    // ONNX-/GenAI-Modellordner: genai_config.json UND eine echte grosse
    // Modelldatei (.onnx/.onnx.data/.fconst/.state ab 50 MB).
    if (!files.includes('genai_config.json')) return out;
    let size = 0;
    let biggest = 0;
    let modelFiles = 0;
    for (const f of files) {
      if (!ONNX_MODEL_FILE_RE.test(f)) continue;
      try {
        const st = await fsp.stat(path.join(dirPath, f));
        if (!st.isFile()) continue;
        size += st.size;
        modelFiles += 1;
        if (st.size > biggest) biggest = st.size;
      } catch { /* ignore */ }
    }
    if (!modelFiles || biggest < ONNX_MIN_MODEL_BYTES) return out;
    out.push({
      id: mkId('onnx'),
      repo,
      file: `ONNX-${dirName}`,
      isOnnx: true,
      vision: false,
      parts: [],
      path: dirPath,
      sizeBytes: size,
      sizeLabel: `${(size / 1073741824).toFixed(2)} GB`,
      quant: null,
      dir: dirPath,
      ...origin,
    });
    return out;
  }

  const groups = new Map();
  for (const f of ggufs) {
    const key = splitKey(f);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const [key, parts] of groups) {
    let size = 0;
    for (const pp of parts) { try { size += (await fsp.stat(path.join(dirPath, pp))).size; } catch { /* ignore */ } }
    out.push({
      id: mkId(key),
      repo,
      file: key,
      // Bilder kann nur ein Modell mit Vision-Projektor (mmproj) sehen.
      vision: !!visionProjector,
      parts: parts.map((pp) => path.join(dirPath, pp)),
      path: path.join(dirPath, parts[0]),
      sizeBytes: size,
      sizeLabel: `${(size / 1073741824).toFixed(2)} GB`,
      quant: quantFromName(key),
      dir: dirPath,
      ...origin,
    });
  }
  return out;
}

/**
 * Scannt einen Modell-Root. `maxDepth` = Ordnerebenen unter dem Root: der eigene
 * Modellordner hat eine (Repo-Ordner), fremde Ablagen oft zwei
 * (z. B. LM Studio: <publisher>/<model>/<datei>.gguf).
 */
async function scanModelRoot(root, { external = false, sourceIndex = -1, maxDepth = 1 } = {}) {
  const out = [];
  const walk = async (absDir, relDir, depth) => {
    out.push(...await modelsInDir(absDir, relDir, { external, sourceIndex, sourceDir: root }));
    if (depth >= maxDepth) return;
    let subs = [];
    try { subs = await fsp.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      await walk(path.join(absDir, s.name), relDir ? `${relDir}/${s.name}` : s.name, depth + 1);
    }
  };
  await walk(path.resolve(root), '', 0);
  return out;
}

/**
 * Alle lokal verfuegbaren Modelle: aus dem eigenen Modellordner und aus
 * zusaetzlichen Ordnern (`external: true`). Modelle aus fremden Ordnern werden
 * geladen und angezeigt, aber nicht geloescht — die Dateien gehoeren nicht dieser App.
 */
async function listLocal(modelsDir, extraDirs = []) {
  const out = await scanModelRoot(modelsDir, { external: false, maxDepth: 1 });
  const extras = Array.isArray(extraDirs) ? extraDirs : [];
  for (let i = 0; i < extras.length; i++) {
    if (!extras[i]) continue;
    out.push(...await scanModelRoot(extras[i], { external: true, sourceIndex: i, maxDepth: 2 }));
  }
  out.sort((a, b) => a.repo.localeCompare(b.repo) || String(a.file).localeCompare(String(b.file)));
  return out;
}

/**
 * Loescht ein lokales Modell. Bei GGUF-Modellen werden NUR die Dateien dieses
 * Modells (inkl. Split-Parts) entfernt — andere Quants im selben Repo-Ordner
 * bleiben erhalten. Der Ordner wird nur aufgeraeumt, wenn er danach leer ist;
 * bleibt kein Modell mehr uebrig, gehen verwaiste mmproj-Projektoren mit.
 * Ein ONNX-Modell ist ein Ordner als Ganzes und wird komplett entfernt.
 * Fehler werden propagiert: ein fehlgeschlagenes Loeschen darf nie als Erfolg
 * beim Aufrufer ankommen.
 */
async function deleteModel(modelsDir, modelId) {
  const id = String(modelId || '');
  // Modelle aus zusaetzlichen Ordnern gehoeren nicht dieser App -> nicht loeschen
  if (isExternalId(id)) throw new Error(i18n.t('error.externalModelDelete'));
  const idx = id.indexOf('/');
  const dirName = idx < 0 ? id : id.slice(0, idx);
  const key = idx < 0 ? '' : id.slice(idx + 1);
  if (!dirName || dirName === '.' || dirName === '..') throw new Error(i18n.t('error.invalidPath'));
  const dirPath = path.join(modelsDir, dirName);
  if (!isWithin(modelsDir, dirPath)) throw new Error(i18n.t('error.invalidPath'));
  // Nur "<ordner>/<datei>.gguf" oder "<ordner>/onnx": eine blosse Repo-ID wuerde
  // den ganzen Ordner mit allen Quants loeschen.
  if (!key) throw new Error(i18n.t('error.invalidPath'));

  let files = [];
  try { files = await fsp.readdir(dirPath); }
  catch (err) {
    if (err.code === 'ENOENT') return; // Ordner fehlt: nichts zu tun
    throw err; // EACCES/ENOTDIR dürfen nicht als Erfolg durchgehen
  }

  // Symlink-Schutz: der Ordner muss auch nach dem Aufloesen aller Symlinks
  // innerhalb des Modellordners liegen, sonst wuerden fremde Dateien geloescht.
  let inside = false;
  try { inside = await isWithinReal(modelsDir, dirPath); }
  catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (!inside) throw new Error(i18n.t('error.modelPathOutside'));

  if (key === 'onnx') {
    // Als Ganzes nur einen echten ONNX-Modellordner entfernen — nicht einen
    // Repo-Ordner, in dem auch GGUF-Modelle liegen.
    if (!files.includes('genai_config.json') || files.some(isModelGguf)) {
      throw new Error(i18n.t('error.invalidPath'));
    }
    await fsp.rm(dirPath, { recursive: true, force: true });
    return;
  }

  // Nur Dateinamen sind Modell-Schluessel; Pfadanteile oder Sammelpfade nicht.
  if (key.includes('/') || key.includes('\\') || key === '.' || key === '..') {
    throw new Error(i18n.t('error.invalidPath'));
  }
  const targets = files.filter((f) => splitKey(f) === key);
  // Unbekannte ID (z. B. ohne ".gguf"): melden statt still nichts zu tun.
  if (!targets.length) throw new Error(i18n.t('toast.modelMissing'));
  for (const f of targets) {
    await fsp.rm(path.join(dirPath, f), { force: true });
  }
  const rest = await fsp.readdir(dirPath);
  // Bleibt kein echtes Modell uebrig, sind die mmproj-Projektoren Waisen: sie
  // waeren in der UI unsichtbar und liessen sich dort nie mehr loeschen.
  if (!rest.some(isModelGguf)) {
    for (const f of rest) {
      if (isVisionProjector(f)) await fsp.rm(path.join(dirPath, f), { force: true });
    }
  }
  const left = await fsp.readdir(dirPath);
  if (!left.length) await fsp.rm(dirPath, { recursive: true, force: true });
}

module.exports = {
  CATALOG, QUANT_BITS, HF,
  searchModels, searchOnnxModels, modelFiles, catalogWithFit, pickBestQuant, evaluateFit, kvCacheGB,
  downloadModel, downloadOnnxModel, parseOnnxFiles, parseOnnxFolderFiles, onnxModelFiles,
  listLocal, deleteModel, quantFromName, quantBits, getJson, downloadFile,
  scanModelRoot, isExternalId, findVisionProjector, isVisionProjector,
};
