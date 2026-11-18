/* SSE-Parsing für den Chat-Stream: reine Funktion, im Renderer global, in Node testbar. */
(function (root) {
  'use strict';

  /**
   * Zerlegt einen SSE-Puffer in JSON-Nutzdaten.
   *
   * Ein Chunk endet mitten in einer Zeile — der unvollständige Rest wird
   * zurückgegeben und beim nächsten Chunk vorangestellt. Mit `final = true`
   * wird auch die letzte Zeile ohne abschließendes Newline ausgewertet:
   * sonst geht das letzte Delta (oft der Usage-Block) verloren.
   *
   * @param {string} buf      bisheriger Puffer inklusive neuem Chunk
   * @param {boolean} [final] Stream ist beendet -> Restzeile auswerten
   * @returns {{payloads: object[], rest: string}}
   */
  function parseSseChunk(buf, final = false) {
    const text = String(buf == null ? '' : buf);
    const parts = text.split('\n');
    const rest = final ? '' : parts.pop();
    const payloads = [];
    for (const raw of parts) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { payloads.push(JSON.parse(data)); } catch { /* unvollständig/kein JSON */ }
    }
    return { payloads, rest };
  }

  root.parseSseChunk = parseSseChunk;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseSseChunk };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
