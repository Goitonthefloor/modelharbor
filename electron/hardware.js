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
      nvidiaNames.add(name.toLowerCase());
      gpus.push({
        vendor: 'NVIDIA',
        name,
        vramBytes: vramMB ? Math.round(vramMB * 1024 * 1024) : null,
        vramFreeBytes: parts[2] ? Math.round(parseNumber(parts[2]) * 1024 * 1024) : null,
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
          usableBy: vendor === 'Intel' ? 'openvino' : (vendor === 'AMD' ? 'experimental' : 'info'),
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

      // AMD VRAM aus sysfs (amdgpu)
      let vramBytes = null;
      try {
        const cards = fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c));
        for (const card of cards) {
          const vendor = readFileSafe(`/sys/class/drm/${card}/device/vendor`);
          if (!vendor || !vendor.toLowerCase().includes(vendorId)) continue;
          const total = readFileSafe(`/sys/class/drm/${card}/device/mem_info_vram_total`);
          if (total) { vramBytes = parseInt(total, 10); break; }
        }
      } catch { /* sysfs nicht lesbar */ }

      if (vendor === 'NVIDIA' && nvidiaNames.size) continue;
      gpus.push({
        vendor: vendor || 'Unbekannt',
        name: desc,
        vramBytes,
        driver: null,
        source: 'lspci',
        discrete: !['Intel'].includes(vendor),
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
      gpus.push({
        vendor: 'NVIDIA',
        name: parts[0],
        vramBytes: parts[1] ? Math.round(parseNumber(parts[1]) * 1024 * 1024) : null,
        vramFreeBytes: parts[2] ? Math.round(parseNumber(parts[2]) * 1024 * 1024) : null,
        driver: parts[3] || null,
        computeCap: parts[4] || null,
        source: 'nvidia-smi',
        discrete: true,
        backends: ['cuda', 'vulkan'],
      });
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
      // AdapterRAM ist bei >4 GB unzuverlässig (uint32) — nur als Hinweis nutzen
      let vramBytes = g.AdapterRAM ? Number(g.AdapterRAM) : null;
      if (vramBytes && vramBytes < 0) vramBytes = null;
      gpus.push({
        vendor,
        name,
        vramBytes,
        vramApprox: true,
        driver: g.DriverVersion || null,
        source: 'wmi',
        discrete: vendor !== 'Intel',
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
        usableBy: vendor === 'Intel' ? 'openvino' : 'experimental',
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
  const bestGpu = [...hw.gpus].filter((g) => g.vramBytes).sort((a, b) => b.vramBytes - a.vramBytes)[0];
  if (bestGpu) {
    hw.modelBudgetGB = Math.round((bestGpu.vramBytes / 1073741824) * 10) / 10;
    hw.modelBudgetSource = `VRAM: ${bestGpu.name}`;
  } else {
    hw.modelBudgetGB = Math.round((hw.totalMemBytes / 1073741824) * 0.55 * 10) / 10;
    hw.modelBudgetSource = 'RAM (kein VRAM erkannt)';
  }
  return hw;
}

module.exports = { scanHardware, recommendBackend, formatBytes, run };
