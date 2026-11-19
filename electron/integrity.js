'use strict';
/**
 * integrity.js — Prüfsummen-Abgleich für heruntergeladene Artefakte.
 *
 * Backend-Archive (GitHub-Release-Assets) werden entpackt und ausgeführt,
 * Modelldateien (HuggingFace) geladen. Ohne Hash-Bindung genügt eine manipulierte
 * Auslieferung (kompromittiertes Release, vorgeschalteter Proxy, Spiegel), um Code
 * im Nutzerkonto auszuführen. Die Dateigröße allein erkennt das nicht.
 *
 * Fail closed: fehlt der erwartete Digest oder weicht er ab, wird die Datei
 * verworfen — nie entpackt, umbenannt oder gestartet.
 *
 * Quellen der Erwartungswerte (live geprüft):
 *  - GitHub-Release-API: assets[].digest = "sha256:<hex>"
 *  - HuggingFace-API (?blobs=true): siblings[].lfs.sha256 für LFS-Dateien,
 *    siblings[].blobId (Git-Blob-SHA1) für kleine Nicht-LFS-Dateien.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const i18n = require('../ui/i18n');

const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;

/** 'sha256:<hex>' oder blankes Hex → lowercase Hex, sonst null. */
function normalizeSha256(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^sha256:/i, '').toLowerCase();
  return SHA256_RE.test(hex) ? hex : null;
}

/** Git-Blob-SHA1 (40 Hex) oder null. */
function normalizeSha1(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  return SHA1_RE.test(hex) ? hex : null;
}

/** SHA-256 einer Datei, streamend (konstanter Speicher, auch für GB-Dateien). */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Git-Blob-SHA1 einer Datei: sha1("blob <bytezahl>\0" + inhalt).
 * Genau der Wert, den die HuggingFace-API als blobId liefert.
 */
async function gitBlobSha1File(filePath) {
  const { size } = await fsp.stat(filePath);
  const hash = crypto.createHash('sha1');
  hash.update(`blob ${size}\0`);
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Prüft eine vollständig heruntergeladene Datei gegen die erwarteten Digests.
 * @param {string} filePath
 * @param {{sha256?: string, blobId?: string}} expected
 * @param {string} label Dateiname für die Fehlermeldung
 * @returns {Promise<string>} der bestätigte Hash
 */
async function verifyDownload(filePath, expected, label) {
  const sha = normalizeSha256(expected && expected.sha256);
  const blob = normalizeSha1(expected && expected.blobId);
  const want = sha || blob;
  if (!want) throw new Error(i18n.t('error.digestMissing', { file: label }));
  const got = sha ? await sha256File(filePath) : await gitBlobSha1File(filePath);
  if (got !== want) {
    // Manipulierte Datei nicht liegen lassen: sonst würde ein Resume sie erneut
    // anbieten und ein späterer Lauf sie ohne Prüfung übernehmen.
    await fsp.rm(filePath, { force: true }).catch(() => {});
    throw new Error(i18n.t('error.digestMismatch', { file: label }));
  }
  return got;
}

module.exports = { normalizeSha256, normalizeSha1, sha256File, gitBlobSha1File, verifyDownload };
