/* Backend pro Modell: welche Engine startet, wenn dieses Modell geladen wird.
 * Eine Quelle für Main (server:start) und Renderer (Badges) — wie ui/kvcache.js
 * im Renderer global, in Node per require nutzbar.
 *
 * Hintergrund: GGUF-Modelle laufen immer über llama.cpp, ONNX-Modelle immer über
 * OnnxRuntime-GenAI. Welches llama.cpp-Backend startet, hängt von den installierten
 * Backends und der Hardware-Empfehlung ab — nicht von der Datei. */
(function (root) {
  'use strict';

  const ONNX_ID = 'onnx';

  /** Kurzname je Backend-ID für Badges (Label der Manifeste ist zu lang). */
  const SHORT_NAMES = {
    'onnx': 'ONNX',
    'win-cuda-12.4': 'CUDA 12.4',
    'win-cuda-13.5': 'CUDA 13.5',
    'win-cuda-13.5-arm64': 'CUDA 13.5',
    'linux-cuda-12.8': 'CUDA 12.8',
    'win-vulkan': 'Vulkan',
    'win-vulkan-arm64': 'Vulkan',
    'linux-vulkan': 'Vulkan',
    'linux-vulkan-arm64': 'Vulkan',
    'win-rocm': 'ROCm',
    'linux-rocm': 'ROCm',
    'win-sycl': 'SYCL',
    'linux-sycl-fp16': 'SYCL',
    'win-openvino': 'OpenVINO',
    'linux-openvino': 'OpenVINO',
    'win-cpu-x64': 'CPU',
    'win-cpu-arm64': 'CPU',
    'linux-cpu': 'CPU',
    'linux-cpu-arm64': 'CPU',
    'macos-arm64': 'Metal',
    'macos-x64': 'CPU',
  };

  /** Kurzname aus ID, sonst aus dem Label (`Vulkan (NVIDIA/AMD/Intel)` → `Vulkan`). */
  function shortName(id, label) {
    if (id && SHORT_NAMES[id]) return SHORT_NAMES[id];
    const text = String(label || id || '').trim();
    if (!text) return '';
    return text.split('(')[0].split(' / ')[0].trim();
  }

  /** Ist das ein llama.cpp-Backend (also alles außer ONNX)? */
  function isLlamaBackend(b) {
    return !!b && b.id !== ONNX_ID;
  }

  /**
   * Backend, das für dieses Modell tatsächlich startet.
   * `installed` = Manifeste aus backends.listInstalled(), `primary` = Empfehlung der
   * Hardware-Erkennung. ONNX-Modelle bekommen ausschließlich das ONNX-Backend,
   * GGUF-Modelle nie (llama.cpp kann keine ONNX-Ordner laden).
   * Rückgabe: Manifest oder null (= nötiges Backend fehlt).
   */
  function pick(installed, opts) {
    const o = opts || {};
    const list = (installed || []).filter(Boolean);
    if (o.isOnnx) return list.find((b) => b.id === ONNX_ID) || null;
    const llama = list.filter(isLlamaBackend);
    return llama.find((b) => b.id === o.primary) || llama[0] || null;
  }

  /**
   * Anzeige-Daten für ein Modell. Sprachfrei — Texte baut der Renderer aus i18n.
   * { kind: 'onnx'|'llama', engine, backendId, backendLabel, backendShort, missing }
   */
  function describe(installed, opts) {
    const o = opts || {};
    const isOnnx = !!o.isOnnx;
    const backend = pick(installed, { isOnnx, primary: o.primary });
    return {
      kind: isOnnx ? 'onnx' : 'llama',
      engine: isOnnx ? 'onnxruntime-genai' : 'llama.cpp',
      backendId: backend ? backend.id : null,
      backendLabel: backend ? (backend.label || backend.id) : null,
      backendShort: backend ? shortName(backend.id, backend.label) : null,
      missing: !backend,
    };
  }

  const api = { ONNX_ID, SHORT_NAMES, shortName, isLlamaBackend, pick, describe };
  root.MODELBACKEND = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
