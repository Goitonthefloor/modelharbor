'use strict';
/**
 * ONNX-Bootstrap: Pins + Hash-Lock (Security-Runde 1.7.4).
 *
 * Deckt die Eigenschaften ab, die ein kompromittiertes Upstream-Release verhindern:
 * - unterstützter Python-Bereich (Floor 3.11, weil es keine cp310-Wheels mehr gibt)
 * - Installation IMMER aus dem Hash-Lock, nie über einen bloßen Paketnamen
 * - die mitgelieferte Lock-Datei ist vollständig gepinnt und gehasht
 * - der uv-Interpreter-Pin ist ein exakter Patch (kein stiller Drift)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  isSupportedOnnxPython, onnxInstallCommand, ONNX_PYTHON_PIN, ONNX_REQUIREMENTS,
} = require('../electron/backends.js');

const REQ_PATH = path.join(__dirname, '..', 'electron', ONNX_REQUIREMENTS);
const HASH_FLAG = '--hash=' + 'sha256:';

test('isSupportedOnnxPython: 3.11/3.12 ja, 3.10 und 3.13+ nein', () => {
  assert.equal(isSupportedOnnxPython(3.11), true);
  assert.equal(isSupportedOnnxPython(3.12), true);
  // 3.10 ist raus: onnxruntime-genai veröffentlicht keine cp310-Wheels mehr.
  assert.equal(isSupportedOnnxPython(3.10), false);
  assert.equal(isSupportedOnnxPython(3.9), false);
  // Obergrenze: der Lock führt nur cp311/cp312-Hashes.
  assert.equal(isSupportedOnnxPython(3.13), false);
  assert.equal(isSupportedOnnxPython(3.14), false);
  assert.equal(isSupportedOnnxPython(0), false);
  assert.equal(isSupportedOnnxPython(NaN), false);
  assert.equal(isSupportedOnnxPython(undefined), false);
});

test('onnxInstallCommand: pip installiert nur aus dem Hash-Lock', () => {
  const cmd = onnxInstallCommand({
    useUv: false, uvPath: null, venvPip: '/v/bin/pip', venvPython: '/v/bin/python',
    requirementsPath: '/target/onnx-requirements.txt',
  });
  assert.equal(cmd.exe, '/v/bin/pip');
  assert.ok(cmd.args.includes('--require-hashes'), 'Hash-Prüfung muss erzwungen sein');
  const i = cmd.args.indexOf('-r');
  assert.ok(i >= 0 && cmd.args[i + 1] === '/target/onnx-requirements.txt');
  assert.ok(!cmd.args.includes('onnxruntime-genai'), 'kein bloßer Paketname (löst auf "neueste" auf)');
  assert.ok(!cmd.args.some((a) => /^onnxruntime/.test(a)), 'kein unkontrolliertes Paket-Argument');
});

test('onnxInstallCommand: uv pip installiert nur aus dem Hash-Lock', () => {
  const cmd = onnxInstallCommand({
    useUv: true, uvPath: '/tools/uv', venvPip: '/v/bin/pip', venvPython: '/v/bin/python',
    requirementsPath: '/target/onnx-requirements.txt',
  });
  assert.equal(cmd.exe, '/tools/uv');
  assert.equal(cmd.args[0], 'pip');
  assert.equal(cmd.args[1], 'install');
  const p = cmd.args.indexOf('--python');
  assert.ok(p >= 0 && cmd.args[p + 1] === '/v/bin/python');
  assert.ok(cmd.args.includes('--require-hashes'));
  const i = cmd.args.indexOf('-r');
  assert.ok(i >= 0 && cmd.args[i + 1] === '/target/onnx-requirements.txt');
  assert.ok(!cmd.args.includes('onnxruntime-genai'));
});

test('ONNX_PYTHON_PIN ist ein exakter Patch (kein Minor-Drift)', () => {
  assert.match(ONNX_PYTHON_PIN, /^\d+\.\d+\.\d+$/, 'uv python install braucht einen exakten Patch');
  assert.ok(ONNX_PYTHON_PIN.startsWith('3.12.'), 'der uv-Pfad nutzt 3.12');
});

test('Lock-Datei: jede Anforderung exakt gepinnt und mit SHA256 gehasht', () => {
  const text = fs.readFileSync(REQ_PATH, 'utf8');
  const lines = text.split('\n');
  const blocks = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const pin = line.match(/^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\?$/);
    if (pin) {
      cur = { name: pin[1], version: pin[2], hashes: [] };
      blocks.push(cur);
      continue;
    }
    const h = line.match(/^--hash=sha256:([0-9a-f]{64})\s*\\?$/);
    assert.ok(h && cur, 'jede Zeile muss ein Pin oder ein SHA256-Hash sein: ' + line);
    cur.hashes.push(h[1]);
  }
  assert.ok(blocks.length >= 6, 'die vollständige Closure muss gepinnt sein (genai, onnxruntime, numpy, …)');
  for (const b of blocks) {
    assert.match(b.version, /^\d+(\.\d+)*$/, `${b.name}: exakte Version, kein Bereich`);
    assert.ok(b.hashes.length >= 1, `${b.name}: mindestens ein SHA256`);
    assert.equal(new Set(b.hashes).size, b.hashes.length, `${b.name}: keine Duplikate`);
  }
  const names = blocks.map((b) => b.name);
  for (const required of ['onnxruntime-genai', 'onnxruntime', 'numpy']) {
    assert.ok(names.includes(required), `${required} muss Teil des Locks sein`);
  }
  // Keine verbleibenden unpinned Anforderungen und keine Bereichsoperatoren.
  assert.ok(!/[><~!]=/.test(text.replace(/--hash=sha256:[0-9a-f]{64}/g, '')), 'keine Versionsbereiche im Lock');
  assert.ok(!/^-[a-z]/m.test(text.replace(/--hash=sha256:[0-9a-f]{64}/g, '')), 'keine zusätzlichen pip-Optionen im Lock');
});

test('Lock-Datei deckt beide unterstützten Python-Versionen und alle Plattformen ab', () => {
  // Die Hashes stammen aus den PyPI-Wheel-Metadaten; hier wird geprüft, dass die
  // Datei überhaupt die erwartete Größenordnung hat (cp311+cp312 × 5 Plattformen
  // für die drei Binärpakete, plus reine Python-Wheels für die restlichen).
  const text = fs.readFileSync(REQ_PATH, 'utf8');
  const total = (text.match(/--hash=sha256:/g) || []).length;
  assert.ok(total >= 30, `erwartet viele Wheel-Hashes, gefunden ${total}`);
  const genai = text.split('onnxruntime-genai==')[1] || '';
  const genaiHashes = (genai.split(/\n[A-Za-z]/)[0].match(/--hash=sha256:/g) || []).length;
  assert.ok(genaiHashes >= 10, `genai braucht cp311/cp312 × 5 Plattformen, gefunden ${genaiHashes}`);
});
