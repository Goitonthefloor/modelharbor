'use strict';
/**
 * Feature-Tests: modellspezifische Einstellungen inkl. K/V-Cache-Quantisierung.
 * Deckt Schema/Validierung, Vorrangregeln, llama.cpp-Flags, Speicherabschätzung
 * und Persistenz ab — plus die Verdrahtung in server.buildArgs/models.evaluateFit.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ms = require('../electron/model-settings.js');
const kv = require('../ui/kvcache.js');
const { buildArgs } = require('../electron/server.js');
const models = require('../electron/models.js');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-ms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'model-settings.json');
}

/* --------------------------- Validierung --------------------------- */

test('normalize: Zahlen werden geklemmt, Unbekanntes verworfen', () => {
  const out = ms.normalize({ ctx: 99999999, gpuLayers: -5, threads: 0, bogus: 'x', sampling: { temp: 1 } });
  assert.equal(out.ctx, ms.LIMITS.ctx[1]);
  assert.equal(out.gpuLayers, 0);
  assert.equal(out.threads, 1);
  assert.equal(out.bogus, undefined);
  assert.equal(out.sampling, undefined);
});

test('normalize: leere Werte erzeugen keine Overrides', () => {
  assert.deepEqual(ms.normalize({ ctx: '', gpuLayers: null, cacheTypeK: undefined }), {});
  assert.deepEqual(ms.normalize(null), {});
  assert.deepEqual(ms.normalize('quatsch'), {});
});

test('normalize: Cache-Typen nur aus der llama.cpp-Whitelist', () => {
  assert.equal(ms.normalize({ cacheTypeK: 'q4_0' }).cacheTypeK, 'q4_0');
  assert.equal(ms.normalize({ cacheTypeV: 'iq4_nl' }).cacheTypeV, 'iq4_nl');
  assert.equal(ms.normalize({ cacheTypeK: 'q2_k' }).cacheTypeK, undefined);
  assert.equal(ms.normalize({ cacheTypeV: '../../etc' }).cacheTypeV, undefined);
  for (const c of ms.CACHE_TYPES) assert.equal(ms.normalize({ cacheTypeK: c }).cacheTypeK, c);
});

test('normalize: Micro-Batch darf nicht größer als Batch sein', () => {
  assert.equal(ms.normalize({ batchSize: 512, ubatchSize: 2048 }).ubatchSize, 512);
  assert.equal(ms.normalize({ batchSize: 512, ubatchSize: 128 }).ubatchSize, 128);
});

test('normalize: RoPE-Skalierung behält Nachkommastellen', () => {
  assert.equal(ms.normalize({ ropeFreqScale: 0.5 }).ropeFreqScale, 0.5);
  assert.equal(ms.normalize({ ropeFreqScale: 0.25 }).ropeFreqScale, 0.25);
  assert.equal(ms.normalize({ ropeFreqBase: 1000000 }).ropeFreqBase, 1000000);
});

/* --------------------------- Vorrangregeln --------------------------- */

test('resolve: global < modellspezifisch < Aufruf', () => {
  const r = ms.resolve({
    global: { ctx: 8192, gpuLayers: 999 },
    model: { ctx: 16384, cacheTypeK: 'q8_0' },
    call: { ctx: 32768 },
  });
  assert.equal(r.ctx, 32768);
  assert.equal(r.gpuLayers, 999);
  assert.equal(r.cacheTypeK, 'q8_0');
  assert.equal(r.cacheTypeV, 'f16');
});

test('resolve: ohne Overrides gelten die globalen Werte', () => {
  const r = ms.resolve({ global: { ctx: 4096, gpuLayers: 20 }, model: {} });
  assert.equal(r.ctx, 4096);
  assert.equal(r.gpuLayers, 20);
  assert.equal(r.flashAttn, null);
  assert.equal(r.customized, false);
});

test('resolve: quantisierter V-Cache erzwingt Flash-Attention', () => {
  const r = ms.resolve({ model: { cacheTypeV: 'q4_0', flashAttn: false } });
  assert.equal(r.flashAttn, true);
  assert.ok(r.notes.includes('vCacheNeedsFlashAttn'));
});

test('resolve: quantisierter K-Cache geht auch ohne Flash-Attention', () => {
  const r = ms.resolve({ model: { cacheTypeK: 'q8_0', flashAttn: false } });
  assert.equal(r.flashAttn, false);
  assert.deepEqual(r.notes, []);
});

test('resolve: explizites Flash-Attention bleibt erhalten, wenn V unquantisiert', () => {
  assert.equal(ms.resolve({ model: { flashAttn: true } }).flashAttn, true);
  assert.equal(ms.resolve({ model: { flashAttn: false } }).flashAttn, false);
  assert.equal(ms.resolve({}).flashAttn, null);
});

/* --------------------------- Speicherfaktor --------------------------- */

test('kvFactor: f16 = 1, q4_0/q4_0 ≈ 0.28, f32/f32 = 2', () => {
  assert.equal(kv.kvFactor('f16', 'f16'), 1);
  assert.equal(kv.kvFactor(), 1);
  assert.ok(Math.abs(kv.kvFactor('q4_0', 'q4_0') - 0.28125) < 1e-9);
  assert.equal(kv.kvFactor('f32', 'f32'), 2);
  // K und V werden getrennt gewichtet
  const mixed = kv.kvFactor('q8_0', 'f16');
  assert.ok(Math.abs(mixed - (34 / 32 + 2) / 4) < 1e-9);
  assert.ok(mixed > kv.kvFactor('q4_0', 'q4_0') && mixed < 1);
  assert.equal(mixed, kv.kvFactor('f16', 'q8_0')); // Summe aus K und V ist symmetrisch
});

test('kvFactor: unbekannter Typ fällt auf f16 zurück', () => {
  assert.equal(kv.kvFactor('q2_k', 'whatever'), 1);
});

test('kvEstimateGB: skaliert linear mit der Kontextlänge', () => {
  const base = kv.kvEstimateGB(2, 8192, 8192, 'f16', 'f16');
  assert.equal(base, 2);
  assert.equal(kv.kvEstimateGB(2, 8192, 16384, 'f16', 'f16'), 4);
  assert.ok(Math.abs(kv.kvEstimateGB(2, 8192, 8192, 'q4_0', 'q4_0') - 0.5625) < 1e-9);
});

test('evaluateFit: quantisierter KV-Cache senkt den Speicherbedarf', () => {
  const hw = { gpus: [{ name: 'Test GPU', vramGB: 12 }], totalMemGB: 32 };
  const size = 8 * 1073741824;
  const f16 = models.evaluateFit(size, 'modell-8b-Q4_K_M.gguf', hw, 32768, {});
  const q4 = models.evaluateFit(size, 'modell-8b-Q4_K_M.gguf', hw, 32768, { cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' });
  assert.ok(q4.needGB < f16.needGB, `${q4.needGB} muss kleiner sein als ${f16.needGB}`);
  const kvF16 = models.kvCacheGB(size, 'modell-8b-Q4_K_M.gguf', 32768);
  assert.ok(Math.abs((f16.needGB - q4.needGB) - kvF16 * (1 - 0.28125)) < 0.15);
});

/* --------------------------- llama.cpp-Flags --------------------------- */

test('llamaArgs: K und V getrennt, Flash-Attention als on/off/auto', () => {
  const r = ms.resolve({ model: { cacheTypeK: 'q4_0', cacheTypeV: 'q8_0' } });
  const args = ms.llamaArgs(r);
  assert.equal(args[args.indexOf('--cache-type-k') + 1], 'q4_0');
  assert.equal(args[args.indexOf('--cache-type-v') + 1], 'q8_0');
  assert.equal(args[args.indexOf('--flash-attn') + 1], 'on'); // V quantisiert -> FA an
  const autoArgs = ms.llamaArgs(ms.resolve({}));
  assert.equal(autoArgs[autoArgs.indexOf('--flash-attn') + 1], 'auto');
  const off = ms.llamaArgs(ms.resolve({ model: { flashAttn: false, cacheTypeK: 'q8_0' } }));
  assert.equal(off[off.indexOf('--flash-attn') + 1], 'off');
});

test('llamaArgs: Batch, mlock, no-mmap und RoPE nur wenn gesetzt', () => {
  const plain = ms.llamaArgs(ms.resolve({}));
  for (const flag of ['--batch-size', '--ubatch-size', '--mlock', '--no-mmap', '--rope-freq-base', '--rope-freq-scale']) {
    assert.ok(!plain.includes(flag), `${flag} darf ohne Override nicht auftauchen`);
  }
  const args = ms.llamaArgs(ms.resolve({
    model: { batchSize: 1024, ubatchSize: 256, mlock: true, noMmap: true, ropeFreqBase: 500000, ropeFreqScale: 0.5 },
  }));
  assert.equal(args[args.indexOf('--batch-size') + 1], '1024');
  assert.equal(args[args.indexOf('--ubatch-size') + 1], '256');
  assert.ok(args.includes('--mlock') && args.includes('--no-mmap'));
  assert.equal(args[args.indexOf('--rope-freq-base') + 1], '500000');
  assert.equal(args[args.indexOf('--rope-freq-scale') + 1], '0.5');
});

test('buildArgs: modellspezifische Werte landen in der Kommandozeile', () => {
  const resolved = ms.resolve({
    global: { ctx: 8192, gpuLayers: 999 },
    model: { ctx: 16384, gpuLayers: 24, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0', batchSize: 512, threads: 6 },
  });
  const { args } = buildArgs({
    serverPath: '/x/llama-server', modelPath: '/models/m.gguf', presetId: 'balanced',
    overrides: {}, ctx: 8192, gpuLayers: 999, threads: 4, port: 9931, hw: null, resolved,
  });
  const val = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(val('--ctx-size'), '16384');
  assert.equal(val('--n-gpu-layers'), '24');
  assert.equal(val('--threads'), '6');
  assert.equal(val('--cache-type-k'), 'q4_0');
  assert.equal(val('--cache-type-v'), 'q4_0');
  assert.equal(val('--flash-attn'), 'on');
  assert.equal(val('--batch-size'), '512');
  // keine doppelten Flags
  assert.equal(args.filter((a) => a === '--cache-type-k').length, 1);
  assert.equal(args.filter((a) => a === '--ctx-size').length, 1);
  assert.equal(args.filter((a) => a === '--flash-attn').length, 1);
});

test('buildArgs ohne resolved: Standard bleibt f16/auto (rückwärtskompatibel im Verhalten)', () => {
  const { args } = buildArgs({
    serverPath: '/x/llama-server', modelPath: '/m.gguf', presetId: 'balanced',
    overrides: {}, ctx: 4096, gpuLayers: 0, threads: 2, port: 9999, hw: null,
  });
  assert.equal(args[args.indexOf('--ctx-size') + 1], '4096');
  assert.equal(args[args.indexOf('--cache-type-k') + 1], 'f16');
  assert.equal(args[args.indexOf('--cache-type-v') + 1], 'f16');
  assert.equal(args[args.indexOf('--flash-attn') + 1], 'auto');
});

/* --------------------------- Schlüssel & Persistenz --------------------------- */

test('modelKey: Zusatzordner-Präfix wird entfernt, Einstellungen bleiben am Modell', () => {
  assert.equal(ms.modelKey('ext0:lmstudio-community/Qwen3/Qwen3-Q4_K_M.gguf'), 'lmstudio-community/Qwen3/Qwen3-Q4_K_M.gguf');
  assert.equal(ms.modelKey('ext7:lmstudio-community/Qwen3/Qwen3-Q4_K_M.gguf'), ms.modelKey('ext0:lmstudio-community/Qwen3/Qwen3-Q4_K_M.gguf'));
  assert.equal(ms.modelKey('owner__model-GGUF/model-Q4_K_M.gguf'), 'owner__model-GGUF/model-Q4_K_M.gguf');
  assert.equal(ms.modelKey({ id: 'ext2:a/b.gguf' }), 'a/b.gguf');
  assert.equal(ms.modelKey({ repo: 'a/b', file: 'm.gguf' }), 'a/b/m.gguf');
  assert.equal(ms.modelKey(null), '');
});

test('Persistenz: Roundtrip, leere Overrides löschen den Eintrag', async (t) => {
  const file = tmpFile(t);
  await ms.writeStore(file, { 'a/b.gguf': { ctx: 16384, cacheTypeK: 'q8_0' } });
  const loaded = await ms.readStore(file);
  assert.deepEqual(loaded['a/b.gguf'], { ctx: 16384, cacheTypeK: 'q8_0' });
  await ms.writeStore(file, {});
  assert.deepEqual(await ms.readStore(file), {});
});

test('Persistenz: kaputte Datei und ungültige Werte brechen nicht', async (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, '{kaputt', 'utf8');
  assert.deepEqual(await ms.readStore(file), {});
  fs.writeFileSync(file, JSON.stringify({ 'a/b': { ctx: 'x', cacheTypeK: 'q2_k', gpuLayers: 5000 }, 'c/d': [1, 2] }), 'utf8');
  const loaded = await ms.readStore(file);
  assert.deepEqual(loaded['a/b'], { gpuLayers: 999 });
  assert.equal(loaded['c/d'], undefined);
  assert.deepEqual(await ms.readStore(path.join(path.dirname(file), 'gibts-nicht.json')), {});
});

test('summary: nennt nur Abweichungen vom Standard', () => {
  assert.equal(ms.summary(ms.resolve({})), 'ctx 8192');
  const s = ms.summary(ms.resolve({ model: { cacheTypeK: 'q4_0', cacheTypeV: 'q8_0', ctx: 16384, gpuLayers: 20 } }));
  assert.ok(s.includes('K q4_0') && s.includes('V q8_0') && s.includes('FA') && s.includes('ctx 16384') && s.includes('ngl 20'));
});

/* --------------------------- F3: String-Bools --------------------------- */

test('F3: parseBool akzeptiert true/false/1/0 als Bool und als String, lehnt Rest ab', () => {
  // Wertematrix: gültige Repräsentationen
  for (const v of [true, 1, '1', 'true', 'TRUE', ' true ']) assert.equal(ms.parseBool(v), true, `parseBool(${JSON.stringify(v)})`);
  for (const v of [false, 0, '0', 'false', 'FALSE', ' false ']) assert.equal(ms.parseBool(v), false, `parseBool(${JSON.stringify(v)})`);
  // Unbekanntes wird abgelehnt (kein Override statt falschem Flag)
  for (const v of ['', 'bogus', 'yes', '2', -1, null, undefined, {}, []]) assert.equal(ms.parseBool(v), null, `parseBool(${JSON.stringify(v)})`);
});

test('F3: normalize dreht String-Bools nicht in true um (mlock/noMmap/flashAttn)', () => {
  const falsch = ms.normalize({ mlock: 'false', noMmap: '0', flashAttn: 'false' });
  assert.deepEqual(falsch, { mlock: false, noMmap: false, flashAttn: false });
  // Gegenprobe: echte Wahrheitswerte bleiben wahr
  assert.deepEqual(ms.normalize({ mlock: true, noMmap: '1', flashAttn: 'true' }), { mlock: true, noMmap: true, flashAttn: true });
  // Unbekannte Werte landen gar nicht im Patch
  assert.deepEqual(ms.normalize({ mlock: 'vielleicht', noMmap: 'yes' }), {});
});

test('F3: llamaArgs erzeugt bei deaktivierten String-Bools keine --mlock/--no-mmap', () => {
  const args = ms.llamaArgs(ms.resolve({ model: { mlock: 'false', noMmap: '0' } }));
  assert.ok(!args.includes('--mlock'), 'kein --mlock');
  assert.ok(!args.includes('--no-mmap'), 'kein --no-mmap');
  // Gegenprobe: aktivierte Werte setzen die Flags
  const an = ms.llamaArgs(ms.resolve({ model: { mlock: 'true', noMmap: '1' } }));
  assert.ok(an.includes('--mlock') && an.includes('--no-mmap'));
});

/* --------------------------- F3: Vorrangregel --------------------------- */

test('F3: Vorrangregel global < modellspezifisch < expliziter Aufruf (mlock/noMmap/batchSize)', () => {
  const global = { mlock: true, noMmap: true, batchSize: 1024, threads: 8, ctx: 4096 };
  // global allein greift jetzt für alle Schlüssel
  const nurGlobal = ms.resolve({ global });
  assert.equal(nurGlobal.mlock, true, 'mlock aus global');
  assert.equal(nurGlobal.noMmap, true, 'noMmap aus global');
  assert.equal(nurGlobal.batchSize, 1024, 'batchSize aus global');
  assert.equal(nurGlobal.threads, 8);
  assert.equal(nurGlobal.ctx, 4096);
  // modellspezifisch schlägt global
  const modell = ms.resolve({ global, model: { mlock: false, noMmap: 'false', batchSize: 512, threads: 4 } });
  assert.equal(modell.mlock, false);
  assert.equal(modell.noMmap, false);
  assert.equal(modell.batchSize, 512);
  assert.equal(modell.threads, 4);
  // expliziter Aufruf schlägt alles
  const aufruf = ms.resolve({ global, model: { mlock: false, batchSize: 512 }, call: { mlock: true, noMmap: false, batchSize: 256 } });
  assert.equal(aufruf.mlock, true);
  assert.equal(aufruf.noMmap, false);
  assert.equal(aufruf.batchSize, 256);
  // fehlt global, bleiben die bisherigen Standardwerte
  const leer = ms.resolve({});
  assert.equal(leer.mlock, false);
  assert.equal(leer.noMmap, false);
  assert.equal(leer.batchSize, null);
});

test('F3: globale Werte werden wie Modellwerte validiert (Klemmen statt Durchreichen)', () => {
  const r = ms.resolve({ global: { ctx: 10, gpuLayers: 5000, batchSize: 1, mlock: 'bogus', threads: 0 } });
  assert.equal(r.ctx, ms.LIMITS.ctx[0], 'ctx wird auf das Minimum geklemmt');
  assert.equal(r.gpuLayers, 999);
  assert.equal(r.batchSize, ms.LIMITS.batchSize[0]);
  assert.equal(r.threads, 1, 'threads=0 wird auf das Minimum geklemmt, nicht verworfen');
  assert.equal(r.mlock, false, 'unbekannter Bool fällt auf den Standard zurück');
});

/* --------------------------- F3: Nebenfälle --------------------------- */

test('F3: NaN/Infinity erzeugen keinen Override, unbekannter Cache-Typ fällt auf f16', () => {
  assert.deepEqual(ms.normalize({ ctx: NaN, gpuLayers: Infinity, batchSize: 'keine Zahl' }), {});
  const r = ms.resolve({ global: { ctx: NaN }, model: { cacheTypeK: 'bogus', cacheTypeV: 'q8_0' } });
  assert.equal(r.ctx, 8192, 'NaN im globalen Wert wird ignoriert');
  assert.equal(r.cacheTypeK, 'f16', 'unbekannter Cache-Typ wird verworfen');
  assert.equal(r.cacheTypeV, 'q8_0');
  assert.ok(r.notes.includes('vCacheNeedsFlashAttn'));
});

test('F3: RoPE-Frequenzen behalten ihre Nachkommastellen', () => {
  const out = ms.normalize({ ropeFreqBase: 1000000.5, ropeFreqScale: 0.25 });
  assert.equal(out.ropeFreqBase, 1000000.5, 'kein Rundungsverlust');
  assert.equal(out.ropeFreqScale, 0.25);
  assert.equal(ms.resolve({ model: out }).ropeFreqBase, 1000000.5);
});
