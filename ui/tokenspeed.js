/* Token-Geschwindigkeit: reine Rechenfunktion, im Renderer global, in Node testbar. */
(function (root) {
  'use strict';

  /**
   * Antwort-Tokens pro Sekunde aus dem Messfenster zwischen erstem und letztem
   * Stream-Delta. Das erste Token fällt am Anfang des Fensters an, deshalb
   * verteilen sich nur (n - 1) Intervalle auf die gemessene Dauer.
   *
   * @param {number} completionTokens  vom Server gemeldete Antwort-Tokens
   * @param {number} genMs             Dauer in ms vom ersten bis zum letzten Delta
   * @returns {number} Tokens/s, oder 0 wenn die Messung nicht belastbar ist
   */
  function tokensPerSecond(completionTokens, genMs) {
    if (!Number.isFinite(completionTokens) || !Number.isFinite(genMs)) return 0;
    if (completionTokens < 2 || genMs < 250) return 0;
    return (completionTokens - 1) / (genMs / 1000);
  }

  root.tokensPerSecond = tokensPerSecond;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { tokensPerSecond: tokensPerSecond };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
