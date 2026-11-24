#!/usr/bin/env node
'use strict';
/* Startpunkt für `model-harbor` (npm bin). Die Logik liegt in cli/index.js. */

require('../cli/index').main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`Fehler: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
