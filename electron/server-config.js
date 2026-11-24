'use strict';
/**
 * server-config.js — Zugangseinstellungen für den lokalen API-Server (LM-Studio-Stil).
 *
 * Ein Server, zwei Nutzer: der Chat in der App und Agenten im Netzwerk. Deshalb
 * gibt es genau einen llama-server-Prozess; diese Einstellungen bestimmen Port,
 * Bindung (nur lokal vs. LAN), API-Key, CORS und parallele Slots.
 *
 * Reine Logik (kein Electron), damit direkt testbar. Die Flags sind gegen
 * llama-server b12527/b12373 verifiziert: --host, --port, --cors-origins,
 * --parallel, --alias. Ein simples --cors existiert dort NICHT.
 *
 * Der API-Key steht NICHT in der Kommandozeile: /proc/<pid>/cmdline ist fuer
 * alle lokalen Benutzer lesbar. llama-server liest ihn aus LLAMA_API_KEY,
 * der app-eigene ONNX-Server aus MH_ONNX_API_KEY (jeweils nur Kind-Env).
 */
const os = require('os');
const crypto = require('crypto');
// Eine Quelle für die Agenten-Beispiele — wird auch vom Renderer benutzt.
const snippets = require('../ui/server-snippets');
const { MODEL_ALIAS, baseUrl, curlExample, pythonExample, agentJson } = snippets;

const DEFAULTS = { port: 1234, lan: false, apiKey: '', cors: true, parallel: 4, corsOrigins: '' };
const LIMITS = { port: [1024, 65535], parallel: [1, 64] };
// CORS-Origins: kommagetrennte Liste. Nur Zeichen, die in einer Origin
// vorkommen können (Schema/Host/Port/Wildcard) — keine Leerzeichen, keine
// Steuerzeichen, nichts, was die Kommandozeile zerlegt.
const CORS_ORIGINS_MAX = 512;
const CORS_ORIGIN_ENTRY = /^[A-Za-z0-9:/._*-]+$/;

function clampInt(value, [min, max]) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * Bringt eine CORS-Origins-Liste in die Form, die als Flag taugt:
 * kommagetrennt, ohne Leerzeichen, ohne leere Einträge, ohne Einträge mit
 * ungültigen Zeichen. Leerer String = „keine eigene Liste“.
 * Ohne diese Prüfung könnte ein Wert mit Leerzeichen oder Semikolon die
 * Kommandozeile zerlegen bzw. ungewollte Flags erzeugen.
 */
function normalizeCorsOrigins(value) {
  if (Array.isArray(value)) value = value.join(',');
  const raw = String(value === undefined || value === null ? '' : value);
  const list = [];
  let len = 0;
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;                       // leere Einträge fliegen raus
    if (!CORS_ORIGIN_ENTRY.test(entry)) continue; // ungültige Zeichen: Eintrag verwerfen
    const add = list.length ? entry.length + 1 : entry.length;
    if (len + add > CORS_ORIGINS_MAX) break;    // nie mitten in einer Origin kappen
    list.push(entry);
    len += add;
  }
  return list.join(',');
}

/**
 * Der Wert, der wirklich als --cors-origins gesetzt wird ('' = kein Flag).
 * Vorrang: eigene Liste > cors-Schalter (false = nur localhost) > kein Flag.
 * llama.cpps Default ohne Flag ist `*` und reflektiert jede Origin — deshalb
 * ist eine gesetzte Liste immer besser als gar keine.
 */
function effectiveCorsOrigins(cfg) {
  const own = normalizeCorsOrigins((cfg && cfg.corsOrigins) || '');
  if (own) return own;
  return cfg && cfg.cors === false ? 'localhost' : '';
}

/** Validiert einen Konfigurations-Patch; Unbekanntes/Leeres fliegt raus. */
function normalize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(LIMITS)) {
    if (patch[key] === undefined || patch[key] === null || patch[key] === '') continue;
    const v = clampInt(patch[key], LIMITS[key]);
    if (v !== null) out[key] = v;
  }
  for (const key of ['lan', 'cors']) {
    if (patch[key] === undefined || patch[key] === null) continue;
    out[key] = !!patch[key];
  }
  if (patch.corsOrigins !== undefined && patch.corsOrigins !== null) {
    out.corsOrigins = normalizeCorsOrigins(patch.corsOrigins);
  }
  if (patch.apiKey !== undefined && patch.apiKey !== null) {
    // Keine Leerzeichen/Umbrüche im Key — sonst zerlegt die Kommandozeile ihn.
    const k = String(patch.apiKey).trim().replace(/\s+/g, '');
    out.apiKey = k.slice(0, 256);
  }
  return out;
}

function resolve(stored) {
  return { ...DEFAULTS, ...normalize(stored) };
}

/**
 * Stellt sicher, dass ein API-Key existiert. Ohne Key ist der lokale Server für
 * jeden Prozess auf dem Rechner und jede Webseite offen, die eine Anfrage an
 * 127.0.0.1 schickt — deshalb wird einer erzeugt, wenn keiner gespeichert ist.
 * Der Aufrufer persistiert das Ergebnis, damit Agenten-Konfigurationen stabil
 * bleiben. Ein vorhandener Key wird NIE ersetzt.
 */
function ensureKey(stored) {
  const cfg = resolve(stored);
  return cfg.apiKey ? cfg : { ...cfg, apiKey: generateKey() };
}

function bindHost(cfg) { return cfg.lan ? '0.0.0.0' : '127.0.0.1'; }

/** IPv4-Adressen, unter denen die Maschine im LAN erreichbar ist. */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces() || {};
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/**
 * Alles, was ein Agent zum Verbinden braucht: Adressen, Modellname, Key,
 * Endpunkte und fertige Beispiele. `ips` wird injiziert (testbar).
 */
function connectionInfo(cfg, ips = []) {
  const local = baseUrl('127.0.0.1', cfg.port);
  const lan = (cfg.lan ? ips : []).map((ip) => baseUrl(ip, cfg.port));
  const key = cfg.apiKey || '';
  return {
    running: undefined,            // wird vom Aufrufer gesetzt
    localUrl: local,
    lanUrls: lan,
    ips: cfg.lan ? ips : [],
    lan: !!cfg.lan,
    port: cfg.port,
    host: bindHost(cfg),
    model: MODEL_ALIAS,
    apiKey: key,
    cors: cfg.cors !== false,
    parallel: cfg.parallel,
    endpoints: [
      { path: '/v1/chat/completions', method: 'POST', note: 'chat' },
      { path: '/v1/completions', method: 'POST', note: 'text' },
      { path: '/v1/models', method: 'GET', note: 'models' },
      { path: '/health', method: 'GET', note: 'health' },
    ],
  };
}

function authHeaderValue(cfg) { return cfg.apiKey ? `Bearer ${cfg.apiKey}` : ''; }

/** Neuer API-Key (zufällig, URL-sicher, mit erkennbarem Präfix). */
function generateKey() {
  return `mh-${crypto.randomBytes(24).toString('base64url')}`;
}

/**
 * Weicht der laufende Prozess von der gespeicherten Konfiguration ab, hilft nur
 * ein Neustart: Bindung, Port, Key, CORS und parallele Slots stehen in der
 * Kommandozeile bzw. in der Kind-Env und werden nicht nachgezogen.
 * `state` kommt aus server.getState(); fehlende Felder gelten als „unbekannt“
 * und lösen keine falsche Warnung aus.
 */
function restartRequired(cfg, state = {}) {
  const st = state || {};
  if (!st.running) return false;
  if (st.host && st.host !== bindHost(cfg)) return true;
  if (st.port && Number(st.port) !== Number(cfg.port)) return true;
  if (!!st.lan !== !!cfg.lan) return true;
  if (typeof st.apiKey === 'string' && st.apiKey !== String((cfg && cfg.apiKey) || '')) return true;
  if (typeof st.corsOrigins === 'string' && st.corsOrigins !== effectiveCorsOrigins(cfg)) return true;
  if (st.parallel !== undefined && st.parallel !== null && Number(st.parallel) !== Number(cfg.parallel)) return true;
  return false;
}

/**
 * Vollständige Server-Info fürs UI: Verbindungsdaten plus Laufzeitzustand.
 * Adressen (ips/lanUrls) folgen dem LAUFENDEN Prozess — sonst zeigt der
 * Server-Tab LAN-URLs an, die niemand erreichen kann, weil der Server lokal
 * gebunden ist (oder umgekehrt).
 */
function runtimeInfo(cfg, state = {}, ips = []) {
  const st = state || {};
  const running = !!st.running;
  const lan = running ? !!st.lan : !!cfg.lan;
  const port = st.port || cfg.port;
  const active = { ...cfg, lan, port };
  const info = connectionInfo(active, lan ? ips : []);
  return {
    ...info,
    running,
    starting: !!st.starting,
    // Im Betrieb zählt die tatsächlich gebundene Adresse/die echte Portnummer.
    activePort: port,
    activeHost: st.host || bindHost(cfg),
    activeLan: lan,
    model: st.model || null,
    error: st.error || null,
    restartRequired: restartRequired(cfg, st),
  };
}

module.exports = {
  DEFAULTS, LIMITS, MODEL_ALIAS, CORS_ORIGINS_MAX,
  normalize, normalizeCorsOrigins, effectiveCorsOrigins, resolve, ensureKey, bindHost,
  lanAddresses, baseUrl, connectionInfo, runtimeInfo, restartRequired,
  authHeaderValue, curlExample, pythonExample, agentJson, generateKey,
};
