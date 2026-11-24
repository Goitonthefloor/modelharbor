'use strict';
/* Einstellungen lesen/schreiben — dieselbe Datei und dasselbe Format wie die
 * Desktop-App (<userData>/settings.json), damit GUI und CLI sich teilen:
 * Modellordner, Zusatzordner, Backend-Wahl, Server-Konfiguration. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sc = require('../electron/server-config');

const FILE = 'settings.json';

/** Standardwerte wie in electron/main.js:defaultSettings(). */
function defaults(base) {
  return {
    modelsDir: path.join(base, 'models'),
    backendsDir: path.join(base, 'backends'),
    ctx: 8192,
    gpuLayers: 999,
    lastPreset: 'balanced',
    lastModelId: null,
    onboardingDone: false,
    language: 'de',
    debugLog: false,
    extraModelDirs: [],
    backendPreference: 'auto',
    server: { ...sc.DEFAULTS },
  };
}

function filePath(base) {
  return path.join(base, FILE);
}

/** Settings laden; fehlende Datei oder kaputtes JSON → Standardwerte. */
function load(base) {
  const def = defaults(base);
  let raw = null;
  try { raw = fs.readFileSync(filePath(base), 'utf8'); } catch { return def; }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return def; }
  const settings = { ...def, ...parsed };
  if (!Array.isArray(settings.extraModelDirs)) settings.extraModelDirs = [];
  // Server-Teil tief zusammenführen (Port/LAN/Key/Slots bleiben erhalten).
  settings.server = sc.ensureKey({ ...def.server, ...(parsed.server || {}) });
  return settings;
}

/**
 * Teil-Update speichern und das Ergebnis zurückgeben.
 * Verschachtelte Objekte werden gemerged, nicht ersetzt — derselbe Fallstrick wie
 * in der App (ein Teil-Patch für `server` darf Port/Key nicht wegwerfen).
 */
async function save(base, patch) {
  const prev = load(base);
  const next = { ...prev, ...(patch || {}) };
  if (!Array.isArray(next.extraModelDirs)) next.extraModelDirs = [];
  next.server = sc.ensureKey({ ...prev.server, ...((patch && patch.server) || {}) });
  const file = filePath(base);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Ordner anlegen, die die CLI erwartet (Modell-/Backend-Verzeichnis). */
async function ensureDirs(settings) {
  for (const dir of [settings.modelsDir, settings.backendsDir]) {
    try { await fsp.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
  }
  return settings;
}

module.exports = { FILE, defaults, filePath, load, save, ensureDirs };
