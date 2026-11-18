'use strict';
/**
 * Regressionstests Runde 3: lokale Modellverwaltung (Hilfsdateien, selektives
 * Löschen), Intel-Arc-iGPU-Klassifikation und der ONNX-Server (Python-Harness).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const models = require('../electron/models.js');
const { isIntegrated } = require('../electron/hardware.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-mm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir, name, bytes = 1024) {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0x41));
}

/* ---------------- listLocal: Hilfsdateien sind keine Modelle ---------------- */

test('listLocal: Ordner nur mit mmproj wird nicht als Modell gelistet', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__model-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'mmproj-F16.gguf');
  put(repo, 'README.md');
  assert.deepEqual(await models.listLocal(root), []);
});

test('listLocal: mmproj neben einem Modell erzeugt keinen zweiten Eintrag', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__model-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'model-Q4_K_M.gguf');
  put(repo, 'mmproj-F16.gguf');
  const list = await models.listLocal(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].file, 'model-Q4_K_M.gguf');
});

/* ---------------- deleteModel: nur das gewählte Modell ---------------- */

test('deleteModel: löscht nur den gewählten Quant, andere bleiben erhalten', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__model-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'model-Q4_K_M.gguf');
  put(repo, 'model-Q8_0.gguf');
  put(repo, 'mmproj-F16.gguf');

  await models.deleteModel(root, 'owner__model-GGUF/model-Q4_K_M.gguf');
  const rest = fs.readdirSync(repo).sort();
  assert.deepEqual(rest, ['mmproj-F16.gguf', 'model-Q8_0.gguf']);
});

test('deleteModel: Split-Parts werden gemeinsam entfernt', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__big-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'big-Q4_K_M-00001-of-00002.gguf');
  put(repo, 'big-Q4_K_M-00002-of-00002.gguf');
  put(repo, 'big-Q8_0.gguf');

  await models.deleteModel(root, 'owner__big-GGUF/big-Q4_K_M.gguf');
  assert.deepEqual(fs.readdirSync(repo), ['big-Q8_0.gguf']);
});

test('deleteModel: leerer Ordner wird aufgeräumt', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__model-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'model-Q4_K_M.gguf');

  await models.deleteModel(root, 'owner__model-GGUF/model-Q4_K_M.gguf');
  assert.ok(!fs.existsSync(repo));
});

test('deleteModel: ONNX-Modell (Ordner als Ganzes) wird komplett entfernt', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'Phi-4-mini-onnx');
  fs.mkdirSync(repo);
  put(repo, 'genai_config.json', 10);
  put(repo, 'model.onnx', 2048);

  await models.deleteModel(root, 'Phi-4-mini-onnx/onnx');
  assert.ok(!fs.existsSync(repo));
});

test('deleteModel: leere/Traversal-IDs werden abgelehnt, Root bleibt', async (t) => {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, 'owner__model-GGUF'));
  for (const id of ['', '/', '../evil/x', '..', '.']) {
    await assert.rejects(() => models.deleteModel(root, id), `ID ${JSON.stringify(id)} muss abgelehnt werden`);
  }
  assert.ok(fs.existsSync(path.join(root, 'owner__model-GGUF')));
  // Ein Schlüssel mit Pfadanteilen kann nicht ausbrechen: er wird nur gegen
  // Dateinamen IM Ordner gematcht und ist hier ein No-op.
  await models.deleteModel(root, 'owner__model-GGUF/../../etc');
  assert.ok(fs.existsSync(path.join(root, 'owner__model-GGUF')));
});

/* ---------------- Intel Arc: iGPU vs. dGPU ---------------- */

test('isIntegrated: Intel Arc ohne Modellnummer ist die Core-Ultra-iGPU', () => {
  assert.equal(isIntegrated('Intel', 'Intel(R) Arc(TM) Graphics'), true);
  assert.equal(isIntegrated('Intel', 'Intel Arc Graphics'), true);
  assert.equal(isIntegrated('Intel', 'Intel(R) Arc(TM) 140V Graphics'), true);
  assert.equal(isIntegrated('Intel', 'Intel(R) Arc(TM) 130V Graphics'), true);
});

test('isIntegrated: Intel Arc mit Modellnummer bleibt diskret', () => {
  assert.equal(isIntegrated('Intel', 'Intel(R) Arc(TM) A770 Graphics'), false);
  assert.equal(isIntegrated('Intel', 'Intel(R) Arc(TM) A750'), false);
  assert.equal(isIntegrated('Intel', 'Intel Arc B580'), false);
  assert.equal(isIntegrated('Intel', 'Intel(R) Arc(TM) Pro B60'), false);
  assert.equal(isIntegrated('Intel', 'Intel(R) UHD Graphics 730'), true);
  assert.equal(isIntegrated('Intel', 'Intel Iris Xe Graphics'), true);
});

/* ---------------- ONNX-Server (Python-Harness, ohne OGA) ---------------- */

function hasPython() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('onnx_server.py: Suchoptionen und SSE-Stream-Ende (Python-Harness)', { skip: !hasPython() }, () => {
  const script = path.join(__dirname, '..', 'scripts', 'test_onnx_server.py');
  const out = execFileSync('python3', [script], { encoding: 'utf8', timeout: 120000 });
  assert.ok(!/^FAIL/m.test(out), out);
  assert.ok(/alle ONNX-Server-Checks bestanden/.test(out), out);
});
