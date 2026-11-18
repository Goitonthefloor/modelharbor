/* KV-Cache-Fakten: reine Funktionen, im Renderer global, in Node testbar.
 * Eine Quelle für Backend (Speicherabschätzung, Flags) und UI (Live-Anzeige). */
(function (root) {
  'use strict';

  /** Von llama.cpp unterstützte Cache-Typen (Reihenfolge = Auswahl im UI). */
  const CACHE_TYPES = ['f16', 'bf16', 'f32', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'];
  const DEFAULT_CACHE = 'f16';

  /** Bytes pro Cache-Wert inkl. Block-Overhead (GGML-Blockgrößen). */
  const CACHE_BYTES = {
    f32: 4, f16: 2, bf16: 2,
    q8_0: 34 / 32, q5_1: 24 / 32, q5_0: 22 / 32, q4_1: 20 / 32, q4_0: 18 / 32, iq4_nl: 18 / 32,
  };

  function isQuantized(type) { return !!type && !['f16', 'bf16', 'f32'].includes(type); }

  /** Speicherfaktor gegenüber f16/f16; K und V getrennt gewichtet. */
  function kvFactor(cacheTypeK, cacheTypeV) {
    const k = CACHE_BYTES[cacheTypeK] || CACHE_BYTES[DEFAULT_CACHE];
    const v = CACHE_BYTES[cacheTypeV] || CACHE_BYTES[DEFAULT_CACHE];
    return (k + v) / (2 * CACHE_BYTES[DEFAULT_CACHE]);
  }

  /**
   * KV-Cache-Bedarf in GB. `baseGB` ist die f16-Schätzung des Backends für
   * `baseCtx` Tokens; der Bedarf wächst linear mit der Kontextlänge.
   */
  function kvEstimateGB(baseGB, baseCtx, ctx, cacheTypeK, cacheTypeV) {
    const base = Number(baseGB) || 0;
    const refCtx = Number(baseCtx) || 8192;
    const wantCtx = Number(ctx) || refCtx;
    return base * (wantCtx / refCtx) * kvFactor(cacheTypeK, cacheTypeV);
  }

  const api = { CACHE_TYPES, CACHE_BYTES, DEFAULT_CACHE, isQuantized, kvFactor, kvEstimateGB };
  root.KVCACHE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
