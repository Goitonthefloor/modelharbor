'use strict';
/**
 * Feature-Tests: API-Server für Agenten (Server-Tab) + natives Kontextfenster.
 * - gguf-meta: Metadaten-Parser (Strings/Arrays überspringen, context_length finden)
 * - server-config: Validierung, LAN-Bindung, Verbindungsinfos, Agenten-Beispiele
 * - server.buildArgs: die Flags landen korrekt in der Kommandozeile
 * - assertPortFree: belegter Port wird klar gemeldet statt still ausgewichen
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const gguf = require('../electron/gguf-meta.js');
const sc = require('../electron/server-config.js');
const snip = require('../ui/server-snippets.js');
const { buildArgs, assertPortFree } = require('../electron/server.js');

/* --------------------------- GGUF-Metadaten --------------------------- */

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]); };
const kv = (key, type, value) => Buffer.concat([str(key), u32(type), value]);
const boolVal = (v) => Buffer.from([v ? 1 : 0]);   // Werttyp 7 schreibt bereits kv()
// Array-Wert: Elementtyp (u32) + Anzahl (u64) + Elemente. Den Werttyp 9 schreibt bereits kv().
const arrVal = (elemType, items) => Buffer.concat([u32(elemType), u64(items.length), ...items]);

function ggufBuf(pairs, version = 3) {
  return Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(version), u64(0), u64(pairs.length), ...pairs]);
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-gguf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('gguf: findet Architektur und natives Kontextfenster', () => {
  const buf = ggufBuf([
    kv('general.architecture', 8, str('llama')),
    kv('general.name', 8, str('Testmodell')),
    kv('llama.context_length', 4, u32(40960)),
    kv('llama.embedding_length', 4, u32(4096)),
  ]);
  const meta = gguf.parseGgufMeta(buf);
  assert.equal(meta.architecture, 'llama');
  assert.equal(meta.contextLength, 40960);
  assert.equal(meta.version, 3);
});

test('gguf: überspringt große Tokenizer-Arrays vor dem Kontextfenster', () => {
  const tokens = [];
  for (let i = 0; i < 500; i++) tokens.push(str(`token_${i}`));
  const buf = ggufBuf([
    kv('general.architecture', 8, str('qwen2')),
    kv('tokenizer.ggml.tokens', 9, arrVal(8, tokens)),
    kv('tokenizer.ggml.scores', 9, arrVal(6, Array.from({ length: 500 }, () => { const b = Buffer.alloc(4); b.writeFloatLE(1.5); return b; }))),
    kv('tokenizer.ggml.add_bos_token', 7, boolVal(true)),
    kv('qwen2.context_length', 4, u32(32768)),
  ]);
  const meta = gguf.parseGgufMeta(buf);
  assert.equal(meta.architecture, 'qwen2');
  assert.equal(meta.contextLength, 32768);
});

test('gguf: Version 2 wird unterstützt, fremde Architekturen auch', () => {
  const buf = ggufBuf([kv('gemma.context_length', 4, u32(8192))], 2);
  assert.equal(gguf.parseGgufMeta(buf).contextLength, 8192);
  const buf2 = ggufBuf([kv('bert.context_length', 4, u32(512))]);
  assert.equal(gguf.parseGgufMeta(buf2).contextLength, 512);
});

test('gguf: kaputte/abgeschnittene Dateien werfen (Aufrufer fängt ab)', () => {
  assert.throws(() => gguf.parseGgufMeta(Buffer.from('NOPE')));
  assert.throws(() => gguf.parseGgufMeta(Buffer.alloc(10)));
  const good = ggufBuf([kv('llama.context_length', 4, u32(4096))]);
  assert.throws(() => gguf.parseGgufMeta(good.subarray(0, good.length - 3)));
  assert.throws(() => gguf.parseGgufMeta(ggufBuf([kv('x', 99, u32(1))])));
  const badVersion = Buffer.concat([Buffer.from('GGUF'), u32(9), u64(0), u64(0)]);
  assert.throws(() => gguf.parseGgufMeta(badVersion));
});

test('gguf: ohne context_length kommt null zurück', () => {
  const buf = ggufBuf([kv('general.architecture', 8, str('llama')), kv('general.name', 8, str('x'))]);
  assert.equal(gguf.parseGgufMeta(buf).contextLength, null);
});

test('readGgufContext: echte Datei, Nicht-GGUF, fehlende Datei, zu kleines Limit', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'modell.gguf');
  fs.writeFileSync(file, ggufBuf([
    kv('general.architecture', 8, str('llama')),
    kv('llama.context_length', 4, u32(131072)),
  ]));
  assert.equal(gguf.readGgufContext(file), 131072);
  const txt = path.join(dir, 'kein-gguf.txt');
  fs.writeFileSync(txt, 'hallo welt');
  assert.equal(gguf.readGgufContext(txt), null);
  assert.equal(gguf.readGgufContext(path.join(dir, 'gibts-nicht.gguf')), null);
  // Nur die ersten 20 Bytes lesen → Metadata nicht vollständig → null statt Crash
  assert.equal(gguf.readGgufContext(file, 20), null);
});

/* --------------------------- Server-Konfiguration --------------------------- */

test('server-config: Standardwerte und Validierung', () => {
  assert.deepEqual(sc.resolve({}), { port: 1234, lan: false, apiKey: '', cors: true, parallel: 4 });
  assert.deepEqual(sc.resolve(undefined), sc.DEFAULTS);
  const n = sc.normalize({ port: 999999, parallel: 0, lan: 'ja', cors: 0, apiKey: '  abc def \n', bogus: 1 });
  assert.equal(n.port, 65535);
  assert.equal(n.parallel, 1);
  assert.equal(n.lan, true);
  assert.equal(n.cors, false);
  assert.equal(n.apiKey, 'abcdef');      // Leerzeichen/Umbrüche raus
  assert.equal(n.bogus, undefined);
});

test('server-config: Port unter 1024 wird geklemmt, leere Werte ignoriert', () => {
  assert.equal(sc.normalize({ port: 80 }).port, 1024);
  assert.deepEqual(sc.normalize({ port: '', apiKey: null, lan: undefined }), {});
  assert.deepEqual(sc.normalize(null), {});
  assert.equal(sc.normalize({ apiKey: 'x'.repeat(400) }).apiKey.length, 256);
});

test('server-config: LAN-Schalter bestimmt die Bind-Adresse', () => {
  assert.equal(sc.bindHost(sc.resolve({ lan: false })), '127.0.0.1');
  assert.equal(sc.bindHost(sc.resolve({ lan: true })), '0.0.0.0');
});

test('connectionInfo: lokale URL immer, LAN-URLs nur mit Schalter', () => {
  const local = sc.connectionInfo(sc.resolve({}), ['192.0.2.50']);
  assert.equal(local.localUrl, 'http://127.0.0.1:1234/v1');
  assert.deepEqual(local.lanUrls, []);
  assert.deepEqual(local.ips, []);
  assert.equal(local.model, 'ModelHarbor');
  assert.equal(local.insecureLan, false);

  const lan = sc.connectionInfo(sc.resolve({ lan: true }), ['192.0.2.50', '10.0.0.5']);
  assert.deepEqual(lan.lanUrls, ['http://192.0.2.50:1234/v1', 'http://10.0.0.5:1234/v1']);
  assert.equal(lan.insecureLan, true, 'LAN ohne Key muss als unsicher markiert sein');
  const lanKey = sc.connectionInfo(sc.resolve({ lan: true, apiKey: 'mh-x' }), ['192.0.2.50']);
  assert.equal(lanKey.insecureLan, false);
  assert.equal(lanKey.hasKey, true);
  assert.ok(lan.endpoints.some((e) => e.path === '/v1/chat/completions'));
  assert.ok(lan.endpoints.some((e) => e.path === '/health'));
});

test('Agenten-Beispiele: mit Key Authorization, ohne Key Platzhalter', () => {
  const withKey = sc.resolve({ port: 1234, apiKey: 'mh-abc' });
  const curl = snip.curlExample(withKey, '192.0.2.50');
  assert.ok(curl.includes('curl http://192.0.2.50:1234/v1/chat/completions'));
  assert.ok(curl.includes('Authorization: Bearer mh-abc'));
  assert.ok(curl.includes('"model":"ModelHarbor"'));
  const py = snip.pythonExample(withKey, '192.0.2.50');
  assert.ok(py.includes('base_url="http://192.0.2.50:1234/v1"'));
  assert.ok(py.includes('api_key="mh-abc"'));
  const json = JSON.parse(snip.agentJson(withKey, '192.0.2.50'));
  assert.deepEqual(json, { base_url: 'http://192.0.2.50:1234/v1', api_key: 'mh-abc', model: 'ModelHarbor' });

  const noKey = sc.resolve({});
  assert.ok(!snip.curlExample(noKey).includes('Authorization'));
  assert.ok(snip.pythonExample(noKey).includes(sc.NO_KEY_PLACEHOLDER));
  assert.equal(JSON.parse(snip.agentJson(noKey)).api_key, sc.NO_KEY_PLACEHOLDER);
});

test('generateKey: eindeutig, mit Präfix, ohne Leerzeichen', () => {
  const a = sc.generateKey();
  const b = sc.generateKey();
  assert.ok(a.startsWith('mh-') && b.startsWith('mh-'));
  assert.notEqual(a, b);
  assert.ok(!/\s/.test(a));
  assert.ok(a.length > 20);
});

test('lanAddresses: liefert nur externe IPv4-Adressen', () => {
  const ips = sc.lanAddresses();
  assert.ok(Array.isArray(ips));
  for (const ip of ips) {
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!ip.startsWith('127.'));
  }
});

/* --------------------------- llama-server-Flags --------------------------- */

function argsWith(serverConfig, resolved) {
  return buildArgs({
    serverPath: '/x/llama-server', modelPath: '/models/m.gguf', presetId: 'balanced',
    overrides: {}, ctx: 8192, gpuLayers: 999, threads: 4, port: serverConfig.port || 1234,
    hw: null, resolved: resolved || null, serverConfig,
  }).args;
}
const val = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

test('buildArgs: LAN-Schalter bindet an 0.0.0.0, sonst nur lokal', () => {
  assert.equal(val(argsWith({ host: '127.0.0.1', port: 1234 }), '--host'), '127.0.0.1');
  assert.equal(val(argsWith({ host: '0.0.0.0', port: 1234 }), '--host'), '0.0.0.0');
  assert.equal(val(argsWith({ host: '0.0.0.0', port: 1234 }), '--port'), '1234');
});

test('buildArgs: API-Key, CORS und parallele Slots', () => {
  const args = argsWith({ host: '0.0.0.0', port: 1234, apiKey: 'mh-abc', cors: false, parallel: 8 });
  assert.equal(val(args, '--api-key'), 'mh-abc');
  // llama.cpp hat kein simples --cors: CORS läuft über --cors-origins
  assert.equal(val(args, '--cors-origins'), 'localhost');
  assert.ok(!args.includes('--cors'));
  assert.equal(val(args, '--parallel'), '8');
  assert.equal(val(args, '--alias'), 'ModelHarbor');
});

test('buildArgs: ohne Key/CORS-Einschränkung keine entsprechenden Flags', () => {
  const args = argsWith({ host: '127.0.0.1', port: 1234, cors: true });
  assert.ok(!args.includes('--api-key'));
  assert.ok(!args.includes('--cors-origins'));   // Standard * = alle Origins erlaubt
  assert.ok(!args.includes('--parallel'));
  assert.equal(val(args, '--host'), '127.0.0.1');
});

test('buildArgs: Server-Flags und Modell-Einstellungen kombiniert', () => {
  const ms = require('../electron/model-settings.js');
  const resolved = ms.resolve({ global: { ctx: 8192 }, model: { ctx: 16384, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' } });
  const args = argsWith({ host: '0.0.0.0', port: 4321, apiKey: 'mh-k', parallel: 2 }, resolved);
  assert.equal(val(args, '--ctx-size'), '16384');
  assert.equal(val(args, '--cache-type-k'), 'q4_0');
  assert.equal(val(args, '--cache-type-v'), 'q4_0');
  assert.equal(val(args, '--flash-attn'), 'on');
  assert.equal(val(args, '--port'), '4321');
  assert.equal(val(args, '--host'), '0.0.0.0');
  assert.equal(val(args, '--api-key'), 'mh-k');
  assert.equal(val(args, '--parallel'), '2');
  for (const f of ['--host', '--port', '--api-key', '--parallel', '--ctx-size', '--cache-type-k']) {
    assert.equal(args.filter((a) => a === f).length, 1, `${f} darf nur einmal vorkommen`);
  }
});

/* --------------------------- Port-Prüfung --------------------------- */

test('assertPortFree: freier Port geht, belegter Port wird klar gemeldet', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await assert.rejects(() => assertPortFree(port, '127.0.0.1'), /1234|belegt|in use/i);
  await new Promise((r) => srv.close(r));
  assert.equal(await assertPortFree(port, '127.0.0.1'), true);
});
