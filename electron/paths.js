'use strict';
/**
 * paths.js — Pfad-Guards für Werte, die aus dem Renderer kommen.
 *
 * Der Renderer ist nicht vertrauenswürdig (XSS, manipulierte API-Antworten).
 * Diese Helfer stellen sicher, dass Dateioperationen im vorgesehenen
 * Verzeichnis bleiben. Reine Funktionen, damit in Node testbar.
 */
const path = require('path');
const fsp = require('fs/promises');
const i18n = require('../ui/i18n');

/** Liegt `candidate` innerhalb von `root` (echter Präfix, nicht nur String)? */
function isWithin(root, candidate) {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Wie isWithin, loest aber vorher alle Symlinks auf (fs.realpath). Ein Symlink
 * im Modellordner, der nach draussen zeigt, gilt damit NICHT als "innerhalb".
 * Fehler (ENOENT/EACCES …) werden nicht verschluckt, sondern an den Aufrufer
 * gegeben — nur der weiss, ob "nicht vorhanden" ein normaler Zustand ist.
 */
async function isWithinReal(root, candidate) {
  const r = await fsp.realpath(path.resolve(String(root)));
  const c = await fsp.realpath(path.resolve(String(candidate)));
  return isWithin(r, c);
}

/**
 * Baut einen Kindpfad aus einem unvertrauenswürdigen NAMEN.
 * Verzeichnisteile werden verworfen (basename), '.'/'..'/leer abgelehnt.
 * @returns {string} absoluter Pfad innerhalb von root
 */
function childPath(root, name) {
  const base = path.basename(String(name == null ? '' : name).replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') {
    throw new Error(i18n.t('error.invalidPath'));
  }
  const target = path.resolve(root, base);
  if (!isWithin(root, target)) throw new Error(i18n.t('error.invalidPath'));
  return target;
}

/**
 * Prüft einen unvertrauenswürdigen PFAD (darunter verschachtelte Pfade) gegen root.
 * @returns {string} aufgelöster Pfad, wenn er innerhalb von root liegt
 */
function withinRoot(root, candidate) {
  if (candidate == null || String(candidate).trim() === '') {
    throw new Error(i18n.t('error.invalidPath'));
  }
  const target = path.resolve(String(candidate));
  if (!isWithin(root, target)) throw new Error(i18n.t('error.invalidPath'));
  return target;
}

/** Liegt `candidate` in IRGENDEINEM der Roots (echter Präfix, nicht nur String)? */
function withinAnyRoot(roots, candidate) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  for (const r of list) {
    try { return withinRoot(r, candidate); } catch { /* nächster Root */ }
  }
  throw new Error(i18n.t('error.invalidPath'));
}

module.exports = { isWithin, isWithinReal, childPath, withinRoot, withinAnyRoot };
