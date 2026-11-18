'use strict';
/**
 * model-settings.js — modellspezifische Lade-/Laufzeiteinstellungen (LM-Studio-Stil).
 *
 * Kernstück: getrennte Quantisierung für K- und V-Cache. llama.cpp erlaubt dafür
 * --cache-type-k / --cache-type-v; ein quantisierter V-Cache braucht Flash-Attention.
 *
 * Gespeichert werden nur ABWEICHUNGEN vom Standard („Overrides“): fehlt ein Wert,
 * gilt der globale Wert aus den Einstellungen bzw. der llama.cpp-Standard.
 * Reine Logik + Datei-Persistenz, kein Electron — damit direkt testbar.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
// Eine Quelle für Cache-Typen/Bytes — wird auch vom Renderer benutzt (ui/kvcache.js).
const { CACHE_TYPES, CACHE_BYTES, DEFAULT_CACHE, isQuantized, kvFactor } = require('../ui/kvcache');

/** Wertebereiche: [min, max]. Alles außerhalb wird geklemmt, nicht verworfen. */
const LIMITS = {
  ctx: [512, 1048576],
  gpuLayers: [0, 999],
  batchSize: [32, 8192],
  ubatchSize: [16, 8192],
  threads: [1, 256],
  ropeFreqBase: [0, 10000000],
  ropeFreqScale: [0, 128],
};
const BOOL_KEYS = ['flashAttn', 'mlock', 'noMmap'];
const NUM_KEYS = Object.keys(LIMITS);
/** Diese Werte dürfen Nachkommastellen haben (RoPE-Skalierung ist oft 0.5/0.25). */
const FLOAT_KEYS = ['ropeFreqBase', 'ropeFreqScale'];
const CACHE_KEYS = ['cacheTypeK', 'cacheTypeV'];
const ALL_KEYS = [...NUM_KEYS, ...BOOL_KEYS, ...CACHE_KEYS];

/**
 * Stabiler Schlüssel je Modell: die Modell-ID ohne Zusatzordner-Präfix.
 * So bleiben die Einstellungen erhalten, wenn sich die Reihenfolge der
 * Zusatzordner ändert — sie hängen am Modell, nicht am Ordner-Index.
 */
function modelKey(model) {
  const raw = typeof model === 'string' ? model : (model && (model.id || `${model.repo || ''}/${model.file || ''}`));
  return String(raw || '').replace(/^ext\d+:/, '');
}

function clampInt(value, [min, max], round = true) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const c = Math.min(max, Math.max(min, n));
  return round ? Math.round(c) : c;
}

/**
 * Validiert einen Override-Satz. Unbekannte Schlüssel fliegen raus, Zahlen werden
 * geklemmt, Cache-Typen gegen die Whitelist geprüft, leere Werte entfernt.
 * `ubatchSize` darf nicht größer als `batchSize` sein.
 */
function normalize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of NUM_KEYS) {
    if (patch[key] === undefined || patch[key] === null || patch[key] === '') continue;
    const v = clampInt(patch[key], LIMITS[key], !FLOAT_KEYS.includes(key));
    if (v !== null) out[key] = v;
  }
  for (const key of BOOL_KEYS) {
    if (patch[key] === undefined || patch[key] === null) continue;
    out[key] = !!patch[key];
  }
  for (const key of CACHE_KEYS) {
    const v = patch[key];
    if (v === undefined || v === null || v === '') continue;
    if (CACHE_TYPES.includes(String(v))) out[key] = String(v);
  }
  if (out.batchSize !== undefined && out.ubatchSize !== undefined && out.ubatchSize > out.batchSize) {
    out.ubatchSize = out.batchSize;
  }
  return out;
}

/**
 * Effektive Werte: global (Einstellungen) < modellspezifisch < expliziter Aufruf.
 * `flashAttn: null` bedeutet „auto“ (llama.cpp entscheidet).
 * Regel: quantisierter V-Cache erzwingt Flash-Attention, sonst startet llama-server nicht.
 */
function resolve({ global = {}, model = {}, call = {} } = {}) {
  const m = normalize(model);
  const c = normalize(call);
  const pick = (key, fallback) => (c[key] !== undefined ? c[key] : (m[key] !== undefined ? m[key] : fallback));

  const cacheTypeK = pick('cacheTypeK', DEFAULT_CACHE);
  const cacheTypeV = pick('cacheTypeV', DEFAULT_CACHE);
  let flashAttn = pick('flashAttn', null);
  const notes = [];
  if (isQuantized(cacheTypeV) && flashAttn !== true) {
    flashAttn = true;
    notes.push('vCacheNeedsFlashAttn');
  }
  const batchSize = pick('batchSize', null);
  let ubatchSize = pick('ubatchSize', null);
  if (batchSize !== null && ubatchSize !== null && ubatchSize > batchSize) ubatchSize = batchSize;

  return {
    ctx: pick('ctx', global.ctx || 8192),
    gpuLayers: pick('gpuLayers', global.gpuLayers !== undefined ? global.gpuLayers : 999),
    threads: pick('threads', global.threads || null),
    flashAttn,
    cacheTypeK,
    cacheTypeV,
    batchSize,
    ubatchSize,
    mlock: pick('mlock', false),
    noMmap: pick('noMmap', false),
    ropeFreqBase: pick('ropeFreqBase', null),
    ropeFreqScale: pick('ropeFreqScale', null),
    notes,
    customized: Object.keys(m).length > 0,
  };
}

/** llama.cpp-Flags für die effektiven Werte (nur gesetzte Optionen). */
function llamaArgs(r) {
  const args = [];
  if (r.flashAttn === true) args.push('--flash-attn', 'on');
  else if (r.flashAttn === false) args.push('--flash-attn', 'off');
  else args.push('--flash-attn', 'auto');
  args.push('--cache-type-k', r.cacheTypeK || DEFAULT_CACHE);
  args.push('--cache-type-v', r.cacheTypeV || DEFAULT_CACHE);
  if (r.batchSize !== null && r.batchSize !== undefined) args.push('--batch-size', String(r.batchSize));
  if (r.ubatchSize !== null && r.ubatchSize !== undefined) args.push('--ubatch-size', String(r.ubatchSize));
  if (r.mlock) args.push('--mlock');
  if (r.noMmap) args.push('--no-mmap');
  if (r.ropeFreqBase !== null && r.ropeFreqBase !== undefined) args.push('--rope-freq-base', String(r.ropeFreqBase));
  if (r.ropeFreqScale !== null && r.ropeFreqScale !== undefined) args.push('--rope-freq-scale', String(r.ropeFreqScale));
  return args;
}

/** Kurzfassung fürs UI/Badge, z. B. „K q4_0 · V q8_0 · FA“. */
function summary(r) {
  const bits = [];
  if (r.cacheTypeK !== DEFAULT_CACHE) bits.push(`K ${r.cacheTypeK}`);
  if (r.cacheTypeV !== DEFAULT_CACHE) bits.push(`V ${r.cacheTypeV}`);
  if (r.flashAttn === true) bits.push('FA');
  if (r.flashAttn === false) bits.push('FA off');
  if (r.ctx) bits.push(`ctx ${r.ctx}`);
  if (r.gpuLayers !== null && r.gpuLayers !== undefined && r.gpuLayers !== 999) bits.push(`ngl ${r.gpuLayers}`);
  return bits.join(' · ');
}

/* --------------------------- Persistenz --------------------------- */

async function readStore(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      const clean = normalize(value);
      if (Object.keys(clean).length) out[String(key)] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeStore(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  CACHE_TYPES, CACHE_BYTES, DEFAULT_CACHE, LIMITS, ALL_KEYS,
  isQuantized, modelKey, normalize, resolve, kvFactor, llamaArgs, summary,
  readStore, writeStore,
};
