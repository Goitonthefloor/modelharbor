/* Anhänge im Chat: baut aus Text + Dateien + Bildern den Request-Inhalt.
   Reine Funktionen — im Renderer global, in Node testbar (Muster wie sse.js). */
(function (root) {
  'use strict';

  /** Zahl mit Punkt als Tausendertrenner (sprachneutral im Prompt). */
  function num(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /**
   * Kopfzeile eines Datei-Blocks. Der Modellkontext ist englisch, damit
   * mehrsprachige Modelle die Marke nicht als Nutzertext lesen.
   */
  function fileHeader(att) {
    const chars = num(att.chars || (att.text ? att.text.length : 0));
    let head = `[Attached file: ${att.name} — ${chars} chars`;
    if (att.truncated) head += `, truncated from ${num(att.totalChars || 0)}`;
    return `${head}]`;
  }

  /**
   * Aus Nutzertext und Anhängen den Inhalt einer Chat-Nachricht bauen.
   *
   * - nur Text/Dateien  -> String (klassischer Chat-Verlauf, kompakt)
   * - mit Bildern       -> OpenAI-Content-Array [{type:'text'},{type:'image_url'}]
   *
   * Datei-Anhänge landen als klar markierte Blöcke HINTER dem Nutzertext,
   * damit die Frage im Modell oben steht.
   *
   * @param {string} text
   * @param {{files?: object[], images?: object[]}} [att]
   * @returns {string|object[]}
   */
  function composeContent(text, att) {
    const files = (att && att.files) || [];
    const images = (att && att.images) || [];
    const parts = [];
    const body = String(text == null ? '' : text).trim();
    if (body) parts.push(body);
    for (const f of files) {
      parts.push(`${fileHeader(f)}\n${f.text || ''}\n[End of file: ${f.name}]`);
    }
    const joined = parts.join('\n\n');
    if (!images.length) return joined;

    const content = [];
    if (joined) content.push({ type: 'text', text: joined });
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    }
    return content;
  }

  /** Kurzbeschreibung eines Anhangs für die Nachrichtenblase. */
  function attachmentLabel(att) {
    if (att.kind === 'image') return att.name;
    const chars = num(att.chars || (att.text ? att.text.length : 0));
    return `${att.name} · ${chars} Zeichen${att.truncated ? ' (gekürzt)' : ''}`;
  }

  /** Enthält der Inhalt Bilder? (Verlauf kann String oder Array sein.) */
  function hasImages(content) {
    return Array.isArray(content) && content.some((p) => p && p.type === 'image_url');
  }

  const api = { composeContent, fileHeader, attachmentLabel, hasImages, num };
  Object.assign(root, api);
  // Namensraum wie bei BENCH: app.js greift als MHAttachments.… zu.
  root.MHAttachments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
