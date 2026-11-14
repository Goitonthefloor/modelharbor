'use strict';
// Lädt ein kleines Testmodell in den echten App-Modellordner.
const os = require('os');
const path = require('path');
const models = require('../electron/models');

const modelsDir = path.join(os.homedir(), '.config', 'ModelHarbor', 'models');

(async () => {
  let last = 0;
  console.log('Zielordner:', modelsDir);
  const res = await models.downloadModel({
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    modelsDir,
    onProgress: (p) => {
      const now = Date.now();
      if (now - last > 1200) {
        last = now;
        console.log(`  ${p.phase} ${p.percent ? p.percent.toFixed(1) + '%' : ''} ${p.received ? (p.received / 1048576).toFixed(0) + ' MB' : ''}`);
      }
    },
  });
  console.log('OK:', JSON.stringify(res, null, 2));
  const local = await models.listLocal(modelsDir);
  console.log('Lokale Modelle:', local.map((m) => `${m.repo} / ${m.file} (${m.sizeLabel})`));
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
