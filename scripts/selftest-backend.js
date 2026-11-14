'use strict';
// Einmaliger Selbsttest: lädt das passende CPU-Backend über backends.js
const b = require('../electron/backends');
const path = require('path');

(async () => {
  const installRoot = path.join(__dirname, '..', '.runtime', 'backends');
  const rel = await b.latestRelease();
  console.log('Release:', rel.tag, 'Assets:', rel.assets.length);
  let last = 0;
  const manifest = await b.installBackend('linux-cpu', {
    installRoot,
    onProgress: (p) => {
      const now = Date.now();
      if (p.phase === 'download' && now - last > 1000) {
        last = now;
        console.log(`  download ${p.percent ? p.percent.toFixed(1) : '?'}%  ${(p.doneBytes / 1048576).toFixed(0)}/${(p.totalBytes / 1048576).toFixed(0)} MB`);
      } else if (p.phase !== 'download') {
        console.log('  ', p.phase, p.percent ? p.percent.toFixed(1) + '%' : '');
      }
    },
  });
  console.log('Installiert:', JSON.stringify({ id: manifest.id, release: manifest.release, serverPath: manifest.serverPath }, null, 2));
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
