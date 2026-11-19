'use strict';
/**
 * server-config.js — Zugangseinstellungen für den lokalen API-Server (LM-Studio-Stil).
 *
 * Ein Server, zwei Nutzer: der Chat in der App und Agenten im Netzwerk. Deshalb
 * gibt es genau einen llama-server-Prozess; diese Einstellungen bestimmen Port,
 * Bindung (nur lokal vs. LAN), API-Key, CORS und parallele Slots.
 *
 * Reine Logik (kein Electron), damit direkt testbar. Die Flags sind gegen
 * llama-server b12527 verifiziert: --host, --port, --api-key, --cors-origins,
 * --parallel, --alias. Ein simples --cors existiert dort NICHT.
 */
const os = require('os');
const crypto = require('crypto');
// Eine Quelle für die Agenten-Beispiele — wird auch vom Renderer benutzt.
const snippets = require('../ui/server-snippets');
const { MODEL_ALIAS, baseUrl, curlExample, pythonExample, agentJson } = snippets;

const DEFAULTS = { port: 1234, lan: false, apiKey: '', cors: true, parallel: 4 };
const LIMITS = { port: [1024, 65535], parallel: [1, 64] };

function clampInt(value, [min, max]) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
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

module.exports = {
  DEFAULTS, LIMITS, MODEL_ALIAS,
  normalize, resolve, ensureKey, bindHost, lanAddresses, baseUrl, connectionInfo,
  authHeaderValue, curlExample, pythonExample, agentJson, generateKey,
};
