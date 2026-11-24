'use strict';
/* Backend je Modell: welche Engine startet (llama.cpp vs. ONNX Runtime) und mit
 * welchem Backend — dieselbe Regel für Main (server:start) und Oberfläche (Badges). */

const test = require('node:test');
const assert = require('node:assert');
const mb = require('../ui/model-backend');
const backends = require('../electron/backends');

const cuda = { id: 'linux-cuda-12.8', label: 'NVIDIA CUDA 12.8' };
const vulkan = { id: 'linux-vulkan', label: 'Vulkan (NVIDIA/AMD/Intel)' };
const onnx = { id: 'onnx', label: 'ONNX Runtime (NPU)' };
const cpu = { id: 'linux-cpu', label: 'CPU (x64)' };

/* ------------------------------- pick ------------------------------- */

test('pick: ONNX-Modell bekommt ausschließlich das ONNX-Backend', () => {
  const got = mb.pick([cuda, vulkan, onnx], { primary: 'linux-cuda-12.8', isOnnx: true });
  assert.equal(got.id, 'onnx', 'ONNX-Modell darf nicht über llama.cpp laufen');
});

test('pick: ONNX-Modell ohne ONNX-Backend ist null (Backend fehlt)', () => {
  assert.equal(mb.pick([cuda, vulkan], { primary: 'linux-cuda-12.8', isOnnx: true }), null);
});

test('pick: GGUF-Modell bekommt nie das ONNX-Backend', () => {
  const got = mb.pick([onnx, cuda], { primary: 'onnx', isOnnx: false });
  assert.equal(got.id, 'linux-cuda-12.8', 'llama.cpp kann keinen ONNX-Ordner laden');
});

test('pick: Hardware-Empfehlung gewinnt gegen die Einfüge-Reihenfolge', () => {
  const got = mb.pick([cuda, vulkan], { primary: 'linux-vulkan' });
  assert.equal(got.id, 'linux-vulkan');
});

test('pick: ohne passende Empfehlung gewinnt das erste installierte llama.cpp-Backend', () => {
  const got = mb.pick([cuda, vulkan], { primary: 'linux-rocm' });
  assert.equal(got.id, 'linux-cuda-12.8');
});

test('pick: keine Backends installiert → null', () => {
  assert.equal(mb.pick([], { primary: 'linux-vulkan' }), null);
  assert.equal(mb.pick(null, { primary: null }), null);
});

/* ----------------------------- describe ----------------------------- */

test('describe: GGUF zeigt Engine, Backend-ID und Kurznamen', () => {
  const d = mb.describe([cuda], { primary: 'linux-cuda-12.8' });
  assert.deepEqual(
    { kind: d.kind, engine: d.engine, backendId: d.backendId, backendShort: d.backendShort, missing: d.missing },
    { kind: 'llama', engine: 'llama.cpp', backendId: 'linux-cuda-12.8', backendShort: 'CUDA 12.8', missing: false },
  );
  assert.equal(d.backendLabel, 'NVIDIA CUDA 12.8');
});

test('describe: ONNX zeigt ONNX Runtime statt llama.cpp', () => {
  const d = mb.describe([onnx, cuda], { primary: 'linux-cuda-12.8', isOnnx: true });
  assert.equal(d.kind, 'onnx');
  assert.equal(d.engine, 'onnxruntime-genai');
  assert.equal(d.backendShort, 'ONNX');
  assert.equal(d.missing, false);
});

test('describe: fehlendes Backend wird als missing gemeldet', () => {
  const llama = mb.describe([onnx], { primary: 'linux-cuda-12.8' });
  assert.equal(llama.missing, true);
  assert.equal(llama.backendId, null);
  const onnxMissing = mb.describe([cuda], { isOnnx: true });
  assert.equal(onnxMissing.missing, true);
  assert.equal(onnxMissing.kind, 'onnx');
});

/* ---------------------------- shortName ---------------------------- */

test('shortName: bekannte IDs haben kurze Anzeigenamen', () => {
  assert.equal(mb.shortName('linux-vulkan', 'Vulkan (NVIDIA/AMD/Intel)'), 'Vulkan');
  assert.equal(mb.shortName('win-cuda-13.5-arm64', 'NVIDIA CUDA 13.5 (ARM64)'), 'CUDA 13.5');
  assert.equal(mb.shortName('macos-arm64', 'macOS Apple Silicon (Metal)'), 'Metal');
  assert.equal(mb.shortName('linux-openvino', 'Intel OpenVINO / NPU (experimentell)'), 'OpenVINO');
});

test('shortName: unbekannte ID fällt auf das Label zurück (Klammer/Zusatz weg)', () => {
  assert.equal(mb.shortName('künftig-neu', 'Vulkan (NVIDIA/AMD/Intel)'), 'Vulkan');
  assert.equal(mb.shortName('', 'CPU (x64)'), 'CPU');
  assert.equal(mb.shortName(null, null), '');
});

/* ------------------- eine Regel für Main und Oberfläche ------------------- */

test('backends.pickForModel ist dieselbe Funktion wie mb.pick', () => {
  assert.equal(backends.pickForModel, mb.pick, 'Main und UI dürfen nicht auseinanderlaufen');
  const installed = [cpu, onnx];
  assert.equal(backends.pickForModel(installed, { primary: 'linux-cpu', isOnnx: false }).id, 'linux-cpu');
  assert.equal(backends.pickForModel(installed, { primary: 'linux-cpu', isOnnx: true }).id, 'onnx');
});
