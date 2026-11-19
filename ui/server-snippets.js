/* Verbindungs-Beispiele für Agenten: reine Funktionen, im Renderer global, in Node testbar.
 * Eine Quelle für Backend (server-config.js) und UI (Server-Tab). */
(function (root) {
  'use strict';

  /** Stabiler Modellname für Agenten — bleibt gleich, wenn das Modell wechselt. */
  const MODEL_ALIAS = 'ModelHarbor';
  /** OpenAI-Clients brauchen einen nicht-leeren Key, auch wenn keiner geprüft wird. */
  const NO_KEY_PLACEHOLDER = 'sk-no-key-required';

  function baseUrl(ip, port) { return `http://${ip}:${port}/v1`; }

  function curlExample(cfg, ip = '127.0.0.1') {
    const lines = [
      `curl ${baseUrl(ip, cfg.port)}/chat/completions \\`,
      '  -H "Content-Type: application/json" \\',
    ];
    if (cfg.apiKey) lines.push(`  -H "Authorization: Bearer ${cfg.apiKey}" \\`);
    lines.push(`  -d '{"model":"${MODEL_ALIAS}","messages":[{"role":"user","content":"Hallo"}]}'`);
    return lines.join('\n');
  }

  function pythonExample(cfg, ip = '127.0.0.1') {
    return [
      'from openai import OpenAI',
      '',
      `client = OpenAI(base_url="${baseUrl(ip, cfg.port)}", api_key="${cfg.apiKey || NO_KEY_PLACEHOLDER}")`,
      'resp = client.chat.completions.create(',
      `    model="${MODEL_ALIAS}",`,
      '    messages=[{"role": "user", "content": "Hallo"}],',
      ')',
      'print(resp.choices[0].message.content)',
    ].join('\n');
  }

  function agentJson(cfg, ip = '127.0.0.1') {
    return JSON.stringify({
      base_url: baseUrl(ip, cfg.port),
      api_key: cfg.apiKey || NO_KEY_PLACEHOLDER,
      model: MODEL_ALIAS,
    }, null, 2);
  }

  const api = { MODEL_ALIAS, NO_KEY_PLACEHOLDER, baseUrl, curlExample, pythonExample, agentJson };
  root.SERVER_SNIPPETS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
