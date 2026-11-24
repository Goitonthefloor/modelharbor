'use strict';
/**
 * Regressionstests Runde C — Löschpfad (Audit-Findings F1, F2, F6, F7, F8).
 *
 * Jeder Test schlägt ohne den jeweiligen Fix fehl:
 *  F1 — verschluckte EACCES/ENOTDIR (Erfolgsmeldung ohne Wirkung)
 *  F2 — rein lexikalischer isWithin-Check (Symlink-Ausbruch)
 *  F6 — unbekannte Modell-ID war ein stiller No-op
 *  F7 — bare Repo-ID / "<repo>/onnx" löschte den ganzen Ordner
 *  F8 — mmproj-Waisen blieben liegen
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const models = require('../electron/models.js');
const { isWithinReal } = require('../electron/paths.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-del-'));
  t.after(() => {
    // chmod-Fixtures zuerst wieder öffnen, sonst schlägt das Aufräumen fehl
    for (const sub of fs.readdirSync(dir)) {
      try { fs.chmodSync(path.join(dir, sub), 0o755); } catch { /* egal */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function put(dir, name, bytes = 512) {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 0x41));
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/* ------------------------------ F1 ------------------------------ */

test('F1 deleteModel: EACCES wird gemeldet statt als Erfolg verbucht', { skip: isRoot && 'root ignoriert Dateirechte' }, async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__locked');
  fs.mkdirSync(repo);
  put(repo, 'a-Q4_K_M.gguf');
  fs.chmodSync(repo, 0o000);

  await assert.rejects(
    () => models.deleteModel(root, 'owner__locked/a-Q4_K_M.gguf'),
    'gesperrter Ordner muss einen Fehler liefern',
  );
  fs.chmodSync(repo, 0o755);
  assert.deepEqual(fs.readdirSync(repo), ['a-Q4_K_M.gguf'], 'Datei bleibt liegen');
});

test('F1 deleteModel: ENOTDIR wird gemeldet statt als Erfolg verbucht', async (t) => {
  const root = tmpDir(t);
  // "owner__file" ist eine Datei, kein Ordner -> readdir wirft ENOTDIR
  put(root, 'owner__file', 16);
  await assert.rejects(
    () => models.deleteModel(root, 'owner__file/a-Q4_K_M.gguf'),
    'ENOTDIR darf nicht als Erfolg durchgehen',
  );
  assert.ok(fs.existsSync(path.join(root, 'owner__file')));
});

test('F1 deleteModel: fehlender Ordner (ENOENT) bleibt stiller Erfolg', async (t) => {
  const root = tmpDir(t);
  await models.deleteModel(root, 'gibt__es-nicht/a-Q4_K_M.gguf');
  assert.deepEqual(fs.readdirSync(root), []);
});

/* ------------------------------ F2 ------------------------------ */

test('F2 isWithinReal: Symlink nach außen gilt nicht als "innerhalb"', async (t) => {
  const base = tmpDir(t);
  const root = path.join(base, 'models');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'linkRepo'), 'dir');

  assert.equal(await isWithinReal(root, path.join(root, 'linkRepo')), false);
  assert.equal(await isWithinReal(root, root), true);
});

test('F2 deleteModel: Symlink im Modellordner löscht keine fremden Dateien', async (t) => {
  const base = tmpDir(t);
  const root = path.join(base, 'models');
  const outside = path.join(base, 'outside2');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  put(outside, 'wichtig.gguf');
  fs.symlinkSync(outside, path.join(root, 'linkRepo'), 'dir');

  await assert.rejects(
    () => models.deleteModel(root, 'linkRepo/wichtig.gguf'),
    'Symlink-Ausbruch muss abgelehnt werden',
  );
  assert.ok(fs.existsSync(path.join(outside, 'wichtig.gguf')), 'Datei außerhalb bleibt erhalten');
  assert.ok(fs.existsSync(path.join(root, 'linkRepo')), 'Symlink selbst bleibt erhalten');
});

/* ------------------------------ F6 ------------------------------ */

test('F6 deleteModel: unbekannte ID ohne ".gguf" wird gemeldet', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__vision');
  fs.mkdirSync(repo);
  put(repo, 'm-Q4_K_M.gguf');
  put(repo, 'mmproj-m-f16.gguf');

  await assert.rejects(
    () => models.deleteModel(root, 'owner__vision/m-Q4_K_M'),
    'ID ohne Endung ist unbekannt und muss einen Fehler liefern',
  );
  assert.deepEqual(fs.readdirSync(repo).sort(), ['m-Q4_K_M.gguf', 'mmproj-m-f16.gguf']);
});

test('F6 deleteModel: unbekannter Dateiname im vorhandenen Ordner wird gemeldet', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__model');
  fs.mkdirSync(repo);
  put(repo, 'm-Q4_K_M.gguf');

  await assert.rejects(() => models.deleteModel(root, 'owner__model/tippe-Q8_0.gguf'));
  assert.deepEqual(fs.readdirSync(repo), ['m-Q4_K_M.gguf']);
});

/* ------------------------------ F7 ------------------------------ */

test('F7 deleteModel: bare Repo-ID wird abgelehnt, alle Quants bleiben', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__model-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'model-Q4_K_M.gguf');
  put(repo, 'model-Q8_0.gguf');
  put(repo, 'model-F16.gguf');

  await assert.rejects(() => models.deleteModel(root, 'owner__model-GGUF'), 'bare Repo-ID muss abgelehnt werden');
  assert.deepEqual(fs.readdirSync(repo).sort(), ['model-F16.gguf', 'model-Q4_K_M.gguf', 'model-Q8_0.gguf']);
});

test('F7 deleteModel: "<repo>/onnx" reißt keine GGUF-Modelle mit', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__mixed');
  fs.mkdirSync(repo);
  put(repo, 'mixed-Q4_K_M.gguf');
  put(repo, 'genai_config.json', 10);

  await assert.rejects(
    () => models.deleteModel(root, 'owner__mixed/onnx'),
    'onnx-Sammelpfad auf einem GGUF-Ordner muss abgelehnt werden',
  );
  assert.deepEqual(fs.readdirSync(repo).sort(), ['genai_config.json', 'mixed-Q4_K_M.gguf']);
});

test('F7 deleteModel: echter ONNX-Ordner (ohne GGUF) wird weiter entfernt', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'Phi-4-mini-onnx');
  fs.mkdirSync(repo);
  put(repo, 'genai_config.json', 10);
  put(repo, 'model.onnx', 2048);

  await models.deleteModel(root, 'Phi-4-mini-onnx/onnx');
  assert.ok(!fs.existsSync(repo));
});

/* ------------------------------ F8 ------------------------------ */

test('F8 deleteModel: mmproj des gelöschten Vision-Modells geht mit', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__vision-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'model-Q4_K_M.gguf');
  put(repo, 'mmproj-model-f16.gguf');
  put(repo, 'README.md', 10);

  await models.deleteModel(root, 'owner__vision-GGUF/model-Q4_K_M.gguf');
  assert.ok(!fs.existsSync(path.join(repo, 'mmproj-model-f16.gguf')), 'mmproj-Waise muss mitgelöscht werden');
  assert.ok(!fs.existsSync(path.join(repo, 'model-Q4_K_M.gguf')));
  assert.deepEqual(fs.readdirSync(repo), ['README.md'], 'Ordner wird nur geleert, nicht blind entfernt');
});

test('F8 deleteModel: mmproj bleibt, solange ein anderer Quant übrig ist', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__vision-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'model-Q4_K_M.gguf');
  put(repo, 'model-Q8_0.gguf');
  put(repo, 'mmproj-model-f16.gguf');

  await models.deleteModel(root, 'owner__vision-GGUF/model-Q4_K_M.gguf');
  assert.deepEqual(fs.readdirSync(repo).sort(), ['mmproj-model-f16.gguf', 'model-Q8_0.gguf'],
    'der verbleibende Quant braucht seinen Projektor weiter');
});

test('F8 deleteModel: mmproj-Waise ist danach nicht mehr als Modell gelistet', async (t) => {
  const root = tmpDir(t);
  const repo = path.join(root, 'owner__vision-GGUF');
  fs.mkdirSync(repo);
  put(repo, 'model-Q4_K_M.gguf');
  put(repo, 'mmproj-model-f16.gguf');

  await models.deleteModel(root, 'owner__vision-GGUF/model-Q4_K_M.gguf');
  assert.deepEqual(await models.listLocal(root), [], 'kein unsichtbarer Rest im Modellordner');
  assert.ok(!fs.existsSync(repo), 'leerer Ordner wird aufgeräumt');
});
