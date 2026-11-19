'use strict';
/**
 * gguf-meta.js — liest das native Kontextfenster aus einer GGUF-Datei.
 *
 * GGUF legt die Metadaten an den Dateianfang: Magic, Version, Tensor-Anzahl,
 * KV-Anzahl, dann Schlüssel/Wert-Paare. Gesucht ist `<arch>.context_length`
 * (z. B. `llama.context_length`). Der Parser läuft nur über den Anfang der Datei
 * und bricht ab, sobald der Wert gefunden ist — Tokenizer-Arrays (mehrere MB)
 * werden übersprungen, ohne sie zu materialisieren.
 *
 * Reine Funktionen + begrenzter Datei-Read, damit ohne echtes Modell testbar.
 */
const fs = require('fs');

const MAX_READ = 8 * 1024 * 1024;   // so viel vom Dateianfang lesen wir höchstens
const MAX_KEY_LEN = 4096;
const MAX_STRING_LEN = 64 * 1024 * 1024;

/** Typgrößen der GGUF-Werttypen (ohne STRING/ARRAY, die variabel sind). */
const FIXED_SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const T_STRING = 8;
const T_ARRAY = 9;

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  need(n) {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('gguf: unerwartetes Dateiende');
  }
  u8() { this.need(1); return this.buf.readUInt8(this.pos++); }
  u16() { this.need(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('gguf: Zahl zu groß');
    return Number(v);
  }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  str() {
    const len = this.u64();
    if (len > MAX_STRING_LEN) throw new Error('gguf: String zu lang');
    this.need(len);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

/** Wert überspringen (bzw. bei STRING/zahlennahen Typen zurückgeben). */
function readValue(r, type) {
  if (type === T_STRING) return r.str();
  if (type === T_ARRAY) {
    const elemType = r.u32();
    const count = r.u64();
    if (count > 10000000) throw new Error('gguf: Array zu groß');
    // Arrays interessieren hier nicht — Elemente einzeln überspringen.
    for (let i = 0; i < count; i++) readValue(r, elemType);
    return null;
  }
  const size = FIXED_SIZE[type];
  if (!size) throw new Error(`gguf: unbekannter Werttyp ${type}`);
  if (type === 4) return r.u32();
  if (type === 5) return r.i32();
  if (type === 6) return r.f32();
  if (type === 10) return r.u64();
  r.need(size);
  const start = r.pos;
  r.pos += size;
  if (type === 7) return r.buf.readUInt8(start) !== 0;
  if (type === 2) return r.buf.readUInt16LE(start);
  if (type === 3) return r.buf.readInt16LE(start);
  if (type === 11) return Number(r.buf.readBigInt64LE(start));
  if (type === 12) return r.buf.readDoubleLE(start);
  return r.buf.readUInt8(start);
}

/**
 * Parst den Metadaten-Block und liefert Architektur + Kontextfenster.
 * Wirft bei kaputter/abgeschnittener Struktur — der Aufrufer fängt das ab.
 */
function parseGgufMeta(buf) {
  const r = new Reader(buf);
  if (buf.length < 24) throw new Error('gguf: zu kurz');
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== 'GGUF') throw new Error('gguf: falsches Magic');
  r.pos = 4;
  const version = r.u32();
  if (version < 2 || version > 3) throw new Error(`gguf: Version ${version} nicht unterstützt`);
  r.u64();                       // tensor_count
  const kvCount = r.u64();
  if (kvCount > 100000) throw new Error('gguf: zu viele Metadaten-Einträge');

  let architecture = null;
  let contextLength = null;
  for (let i = 0; i < kvCount; i++) {
    const keyLen = r.u64();
    if (keyLen > MAX_KEY_LEN) throw new Error('gguf: Schlüssel zu lang');
    r.need(keyLen);
    const key = r.buf.toString('utf8', r.pos, r.pos + keyLen);
    r.pos += keyLen;
    const type = r.u32();
    const value = readValue(r, type);
    if (key === 'general.architecture' && typeof value === 'string') architecture = value;
    // `<arch>.context_length` — der Schlüssel endet immer auf .context_length
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      contextLength = value;
      break;                       // gefunden — Rest (Tokenizer) nicht mehr anfassen
    }
  }
  return { architecture, contextLength, version };
}

/**
 * Liest das native Kontextfenster einer GGUF-Datei. Gibt null zurück, wenn die
 * Datei keine GGUF ist, der Wert fehlt oder der Anfang nicht ausreicht.
 */
function readGgufContext(filePath, maxRead = MAX_READ) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxRead);
    if (len < 24) return null;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const meta = parseGgufMeta(buf);
    return meta.contextLength || null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

module.exports = { parseGgufMeta, readGgufContext, MAX_READ };
