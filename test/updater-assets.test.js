'use strict';
/**
 * Regressionstests Audit-Befund F14: Asset-Auswahl im Updater.
 * 6 Assets × 3 Plattformen (linux/win32/darwin) plus Randfälle:
 * beliebige .exe (Helfer) ist kein Installer, unbekannte Plattformen
 * (z. B. freebsd) bekommen kein Linux-Paket, macOS ohne .dmg -> null.
 */
const test = require('node:test');
const assert = require('node:assert');

const { pickAsset } = require('../electron/updater.js');

// Alle Assets, die ein Release typischerweise enthält.
const assets = [
  { name: 'ModelHarbor-Setup-2.0.0.exe', url: 'https://example.invalid/setup.exe' },
  { name: 'ModelHarbor-2.0.0.AppImage', url: 'https://example.invalid/app.AppImage' },
  { name: 'ModelHarbor-2.0.0-arm64.dmg', url: 'https://example.invalid/mac.dmg' },
  { name: 'helper.exe', url: 'https://example.invalid/helper.exe' },
  { name: 'ModelHarbor-2.0.0.deb', url: 'https://example.invalid/pkg.deb' },
  { name: 'latest.yml', url: 'https://example.invalid/latest.yml' },
];

test('F14: Asset-Matrix 6 Assets × 3 Plattformen', () => {
  const matrix = [
    ['linux', 'ModelHarbor-2.0.0.AppImage'],
    ['win32', 'ModelHarbor-Setup-2.0.0.exe'],
    ['darwin', 'ModelHarbor-2.0.0-arm64.dmg'],
  ];
  for (const [platform, want] of matrix) {
    const hit = pickAsset(assets, platform);
    assert.ok(hit, `${platform} findet ein Asset`);
    assert.equal(hit.name, want, `${platform} -> ${want}`);
  }
});

test('F14: nur der NSIS-Installer gilt als Windows-Paket, nicht "helper.exe"', () => {
  const nurHelfer = [{ name: 'helper.exe', url: 'https://example.invalid/helper.exe' }];
  assert.equal(pickAsset(nurHelfer, 'win32'), null, 'helper.exe ist kein Installer');
  const mitBeidem = [
    { name: 'helper.exe', url: 'https://example.invalid/helper.exe' },
    { name: 'ModelHarbor-Setup-2.0.0.exe', url: 'https://example.invalid/setup.exe' },
  ];
  assert.equal(pickAsset(mitBeidem, 'win32').name, 'ModelHarbor-Setup-2.0.0.exe');
});

test('F14: unbekannte Plattformen (freebsd) bekommen kein AppImage untergeschoben', () => {
  assert.equal(pickAsset(assets, 'freebsd'), null);
  assert.equal(pickAsset(assets, 'openbsd'), null);
  assert.equal(pickAsset(assets, 'android'), null);
});

test('F14: macOS ohne .dmg wird sauber abgelehnt', () => {
  const ohneDmg = assets.filter((a) => !a.name.endsWith('.dmg'));
  assert.equal(pickAsset(ohneDmg, 'darwin'), null);
  // Ein .zip wird nicht als macOS-Paket akzeptiert
  assert.equal(pickAsset([{ name: 'ModelHarbor-2.0.0-mac.zip', url: 'x' }], 'darwin'), null);
});

test('F14: leere/kaputte Asset-Listen liefern null', () => {
  assert.equal(pickAsset([], 'linux'), null);
  assert.equal(pickAsset(null, 'linux'), null);
  assert.equal(pickAsset(undefined, 'win32'), null);
  assert.equal(pickAsset([{ name: null, url: 'x' }, {}], 'linux'), null);
});
