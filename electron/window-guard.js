'use strict';
/**
 * window-guard.js — die einzige vertrauenswürdige Quelle für Fenster und IPC.
 *
 * Electron führt das Preload-Skript bei JEDER Navigation der WebContents erneut
 * aus. Ohne Guard bekäme ein fremdes Dokument (Datei-Drop, Link, Renderer-
 * Schwachstelle) die komplette window.api-Brücke: settings.set, models.delete,
 * backends.remove, Serverstart. Deshalb zwei Grenzen:
 *  - Navigation nur auf die eigene App-Datei (will-navigate/will-frame-navigate)
 *  - IPC nur aus genau dieser Datei (Absenderprüfung in jedem Handler)
 *
 * Reine Funktion ohne Electron-Import, damit in Node testbar.
 */
const path = require('path');
const { fileURLToPath } = require('url');

/**
 * Ist `url` die eigene App-Datei? Vergleicht aufgelöste Dateipfade, nicht
 * String-Präfixe — kodierte Pfade (Leerzeichen, Umlaute) und '..' werden damit
 * korrekt behandelt, und eine Fremd-URL mit gleichem Präfix fällt durch.
 * @param {string} url z. B. event.senderFrame.url oder das Navigationsziel
 * @param {string} appFile absoluter Pfad der ui/index.html
 */
function isAppUrl(url, appFile) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  try {
    return path.resolve(fileURLToPath(url)) === path.resolve(appFile);
  } catch {
    return false;
  }
}

module.exports = { isAppUrl };
