'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { recommendBackend, isIntegrated, formatBytes, estimateVramFromName, pickRegistryVram } = require('../electron/hardware');
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

/* ---------------- integrated/discrete Klassifikation ---------------- */

test('AMD-APU-iGPU (Radeon-Graphics/Codename) wird integriert erkannt', () => {
  assert.equal(isIntegrated('AMD', 'Advanced Micro Devices, Inc. [AMD/ATI] Renoir [Radeon Vega 8/7 Graphics]'), true);
  assert.equal(isIntegrated('AMD', 'AMD Radeon 780M Graphics'), true);
  assert.equal(isIntegrated('AMD', 'Phoenix1 [Radeon 780M]'), true);
  assert.equal(isIntegrated('AMD', 'Radeon(TM) Graphics'), true);
});

test('Diskrete AMD-GPU (RX/Navi/Vega-10) wird nicht als integriert erkannt', () => {
  assert.equal(isIntegrated('AMD', 'Radeon RX 7900 XTX'), false);
  assert.equal(isIntegrated('AMD', 'Navi 31 [Radeon RX 7900 XT]'), false);
  assert.equal(isIntegrated('AMD', 'Vega 20 [Radeon Pro VII]'), false);
});

test('Intel Arc dGPU (diskrete Karte) wird nicht als integriert erkannt', () => {
  assert.equal(isIntegrated('Intel', 'Intel(R) Arc(TM) A770 Graphics'), false);
});

test('Intel HD/Iris/UHD werden integriert erkannt', () => {
  assert.equal(isIntegrated('Intel', 'Intel(R) UHD Graphics 730'), true);
  assert.equal(isIntegrated('Intel', 'Intel Iris Xe Graphics'), true);
  assert.equal(isIntegrated('Intel', 'Intel HD Graphics 630'), true);
});

test('NVIDIA wird nie als integriert erkannt', () => {
  assert.equal(isIntegrated('NVIDIA', 'NVIDIA GeForce RTX 4070'), false);
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

/* ---------------- Update-Checker ---------------- */

const { parseVersion, isNewerVersion, pickAsset } = require('../electron/updater');

test('parseVersion: v-Präfix und reine Zahlen', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseVersion('abc'), null);
});

test('isNewerVersion: Semver-Vergleich', () => {
  assert.ok(isNewerVersion('v1.1.0', '1.0.0'));
  assert.ok(isNewerVersion('1.2.0', '1.1.9'));
  assert.ok(isNewerVersion('2.0.0', '1.9.9'));
  assert.ok(!isNewerVersion('1.1.0', '1.1.0'));
  assert.ok(!isNewerVersion('1.0.0', '1.1.0'));
  assert.ok(!isNewerVersion('garbage', '1.1.0'));
});

test('pickAsset: plattformspezifische Pakete', () => {
  const assets = [
    { name: 'ModelHarbor-Setup-1.1.0.exe', url: 'x' },
    { name: 'ModelHarbor-1.1.0.AppImage', url: 'y' },
    { name: 'ModelHarbor-1.1.0-arm64.dmg', url: 'z' },
  ];
  assert.equal(pickAsset(assets, 'linux').name, 'ModelHarbor-1.1.0.AppImage');
  assert.equal(pickAsset(assets, 'win32').name, 'ModelHarbor-Setup-1.1.0.exe');
  assert.equal(pickAsset(assets, 'darwin').name, 'ModelHarbor-1.1.0-arm64.dmg');
  assert.equal(pickAsset(assets, 'linux'), pickAsset(assets, 'unknown-platform'));
});

test('pickAsset: kein passendes Asset liefert null', () => {
  assert.equal(pickAsset([{ name: 'readme.txt' }], 'linux'), null);
  assert.equal(pickAsset([], 'linux'), null);
});

/* --- Regression: update:download nutzt deklarierte Zustandsvariable -------- */

test('main.js deklariert activeUpdate für den update:download-Handler', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  // Ohne Deklaration wirft der Handler unter 'use strict' einen ReferenceError
  assert.match(src, /^let activeUpdate = null;$/m, 'activeUpdate ist deklariert');
  assert.match(src, /if \(activeUpdate\) throw new Error\(i18n\.t\('error\.updateRunning'\)\);/, 'Guard nutzt activeUpdate');
  assert.match(src, /activeUpdate = \{ startedAt: Date\.now\(\) \};/, 'Handler setzt activeUpdate');
  assert.match(src, /activeUpdate = null;/, 'Handler räumt activeUpdate wieder auf');
});

/* -------------------- ONNX / NPU (GenAI) -------------------- */

const backends = require('../electron/backends');

test('listLocal erkennt einen ONNX-/GenAI-Modellordner', async () => {
  const os = require('os');
  const path = require('path');
  const fsp = require('fs/promises');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-onnx-'));
  const mdir = path.join(root, 'phi3-mini');
  await fsp.mkdir(mdir, { recursive: true });
  await fsp.writeFile(path.join(mdir, 'genai_config.json'), '{}');
  await fsp.writeFile(path.join(mdir, 'model.onnx'), 'x');
  // sparse Datei: 60 MB Modellgewichte (listLocal verlangt >= 50 MB)
  await fsp.writeFile(path.join(mdir, 'model.onnx.data'), '');
  await fsp.truncate(path.join(mdir, 'model.onnx.data'), 60 * 1024 * 1024);
  const list = await models.listLocal(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].isOnnx, true);
  assert.ok(path.isAbsolute(list[0].path));
  assert.ok(list[0].file.startsWith('ONNX-'));
  assert.ok(list[0].sizeBytes >= 60 * 1024 * 1024);
  await fsp.rm(root, { recursive: true, force: true });
});

test('listLocal erkennt einen Ryzen-AI-Ordner ohne .onnx (fconst/state)', async () => {
  const os = require('os');
  const path = require('path');
  const fsp = require('fs/promises');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-rai-'));
  const mdir = path.join(root, 'Qwen3.5_9B_rai_1.9.0_npu');
  await fsp.mkdir(mdir, { recursive: true });
  await fsp.writeFile(path.join(mdir, 'genai_config.json'), '{}');
  await fsp.writeFile(path.join(mdir, 'rai_config.json'), '{}');
  await fsp.writeFile(path.join(mdir, 'dd_metastate_Llm_Token_x.state'), '');
  await fsp.truncate(path.join(mdir, 'dd_metastate_Llm_Token_x.state'), 80 * 1024 * 1024);
  const list = await models.listLocal(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].isOnnx, true);
  assert.equal(list[0].repo, 'Qwen3.5_9B_rai_1.9.0_npu');
  await fsp.rm(root, { recursive: true, force: true });
});

test('listLocal ignoriert reine Config-Ordner (keine große Modelldatei)', async () => {
  const os = require('os');
  const path = require('path');
  const fsp = require('fs/promises');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-cfg-'));
  const mdir = path.join(root, 'config-only');
  await fsp.mkdir(mdir, { recursive: true });
  await fsp.writeFile(path.join(mdir, 'genai_config.json'), '{}');
  await fsp.writeFile(path.join(mdir, 'model.onnx'), 'x'); // zu klein
  const list = await models.listLocal(root);
  assert.equal(list.length, 0);
  await fsp.rm(root, { recursive: true, force: true });
});

test('listLocal ignoriert leere bzw. Nicht-ONNX-Ordner', async () => {
  const os = require('os');
  const path = require('path');
  const fsp = require('fs/promises');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-onnx2-'));
  await fsp.mkdir(path.join(root, 'empty'), { recursive: true });
  await fsp.mkdir(path.join(root, 'notes'), { recursive: true });
  await fsp.writeFile(path.join(root, 'notes', 'readme.txt'), 'hi');
  const list = await models.listLocal(root);
  assert.equal(list.length, 0);
  await fsp.rm(root, { recursive: true, force: true });
});

test('listInstalled erkennt das ONNX-Backend über sein Manifest', async () => {
  const os = require('os');
  const path = require('path');
  const fsp = require('fs/promises');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-be-'));
  const onnxDir = path.join(root, 'onnx');
  await fsp.mkdir(onnxDir, { recursive: true });
  await fsp.writeFile(path.join(onnxDir, 'modelharbor-backend.json'),
    JSON.stringify({ id: 'onnx', serverPath: '/bin/true', label: 'ONNX Runtime (NPU)', onnx: true, npu: true }));
  const installed = await backends.listInstalled(root);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].id, 'onnx');
  assert.equal(installed[0].onnx, true);
  await fsp.rm(root, { recursive: true, force: true });
});

test('server.js reicht onnxPython durch und startet onnx_server.py', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'server.js'), 'utf8');
  assert.ok(src.includes('onnxPython'), 'startServer akzeptiert onnxPython');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'electron', 'onnx_server.py')), 'onnx_server.py ist gebündelt');
  assert.ok(src.includes('genai_config.json'), 'ONNX-Erkennung über genai_config.json');
});

/* -------------------- Erweitertes Debug-Logging -------------------- */

const logger = require('../electron/logger');

test('logger: bei debug=false passiert nichts (no-op)', () => {
  const os = require('os');
  const path = require('path');
  logger.configure({ debug: false, dir: '/nonexistent' });
  logger.debug('darf nicht auftauchen');
  assert.equal(logger.debugEnabled, false);
});

test('logger: schreibt Debug-Zeilen nach <dir>/logs/modelharbor-debug.log', () => {
  const os = require('os');
  const path = require('path');
  const fsp = require('fs/promises');
  const fs = require('fs');
  return (async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-log-'));
    logger.configure({ debug: true, dir });
    logger.debug('probe debug line');
    logger.error('probe error line');
    logger.configure({ debug: false, dir });
    const file = path.join(dir, 'logs', 'modelharbor-debug.log');
    assert.ok(fs.existsSync(file), 'Debug-Logdatei wurde erzeugt');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('probe debug line'), 'enthält debug-Meldung');
    assert.ok(text.includes('probe error line'), 'enthält error-Meldung');
    logger.configure({ debug: false, dir: null });
    await fsp.rm(dir, { recursive: true, force: true });
  })().catch((e) => { throw e; });
});

/* -------------------- ONNX-Katalog & Mehrfach-Download -------------------- */

test('ONNX-Katalog-Einträge haben onnxSub (Unterordner) oder null (Repo-Root)', () => {
  const onnxEntries = models.CATALOG.filter((c) => c.onnx);
  assert.equal(onnxEntries.length, 6);
  for (const e of onnxEntries) {
    assert.ok(e.repo.includes('/'), `${e.repo} ist ein HF-Repo`);
    // onnxSub: String = OGA-Unterordner, null = kompletter Repo-Root (Ryzen AI)
    assert.ok(e.onnxSub === null || (typeof e.onnxSub === 'string' && e.onnxSub.length > 0),
      `${e.repo} hat onnxSub (String) oder null`);
    if (typeof e.onnxSub === 'string') {
      assert.ok(!e.onnxSub.endsWith('/'), `${e.repo}: onnxSub ohne Slash am Ende`);
    }
    assert.ok(e.name && e.params && e.blurb, `${e.repo} hat Titel/Params/blurb`);
    assert.equal(e.preferQuant, null, `${e.repo} hat keinen Quant-Filter`);
  }
  const repos = onnxEntries.map((e) => e.repo);
  assert.ok(repos.includes('microsoft/Phi-3-mini-4k-instruct-onnx'));
  assert.ok(repos.includes('microsoft/Phi-4-mini-instruct-onnx'));
  assert.ok(repos.includes('onnx-community/Llama-3.2-1B-ONNX'));
  // Ryzen-AI-/NPU-Repos mit genai_config.json im Root (per HF-API verifiziert)
  assert.ok(repos.includes('amd/Qwen3.5_9B_rai_1.9.0_npu'));
  assert.ok(repos.includes('amd/Qwen3-8B-awq-quant-onnx-hybrid'));
  assert.ok(repos.includes('amd/Phi-4-mini-instruct-onnx-ryzenai-hybrid'));
  const qwen35 = onnxEntries.find((e) => e.repo === 'amd/Qwen3.5_9B_rai_1.9.0_npu');
  assert.equal(qwen35.onnxSub, null, 'Ryzen-AI-Repo lädt den ganzen Root');
  assert.equal(qwen35.rai, true, 'Eintrag ist als Ryzen AI markiert');
  assert.ok(qwen35.minGB >= 16, 'großer RAI-Build nennt seinen Platzbedarf');
});

test('parseOnnxFolderFiles: ganze Ordner-Downloads nur aus dem Root', () => {
  const siblings = [
    { rfilename: '.gitattributes', size: 100 },
    { rfilename: 'gitattributes', size: 5 },
    { rfilename: 'README.md', size: 200 },
    { rfilename: 'LICENSE', size: 50 },
    { rfilename: 'onnx_utils.log', size: 20 },
    { rfilename: 'cache/txn_bins.zip', size: 2285153 },
    { rfilename: 'partitioned/vision.onnx.data', size: 10129035 },
    { rfilename: 'genai_config.json', size: 3000 },
    { rfilename: 'chat_template.jinja', size: 900 },
    { rfilename: 'dd_metastate_Llm_Token_x.fconst', size: 3749412864 },
    { rfilename: 'dd_metastate_Llm_Token_x.state', size: 128 },
    { rfilename: 'text.onnx', size: 1835008 },
    { rfilename: 'text.onnx.data', size: 614891469 },
  ];
  const files = models.parseOnnxFolderFiles(siblings);
  assert.deepEqual(files.map((f) => f.name), [
    'chat_template.jinja', 'dd_metastate_Llm_Token_x.fconst', 'dd_metastate_Llm_Token_x.state',
    'genai_config.json', 'text.onnx', 'text.onnx.data',
  ]);
  for (const f of files) {
    assert.ok(!f.name.includes('/'), `${f.name} ist flach`);
    assert.equal(f.repoPath, f.name, 'Repo-Root: repoPath == name');
  }
  // Doku/Logs/Unterordner bleiben draußen
  const names = files.map((f) => f.name);
  assert.ok(!names.includes('README.md') && !names.includes('.gitattributes'));
  assert.ok(!names.includes('onnx_utils.log') && !names.some((n) => n.includes('cache')));
  assert.equal(models.parseOnnxFolderFiles(null).length, 0);
});

const onnxSiblings = [
  { rfilename: '.gitattributes', size: 100 },
  { rfilename: 'README.md', size: 200 },
  { rfilename: 'config.json', size: 876 },
  { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/genai_config.json', size: 1539 },
  { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/model.onnx', size: 107227 },
  { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/model.onnx.data', size: 1856839680 },
  { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/tokenizer.json', size: 9085657 },
  { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/tokenizer_config.json', size: 54528 },
  { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/special_tokens_map.json', size: 296 },
  { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/config.json', size: 876 },
  { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/README.md', size: 300 },
  { rfilename: 'cuda/cuda-fp16/genai_config.json', size: 1713 },
  { rfilename: 'cuda/cuda-fp16/model.onnx', size: 83869 },
  { rfilename: 'gpu/gpu-int4-rtn-block-32/model.onnx.data', size: 999 },
];

test('parseOnnxFiles: nur Dateien aus onnxSub, flach, ohne fremde Ordner', () => {
  const sub = 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4';
  const files = models.parseOnnxFiles(onnxSiblings, sub);
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, [
    'config.json', 'genai_config.json', 'model.onnx', 'model.onnx.data',
    'special_tokens_map.json', 'tokenizer.json', 'tokenizer_config.json',
  ]);
  for (const f of files) {
    assert.ok(!f.name.includes('/'), `${f.name} ist flach`);
    assert.equal(f.repoPath, `${sub}/${f.name}`, 'repoPath bleibt vollständig');
  }
  const data = files.find((f) => f.name === 'model.onnx.data');
  assert.equal(data.size, 1856839680, 'Größe kommt aus der HF-API');
});

test('parseOnnxFiles: fremder onnxSub liefert leere Liste, Ungültiges crasht nicht', () => {
  assert.deepEqual(models.parseOnnxFiles(onnxSiblings, 'cuda/cuda-int4-rtn-block-32'), []);
  assert.deepEqual(models.parseOnnxFiles(onnxSiblings, 'gibts/nicht'), []);
  assert.deepEqual(models.parseOnnxFiles(null, 'x'), []);
  assert.deepEqual(models.parseOnnxFiles(onnxSiblings, ''), [{ name: 'config.json', repoPath: 'config.json', size: 876, sha256: null, blobId: null }]);
  // anderer Unterordner bleibt getrennt (keine Vermischung von gpu/ und cpu_and_mobile/)
  assert.deepEqual(models.parseOnnxFiles(onnxSiblings, 'gpu/gpu-int4-rtn-block-32'),
    [{ name: 'model.onnx.data', repoPath: 'gpu/gpu-int4-rtn-block-32/model.onnx.data', size: 999, sha256: null, blobId: null }]);
});

test('parseOnnxFiles: erkennt auch Phi-4-Mini mit vocab.json/merges.txt', () => {
  const siblings = [
    { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/genai_config.json', size: 1 },
    { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/model.onnx', size: 2 },
    { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/model.onnx.data', size: 3 },
    { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/vocab.json', size: 4 },
    { rfilename: 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4/merges.txt', size: 5 },
    { rfilename: 'gpu/gpu-int4-rtn-block-32/genai_config.json', size: 6 },
  ];
  const files = models.parseOnnxFiles(siblings, 'cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4');
  assert.deepEqual(files.map((f) => f.name).sort(),
    ['genai_config.json', 'merges.txt', 'model.onnx', 'model.onnx.data', 'vocab.json']);
});

/* -------------------- uv / Python-3.12-Mitinstall -------------------- */

test('uvAssetFor liefert die richtigen uv-Release-Assets', () => {
  assert.equal(backends.uvAssetFor('linux', 'x64'), 'uv-x86_64-unknown-linux-gnu.tar.gz');
  assert.equal(backends.uvAssetFor('linux', 'arm64'), 'uv-aarch64-unknown-linux-gnu.tar.gz');
  assert.equal(backends.uvAssetFor('win32', 'x64'), 'uv-x86_64-pc-windows-msvc.zip');
  assert.equal(backends.uvAssetFor('win32', 'arm64'), 'uv-aarch64-pc-windows-msvc.zip');
  assert.equal(backends.uvAssetFor('darwin', 'arm64'), 'uv-aarch64-apple-darwin.tar.gz');
  assert.equal(backends.uvAssetFor('darwin', 'x64'), 'uv-x86_64-apple-darwin.tar.gz');
});

test('uvAssetFor: unbekannte Plattform/Architektur liefert null', () => {
  assert.equal(backends.uvAssetFor('freebsd', 'x64'), null);
  assert.equal(backends.uvAssetFor('linux', 'ia32'), null);
  assert.equal(backends.uvAssetFor(undefined, undefined), null);
});

/* -------------------- VRAM: Registry-QWORD + Namens-Schätzung -------------------- */

const GB = 1024 * 1024 * 1024;

test('estimateVramFromName: bekannte dGPUs liefern ihren typischen VRAM', () => {
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4070'), 12 * GB);
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4060'), 8 * GB);
  assert.equal(estimateVramFromName('AMD Radeon RX 7900 XTX'), 24 * GB);
  assert.equal(estimateVramFromName('AMD Radeon RX 9070'), 16 * GB);
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4090'), 24 * GB);
  assert.equal(estimateVramFromName('Intel(R) Arc(TM) A770 Graphics'), 16 * GB);
});

test('estimateVramFromName: Ti-/XT-Varianten werden nicht verwechselt', () => {
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4070 Ti'), 12 * GB);
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4060 Ti'), 8 * GB);
  assert.equal(estimateVramFromName('AMD Radeon RX 7900 XT'), 20 * GB);
  assert.equal(estimateVramFromName('AMD Radeon RX 9070 XT'), 16 * GB);
  assert.equal(estimateVramFromName('NVIDIA GeForce GTX 1660 Ti'), 6 * GB);
});

test('estimateVramFromName: integrierte Grafiken und Unbekanntes liefern null', () => {
  assert.equal(estimateVramFromName('AMD Radeon(TM) Graphics'), null);
  assert.equal(estimateVramFromName('Intel(R) HD Graphics'), null);
  assert.equal(estimateVramFromName('Intel(R) Iris(R) Xe Graphics'), null);
  assert.equal(estimateVramFromName('Irgendeine GPU 3000'), null);
  assert.equal(estimateVramFromName(''), null);
  assert.equal(estimateVramFromName(null), null);
});

test('estimateVramFromName: Laptop-/Mobil-Varianten werden nicht geschätzt', () => {
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4070 Laptop GPU'), null);
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 3080 Mobile'), null);
});

test('pickRegistryVram: ordnet qwMemorySize über den Treibernamen zu', () => {
  const entries = [
    { driverDesc: 'NVIDIA GeForce RTX 4070', bytes: 12884901888 },
    { driverDesc: 'Intel(R) UHD Graphics 770', bytes: 1073741824 },
  ];
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4070', entries), 12884901888);
  // WMI-Name und DriverDesc weichen leicht ab -> Teiltreffer greift
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4070 (Desktop)', entries), 12884901888);
  assert.equal(pickRegistryVram('AMD Radeon RX 7900 XTX', entries), null);
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4070', []), null);
  assert.equal(pickRegistryVram('', entries), null);
});
