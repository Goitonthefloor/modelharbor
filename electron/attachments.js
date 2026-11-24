'use strict';
/**
 * attachments.js — Anhänge für den Chat einlesen.
 *
 * Zwei Sorten: Text (Charts, Code, CSV, PDF, DOCX) wird zu reinem Text, den der
 * Prompt mitbekommt; Bilder werden als dataURL durchgereicht und gehen als
 * image_url an den Server. Ob ein Modell Bilder sehen kann, entscheidet der
 * Vision-Projektor (mmproj) — das prüft server.js, nicht dieses Modul.
 *
 * PDF-Text via pdfjs-dist (legacy build, ohne Worker). Die früher genutzte
 * pdf-parse-Bündelung (pdf.js 1.10) scheitert an jedem modernen PDF
 * ("bad XRef entry" / "Unknown compression method"), deshalb bewusst pdfjs-dist.
 */
const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_CHARS = 120000;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.log', '.ini', '.cfg', '.conf', '.toml', '.env', '.srt', '.vtt',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.gd', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.java', '.rs', '.go', '.rb', '.php', '.sh', '.bash', '.ps1', '.sql', '.css',
  '.scss', '.lua', '.swift', '.kt', '.patch', '.diff', '.tex',
]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** Art des Anhangs anhand der Endung: 'image' | 'text' | 'pdf' | 'docx' | null. */
function kindOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}

/** Endungen, die der Datei-Dialog anbietet (für den Renderer/Fehlermeldungen). */
function supportedExtensions() {
  return [...TEXT_EXT, ...IMAGE_EXT, '.pdf', '.docx'].sort();
}

/** Sieht der Puffer nach Binärdaten aus? NUL-Byte oder viele Steuerzeichen. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // Erlaubt: Tab, LF, CR, ESC-Anführung (kein) — alles andere unter 0x09 zählt.
    if (b < 0x09 && b !== 0x00) ctrl++;
    else if (b > 0x0e && b < 0x20) ctrl++;
  }
  return n > 0 && ctrl / n > 0.1;
}

/** Text mit BOM-Erkennung dekodieren (UTF-8, UTF-16LE/BE). */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  return buf.toString('utf8');
}

/** Text hart auf `limit` Zeichen kürzen und melden, wie viel wegfiel. */
function truncateText(text, limit = MAX_TEXT_CHARS) {
  const total = text.length;
  if (total <= limit) return { text, truncated: false, total, dropped: 0 };
  const cut = text.slice(0, limit);
  return { text: cut, truncated: true, total, dropped: total - limit };
}

/** Rohes XML eines Office-Dokuments zu Text (Absätze, Tabs, Entities). */
function officeXmlToText(xml) {
  return String(xml)
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<w:cr[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Eintrag `name` aus einem ZIP-Puffer als UTF-8-String lesen (yauzl). */
function readZipEntry(buf, name) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) { reject(err); return; }
      let done = false;
      const finish = (e, val) => {
        if (done) return;
        done = true;
        try { zip.close(); } catch { /* ignore */ }
        if (e) reject(e); else resolve(val);
      };
      zip.on('error', (e) => finish(e));
      zip.on('entry', (entry) => {
        if (entry.fileName !== name) { zip.readEntry(); return; }
        if (entry.uncompressedSize > 64 * 1024 * 1024) { finish(new Error('Eintrag zu groß')); return; }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) { finish(e2); return; }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', (e3) => finish(e3));
          stream.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
        });
      });
      zip.on('end', () => finish(new Error(`Eintrag ${name} fehlt`)));
      zip.readEntry();
    });
  });
}

/** Textlayer eines PDFs (alle Seiten, mit Seitenmarken). */
async function extractPdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
  }).promise;
  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const line = content.items.map((it) => (it.str !== undefined ? it.str : '')).join(' ');
      pages.push(doc.numPages > 1 ? `--- Seite ${p} ---\n${line.replace(/[ \t]+/g, ' ').trim()}` : line.trim());
      page.cleanup();
    }
    return { text: pages.join('\n\n'), pages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}

/**
 * Datei lesen und in einen Anhang verwandeln.
 * Ergebnis: { name, ext, kind, bytes, text, chars, truncated, dropped } für Text,
 *           { name, ext, kind, bytes, dataUrl, mime } für Bilder.
 */
async function readAttachment(filePath, opts = {}) {
  const kind = kindOf(filePath);
  if (!kind) throw new Error(`Nicht unterstützt: ${path.extname(filePath) || 'ohne Endung'}`);
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error('Kein reguläre Datei');
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (st.size > limit) throw new Error(`Datei zu groß (${Math.round(st.size / 1024 / 1024)} MB, max ${Math.round(limit / 1024 / 1024)} MB)`);

  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fsp.readFile(filePath);
  // pdfjs überträgt den Puffer an seinen Worker und detacht ihn dabei —
  // buf.length ist danach 0. Größe deshalb vorher festhalten.
  const fileBytes = buf.length;

  if (kind === 'image') {
    return {
      name, ext, kind, bytes: fileBytes,
      mime: MIME[ext] || 'image/png',
      dataUrl: `data:${MIME[ext] || 'image/png'};base64,${buf.toString('base64')}`,
    };
  }

  let raw;
  if (kind === 'text') {
    if (looksBinary(buf)) throw new Error('Datei ist binär, kein Text');
    raw = decodeText(buf);
  } else if (kind === 'pdf') {
    raw = (await extractPdfText(buf)).text;
    if (!raw.trim()) throw new Error('PDF ohne Textlayer (Scan)');
  } else {
    raw = officeXmlToText(await readZipEntry(buf, 'word/document.xml'));
  }
  const t = truncateText(raw, opts.maxChars || MAX_TEXT_CHARS);
  return {
    name, ext, kind, bytes: fileBytes,
    text: t.text, chars: t.text.length, totalChars: t.total, truncated: t.truncated, dropped: t.dropped,
  };
}

/** Datei-Dialog-Filter für Electron (showOpenDialog). */
/**
 * Datei-Dialog-Filter. mode 'images' zeigt nur Bilder (für Modelle ohne
 * Vision-Projektor ist der Bild-Anhang gesperrt), sonst Dokumente + Bilder.
 */
function dialogFilters(mode) {
  const docs = { name: 'Dokumente & Text', extensions: [...TEXT_EXT, '.pdf', '.docx'].map((e) => e.slice(1)) };
  const imgs = { name: 'Bilder', extensions: [...IMAGE_EXT].map((e) => e.slice(1)) };
  return mode === 'images' ? [imgs] : [docs, imgs];
}

module.exports = {
  MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_CHARS,
  kindOf, supportedExtensions, looksBinary, decodeText, truncateText,
  officeXmlToText, readZipEntry, extractPdfText, readAttachment, dialogFilters,
};
