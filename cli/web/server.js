'use strict';
/* Headless-Webmodus: liefert die vorhandene Oberfläche aus `ui/` im Browser aus
 * und stellt die IPC-Kanäle als HTTP-Bridge bereit (`ui/webapi.js` bildet dafür
 * `window.api` auf diese Endpunkte ab — dieselben Aufrufe wie in der Desktop-App).
 *
 * Nur Standardbibliothek: ein Node-Prozess, keine zusätzlichen Abhängigkeiten.
 * Sicherheit: bindet standardmäßig an 127.0.0.1. Für eine LAN-Bindung wird ein
 * Zugriffs-Token erzeugt, das jede Anfrage mitbringen muss (Modelle löschen oder
 * Server starten darf niemand aus dem Netz ohne Nachweis). */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const UI_DIR = path.join(__dirname, '..', '..', 'ui');
// Dieselben Kanäle, die electron/preload.js durchlässt (ALLOWED_EVENTS).
const EVENTS = [
  'download:progress', 'backend:progress', 'server:state', 'server:log',
  'update:available', 'update:progress',
];
const MAX_BODY = 32 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function lanAddresses() {
  const out = [];
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Anfrage zu groß'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function startWebServer(opts = {}) {
  const core = opts.core;
  const host = opts.host || '127.0.0.1';
  const wanted = Number(opts.port) || 8787;
  const version = opts.version || '';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const token = loopback ? null : crypto.randomBytes(18).toString('base64url');
  const startedAt = Date.now();
  const clients = new Set();

  function authorized(req, url) {
    if (!token) return true;
    const fromQuery = url.searchParams.get('token');
    const fromHeader = req.headers['x-mh-token'];
    return fromQuery === token || fromHeader === token;
  }

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.join(UI_DIR, rel);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(UI_DIR) + path.sep) && resolved !== path.join(path.resolve(UI_DIR), 'index.html')) {
      sendJson(res, 403, { ok: false, error: 'Pfad außerhalb der Oberfläche' });
      return;
    }
    let data;
    try {
      data = await fsp.readFile(resolved);
    } catch {
      sendJson(res, 404, { ok: false, error: 'Nicht gefunden' });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; "
        + "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'";
    }
    res.writeHead(200, headers);
    res.end(data);
  }

  function handleEvents(req, res, url) {
    if (!authorized(req, url)) { sendJson(res, 401, { ok: false, error: 'Token fehlt' }); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }

  function broadcast(event, payload) {
    if (!clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  const offs = EVENTS.map((event) => core.on(event, (payload) => broadcast(event, payload)));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        mode: 'headless',
        version,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        tokenRequired: !!token,
        channels: core.channels.length,
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/events') { handleEvents(req, res, url); return; }
    if (req.method === 'POST' && pathname === '/api/invoke') {
      if (!authorized(req, url)) { sendJson(res, 401, { ok: false, error: 'Token fehlt oder falsch' }); return; }
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) {
        sendJson(res, 400, { ok: false, error: `Ungültiges JSON: ${e.message}` });
        return;
      }
      const channel = String(body.channel || '');
      const args = Array.isArray(body.args) ? body.args : [];
      if (!core.channels.includes(channel)) {
        sendJson(res, 404, { ok: false, error: `Unbekannter Kanal: ${channel}` });
        return;
      }
      try {
        const result = await core.invoke(channel, ...args);
        sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e && e.message ? e.message : String(e) });
      }
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!authorized(req, url)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Zugriffs-Token fehlt (URL-Parameter ?token=…).');
        return;
      }
      await serveStatic(req, res, pathname);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'Methode nicht erlaubt' });
  });

  const port = await new Promise((resolve, reject) => {
    const tryListen = (candidate, attempt) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempt < 20) tryListen(candidate + 1, attempt + 1);
        else reject(e);
      });
      server.listen(candidate, host, () => resolve(server.address().port));
    };
    tryListen(wanted, 0);
  });

  const suffix = token ? `/?token=${token}` : '/';
  const url = `http://${host === '0.0.0.0' ? (loopback ? '127.0.0.1' : lanAddresses()[0] || '127.0.0.1') : host}:${port}${suffix}`;

  return {
    port,
    host,
    url,
    token,
    close: () => new Promise((resolve) => {
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
      for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
      clients.clear();
      server.close(() => resolve());
    }),
  };
}

module.exports = { startWebServer, lanAddresses, UI_DIR, EVENTS };
