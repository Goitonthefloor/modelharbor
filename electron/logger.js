'use strict';
/**
 * logger.js — optionales erweitertes Debug-Logging.
 *
 * Standardmäßig inaktiv (no-op). Erst wenn in den Einstellungen "Erweitertes
 * Log (Debug)" aktiviert ist (settings.debugLog), werden .debug()- und
 * .error()-Meldungen zusätzlich auf die Konsole und in eine rotierende
 * Logdatei geschrieben:
 *
 *   <userData>/logs/modelharbor-debug.log   (bei >150 KB -> .old)
 *
 * WICHTIG: Es werden niemals Secrets/Tokens/API-Keys geloggt.
 */
const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 150 * 1024;

class Logger {
  constructor() {
    this.debugEnabled = false;
    this.logPath = null;
    this._written = 0;
    this._console = typeof console !== 'undefined' ? console : null;
  }

  /** Aktiviert/konfiguriert das Logging. Nicht idempotent-gefährlich, restart-fest. */
  configure({ debug = false, dir = null } = {}) {
    this.debugEnabled = !!debug;
    this.logPath = dir ? path.join(dir, 'logs', 'modelharbor-debug.log') : null;
    this._written = this._size();
    if (this.logPath) this._rotate();
    return this;
  }

  _size() {
    try { return fs.statSync(this.logPath).size; } catch { return 0; }
  }

  _rotate() {
    try {
      if (fs.existsSync(this.logPath) && fs.statSync(this.logPath).size > MAX_LOG_BYTES) {
        fs.renameSync(this.logPath, `${this.logPath}.old`);
        this._written = 0;
      }
    } catch { /* ignore */ }
  }

  _write(level, msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${level.toUpperCase()} ${msg}\n`;
    // Konsole nur im Debug-Modus und nur für relevante Stufen.
    if (this.debugEnabled && this._console && (level === 'debug' || level === 'error')) {
      try { this._console.log(`[${ts} ${level}] ${msg}`); } catch { /* ignore */ }
    }
    if (this.debugEnabled && this.logPath) {
      try {
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        fs.appendFileSync(this.logPath, line);
        // Auch während der Laufzeit rotieren, nicht nur beim App-Start —
        // sonst wächst die Datei in einer langen Sitzung unbegrenzt.
        this._written += Buffer.byteLength(line);
        if (this._written > MAX_LOG_BYTES) this._rotate();
      } catch { /* ignore */ }
    }
  }

  debug(msg) { if (this.debugEnabled) this._write('debug', msg); }
  info(msg)  { if (this.debugEnabled) this._write('info', msg); }
  warn(msg)  { if (this.debugEnabled) this._write('warn', msg); }
  error(msg, err) {
    if (!this.debugEnabled) return;
    const tail = err ? ` :: ${err && err.stack ? err.stack : (err && err.message ? err.message : err)}` : '';
    this._write('error', msg + tail);
    if (this._console && err) { try { this._console.error(msg, err); } catch { /* ignore */ } }
  }
}

module.exports = new Logger();
