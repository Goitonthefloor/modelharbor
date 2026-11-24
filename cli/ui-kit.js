'use strict';
/* Terminal-Bausteine der CLI: Farben, Tabellen, Zahlenmenü, Eingaben, Fortschritt.
 *
 * `createTerminal({ io })` nimmt eine austauschbare Eingabe/Ausgabe, damit die
 * Tests komplette Menüläufe ohne TTY durchspielen können (Antworten als Array
 * oder async-Funktion). Ohne TTY (Pipe/Rotstift) entfallen Farben und der
 * Fortschrittsbalken wird zu einer Zeile pro Phasenwechsel. */

const hardware = require('../electron/hardware');

const ESC = '\u001b[';

function makeColors(enabled) {
  const wrap = (code) => (s) => (enabled ? `${ESC}${code}m${s}${ESC}0m` : String(s));
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    accent: wrap('36'),
    ok: wrap('32'),
    warn: wrap('33'),
    err: wrap('31'),
    num: wrap('35'),
  };
}

/**
 * Sauberer Abbruch des Dialogs (Eingabe-Ende / Strg-D). main() behandelt das als
 * „Beendet." mit Exit-Code 0 — kein Stacktrace, keine Fehlermeldung.
 */
class MenuAbort extends Error {
  constructor() {
    super('Eingabe beendet');
    this.name = 'MenuAbort';
  }
}

function createTerminal(opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const errorOutput = opts.errorOutput || process.stderr;
  const isTTY = opts.isTTY !== undefined ? opts.isTTY : !!(output.isTTY && input.isTTY);
  const c = makeColors(isTTY && !process.env.NO_COLOR);
  const width = Math.max(60, Math.min(120, (output.columns || 100)));

  let queue = Array.isArray(opts.answers) ? opts.answers.slice() : null;
  let answerFn = typeof opts.answers === 'function' ? opts.answers : null;
  let rl = null;
  // Eingabe-Ende (Strg-D, Pipe zu Ende) ist ein normaler Abbruch, kein Fehler:
  // readline schliesst dann und wuerde bei question() 'readline was closed' werfen.
  let eof = false;

  function ensureRl() {
    if (rl || queue || answerFn) return rl;
    const readline = require('readline');
    rl = readline.createInterface({ input, output, terminal: isTTY });
    rl.on('close', () => { eof = true; });
    return rl;
  }

  /** Eine Zeile Text ausgeben. */
  function write(s = '') { output.write(`${s}\n`); }
  function writeErr(s = '') { errorOutput.write(`${s}\n`); }

  async function ask(question, { default: def = '', mask = false } = {}) {
    const suffix = def ? c.dim(` [${def}]`) : '';
    const prompt = `${c.accent('?')} ${question}${suffix} `;
    let answer;
    if (queue) {
      answer = queue.length ? String(queue.shift()) : '';
      write(`${prompt}${mask ? '****' : answer}`);
    } else if (answerFn) {
      answer = String((await answerFn(question)) ?? '');
      write(`${prompt}${mask ? '****' : answer}`);
    } else {
      const line = ensureRl();
      if (eof) throw new MenuAbort();
      answer = await new Promise((resolve) => {
        const onClose = () => resolve(null);
        line.once('close', onClose);
        line.question(prompt, (a) => { line.removeListener('close', onClose); resolve(a); });
      });
      if (answer === null) throw new MenuAbort();
    }
    const value = String(answer).trim();
    return value === '' ? def : value;
  }

  async function confirm(question, def = true) {
    const label = def ? '(J/n)' : '(j/N)';
    const answer = (await ask(`${question} ${label}`)).toLowerCase();
    if (!answer) return def;
    return answer === 'j' || answer === 'y' || answer === 'ja' || answer === 'yes';
  }

  /**
   * Zahlenmenü. Einträge: { label, hint?, disabled? }.
   * 0 ist immer „zurück/beenden", sofern `backLabel` gesetzt ist.
   * Rückgabe: gewählter Index (1..n), 0 für zurück, oder null bei Abbruch (Strg-D).
   */
  async function choose(title, items, { backLabel = 'Zurück', subtitle = '' } = {}) {
    if (title) write('');
    if (title) write(c.bold(title));
    if (subtitle) write(c.dim(subtitle));
    if (title || subtitle) write('');
    const labelWidth = Math.min(46, Math.max(...items.map((i) => i.label.length), 10) + 2);
    items.forEach((item, i) => {
      const num = c.num(String(i + 1).padStart(2));
      const label = item.disabled ? c.dim(item.label) : item.label;
      const pad = ' '.repeat(Math.max(1, labelWidth - item.label.length));
      const hint = item.hint ? c.dim(item.hint) : '';
      write(`  ${num}) ${label}${pad}${hint}`);
    });
    if (backLabel) write(`  ${c.num(' 0')}) ${c.dim(backLabel)}`);
    write('');
    for (;;) {
      const raw = await ask(`Auswahl [0-${items.length}]`, { default: '0' });
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) { writeErr(c.err('  Bitte eine Zahl eingeben.')); continue; }
      if (n === 0) return 0;
      if (n >= 1 && n <= items.length) {
        if (items[n - 1].disabled) { writeErr(c.err('  Nicht verfügbar.')); continue; }
        return n;
      }
      writeErr(c.err(`  Zahl zwischen 0 und ${items.length} eingeben.`));
    }
  }

  /** Einfache Tabelle mit ausgerichteten Spalten. */
  function table(headers, rows, { align = [] } = {}) {
    const cells = [headers, ...rows].map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v))));
    const widths = [];
    for (const row of cells) row.forEach((v, i) => { widths[i] = Math.max(widths[i] || 0, v.length); });
    const fmt = (row, isHead) => row
      .map((v, i) => {
        const a = align[i] || (isHead ? 'left' : 'left');
        const width = widths[i];
        if (a === 'right') return v.padStart(width);
        return v.padEnd(width);
      })
      .join('  ')
      .trimEnd();
    const lines = [c.bold(fmt(cells[0], true)), c.dim('─'.repeat(Math.min(width, fmt(cells[0], true).length)))];
    for (const row of cells.slice(1)) lines.push(fmt(row, false));
    return lines.join('\n');
  }

  /** Fortschrittsanzeige: eine Zeile, die sich selbst überschreibt (TTY) bzw. Phasenwechsel (Pipe). */
  function progress(label) {
    let lastPercent = -1;
    let lastPhase = '';
    const bar = (pct) => {
      const total = 28;
      const filled = Math.max(0, Math.min(total, Math.round((pct / 100) * total)));
      return `${'█'.repeat(filled)}${'░'.repeat(total - filled)}`;
    };
    return {
      update(p = {}) {
        const pct = Math.round(Number(p.percent) || 0);
        const phase = p.phase || '';
        const detail = p.file || p.backend || p.message || '';
        const speed = p.speed ? ` ${hardware.formatBytes(p.speed)}/s` : '';
        const line = `  ${c.accent(label)} ${bar(pct)} ${String(pct).padStart(3)}% ${c.dim(`${phase} ${detail}${speed}`.trim())}`;
        if (isTTY) {
          errorOutput.write(`\r${ESC}2K${line}`);
        } else if (phase !== lastPhase || pct - lastPercent >= 25 || pct === 100) {
          writeErr(line.replace(/\s+/g, ' '));
        }
        lastPercent = pct;
        lastPhase = phase;
      },
      done(message = '') {
        if (isTTY) errorOutput.write(`\r${ESC}2K`);
        if (message) write(`  ${c.ok('✓')} ${message}`);
      },
      fail(message = '') {
        if (isTTY) errorOutput.write(`\r${ESC}2K`);
        if (message) writeErr(`  ${c.err('✗')} ${message}`);
      },
    };
  }

  function hr(char = '─') { return c.dim(char.repeat(Math.min(width, 72))); }
  function close() { if (rl) { rl.close(); rl = null; } }

  return { write, writeErr, ask, confirm, choose, table, progress, hr, close, colors: c, isTTY, width, MenuAbort };
}

module.exports = { createTerminal, makeColors, MenuAbort };
