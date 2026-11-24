'use strict';
/**
 * Regressionstests zu Audit-Finding F5 (iGPU-Erkennung funktioniert nie).
 *
 * Die Fixtures sind echte Gerätenamen, wie sie auf Zielsystemen auftauchen:
 *   - Windows: `wmic path win32_VideoController get name` / WMI-DriverDesc
 *   - Linux:   `lspci -nn` bzw. `lspci -nnk` (VGA compatible controller)
 *   - macOS:   `system_profiler SPDisplaysDataType` (Chipset-Modell)
 * Erwartet wird jeweils, ob die GPU integriert (geteilter Speicher) ist.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  isIntegrated,
  vendorFromName,
  estimateVramFromName,
  estimateVramBytesFromName,
  pickRegistryVram,
} = require('../electron/hardware.js');

const GB = 1024 * 1024 * 1024;

/** [Quelle, Gerätename, erwartet integriert?] */
const FIXTURES = [
  // ---------- Windows/WMI: Intel ----------
  ['wmic', 'Intel(R) UHD Graphics 770', true],
  ['wmic', 'Intel(R) UHD Graphics 630', true],
  ['wmic', 'Intel(R) Iris(R) Xe Graphics', true],
  ['wmic', 'Intel(R) HD Graphics 530', true],
  ['wmic', 'Intel(R) Arc(TM) Graphics', true], // Meteor-Lake-iGPU
  ['wmic', 'Intel(R) Arc(TM) 140V Graphics', true], // Lunar-Lake-iGPU
  ['wmic', 'Intel(R) Arc(TM) A770 Graphics', false], // dGPU trotz "Graphics"
  ['wmic', 'Intel(R) Arc(TM) B580 Graphics', false],

  // ---------- Windows/WMI: AMD ----------
  ['wmic', 'AMD Radeon(TM) Graphics', true], // Zen-APU ohne Modellnummer
  ['wmic', 'AMD Radeon(TM) 780M Graphics', true],
  ['wmic', 'AMD Radeon 610M', true],
  ['wmic', 'AMD Radeon 680M', true],
  ['wmic', 'AMD Radeon 880M', true],
  ['wmic', 'AMD Radeon RX 7900 XTX', false],
  ['wmic', 'AMD Radeon HD 7970', false], // altes "HD" ist diskret, nicht Intels HD

  // ---------- Windows/WMI: NVIDIA ----------
  ['wmic', 'NVIDIA GeForce RTX 4090', false],
  ['wmic', 'NVIDIA GeForce RTX 3060 Laptop GPU', false],
  ['wmic', 'NVIDIA GeForce GTX 1650', false],

  // ---------- Windows: virtuelle/Software-Adapter ----------
  ['wmic', 'Microsoft Basic Display Adapter', true],
  ['wmic', 'Microsoft Basic Render Driver', true],
  ['wmic', 'VMware SVGA II Adapter', true],
  ['wmic', 'VirtualBox Graphics Adapter', true],
  ['wmic', 'Red Hat QXL controller', true],
  ['wmic', 'Microsoft Hyper-V Video', true],

  // ---------- Linux: lspci -nn ----------
  ['lspci', 'Intel Corporation AlderLake-S GT1 [UHD Graphics 770] [8086:4680] (rev 0c)', true],
  ['lspci', 'Intel Corporation Raptor Lake-P [Iris Xe Graphics] (rev 04)', true],
  ['lspci', 'Intel Corporation DG2 [Arc A770] (rev 08)', false],
  ['lspci', 'Advanced Micro Devices, Inc. [AMD/ATI] Phoenix1 [Radeon 780M] (rev c1)', true],
  ['lspci', 'Advanced Micro Devices, Inc. [AMD/ATI] Rembrandt [Radeon 680M] (rev c8)', true],
  ['lspci', 'Advanced Micro Devices, Inc. [AMD/ATI] Renoir (rev c6)', true], // nur Codename
  ['lspci', 'Advanced Micro Devices, Inc. [AMD/ATI] Cezanne [Radeon Vega Series / Radeon Vega Mobile Series]', true],
  ['lspci', 'Advanced Micro Devices, Inc. [AMD/ATI] Strix1 [Radeon 890M] (rev 01)', true],
  ['lspci', 'Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XT] (rev c8)', false],
  ['lspci', 'Advanced Micro Devices, Inc. [AMD/ATI] Vega 20 [Radeon Pro VII]', false],
  ['lspci', 'Advanced Micro Devices, Inc. [AMD/ATI] Cape Verde PRO [Radeon HD 7750/8740 / R7 250E]', false],
  ['lspci', 'NVIDIA Corporation AD102 [GeForce RTX 4090] (rev a1)', false],
  ['lspci', 'NVIDIA Corporation GA104 [GeForce RTX 3070 Ti] (rev a1)', false],
  ['lspci', 'Intel Corporation HD Graphics 620 (rev 02)', true],

  // ---------- macOS / SoC ----------
  ['system_profiler', 'Apple M1', true],
  ['system_profiler', 'Apple M2 Pro', true],
  ['system_profiler', 'Apple M3 Max', true],
  ['wmic', 'Qualcomm(R) Adreno(TM) 680 GPU', true],

  // ---------- Offscreen-Software-Renderer ----------
  ['glxinfo', 'llvmpipe (LLVM 15.0.7, 256 bits)', true],
];

test('F5: isIntegrated klassifiziert echte lspci-/wmic-Namen korrekt', () => {
  const falsch = [];
  for (const [quelle, name, erwartet] of FIXTURES) {
    // Produktionsaufruf (vendor, desc) und der Ein-Argument-Aufruf müssen
    // dasselbe Ergebnis liefern — letzterer war vor F5 immer false.
    const mitVendor = isIntegrated(vendorFromName(name), name);
    const ohneVendor = isIntegrated(name);
    if (mitVendor !== erwartet || ohneVendor !== erwartet) {
      falsch.push(`${quelle}: "${name}" -> erwartet ${erwartet}, erhalten ${mitVendor}/${ohneVendor}`);
    }
  }
  assert.deepEqual(falsch, [], `Fehlklassifikationen:\n${falsch.join('\n')}`);
});

test('F5: die drei Audit-Belege werden jetzt korrekt beantwortet', () => {
  // Vor dem Fix lieferten alle drei false, weil das Argument als Hersteller
  // gelesen wurde (electron/hardware.js: isIntegrated).
  assert.equal(isIntegrated('Intel(R) UHD Graphics 770'), true);
  assert.equal(isIntegrated('AMD Radeon 780M'), true);
  assert.equal(isIntegrated('Microsoft Basic Display Adapter'), true);
  // Gegenprobe: eine echte dGPU bleibt diskret.
  assert.equal(isIntegrated('NVIDIA GeForce RTX 4090'), false);
});

test('F5: vendorFromName leitet den Hersteller aus dem Gerätenamen ab', () => {
  assert.equal(vendorFromName('Intel(R) UHD Graphics 770'), 'Intel');
  assert.equal(vendorFromName('AMD Radeon(TM) 780M Graphics'), 'AMD');
  assert.equal(vendorFromName('NVIDIA GeForce RTX 4090'), 'NVIDIA');
  assert.equal(vendorFromName('Apple M2 Pro'), 'Apple');
  assert.equal(vendorFromName('Qualcomm(R) Adreno(TM) 680 GPU'), 'Qualcomm');
  // Unbekannt bleibt unbekannt (kein Raten).
  assert.equal(vendorFromName('Microsoft Basic Display Adapter'), null);
  assert.equal(vendorFromName(''), null);
  assert.equal(vendorFromName(null), null);
});

test('F5: estimateVramFromName liefert GB (öffentliche API), intern Bytes', () => {
  // Audit-Beleg: vorher 25769803776 (Bytes) statt 24 GB.
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4090'), 24);
  assert.equal(estimateVramFromName('RTX 4090'), 24);
  assert.equal(estimateVramBytesFromName('NVIDIA GeForce RTX 4090'), 24 * GB);
  // Audit-Beleg: Laptop-Name lieferte vorher null.
  assert.equal(estimateVramFromName('NVIDIA GeForce RTX 4090 Laptop GPU'), 16);
  assert.equal(estimateVramBytesFromName('NVIDIA GeForce RTX 4090 Laptop GPU'), 16 * GB);
  // iGPUs und virtuelle Adapter haben keinen eigenen VRAM.
  for (const [, name, integriert] of FIXTURES) {
    if (!integriert) continue;
    assert.equal(estimateVramFromName(name), null, `iGPU mit VRAM-Schätzung: ${name}`);
  }
});

test('F5: pickRegistryVram ist deterministisch (Namensrang, dann größter Wert)', () => {
  // Audit-Beleg: 24-GB- und 8-GB-Eintrag zur selben Karte -> vorher null.
  const doppelt = [
    { driverDesc: 'NVIDIA GeForce RTX 4090', bytes: 24 * GB },
    { driverDesc: 'NVIDIA GeForce RTX 4090', bytes: 8 * GB },
  ];
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4090', doppelt), 24 * GB);
  // Reihenfolge der Einträge ändert das Ergebnis nicht.
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4090', [...doppelt].reverse()), 24 * GB);
  // Namensrang schlägt Größe: die 4060 bekommt nicht den VRAM der 4060 Ti.
  const gemischt = [
    { driverDesc: 'NVIDIA GeForce RTX 4060 Ti', bytes: 16 * GB },
    { driverDesc: 'NVIDIA GeForce RTX 4060', bytes: 8 * GB },
  ];
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4060', gemischt), 8 * GB);
  // Treibername mit Suffix ("(Desktop)", "24GB") findet den Basiseintrag.
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4070 (Desktop)', [{ driverDesc: 'NVIDIA GeForce RTX 4070', bytes: 12 * GB }]), 12 * GB);
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4090 24GB', [{ driverDesc: 'NVIDIA GeForce RTX 4090', bytes: 24 * GB }]), 24 * GB);
  // Kein Treffer / unbrauchbare Einträge -> null (kein Zufallswert).
  assert.equal(pickRegistryVram('AMD Radeon(TM) Graphics', gemischt), null);
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4060', []), null);
  assert.equal(pickRegistryVram('NVIDIA GeForce RTX 4060', [{ driverDesc: 'NVIDIA GeForce RTX 4060', bytes: NaN }]), null);
  assert.equal(pickRegistryVram('', doppelt), null);
  assert.equal(pickRegistryVram(null, doppelt), null);
});
