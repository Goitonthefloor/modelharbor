'use strict';
/**
 * hardware.js — plattformübergreifende Hardware-Erkennung für ModelHarbor.
 * Keine externen Abhängigkeiten, nur Node-Standardbibliothek + Systemtools.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const i18n = require('../ui/i18n');
const { execFile } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = execFile(cmd, args, {
        timeout: opts.timeout || 6000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...(opts.env || {}) },
      }, (err, stdout, stderr) => {
        done({
          ok: !err,
          out: String(stdout || ''),
          err: String(stderr || ''),
          error: err ? (err.message || String(err)) : null,
        });
      });
      child.on('error', (e) => done({ ok: false, out: '', err: '', error: e.message }));
    } catch (e) {
      done({ ok: false, out: '', err: '', error: e.message });
    }
  });
}

const GPU_VENDORS = {
  '10de': 'NVIDIA',
  '1002': 'AMD',
  '1022': 'AMD',
  '8086': 'Intel',
  '106b': 'Apple',
  '1af4': 'VirtIO',
  '15ad': 'VMware',
  '1234': 'QEMU',
  '1414': 'Microsoft',
  '1ae0': 'Google',
  '13b5': 'ARM',
  '5143': 'Qualcomm',
  '17cb': 'Qualcomm',
};

function vendorFromPciId(id) {
  if (!id) return null;
  const v = String(id).toLowerCase().replace(/^0x/, '');
  return GPU_VENDORS[v] || null;
}

/**
 * Leitet den Hersteller aus dem Gerätenamen ab.
 * Nötig, weil Quellen wie WMI (Win32_VideoController.Name), lspci-Zeilen ohne
 * aufgelöste PCI-ID oder ein Aufruf mit nur einem Argument keinen Hersteller
 * mitliefern. Ohne Ableitung war jede Klassifikation "diskret" (Audit F5:
 * isIntegrated('Intel(R) UHD Graphics 770') === false).
 */
function vendorFromName(desc) {
  const d = String(desc || '');
  if (/qualcomm|adreno|snapdragon/i.test(d)) return 'Qualcomm';
  if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i.test(d)) return 'NVIDIA';
  if (/\bamd\b|radeon|advanced\s+micro\s+devices|\bati\b/i.test(d)) return 'AMD';
  if (/intel|\barc\b|iris|\buhd\b|\bhd\s*graphics/i.test(d)) return 'Intel';
  if (/apple/i.test(d)) return 'Apple';
  return null;
}

/**
 * Namen, die auf eine eigene Karte mit eigenem VRAM hindeuten.
 * Wird VOR den Integriert-Mustern geprüft, damit z. B. "Arc(TM) A770 Graphics"
 * (dGPU) nicht über das Wort "Graphics" als integriert gilt.
 */
const DISCRETE_NAME_RE =
  /\bradeon\s+rx\b|\bradeon\s+pro\b|\bradeon\s+vii\b|\bradeon\s+hd\s*\d{3,4}\b|\bradeon\s+[rx][579]\s*\d{3}\b|\bnavi\s*\d|\bvega\s*(?:10|20|56|64)\b|\bgeforce\b|\bquadro\b|\btesla\b|\b(?:rtx|gtx)\s*\d{3,4}\b|\btitan\b|\barc\s*(?:pro\s*)?[ab]\d{2,4}\b/i;

/**
 * Namen, die auf eine integrierte GPU hindeuten (geteilter Systemspeicher,
 * kein eigener VRAM): Intel HD/UHD/Iris, Arc-iGPUs (140V/130V, "Arc Graphics"),
 * AMD-APUs (6xxM/7xxM/8xxM, Vega-iGPU, Codenamen), Apple M-Serie,
 * Qualcomm Adreno, virtuelle Grafiken (VMware/VirtualBox/QXL/virtio/Hyper-V)
 * und Software-/Fallback-Adapter.
 */
const INTEGRATED_NAME_RE =
  /microsoft\s+basic|\bbasic\s+display|\bbasic\s+render|virtual\s+vga|\badreno\b|\bradeon\s*\d{3}\s*m\b|\bradeon\b[^,]*\b(?:vega|graphics|integrated)\b|\bvega\s*\d{1,2}\b|\b(?:hd|uhd|iris)\s*(?:graphics|xe)?\b|\barc\s*\d{3}\s*v\b|\bgraphics\b|renoir|cezanne|raven|picasso|rembrandt|\bphoenix\d?\b|mendocino|\braphael\d?\b|strix|integrated|\bapu\b/i;

/**
 * Unterscheidet integrierte von diskreten GPUs.
 *
 * Erkennung laeuft ueber Muster im Gerätenamen und ist damit hersteller-
 * unabhängig; der (ggf. aus dem Namen abgeleitete) Hersteller entscheidet nur
 * noch im Fall "Muster sagt nichts" (Intel -> integriert, sonst diskret).
 *
 * Aufrufbar als isIntegrated(vendor, desc) und als isIntegrated(desc) —
 * frueher ergab der Ein-Argument-Aufruf fuer JEDEN Namen false, weil das
 * Argument als Hersteller gelesen wurde (Audit F5).
 */
function isIntegrated(vendor, desc) {
  let v = vendor;
  let d;
  if (desc === undefined) {
    d = String(vendor == null ? '' : vendor);
    v = vendorFromName(d);
  } else {
    d = String(desc == null ? '' : desc);
    v = v || vendorFromName(d);
  }
  // "(TM)"/"(R)"/®/™ stoeren Muster wie "Arc(TM) A770" oder "Radeon  Graphics"
  const name = d.replace(/\((?:tm|r)\)|®|™/gi, ' ').replace(/\s+/g, ' ').trim();
  // 1) Software-/Fallback-Adapter, virtuelle Grafiken und SoC-GPUs: geteilter Speicher
  if (/microsoft\s+basic|\bbasic\s+display|\bbasic\s+render|virtual\s+vga|\badreno\b|\bsvga\b|\bqxl\b|virtio|\bvmware\b|virtualbox|hyper-v|parallels|\bvirgl\b|llvmpipe|swrast/i.test(name)) return true;
  // 2) eindeutig diskret (eigener VRAM)
  if (DISCRETE_NAME_RE.test(name)) return false;
  // 3) eindeutig integriert
  if (INTEGRATED_NAME_RE.test(name)) return true;
  // 4) Apple M-Serie = Unified Memory, aeltere Apple-Geraete mit dGPU nicht
  if (v === 'Apple') return /\bm\d/i.test(name);
  // 5) Hersteller-Fallback: Intel baut fast nur iGPUs, Rest unbekannt -> diskret
  if (v === 'Intel') return true;
  return false;
}

/**
 * Typischer VRAM (GB) bekannter Desktop-GPUs, aus dem Gerätenamen geschätzt.
 * Integrierte Grafiken und unbekannte Namen liefern null.
 */
const VRAM_NAME_MAP = [
  // NVIDIA — spezifischere Namen zuerst (4070 Ti vor 4070)
  [/rtx\s*5090/i, 32], [/rtx\s*5080/i, 16], [/rtx\s*5070\s*ti/i, 16], [/rtx\s*5070/i, 12],
  [/rtx\s*5060\s*ti/i, 8], [/rtx\s*5060/i, 8],
  [/rtx\s*4090/i, 24], [/rtx\s*4080/i, 16], [/rtx\s*4070\s*ti/i, 12], [/rtx\s*4070/i, 12],
  [/rtx\s*4060\s*ti/i, 8], [/rtx\s*4060/i, 8],
  [/rtx\s*3090/i, 24], [/rtx\s*3080\s*ti/i, 12], [/rtx\s*3080/i, 10],
  [/rtx\s*3070\s*ti/i, 8], [/rtx\s*3070/i, 8], [/rtx\s*3060\s*ti/i, 8], [/rtx\s*3060/i, 12],
  [/rtx\s*3050/i, 8],
  [/rtx\s*2080\s*ti/i, 11], [/rtx\s*2080/i, 8], [/rtx\s*2070/i, 8], [/rtx\s*2060/i, 6],
  [/gtx\s*1660\s*ti/i, 6], [/gtx\s*1660/i, 6], [/gtx\s*1650/i, 4], [/gtx\s*1080\s*ti/i, 11],
  // AMD
  [/rx\s*9070\s*xt/i, 16], [/rx\s*9070/i, 16], [/rx\s*9060\s*xt/i, 16],
  [/rx\s*7900\s*xtx/i, 24], [/rx\s*7900\s*xt/i, 20], [/rx\s*7800\s*xt/i, 16],
  [/rx\s*7700\s*xt/i, 12], [/rx\s*7600/i, 8],
  [/rx\s*6950/i, 16], [/rx\s*6900/i, 16], [/rx\s*6800\s*xt/i, 16], [/rx\s*6800/i, 16],
  [/rx\s*6700\s*xt/i, 12], [/rx\s*6600\s*xt/i, 8], [/rx\s*6600/i, 8],
  // Intel
  [/arc\s*a770/i, 16], [/arc\s*a750/i, 8], [/arc\s*a380/i, 6],
  [/arc\s*b580/i, 12], [/arc\s*b570/i, 10],
];

/**
 * Typischer VRAM (GB) der Mobil-/Laptop-Varianten. Diese haben einen anderen
 * Speicherausbau als die Desktop-Karte gleichen Namens (RTX 4090 Laptop = 16 GB,
 * Desktop = 24 GB) und brauchen deshalb eine eigene Tabelle. Audit F5: vorher
 * lieferten alle Laptop-Namen null.
 */
const VRAM_MOBILE_MAP = [
  [/(?:rtx\s*)?5090\b/i, 24], [/(?:rtx\s*)?5080\b/i, 16],
  [/(?:rtx\s*)?5070\s*ti\b/i, 12], [/(?:rtx\s*)?5070\b/i, 8], [/(?:rtx\s*)?5060\b/i, 8],
  [/(?:rtx\s*)?4090\b/i, 16], [/(?:rtx\s*)?4080\b/i, 12], [/(?:rtx\s*)?4070\b/i, 8],
  [/(?:rtx\s*)?4060\b/i, 8], [/(?:rtx\s*)?4050\b/i, 6],
  [/(?:rtx\s*)?3080\s*ti\b/i, 16], [/(?:rtx\s*)?3080\b/i, 8], [/(?:rtx\s*)?3070\s*ti\b/i, 8],
  [/(?:rtx\s*)?3070\b/i, 8], [/(?:rtx\s*)?3060\b/i, 6], [/(?:rtx\s*)?3050\s*ti\b/i, 4],
  [/(?:rtx\s*)?3050\b/i, 4], [/(?:rtx\s*)?2080\b/i, 8], [/(?:rtx\s*)?2070\b/i, 8],
  [/(?:rtx\s*)?2060\b/i, 6], [/gtx\s*1660\s*ti\b/i, 6], [/gtx\s*1650\b/i, 4],
  [/rx\s*7900\s*m\b/i, 16], [/rx\s*7600\s*m\b/i, 8], [/rx\s*6800\s*m\b/i, 12],
  [/rx\s*6700\s*m\b/i, 10], [/rx\s*6600\s*m\b/i, 8], [/rx\s*6500\s*m\b/i, 4],
];

/**
 * Schätzt den typischen VRAM aus dem Gerätenamen — öffentliche API, Rückgabe
 * in GB (nicht Bytes) oder null bei integrierten/unbekannten Namen.
 * Einheiten laut Doku: GB. Intern wird für Vergleiche mit qwMemorySize
 * estimateVramBytesFromName() verwendet.
 */
function estimateVramFromName(name) {
  // (TM)/(R)/®/™ raus, sonst scheitern Muster wie "Arc(TM) A770"
  const n = String(name || '').replace(/\((?:tm|r)\)|®|™/gi, ' ');
  if (!n.trim()) return null;
  // integrierte Grafik / Software-Adapter: kein eigener VRAM
  if (/radeon\s*(?:graphics|vega)|vega\s*\d+\s*graphics|intel\s*(?:hd|uhd|iris)|\buhd\s*graphics\b|iris\s*xe|apple\s*m\d|\badreno\b|basic\s+display/i.test(n)) {
    return null;
  }
  // Explizite Größenangabe im Namen schlägt die Tabelle: sonst wird z. B. die
  // 16-GB-Variante der RTX 4060 Ti als 8 GB geschätzt.
  const explicit = n.match(/\b(\d{1,2})\s*GB\b/i);
  if (explicit) {
    const gb = Number(explicit[1]);
    if (gb >= 2 && gb <= 96) return gb;
  }
  // Laptop-/Mobil-Varianten haben eigene Speichergrößen (eigene Tabelle)
  const mobile = /laptop|mobile|max-?q|notebook/i.test(n);
  for (const [re, gb] of (mobile ? VRAM_MOBILE_MAP : VRAM_NAME_MAP)) {
    if (re.test(n)) return gb;
  }
  return null;
}

/** Wie estimateVramFromName, aber in Bytes (intern für qwMemorySize-Vergleiche). */
function estimateVramBytesFromName(name) {
  const gb = estimateVramFromName(name);
  return gb == null ? null : gb * 1024 * 1024 * 1024;
}

/**
 * Sucht zu einem GPU-Namen den passenden Registry-VRAM-Wert
 * (HardwareInformation.qwMemorySize ist ein QWORD und damit auch >4 GB korrekt).
 * `entries` = [{ driverDesc, bytes }]. Reine Funktion, damit testbar.
 *
 * Auswahl deterministisch: erst der beste Namensrang (identischer Treibername
 * vor Namensvariante vor Modellnummer), bei gleichem Rang der größte
 * Speicherwert. Vorher gewann bei mehreren Treffern immer der größte Wert —
 * eine RTX 4060 bekam so den VRAM einer zusätzlich verbauten 4060 Ti 16 GB.
 */
function pickRegistryVram(gpuName, entries) {
  const name = String(gpuName || '').toLowerCase().trim();
  if (!name || !Array.isArray(entries) || !entries.length) return null;
  const rank = (desc) => {
    const d = String(desc || '').toLowerCase().trim();
    if (!d) return 0;
    if (d === name) return 3; // identischer Treibername
    if (name.includes(d) || d.includes(name)) return 2; // Namensvariante (Suffixe)
    // Teiltreffer nur über die Modellnummer ("rtx 4090 24gb" -> "nvidia geforce rtx 4090");
    // generische Herstellerwörter reichen dafür nicht.
    const num = d.match(/\b(\d{3,4})\s*(?:m|ti|xt|xtx|super)?\b/);
    if (num && new RegExp(`\\b${num[1]}\\b`).test(name)) return 1;
    return 0;
  };
  let bestRank = 0;
  let best = null;
  for (const e of entries) {
    if (!e || !Number.isFinite(e.bytes) || e.bytes <= 0) continue;
    const r = rank(e.driverDesc);
    if (!r) continue;
    if (r > bestRank || (r === bestRank && (!best || e.bytes > best))) {
      bestRank = r;
      best = e.bytes;
    }
  }
  return best;
}

function parseNumber(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Linux                                                              */
/* ------------------------------------------------------------------ */

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
}

/**
 * Gehört ein sysfs-Gerätepfad zur lspci-Adresse? sysfs liefert die Adresse mit
 * Domain ("0000:03:00.0"), lspci meist ohne ("03:00.0"). Reine Funktion, testbar.
 */
function pciAddressMatches(devicePath, lspciAddress) {
  const addr = String(lspciAddress || '').toLowerCase().trim();
  if (!addr) return false;
  const base = path.basename(String(devicePath || '').toLowerCase());
  const short = base.replace(/^[0-9a-f]{4}:/, '');
  return short === addr || base === addr;
}

async function detectLinux() {
  const gpus = [];
  const npus = [];
  const notes = [];

  // NVIDIA via nvidia-smi (Treiber-Info inkl. VRAM)
  const smi = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.free,driver_version,compute_cap',
    '--format=csv,noheader,nounits',
  ]);
  const nvidiaNames = new Set();
  if (smi.ok && smi.out.trim()) {
    for (const line of smi.out.trim().split('\n')) {
      const parts = line.split(',').map((x) => x.trim());
      if (!parts[0]) continue;
      const name = parts[0];
      const vramMB = parseNumber(parts[1]);
      const freeMB = parseNumber(parts[2]);
      nvidiaNames.add(name.toLowerCase());
      gpus.push({
        vendor: 'NVIDIA',
        name,
        vramBytes: vramMB != null ? Math.round(vramMB * 1024 * 1024) : null,
        vramFreeBytes: freeMB != null ? Math.round(freeMB * 1024 * 1024) : null,
        driver: parts[3] || null,
        computeCap: parts[4] || null,
        source: 'nvidia-smi',
        discrete: true,
        backends: ['cuda', 'vulkan'],
      });
    }
  }

  // lspci: alle Display-/3D-/Accelerator-Geräte
  const lspci = await run('lspci', ['-nn']);
  if (lspci.ok) {
    for (const line of lspci.out.split('\n')) {
      const m = line.match(/^([0-9a-f:.]+)\s+(VGA compatible controller|3D controller|Display controller|Processing accelerators?)\s*(?:\[[0-9a-f]+\])?:\s*(.+?)\s*\[([0-9a-f]{4}):([0-9a-f]{4})\]/i);
      if (!m) continue;
      const className = m[2];
      const desc = m[3].trim();
      const vendorId = m[4];
      const deviceId = m[5];
      const vendor = vendorFromPciId(vendorId);
      const isAccel = /accelerator/i.test(className);

      if (isAccel) {
        npus.push({
          vendor: vendor || 'Unbekannt',
          name: desc,
          pciId: `${vendorId}:${deviceId}`,
          usableBy: vendor === 'Intel' ? 'openvino' : (vendor === 'AMD' ? 'ryzenai' : 'info'),
        });
        continue;
      }
      if (vendor === 'NVIDIA' && [...nvidiaNames].some((n) => n && desc.toLowerCase().includes(n.split(' ')[0]))) continue;
      if (gpus.some((g) => g.name === desc)) continue;
      // Virtuelle Grafikkarten (VM) sind keine nutzbare GPU-Beschleunigung
      if (['QEMU', 'VMware', 'VirtIO', 'Microsoft'].includes(vendor) || /^device$/i.test(desc)) {
        notes.push(i18n.t('hw.note.virtualGpu', { name: desc || vendor }));
        continue;
      }

      // VRAM aus sysfs (amdgpu). Die Karte muss zur PCI-Adresse passen:
      // über den Vendor allein bekommt eine dGPU den VRAM der iGPU (gleicher
      // Vendor, z. B. APU + Radeon-Karte) — das verfälscht das Modell-Budget.
      let vramBytes = null;
      try {
        const cards = fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c));
        for (const card of cards) {
          let devPath = '';
          try { devPath = fs.realpathSync(`/sys/class/drm/${card}/device`); } catch { continue; }
          if (!pciAddressMatches(devPath, m[1])) continue;
          const total = readFileSafe(`/sys/class/drm/${card}/device/mem_info_vram_total`);
          if (total) vramBytes = parseInt(total, 10);
          break;
        }
      } catch { /* sysfs nicht lesbar */ }

      if (vendor === 'NVIDIA' && nvidiaNames.size) continue;
      gpus.push({
        vendor: vendor || 'Unbekannt',
        name: desc,
        vramBytes,
        driver: null,
        source: 'lspci',
        discrete: !isIntegrated(vendor, desc),
        backends: vendor === 'AMD'
          ? ['rocm', 'vulkan']
          : vendor === 'Intel'
            ? ['vulkan', 'sycl', 'openvino']
            : ['vulkan'],
      });
    }
  }

  // ROCm-Verfügbarkeit
  const rocm = await run('rocminfo', []);
  const hasRocmRuntime = rocm.ok && rocm.out.length > 0;
  const rocmSmi = await run('rocm-smi', ['--showproductname']);
  const hasRocmSmi = rocmSmi.ok;

  // Vulkan
  const vk = await run('vulkaninfo', ['--summary']);
  const vulkanDevices = [];
  if (vk.ok) {
    for (const line of vk.out.split('\n')) {
      const m = line.match(/deviceName\s*=\s*(.+)$/);
      if (m) vulkanDevices.push(m[1].trim());
    }
  }

  // NPU: /dev/accel
  try {
    const accel = fs.readdirSync('/dev/accel');
    if (accel.length) {
      notes.push(i18n.t('hw.note.accelDevice', { list: accel.join(', ') }));
    }
  } catch { /* kein /dev/accel */ }

  const hasNpu = npus.length > 0 || (() => { try { return fs.readdirSync('/dev/accel').length > 0; } catch { return false; } })();

  return {
    gpus, npus, notes,
    hasRocm: hasRocmRuntime || hasRocmSmi,
    vulkanDevices,
    hasNpu,
  };
}

/* ------------------------------------------------------------------ */
/* Windows                                                            */
/* ------------------------------------------------------------------ */

async function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 15000 });
}

async function detectWindows() {
  const gpus = [];
  const npus = [];
  const notes = [];

  const smi = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.free,driver_version,compute_cap',
    '--format=csv,noheader,nounits',
  ]);
  const nvidiaNames = new Set();
  if (smi.ok && smi.out.trim()) {
    for (const line of smi.out.trim().split('\n')) {
      const parts = line.split(',').map((x) => x.trim());
      if (!parts[0]) continue;
      nvidiaNames.add(parts[0].toLowerCase());
      require('./logger').debug(`hw(windows) nvidia-smi name=${parts[0]} vramMB=${parts[1] || 'n/a'} freeMB=${parts[2] || 'n/a'}`);
      const totalMB = parseNumber(parts[1]);
      const freeMB = parseNumber(parts[2]);
      gpus.push({
        vendor: 'NVIDIA',
        name: parts[0],
        vramBytes: totalMB != null ? Math.round(totalMB * 1024 * 1024) : null,
        vramFreeBytes: freeMB != null ? Math.round(freeMB * 1024 * 1024) : null,
        driver: parts[3] || null,
        computeCap: parts[4] || null,
        source: 'nvidia-smi',
        discrete: true,
        backends: ['cuda', 'vulkan'],
      });
    }
  }

  // Echter VRAM aus der Registry: HardwareInformation.qwMemorySize ist ein QWORD
  // und damit auch jenseits von 4 GB korrekt (WMI-AdapterRAM ist UInt32 und kappt).
  const vramReg = [];
  const psVram = await powershell(
    "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; "
    + "Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object { "
    + "$p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue; "
    + "if ($p.DriverDesc) { [pscustomobject]@{ DriverDesc=$p.DriverDesc; Vram=$p.'HardwareInformation.qwMemorySize' } } "
    + "} | ConvertTo-Json -Compress"
  );
  if (psVram.ok && psVram.out.trim()) {
    let list = [];
    try {
      const parsed = JSON.parse(psVram.out.trim());
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch { /* unparsbar */ }
    for (const r of list) {
      const bytes = Number(r && r.Vram);
      if (!r || !r.DriverDesc || !Number.isFinite(bytes) || bytes <= 0) continue;
      vramReg.push({ driverDesc: String(r.DriverDesc), bytes });
    }
  }

  const psGpu = await powershell(
    "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM,VideoProcessor | ConvertTo-Json -Compress"
  );
  if (psGpu.ok && psGpu.out.trim()) {
    let list = [];
    try {
      const parsed = JSON.parse(psGpu.out.trim());
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch { /* unparsbar */ }
    for (const g of list) {
      const name = g.Name || 'Unbekannte GPU';
      if ([...nvidiaNames].some((n) => name.toLowerCase().includes(n.split(' ')[0]))) continue;
      if (gpus.some((x) => x.name === name)) continue;
      const vendor = /nvidia/i.test(name) ? 'NVIDIA' : /amd|radeon/i.test(name) ? 'AMD' : /intel|arc|iris/i.test(name) ? 'Intel' : /qualcomm|adreno/i.test(name) ? 'Qualcomm' : 'Unbekannt';
      // AdapterRAM ist bei >4 GB unzuverlässig (UInt32): nur als Startwert,
      // danach gewinnt der Registry-Wert (qwMemorySize, QWORD).
      let vramBytes = g.AdapterRAM ? Number(g.AdapterRAM) : null;
      if (vramBytes && (vramBytes < 0 || vramBytes >= 4294967295)) vramBytes = null;
      let vramSource = vramBytes ? 'wmi' : null;
      const regBytes = pickRegistryVram(name, vramReg);
      if (regBytes && (!vramBytes || regBytes > vramBytes)) {
        vramBytes = regBytes;
        vramSource = 'registry';
      }
      const discrete = !isIntegrated(vendor, name);
      // Letzter Fallback: aus dem Gerätenamen schätzen (nur diskrete Karten).
      // estimateVramFromName liefert GB (öffentliche API), intern brauchen wir Bytes.
      if (discrete && (!vramBytes || vramBytes < 1073741824)) {
        const est = estimateVramBytesFromName(name);
        if (est) { vramBytes = est; vramSource = 'estimate'; }
      }
      gpus.push({
        vendor,
        name,
        vramBytes,
        vramApprox: vramSource !== 'registry',
        vramSource,
        driver: g.DriverVersion || null,
        source: 'wmi',
        discrete,
        backends: vendor === 'NVIDIA' ? ['cuda', 'vulkan'] : vendor === 'AMD' ? ['rocm', 'vulkan'] : vendor === 'Intel' ? ['vulkan', 'sycl', 'openvino'] : ['vulkan'],
      });
    }
  }

  const psNpu = await powershell(
    "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Class -eq 'ComputeAccelerator' -or $_.FriendlyName -match 'NPU|Neural Processing|AI Boost|XDNA|Hexagon' } | Select-Object FriendlyName,Status,Class,InstanceId | ConvertTo-Json -Compress"
  );
  if (psNpu.ok && psNpu.out.trim()) {
    let list = [];
    try {
      const parsed = JSON.parse(psNpu.out.trim());
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch { /* unparsbar */ }
    for (const d of list) {
      if (!d || !d.FriendlyName) continue;
      const name = String(d.FriendlyName);
      const cls = String(d.Class || '');
      // Nur echte Beschleuniger: PnP-Klasse oder eindeutiger Name.
      // USB/HID-Geräte fallen hier raus, auch wenn die WMI-Abfrage sie liefert.
      const isAccelClass = cls === 'ComputeAccelerator';
      const looksNpu = /\bNPU\b|Neural|AI Boost|XDNA|Hexagon|\bVPU\b|Vision Processing|Compute Accelerator/i.test(name);
      const isNoise = /USB|Input Device|\bHID\b|Root Hub|Composite|Bluetooth|Audio/i.test(name);
      if (!isAccelClass && (!looksNpu || isNoise)) continue;
      const vendor = /intel/i.test(name) ? 'Intel' : /amd/i.test(name) ? 'AMD' : /qualcomm/i.test(name) ? 'Qualcomm' : 'Unbekannt';
      if (npus.some((n) => n.name === name)) continue;
      npus.push({
        vendor,
        name,
        status: d.Status || null,
        pciId: null,
        usableBy: vendor === 'Intel' ? 'openvino' : (vendor === 'AMD' ? 'ryzenai' : 'experimental'),
      });
    }
  }

  return { gpus, npus, notes, hasRocm: gpus.some((g) => g.vendor === 'AMD'), vulkanDevices: gpus.map((g) => g.name), hasNpu: npus.length > 0 };
}

/* ------------------------------------------------------------------ */
/* macOS                                                              */
/* ------------------------------------------------------------------ */

async function detectMac() {
  const gpus = [];
  const npus = [];
  const notes = [];

  const isAppleSilicon = process.arch === 'arm64';
  const brand = (await run('sysctl', ['-n', 'machdep.cpu.brand_string'])).out.trim();
  const memBytes = parseInt((await run('sysctl', ['-n', 'hw.memsize'])).out.trim(), 10) || os.totalmem();

  const sp = await run('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 20000 });
  let displayData = [];
  if (sp.ok && sp.out.trim()) {
    try {
      const parsed = JSON.parse(sp.out);
      displayData = parsed.SPDisplaysDataType || [];
    } catch { /* unparsbar */ }
  }
  for (const d of displayData) {
    const name = d.sppci_model || d._name || 'GPU';
    const vram = parseNumber(d.spdisplays_vram || d.spdisplays_vram_shared || '');
    const metal = !!(d.spdisplays_mtlsupport || d.spdisplays_metal || /metal/i.test(JSON.stringify(d)));
    gpus.push({
      vendor: /apple/i.test(name) ? 'Apple' : /amd|radeon/i.test(name) ? 'AMD' : /intel/i.test(name) ? 'Intel' : 'Unbekannt',
      name,
      vramBytes: isAppleSilicon ? Math.round(memBytes * 0.66) : (vram ? Math.round(vram * 1024 * 1024 * 1024) : null),
      vramApprox: isAppleSilicon,
      unifiedMemory: isAppleSilicon,
      metal,
      source: 'system_profiler',
      discrete: !isAppleSilicon,
      backends: ['metal'],
    });
  }
  if (!gpus.length && isAppleSilicon) {
    gpus.push({
      vendor: 'Apple',
      name: `${brand || 'Apple Silicon'} (GPU)`,
      vramBytes: Math.round(memBytes * 0.66),
      vramApprox: true,
      unifiedMemory: true,
      metal: true,
      source: 'sysctl',
      discrete: false,
      backends: ['metal'],
    });
  }
  if (isAppleSilicon) {
    npus.push({
      vendor: 'Apple',
      name: 'Apple Neural Engine (ANE)',
      status: 'vorhanden',
      pciId: null,
      usableBy: 'info',
    });
    notes.push(i18n.t('hw.note.appleNeuralEngine'));
  }

  return {
    gpus, npus, notes,
    hasRocm: false,
    vulkanDevices: [],
    hasNpu: isAppleSilicon,
    unifiedMemory: isAppleSilicon,
    memoryBytes: memBytes,
  };
}

/* ------------------------------------------------------------------ */
/* Aggregation + Empfehlung                                           */
/* ------------------------------------------------------------------ */

function formatBytes(b) {
  if (!b || !Number.isFinite(b)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function recommendBackend(hw, platform = process.platform, arch = process.arch) {
  const gpus = hw.gpus || [];
  const hasNvidia = gpus.some((g) => g.vendor === 'NVIDIA');
  const hasAmd = gpus.some((g) => g.vendor === 'AMD');
  const hasIntelGpu = gpus.some((g) => g.vendor === 'Intel');
  const hasApple = gpus.some((g) => g.vendor === 'Apple');
  const intelNpu = (hw.npus || []).some((n) => n.vendor === 'Intel');

  const candidates = [];
  const add = (id, reason, priority, experimental) => candidates.push({ id, reason, priority, experimental: !!experimental });

  if (platform === 'darwin') {
    if (arch === 'arm64' || hasApple) add('macos-arm64', i18n.t('reason.darwin.apple'), 100);
    else add('macos-x64', i18n.t('reason.darwin.intel'), 80);
    return { primary: candidates[0].id, candidates };
  }

  if (platform === 'win32') {
    if (hasNvidia) {
      add('win-cuda-12.4', i18n.t('reason.win.nvidiaCuda'), 100);
      add('win-vulkan', i18n.t('reason.win.vulkanNvidia'), 60);
    }
    if (hasAmd) {
      add('win-vulkan', i18n.t('reason.win.amdVulkan'), 100);
      add('win-rocm', i18n.t('reason.win.amdRocm'), 40, true);
    }
    if (hasIntelGpu) {
      add('win-vulkan', i18n.t('reason.win.intelVulkan'), 90);
      if (intelNpu) add('win-openvino', i18n.t('reason.win.intelNpu'), 30, true);
    }
    if (!hasNvidia && !hasAmd && !hasIntelGpu) add('win-cpu-x64', i18n.t('reason.win.noGpu'), 50);
    if (arch === 'arm64') {
      add('win-cpu-arm64', i18n.t('reason.win.armCpu'), 70);
      add('win-vulkan-arm64', i18n.t('reason.win.armVulkan'), 60);
    }
    if (!hasNvidia) add('win-cuda-12.4', i18n.t('reason.win.cudaOption'), 10);
    if (hasNvidia) add('win-cpu-x64', i18n.t('reason.win.cpuFallback'), 20);
  }

  if (platform === 'linux') {
    if (hasNvidia) {
      add('linux-cuda-12.8', i18n.t('reason.linux.nvidiaCuda'), 100);
      add('linux-vulkan', i18n.t('reason.linux.vulkanNvidia'), 60);
    }
    if (hasAmd) {
      if (hw.hasRocm) add('linux-rocm', i18n.t('reason.linux.amdRocm'), 100);
      else add('linux-vulkan', i18n.t('reason.linux.amdVulkan'), 95);
    }
    if (hasIntelGpu) {
      add('linux-vulkan', i18n.t('reason.linux.intelVulkan'), 90);
      add('linux-sycl-fp16', i18n.t('reason.linux.intelSycl'), 40, true);
      if (intelNpu) add('linux-openvino', i18n.t('reason.linux.intelNpu'), 30, true);
    }
    if (!hasNvidia && !hasAmd && !hasIntelGpu) add('linux-cpu', i18n.t('reason.linux.noGpu'), 50);
    if (hasNvidia || hasAmd) add('linux-cpu', i18n.t('reason.linux.cpuFallback'), 20);
    if (arch === 'arm64') {
      add('linux-cpu-arm64', i18n.t('reason.linux.armCpu'), 80);
      add('linux-vulkan-arm64', i18n.t('reason.linux.armVulkan'), 60);
    }
  }

  if (!candidates.length) {
    add(platform === 'win32' ? 'win-cpu-x64' : platform === 'darwin' ? 'macos-arm64' : 'linux-cpu', i18n.t('reason.fallback'), 10);
  }
  candidates.sort((a, b) => b.priority - a.priority);
  // Duplikate entfernen (gleiche id, höchste Priorität behalten)
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    unique.push(c);
  }
  return { primary: unique[0].id, candidates: unique };
}

async function scanHardware() {
  const platform = process.platform;
  const base = {
    platform,
    arch: process.arch,
    osVersion: os.release(),
    osName: platform === 'win32' ? `Windows ${os.release()}` : platform === 'darwin' ? `macOS ${os.release()}` : `${os.type()} ${os.release()}`,
    cpuModel: (os.cpus()[0] || {}).model || 'Unbekannte CPU',
    cpuCores: os.cpus().length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    node: process.versions.node,
    electron: process.versions.electron || null,
  };

  let detected;
  try {
    if (platform === 'win32') detected = await detectWindows();
    else if (platform === 'darwin') detected = await detectMac();
    else detected = await detectLinux();
  } catch (e) {
    detected = { gpus: [], npus: [], notes: [`Hardware-Erkennung teilweise fehlgeschlagen: ${e.message}`], hasRocm: false, vulkanDevices: [], hasNpu: false };
  }

  const hw = { ...base, ...detected };
  hw.totalMemGB = Math.round((hw.totalMemBytes / 1073741824) * 10) / 10;
  hw.freeMemGB = Math.round((hw.freeMemBytes / 1073741824) * 10) / 10;
  for (const g of hw.gpus) {
    g.vramGB = g.vramBytes ? Math.round((g.vramBytes / 1073741824) * 10) / 10 : null;
    g.vramLabel = formatBytes(g.vramBytes);
  }
  hw.recommendation = recommendBackend(hw);

  // Realistisches Modell-Budget in GB
  // Nur eine DISKRETE GPU mit VRAM zaehlt fuer das Budget. Eine integrierte GPU
  // (APU) hat nur geteiltes System-RAM als nutzbaren Speicher — ihr kleiner VRAM
  // wuerde das Budget sonst falsch (zu klein oder Mismatch) berechnen.
  const discreteGpu = [...hw.gpus].filter((g) => g.discrete && g.vramBytes).sort((a, b) => b.vramBytes - a.vramBytes)[0];
  const anyGpu = [...hw.gpus].filter((g) => g.vramBytes).sort((a, b) => b.vramBytes - a.vramBytes)[0];
  if (discreteGpu) {
    hw.modelBudgetGB = Math.round((discreteGpu.vramBytes / 1073741824) * 10) / 10;
    hw.modelBudgetSource = `VRAM: ${discreteGpu.name}`;
  } else if (hw.gpus.some((g) => !g.discrete)) {
    // iGPU-only-System: VRAM ist geteilter Speicher -> RAM-Budget mit klarem Hinweis
    hw.modelBudgetGB = Math.round((hw.totalMemBytes / 1073741824) * 0.55 * 10) / 10;
    hw.modelBudgetSource = 'RAM (integrierte GPU, geteilter Speicher)';
  } else if (anyGpu) {
    hw.modelBudgetGB = Math.round((anyGpu.vramBytes / 1073741824) * 10) / 10;
    hw.modelBudgetSource = `VRAM: ${anyGpu.name}`;
  } else {
    hw.modelBudgetGB = Math.round((hw.totalMemBytes / 1073741824) * 0.55 * 10) / 10;
    hw.modelBudgetSource = 'RAM (kein VRAM erkannt)';
  }
  return hw;
}

module.exports = { scanHardware, recommendBackend, isIntegrated, vendorFromName, formatBytes, run, estimateVramFromName, estimateVramBytesFromName, pickRegistryVram, pciAddressMatches };
