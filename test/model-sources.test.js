'use strict';
/**
 * Feature-Tests: Modelle aus zusätzlichen Ordnern laden.
 * - eigene Modelle bleiben unverändert (id ohne Präfix, external: false)
 * - fremde Ordner werden eine Ebene tiefer durchsucht (LM-Studio-Layout)
 * - externe Modelle sind markiert und werden NICHT gelöscht
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const models = require('../electron/models.js');
const { withinAnyRoot } = require('../electron/paths.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-src-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir, name, bytes = 2048) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0x41));
}

function putSparse(dir, name, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, name), 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

test('listLocal: eigene Modelle bleiben unverändert (external: false, id ohne Präfix)', async (t) => {
  const root = tmpDir(t);
  put(path.join(root, 'models', 'owner__model-GGUF'), 'model-Q4_K_M.gguf');
  const list = await models.listLocal(path.join(root, 'models'), []);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'owner__model-GGUF/model-Q4_K_M.gguf');
  assert.equal(list[0].external, false);
  assert.equal(list[0].repo, 'owner/model-GGUF');
});

test('listLocal: Modell aus einem Zusatzordner wird gefunden und markiert', async (t) => {
  const root = tmpDir(t);
  const primary = path.join(root, 'models');
  const extra = path.join(root, 'andere-platte');
  put(path.join(primary, 'owner__model-GGUF'), 'model-Q4_K_M.gguf');
  put(path.join(extra, 'fremd__modell-GGUF'), 'modell-Q5_K_M.gguf');

  const list = await models.listLocal(primary, [extra]);
  assert.equal(list.length, 2);
  const ext = list.find((m) => m.external);
  assert.ok(ext, 'externes Modell muss dabei sein');
  assert.equal(ext.sourceDir, extra);
  assert.equal(ext.sourceIndex, 0);
  assert.equal(ext.id, 'ext0:fremd__modell-GGUF/modell-Q5_K_M.gguf');
  assert.equal(ext.repo, 'fremd/modell-GGUF');
  assert.ok(fs.existsSync(ext.path), 'Pfad zeigt auf die echte Datei');
  assert.equal(list.find((m) => !m.external).external, false);
});

test('listLocal: verschachtelte Ablage (LM Studio: publisher/model/datei.gguf) wird gefunden', async (t) => {
  const root = tmpDir(t);
  const extra = path.join(root, 'lmstudio');
  put(path.join(extra, 'lmstudio-community', 'Qwen3-8B-GGUF'), 'Qwen3-8B-Q4_K_M.gguf');

  const list = await models.listLocal(path.join(root, 'models'), [extra]);
  assert.equal(list.length, 1);
  assert.equal(list[0].repo, 'lmstudio-community/Qwen3-8B-GGUF');
  assert.equal(list[0].id, 'ext0:lmstudio-community/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf');
  assert.equal(list[0].external, true);
});

test('listLocal: ONNX-Ordner in einem Zusatzordner wird erkannt', async (t) => {
  const root = tmpDir(t);
  const extra = path.join(root, 'onnx-ablage');
  const dir = path.join(extra, 'Phi-4-mini-onnx');
  put(dir, 'genai_config.json', 20);
  putSparse(dir, 'model.onnx', 51 * 1024 * 1024);

  const list = await models.listLocal(path.join(root, 'models'), [extra]);
  assert.equal(list.length, 1);
  assert.equal(list[0].isOnnx, true);
  assert.equal(list[0].external, true);
  assert.equal(list[0].id, 'ext0:Phi-4-mini-onnx/onnx');
  assert.equal(list[0].path, dir);
});

test('listLocal: mehrere Zusatzordner bekommen eindeutige IDs', async (t) => {
  const root = tmpDir(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  put(path.join(a, 'gleich__modell'), 'modell-Q4_K_M.gguf');
  put(path.join(b, 'gleich__modell'), 'modell-Q4_K_M.gguf');

  const list = await models.listLocal(path.join(root, 'models'), [a, b]);
  assert.equal(list.length, 2);
  assert.equal(new Set(list.map((m) => m.id)).size, 2, 'IDs dürfen nicht kollidieren');
  assert.deepEqual(list.map((m) => m.sourceIndex).sort(), [0, 1]);
});

test('listLocal: fehlender/leerer Zusatzordner crasht nicht', async (t) => {
  const root = tmpDir(t);
  put(path.join(root, 'models', 'owner__model-GGUF'), 'model-Q4_K_M.gguf');
  const list = await models.listLocal(path.join(root, 'models'), [path.join(root, 'gibts-nicht'), '', null]);
  assert.equal(list.length, 1);
});

test('listLocal: Splits aus einem Zusatzordner werden gruppiert', async (t) => {
  const root = tmpDir(t);
  const extra = path.join(root, 'gross');
  const dir = path.join(extra, 'big__modell-GGUF');
  put(dir, 'big-Q4_K_M-00001-of-00002.gguf');
  put(dir, 'big-Q4_K_M-00002-of-00002.gguf');

  const list = await models.listLocal(path.join(root, 'models'), [extra]);
  assert.equal(list.length, 1);
  assert.equal(list[0].parts.length, 2);
  assert.equal(list[0].file, 'big-Q4_K_M.gguf');
});

test('deleteModel: externe Modelle werden nicht gelöscht', async (t) => {
  const root = tmpDir(t);
  const extra = path.join(root, 'fremd');
  const file = path.join(extra, 'fremd__modell-GGUF', 'modell-Q4_K_M.gguf');
  put(path.dirname(file), path.basename(file));

  await assert.rejects(() => models.deleteModel(path.join(root, 'models'), 'ext0:fremd__modell-GGUF/modell-Q4_K_M.gguf'));
  assert.ok(fs.existsSync(file), 'Datei im fremden Ordner bleibt unangetastet');
});

test('isExternalId erkennt die Kennung', () => {
  assert.equal(models.isExternalId('ext0:ordner/modell.gguf'), true);
  assert.equal(models.isExternalId('ext12:a/b/onnx'), true);
  assert.equal(models.isExternalId('owner__model/modell.gguf'), false);
  assert.equal(models.isExternalId(''), false);
  assert.equal(models.isExternalId(null), false);
});

test('withinAnyRoot: erlaubt Pfade in jedem eingerichteten Ordner, lehnt andere ab', () => {
  const roots = ['/tmp/beispiel/models', '/tmp/beispiel/andere-platte'];
  assert.equal(withinAnyRoot(roots, '/tmp/beispiel/andere-platte/x/model.gguf'), '/tmp/beispiel/andere-platte/x/model.gguf');
  assert.equal(withinAnyRoot(roots, '/tmp/beispiel/models/y/model.gguf'), '/tmp/beispiel/models/y/model.gguf');
  assert.throws(() => withinAnyRoot(roots, '/etc/passwd'));
  assert.throws(() => withinAnyRoot(roots, '/tmp/beispiel/andere-platte-evil/x'));
  assert.throws(() => withinAnyRoot([], '/tmp/beispiel/models/x'));
});
