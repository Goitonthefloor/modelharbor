'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { recommendBackend, formatBytes } = require('../electron/hardware');
const models = require('../electron/models');
const { samplingArgs, getPreset, PRESETS } = require('../electron/presets');
const { buildArgs } = require('../electron/server');

/* ---------------- Hardware-Empfehlung ---------------- */

test('NVIDIA unter Windows -> CUDA empfohlen', () => {
  const hw = { gpus: [{ vendor: 'NVIDIA', name: 'RTX 4070', vramGB: 12 }], npus: [] };
  const rec = recommendBackend(hw, 'win32', 'x64');
  assert.equal(rec.primary, 'win-cuda-12.4');
  assert.ok(rec.candidates.some((c) => c.id === 'win-vulkan'), 'Vulkan als Alternative');
});

test('AMD unter Windows -> Vulkan zuerst, ROCm experimentell', () => {
  const hw = { gpus: [{ vendor: 'AMD', name: 'RX 7800 XT', vramGB: 16 }], npus: [], hasRocm: true };
  const rec = recommendBackend(hw, 'win32', 'x64');
  assert.equal(rec.primary, 'win-vulkan');
  const rocm = rec.candidates.find((c) => c.id === 'win-rocm');
  assert.ok(rocm && rocm.experimental, 'ROCm ist als experimentell markiert');
});

test('AMD unter Linux mit ROCm -> ROCm; ohne ROCm -> Vulkan', () => {
  const withRocm = recommendBackend({ gpus: [{ vendor: 'AMD', name: 'RX 7900', vramGB: 24 }], npus: [], hasRocm: true }, 'linux', 'x64');
  assert.equal(withRocm.primary, 'linux-rocm');
  const noRocm = recommendBackend({ gpus: [{ vendor: 'AMD', name: 'RX 7900', vramGB: 24 }], npus: [], hasRocm: false }, 'linux', 'x64');
  assert.equal(noRocm.primary, 'linux-vulkan');
});

test('Apple Silicon -> Metal-Build', () => {
  const rec = recommendBackend({ gpus: [{ vendor: 'Apple', name: 'M3 Pro', vramGB: 12 }], npus: [], unifiedMemory: true }, 'darwin', 'arm64');
  assert.equal(rec.primary, 'macos-arm64');
});

test('Intel-Mac -> x64-Build', () => {
  const rec = recommendBackend({ gpus: [{ vendor: 'Intel', name: 'Iris', vramGB: null }], npus: [] }, 'darwin', 'x64');
  assert.equal(rec.primary, 'macos-x64');
});

test('Keine GPU unter Linux -> CPU-Backend', () => {
  const rec = recommendBackend({ gpus: [], npus: [] }, 'linux', 'x64');
  assert.equal(rec.primary, 'linux-cpu');
});

test('Intel-NPU unter Windows bietet OpenVINO an, aber nicht als Primärwahl ohne GPU', () => {
  const hw = {
    gpus: [{ vendor: 'Intel', name: 'Intel Arc iGPU', vramGB: 4 }],
    npus: [{ vendor: 'Intel', name: 'Intel AI Boost', usableBy: 'openvino' }],
  };
  const rec = recommendBackend(hw, 'win32', 'x64');
  assert.equal(rec.primary, 'win-vulkan');
  const ov = rec.candidates.find((c) => c.id === 'win-openvino');
  assert.ok(ov && ov.experimental, 'OpenVINO wird als experimentelle Option gelistet');
});

test('formatBytes', () => {
  assert.equal(formatBytes(1073741824), '1.0 GB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(null), null);
});

/* ---------------- Quant-Auswahl & Fit ---------------- */

const sampleFiles = [
  { name: 'm-Q8_0.gguf', size: 8.11 * 1073741824, quant: 'Q8_0' },
  { name: 'm-Q6_K.gguf', size: 6.26 * 1073741824, quant: 'Q6_K' },
  { name: 'm-Q5_K_M.gguf', size: 5.45 * 1073741824, quant: 'Q5_K_M' },
  { name: 'm-Q4_K_M.gguf', size: 4.68 * 1073741824, quant: 'Q4_K_M' },
];

test('pickBestQuant: 12-GB-Karte bekommt größten passenden Quant', () => {
  const best = models.pickBestQuant(sampleFiles, 12, null);
  assert.equal(best.quant, 'Q6_K'); // 6.26 GB passt in 12 GB * 0.88
});

test('pickBestQuant: 6-GB-Karte bekommt Q4_K_M', () => {
  const best = models.pickBestQuant(sampleFiles, 6, null);
  assert.equal(best.quant, 'Q4_K_M');
});

test('pickBestQuant: bevorzugter Quant gewinnt, wenn er passt', () => {
  const best = models.pickBestQuant(sampleFiles, 12, 'Q4_K_M');
  assert.equal(best.quant, 'Q4_K_M');
});

test('pickBestQuant: bevorzugter Quant wird verworfen, wenn zu groß', () => {
  const best = models.pickBestQuant(sampleFiles, 6, 'Q8_0');
  assert.notEqual(best.quant, 'Q8_0');
});

test('evaluateFit: 4,7 GB Modell auf 12 GB VRAM -> gpu', () => {
  const fit = models.evaluateFit(4.68 * 1073741824, 'm-Q4_K_M.gguf', { gpus: [{ name: 'RTX 4070', vramGB: 12 }], totalMemGB: 32 }, 8192);
  assert.equal(fit.verdict, 'gpu');
  assert.equal(fit.gpuLayers, 999);
});

test('evaluateFit: zu groß für VRAM, aber RAM reicht -> hybrid', () => {
  const fit = models.evaluateFit(8.38 * 1073741824, 'm-Q4_K_M.gguf', { gpus: [{ name: 'RTX 3060', vramGB: 6 }], totalMemGB: 32 }, 8192);
  assert.equal(fit.verdict, 'hybrid');
});

test('evaluateFit: ohne GPU -> ram, zu groß -> too-big', () => {
  const ram = models.evaluateFit(1.0 * 1073741824, 'm-Q4_K_M.gguf', { gpus: [], totalMemGB: 16 }, 8192);
  assert.equal(ram.verdict, 'ram');
  const big = models.evaluateFit(30 * 1073741824, 'm-Q4_K_M.gguf', { gpus: [], totalMemGB: 8 }, 8192);
  assert.equal(big.verdict, 'too-big');
});

test('quantFromName erkennt gängige Quantnamen', () => {
  assert.equal(models.quantFromName('Qwen3-8B-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(models.quantFromName('qwen2.5-0.5b-instruct-q5_k_m.gguf'), 'Q5_K_M');
  assert.equal(models.quantFromName('gemma-3-1b-it-Q8_0.gguf'), 'Q8_0');
  assert.equal(models.quantFromName('model-f16.gguf'), 'F16');
});

/* ---------------- Presets & Server-Args ---------------- */

test('alle vier Presets existieren mit vollständiger Sampling-Konfiguration', () => {
  assert.deepEqual(PRESETS.map((p) => p.id).sort(), ['balanced', 'code', 'creative', 'deterministic']);
  for (const p of PRESETS) {
    assert.ok(p.name && p.description, `${p.id} hat Name/Beschreibung`);
    assert.ok(p.sampling && typeof p.sampling.temp === 'number', `${p.id} hat Temperatur`);
  }
});

test('deterministisches Preset nutzt temp 0, top-k 1 und festen Seed', () => {
  const args = samplingArgs(getPreset('deterministic').sampling);
  assert.ok(args.includes('--temp') && args[args.indexOf('--temp') + 1] === '0');
  assert.ok(args.includes('--top-k') && args[args.indexOf('--top-k') + 1] === '1');
  assert.ok(args.includes('--seed') && args[args.indexOf('--seed') + 1] === '42');
});

test('kreatives Preset aktiviert DRY und XTC', () => {
  const args = samplingArgs(getPreset('creative').sampling);
  assert.ok(args.includes('--dry-multiplier'));
  assert.ok(args.includes('--xtc-probability'));
  assert.ok(args.includes('--temp'));
});

test('buildArgs erzeugt vollständige llama-server-Kommandozeile', () => {
  const { args } = buildArgs({
    serverPath: '/x/llama-server',
    modelPath: '/models/m.gguf',
    presetId: 'balanced',
    overrides: {},
    ctx: 8192,
    gpuLayers: 999,
    threads: 4,
    port: 9931,
    hw: null,
  });
  assert.equal(args[0], '--model');
  assert.equal(args[1], '/models/m.gguf');
  assert.ok(args.includes('--host') && args[args.indexOf('--host') + 1] === '127.0.0.1');
  assert.ok(args.includes('--port') && args[args.indexOf('--port') + 1] === '9931');
  assert.ok(args.includes('--ctx-size') && args[args.indexOf('--ctx-size') + 1] === '8192');
  assert.ok(args.includes('--n-gpu-layers') && args[args.indexOf('--n-gpu-layers') + 1] === '999');
  assert.ok(args.includes('--fit'));
  assert.ok(args.includes('--jinja'));
  assert.ok(args.includes('--samplers'));
});

test('buildArgs: Overrides überschreiben Preset-Sampling', () => {
  const { sampling } = buildArgs({
    serverPath: '/x/llama-server', modelPath: '/m.gguf', presetId: 'balanced',
    overrides: { sampling: { temp: 0.1 } }, ctx: 4096, gpuLayers: 0, threads: 2, port: 9999, hw: null,
  });
  assert.equal(sampling.temp, 0.1);
  assert.equal(sampling.topP, 0.92); // Rest bleibt vom Preset
});

/* --- Asset-Matching gegen echte llama.cpp-Release-Namen ------------- */

test('cudart-Asset wird mit und ohne Build-Nummer im Namen erkannt', () => {
  const { BACKENDS } = require('../electron/backends.js');
  const cases = [
    ['win-cuda-12.4', ['cudart-llama-bin-win-cuda-12.4-x64.zip', 'cudart-llama-b12374-bin-win-cuda-12.4-x64.zip']],
    ['win-cuda-13.5', ['cudart-llama-bin-win-cuda-13.5-x64.zip', 'cudart-llama-b12374-bin-win-cuda-13.5-x64.zip']],
    ['linux-cuda-12.8', ['cudart-llama-bin-ubuntu-cuda-12.8-x64.tar.gz', 'cudart-llama-b12374-bin-ubuntu-cuda-12.8-x64.tar.gz']],
  ];
  for (const [id, names] of cases) {
    const rule = BACKENDS[id].assets.find((a) => /cudart/.test(String(a.match)));
    assert.ok(rule, `${id} hat keine cudart-Regel`);
    for (const n of names) assert.ok(rule.match.test(n), `${id} erkennt ${n} nicht`);
  }
});

test('cudart-Regel verwechselt keine fremden Pakete', () => {
  const { BACKENDS } = require('../electron/backends.js');
  const rule = BACKENDS['win-cuda-12.4'].assets.find((a) => /cudart/.test(String(a.match)));
  assert.equal(rule.match.test('cudart-llama-bin-win-cuda-13.5-x64.zip'), false);
  assert.equal(rule.match.test('llama-b12374-bin-win-cuda-12.4-x64.zip'), false);
});

/* ---------------- Token-Geschwindigkeit ---------------- */

const { tokensPerSecond } = require('../ui/tokenspeed');

test('tok/s: 100 Antwort-Tokens in 10 s ergeben 9,9 tok/s', () => {
  assert.equal(Number(tokensPerSecond(100, 10000).toFixed(1)), 9.9);
});

test('tok/s: 2 Tokens in 1 s ergeben 1,0 tok/s', () => {
  assert.equal(tokensPerSecond(2, 1000), 1);
});

test('tok/s: GPU-Messung 112 Tokens in 1 s ergibt 111 tok/s', () => {
  assert.equal(Math.round(tokensPerSecond(112, 1000)), 111);
});

test('tok/s: Messfenster unter 250 ms wird verworfen, ab 250 ms akzeptiert', () => {
  assert.equal(tokensPerSecond(50, 249), 0);
  assert.ok(tokensPerSecond(50, 250) > 0);
});

test('tok/s: unter 2 Tokens oder ungültige Eingaben ergeben 0', () => {
  assert.equal(tokensPerSecond(1, 5000), 0);
  assert.equal(tokensPerSecond(0, 5000), 0);
  assert.equal(tokensPerSecond(NaN, 5000), 0);
  assert.equal(tokensPerSecond(50, NaN), 0);
  assert.equal(tokensPerSecond(50, undefined), 0);
});
