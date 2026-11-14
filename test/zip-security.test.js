'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { extractZipSafe } = require('../electron/backends.js');

/* --- Minimaler ZIP-Builder (Store-Methode, kein Kompressor) --- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Baut ein ZIP-Archiv mit Store-Methode.
 * @param {Array<{name: string, data?: Buffer, unixMode?: number}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data || Buffer.alloc(0);
    const crc = crc32(data);
    const mode = (e.unixMode || 0o100644) << 16;

    // Local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);          // Version needed
    lfh.writeUInt16LE(0, 6);           // Flags
    lfh.writeUInt16LE(0, 8);           // Method: store
    lfh.writeUInt16LE(0, 10);          // MTime
    lfh.writeUInt16LE(0, 12);          // MDate
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);          // Extra
    chunks.push(lfh, nameBuf, data);

    // Central directory entry
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4);       // Version made by (UNIX)
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(mode >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, eocd]);
}

async function withTempZip(entries, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-zip-'));
  try {
    const zipPath = path.join(dir, 'test.zip');
    await fsp.writeFile(zipPath, buildZip(entries));
    return await fn(dir, zipPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* --- Tests --- */

test('extractZipSafe entpackt normale Dateien und Verzeichnisse', async () => {
  await withTempZip([
    { name: 'bin/llama-server', data: Buffer.from('#!/bin/sh\n', 'utf8'), unixMode: 0o100755 },
    { name: 'lib/libfoo.so', data: Buffer.from('ELF', 'utf8') },
    { name: 'docs/readme.txt', data: Buffer.from('ok', 'utf8') },
  ], async (dir, zipPath) => {
    const out = path.join(dir, 'out');
    const result = await extractZipSafe(zipPath, out);
    assert.equal(result, out);
    assert.equal(await fsp.readFile(path.join(out, 'bin/llama-server'), 'utf8'), '#!/bin/sh\n');
    assert.equal(await fsp.readFile(path.join(out, 'lib/libfoo.so'), 'utf8'), 'ELF');
    assert.equal(await fsp.readFile(path.join(out, 'docs/readme.txt'), 'utf8'), 'ok');
  });
});

test('extractZipSafe lehnt Pfad-Traversal (../) ab', async () => {
  await withTempZip([
    { name: 'ok.txt', data: Buffer.from('safe', 'utf8') },
    { name: '../evil.txt', data: Buffer.from('pwn', 'utf8') },
  ], async (dir, zipPath) => {
    const out = path.join(dir, 'out');
    // yauzl lehnt '../' bereits in validateFileName ab; jede Ablehnung zählt.
    await assert.rejects(extractZipSafe(zipPath, out));
    // Nichts außerhalb darf entstanden sein, und kein evil.txt im Parent
    await assert.rejects(fsp.stat(path.join(dir, 'evil.txt')), { code: 'ENOENT' });
  });
});

test('extractZipSafe lehnt absolute Pfade ab', async () => {
  await withTempZip([
    { name: '/tmp/evil-abs.txt', data: Buffer.from('pwn', 'utf8') },
  ], async (dir, zipPath) => {
    await assert.rejects(extractZipSafe(zipPath, path.join(dir, 'out')));
  });
});

test('extractZipSafe lehnt Symlink-Einträge ab', async () => {
  await withTempZip([
    { name: 'link', data: Buffer.from('/etc/passwd', 'utf8'), unixMode: 0o120777 },
  ], async (dir, zipPath) => {
    await assert.rejects(extractZipSafe(zipPath, path.join(dir, 'out')), /Symlink/);
  });
});

test('extractZipSafe lehnt doppelte Slashes mit Aufstieg nicht stillschweigend ab (normalisiert)', async () => {
  await withTempZip([
    { name: 'a//../../evil.txt', data: Buffer.from('pwn', 'utf8') },
  ], async (dir, zipPath) => {
    // yauzl validiert relative Pfade selbst (invalid relative path) —
    // jede Ablehnung ist ok, solange nichts extrahiert wird.
    await assert.rejects(extractZipSafe(zipPath, path.join(dir, 'out')));
    await assert.rejects(fsp.stat(path.join(dir, 'evil.txt')), { code: 'ENOENT' });
  });
});
