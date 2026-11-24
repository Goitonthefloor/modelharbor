/* Benchmark-Messung: reine Logik, im Renderer global, in Node testbar.
 *
 * Gemessen wird gegen den lokalen OpenAI-kompatiblen Endpunkt (llama-server oder
 * ONNX), damit dasselbe Verfahren für jedes Backend gilt. Drei Lastfälle
 * (kurzer/mittlerer/langer Prompt) trennen Prompt-Verarbeitung von Generierung:
 *   - Prefill: prompt_tokens / Zeit bis zum ersten Token (TTFT)
 *   - Generierung: completion_tokens / Zeit zwischen erstem und letztem Token
 * llama.cpp liefert zusätzlich `timings`; die werden bevorzugt, weil sie im
 * Server gemessen sind und nicht Netzwerk/Streaming enthalten. */
(function (root) {
  'use strict';

  /** Lastfälle: Zeichenzahl des Fülltexts + Antwortbudget. */
  const CASES = [
    { id: 'short', chars: 400, maxTokens: 64 },
    { id: 'medium', chars: 6000, maxTokens: 128 },
    { id: 'long', chars: 24000, maxTokens: 128 },
  ];

  // Deterministischer Fülltext (kein Zufall): gleiche Eingabe für jeden Lauf,
  // damit Messwerte zwischen Backends vergleichbar bleiben.
  const FILLER = 'Der schnelle braune Fuchs springt über den faulen Hund. '
    + 'ModelHarbor misst, wie schnell lokale Sprachmodelle auf dieser Maschine antworten. '
    + 'Die Küstenlinie bei Sonnenaufgang ist ein beliebtes Motiv für Langzeitbelichtungen. ';

  const QUESTION = '\n\nSchreibe einen kurzen, zusammenhängenden Absatz über den Inhalt des Textes.';

  /** Fülltext auf die gewünschte Länge bringen (immer ganze Sätze). */
  function buildPrompt(chars) {
    const target = Math.max(120, Number(chars) || 0);
    let text = '';
    while (text.length < target) text += FILLER;
    return text.slice(0, target) + QUESTION;
  }

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  /** SSE-Nutzdaten eines Chunks — im Browser aus ui/sse.js, in Node nachgeladen. */
  function sseParse(buf, final) {
    const fn = root.parseSseChunk || require('./sse.js').parseSseChunk;
    return fn(buf, final);
  }

  /**
   * Einen Lastfall messen.
   * @param {{port:number, apiKey?:string, c:object, fetchImpl?:Function, signal?:AbortSignal, now?:Function}} o
   * @returns {Promise<{id:string, promptTokens:number, completionTokens:number,
   *   ttftMs:number, prefillTps:number, genTps:number, source:string}>}
   */
  async function measureCase(o) {
    const fetchImpl = o.fetchImpl || root.fetch;
    const now = o.now || ((root.performance && root.performance.now) ? () => root.performance.now() : Date.now);
    const c = o.c;
    const prompt = buildPrompt(c.chars);
    const headers = { 'Content-Type': 'application/json' };
    if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;

    const body = {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: c.maxTokens,
      temperature: 0,
      seed: 42,
      stream: true,
      stream_options: { include_usage: true },
    };

    const t0 = now();
    const res = await fetchImpl(`http://127.0.0.1:${o.port}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: o.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body || !res.body.getReader) throw new Error('no stream');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let firstAt = 0;
    let lastAt = 0;
    let chars = 0;
    let usage = null;
    let timings = null;

    const handle = (payloads) => {
      for (const p of payloads) {
        if (!p) continue;
        if (p.usage) usage = p.usage;
        if (p.timings) timings = p.timings;
        const choice = p.choices && p.choices[0];
        const delta = choice && (choice.delta || choice.message);
        const piece = delta && typeof delta.content === 'string' ? delta.content : '';
        if (!piece) continue;
        const at = now();
        if (!firstAt) firstAt = at;
        lastAt = at;
        chars += piece.length;
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (!chunk) continue;
      const parsed = sseParse(buf + chunk, false);
      buf = parsed.rest;
      handle(parsed.payloads);
    }
    handle(sseParse(buf, true).payloads);
    if (!firstAt) throw new Error('no tokens');

    const ttftMs = Math.max(0, Math.round(firstAt - t0));
    const genMs = Math.max(1, lastAt - firstAt);
    // Ohne Usage (ältere Server) grob über Zeichen schätzen — als Schätzung markiert.
    const promptTokens = usage && usage.prompt_tokens ? usage.prompt_tokens : Math.round(prompt.length / 3.6);
    const completionTokens = usage && usage.completion_tokens ? usage.completion_tokens : Math.round(chars / 3.6);

    const fromServer = !!(timings && timings.predicted_per_second);
    const genTps = fromServer
      ? timings.predicted_per_second
      : (completionTokens > 1 ? (completionTokens - 1) / (genMs / 1000) : 0);
    const prefillTps = timings && timings.prompt_per_second
      ? timings.prompt_per_second
      : (ttftMs > 0 ? promptTokens / (ttftMs / 1000) : 0);

    return {
      id: c.id,
      promptTokens,
      completionTokens,
      ttftMs,
      prefillTps: round2(prefillTps),
      genTps: round2(genTps),
      source: fromServer ? 'server' : 'client',
    };
  }

  /**
   * Alle Lastfälle nacheinander messen (sequenziell: parallele Läufe würden sich
   * auf derselben GPU gegenseitig verfälschen).
   * @param {object} o  { port, apiKey, cases?, onCase?, signal?, fetchImpl?, now? }
   */
  async function run(o) {
    const cases = o.cases && o.cases.length ? o.cases : CASES;
    const results = [];
    for (const c of cases) {
      if (o.signal && o.signal.aborted) break;
      if (o.onCase) o.onCase(c, null);
      const r = await measureCase({ ...o, c });
      results.push(r);
      if (o.onCase) o.onCase(c, r);
    }
    const avg = (key) => (results.length
      ? round2(results.reduce((s, r) => s + r[key], 0) / results.length)
      : 0);
    return {
      results,
      genTps: avg('genTps'),
      prefillTps: avg('prefillTps'),
      ttftMs: results.length
        ? Math.round(results.reduce((s, r) => s + r.ttftMs, 0) / results.length)
        : 0,
    };
  }

  const api = { CASES, FILLER, QUESTION, buildPrompt, measureCase, run, round2 };
  Object.assign(root, { BENCH: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
