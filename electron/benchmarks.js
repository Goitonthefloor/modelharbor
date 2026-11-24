'use strict';
/* Benchmark-Ergebnisse: Ablage als JSON im Benutzerdatenverzeichnis.
 *
 * Bewusst eine eigene Datei statt settings.json — Messreihen wachsen und sollen
 * nicht die Einstellungen aufblähen. Gekappt auf MAX_ENTRIES (neueste zuerst). */

const fsp = require('fs/promises');
const path = require('path');

const MAX_ENTRIES = 50;
const FILE = 'benchmarks.json';

function filePath(dir) {
  return path.join(dir, FILE);
}

/** Alle Einträge, neueste zuerst. Kaputte Datei → leere Liste (kein Absturz). */
async function list(dir) {
  try {
    const raw = await fsp.readFile(filePath(dir), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function write(dir, entries) {
  const file = filePath(dir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2), 'utf8');
  return entries.slice(0, MAX_ENTRIES);
}

/**
 * Eintrag anhängen. Erwartet ein Messergebnis der Form
 * { at?, model, modelId?, backend?, engine?, genTps, prefillTps, ttftMs, results? }
 */
async function add(dir, entry) {
  const cur = await list(dir);
  const clean = {
    id: String(entry.id || `bench-${Date.now()}`),
    at: entry.at || new Date().toISOString(),
    model: String(entry.model || ''),
    modelId: entry.modelId ? String(entry.modelId) : '',
    backend: String(entry.backend || ''),
    engine: String(entry.engine || ''),
    genTps: Number(entry.genTps) || 0,
    prefillTps: Number(entry.prefillTps) || 0,
    ttftMs: Number(entry.ttftMs) || 0,
    results: Array.isArray(entry.results) ? entry.results : [],
  };
  return write(dir, [clean, ...cur]);
}

/** Alle Einträge löschen. */
async function clear(dir) {
  return write(dir, []);
}

/** Einen Eintrag löschen. */
async function remove(dir, id) {
  const cur = await list(dir);
  return write(dir, cur.filter((e) => e.id !== id));
}

module.exports = { MAX_ENTRIES, list, add, clear, remove, filePath };
