#!/usr/bin/env python3
"""ModelHarbor UI-Smoke-Test: laedt ui/index.html mit gemocktem window.api in Chromium.

Voraussetzung: Playwright + Chromium (z. B. venv mit `pip install playwright`).
Ausfuehrung:   python3 scripts/ui-smoke.py   (erwartet Exit-Code 0)
Deckt ab: Toast-Popover (Close, Stacking), Entladen->gruener 'Letztes Modell laden'-
Button -> Neuladen, Tabs (aria-selected, Pfeiltasten), natives confirmDialog, Composer-State.
"""
import sys, json
from playwright.sync_api import sync_playwright

from pathlib import Path
URL = Path(__file__).resolve().parent.parent.joinpath('ui', 'index.html').as_uri()

API_MOCK = """
window.__apiCalls = [];
window.__srvCfgCalls = [];
window.__srvCfg = { port: 1234, lan: false, apiKey: 'mh-testkey-0123456789abcdef', cors: true, corsOrigins: '', parallel: 4 };
window.__keySeq = 0;
window.__srvInfo = { ips: [], restartRequired: false, endpoints: [
  { path: '/v1/chat/completions', method: 'POST' }, { path: '/v1/completions', method: 'POST' },
  { path: '/v1/models', method: 'GET' }, { path: '/health', method: 'GET' }] };
window.__settingsCalls = [];
window.api = {
  info: async () => ({ version: '1.0.0', name: 'ModelHarbor' }),
  settings: {
    get: async () => ({ modelsDir: '/tmp/models', ctx: 8192, gpuLayers: 999, lastPreset: 'balanced', onboardingDone: false, language: 'de' }),
    set: async (p) => { window.__settingsCalls.push(p); return { modelsDir: '/tmp/models', ctx: 8192, gpuLayers: 999, lastPreset: 'balanced', onboardingDone: false, language: 'de', ...p }; },
  },
  presets: async () => ([{ id: 'balanced', name: 'Balanced', icon: '⚖', description: 'Standard', systemPrompt: '', sampling: {} }]),
  server: {
    state: async () => ({ running: false }),
    start: async (o) => { window.__apiCalls.push(['start', o]); return { port: 9931, preset: o.preset }; },
    stop: async () => { window.__apiCalls.push(['stop']); return { stopped: true }; },
    config: async () => ({ config: window.__srvCfg, info: window.__srvInfo }),
    setConfig: async (p) => {
      window.__srvCfgCalls.push(p);
      window.__srvCfg = { ...window.__srvCfg, ...p };
      window.__srvInfo = { ...window.__srvInfo, ips: window.__srvCfg.lan ? ['192.0.2.50'] : [] };
      return { config: window.__srvCfg, info: window.__srvInfo };
    },
    generateKey: async () => ({ key: 'mh-regen-' + (++window.__keySeq) + '-0123456789abcdef' }),
  },
  hw: { scan: async () => ({ osName: 'Linux', arch: 'x64', cpuModel: 'Test CPU', cpuCores: 8, totalMemGB: 16, freeMemGB: 10, gpus: [], npus: [], recommendation: { primary: null, candidates: [] } }) },
  models: {
    catalog: async () => [],
    local: async () => ([{ id: 'm1', repo: 'test/model', file: 'model.Q4_K_M.gguf', sizeLabel: '4.2 GB', path: '/tmp/models/model.Q4_K_M.gguf', quant: 'Q4_K_M', fit: { verdict: 'gpu', label: 'GPU', detail: 'Passt zur GPU', gpuLayers: 32 } }]),
    search: async () => [],
    files: async () => ({ files: [], downloads: 0 }),
    download: async () => ({}),
    delete: async () => ({}),
    reveal: async () => ({}),
  },
  backends: {
    list: async () => ({ available: [], installed: [{ id: 'linux-cpu', label: 'CPU' }], release: { tag: 'b1' } }),
    install: async () => ({}),
    remove: async () => ({}),
  },
  shell: { showModels: async () => ({}), openExternal: async () => ({}) },
  dialog: { pickFolder: async () => null },
  update: {
    check: async () => ({ updateAvailable: false, latest: { tag: 'v1.1.0' } }),
    download: async () => { await new Promise((r) => setTimeout(r, 600)); return { assetPath: '/tmp/mh-update.AppImage', size: 1048576 }; },
    openFile: async () => ({}),
    openReleases: async () => ({}),
  },
  on: (channel, cb) => { (window.__handlers = window.__handlers || {})[channel] = cb; return () => {}; },
};
"""

results = []

FOCUS_JS = "() => { window.fetch = async () => { await new Promise(r => setTimeout(r, 400)); const e = new TextEncoder(); const b = new ReadableStream({ start(c) { c.enqueue(e.encode('data: ' + JSON.stringify({choices:[{delta:{content:'Hi'}}]}) + '\\n\\n')); c.close(); } }); return new Response(b, {status: 200}); }; document.querySelectorAll('dialog[open]').forEach(d => d.close()); setView('chat'); state.server = { running: true, starting: false, port: 9931, model: '/tmp/models/m.gguf', preset: 'balanced', apiKey: '', host: '127.0.0.1', lan: false }; state.chat.messages = []; state.chat.streaming = false; renderChatState(); return true; }"

def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS" if ok else "FAIL"), name, ("- " + detail if detail else ""))

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.add_init_script(API_MOCK)
    page.goto(URL)
    page.wait_for_function("document.querySelector('#side-status') && document.querySelector('#side-status').textContent.includes('Backend')", timeout=10000)
    page.wait_for_timeout(300)

    # 1) Boot: kein Modell -> Entladen-Button disabled
    btn_state = page.evaluate("""() => {
      const b = document.querySelector('#btn-unload');
      return { cls: b.className, disabled: b.disabled, text: b.textContent.trim() };
    }""")
    check("Boot: roter Entladen-Button disabled", "btn-danger-ghost" in btn_state["cls"] and btn_state["disabled"] and "Entladen" in btn_state["text"], json.dumps(btn_state, ensure_ascii=False))

    # 2) Toast: popover, sichtbar, Close-Button
    page.evaluate("toast('Testmeldung ok', 'ok', 6000)")
    page.wait_for_timeout(150)
    toast_ok = page.evaluate("""() => {
      const t = document.querySelector('#toast-wrap .toast');
      return t && t.matches(':popover-open') && t.querySelector('.toast-close') && t.querySelector('.toast-msg').textContent === 'Testmeldung ok';
    }""")
    check("Toast: popover offen + Close-Button + Text", bool(toast_ok))
    page.evaluate("document.querySelector('#toast-wrap .toast .toast-close').click()")
    page.wait_for_timeout(500)
    toast_gone = page.evaluate("document.querySelectorAll('#toast-wrap .toast').length === 0")
    check("Toast: Close-Button entfernt Meldung", bool(toast_gone))

    # 3) loadModel -> roter Entladen-Button aktiv
    page.evaluate("""async () => {
      const m = state.local[0];
      await loadModel(m);
    }""")
    page.wait_for_timeout(200)
    loaded = page.evaluate("""() => {
      const b = document.querySelector('#btn-unload');
      const chip = document.querySelector('#chat-model-chip');
      return { cls: b.className, disabled: b.disabled, text: b.textContent.trim(), live: chip.classList.contains('is-live'), calls: window.__apiCalls };
    }""")
    check("loadModel: rotes Entladen aktiv", "btn-danger-ghost" in loaded["cls"] and not loaded["disabled"] and "Entladen" in loaded["text"] and loaded["live"], json.dumps(loaded, ensure_ascii=False))
    check("loadModel: server.start aufgerufen", any(c[0] == "start" for c in loaded["calls"]))

    # 4) unloadModel -> gruener 'Letztes Modell laden'
    page.evaluate("async () => { await unloadModel(); }")
    page.wait_for_timeout(200)
    unloaded = page.evaluate("""() => {
      const b = document.querySelector('#btn-unload');
      const chip = document.querySelector('#chat-model-chip');
      return { cls: b.className, disabled: b.disabled, text: b.textContent.trim(), live: chip.classList.contains('is-live'), calls: window.__apiCalls };
    }""")
    check("unload: gruener 'Letztes Modell laden'",
          "btn-ok" in unloaded["cls"] and not unloaded["disabled"] and unloaded["text"] == "Letztes Modell laden" and not unloaded["live"],
          json.dumps(unloaded, ensure_ascii=False))
    check("unload: server.stop aufgerufen", any(c[0] == "stop" for c in unloaded["calls"]))
    page.wait_for_timeout(350)
    toasts = page.evaluate("[...document.querySelectorAll('#toast-wrap .toast .toast-msg')].map(t => t.textContent)")
    check("unload: nur Abschluss-Toast sichtbar", len(toasts) == 1 and "bereit zum Neuladen" in toasts[0], str(toasts))

    # 5) Klick auf gruenen Button laedt letztes Modell wieder
    page.click("#btn-unload")
    page.wait_for_timeout(200)
    reloaded = page.evaluate("""() => {
      const b = document.querySelector('#btn-unload');
      const starts = window.__apiCalls.filter(c => c[0] === 'start');
      return { cls: b.className, text: b.textContent.trim(), starts: starts.length, lastModelPath: starts.length ? starts[starts.length-1][1].modelPath : null };
    }""")
    check("Neuladen: Klick laedt letztes Modell",
          "btn-danger-ghost" in reloaded["cls"] and reloaded["starts"] == 2 and reloaded["lastModelPath"] == "/tmp/models/model.Q4_K_M.gguf",
          json.dumps(reloaded, ensure_ascii=False))

    # 6) setTab: aria-selected + Panels
    page.evaluate("setTab('local')")
    page.wait_for_timeout(100)
    tabs = page.evaluate("""() => {
      const sel = document.querySelector('#tab-btn-local').getAttribute('aria-selected');
      const locVis = !document.querySelector('#tab-local').classList.contains('is-hidden');
      const catHidden = document.querySelector('#tab-catalog').classList.contains('is-hidden');
      const start = document.querySelector('#tab-btn-local').hasAttribute('focusgroupstart');
      return { sel, locVis, catHidden, start };
    }""")
    check("setTab: aria-selected + Panels + focusgroupstart", tabs["sel"] == "true" and tabs["locVis"] and tabs["catHidden"] and tabs["start"], json.dumps(tabs))

    # 7) Tabs-Keyboard: ArrowRight wechselt Tab (native focusgroup oder Fallback)
    page.evaluate("setTab('catalog')")
    page.evaluate("setView('models')")
    page.wait_for_timeout(100)
    page.focus("#tab-btn-catalog")
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(100)
    kb = page.evaluate("""() => {
      const active = document.activeElement ? document.activeElement.id : null;
      const sel = document.querySelector('#tab-btn-search').getAttribute('aria-selected');
      return { active, sel };
    }""")
    check("Tabs: Pfeiltaste wechselt Tab + Auswahl", kb["active"] == "tab-btn-search" and kb["sel"] == "true", json.dumps(kb))

    # 8) confirmDialog: destruktiv -> Fokus auf Abbrechen, OK liefert true
    page.evaluate("""() => {
      window.__cd = null;
      confirmDialog({ title: 'Löschen?', message: 'Wirklich?', okLabel: 'Löschen', danger: true }).then(r => window.__cd = r);
    }""")
    page.wait_for_timeout(100)
    dlg = page.evaluate("""() => {
      const d = document.querySelector('#confirm-dialog');
      return { open: d.open, title: document.querySelector('#confirm-title').textContent, okCls: document.querySelector('#confirm-ok').className, focusId: document.activeElement ? document.activeElement.id : null };
    }""")
    check("confirmDialog: modal offen, Titel, danger-Klasse, Fokus Abbrechen", dlg["open"] and dlg["title"] == "Löschen?" and "btn-danger" in dlg["okCls"] and dlg["focusId"] == "confirm-cancel", json.dumps(dlg, ensure_ascii=False))
    page.click("#confirm-ok")
    page.wait_for_timeout(100)
    cd_ok = page.evaluate("window.__cd")
    check("confirmDialog: OK ergibt true", cd_ok is True, str(cd_ok))

    # 9) confirmDialog: Esc ergibt false
    page.evaluate("""() => {
      window.__cd2 = 'pending';
      confirmDialog({ title: 'T', message: 'M', okLabel: 'OK' }).then(r => window.__cd2 = r);
    }""")
    page.wait_for_timeout(100)
    page.keyboard.press("Escape")
    page.wait_for_timeout(100)
    cd_esc = page.evaluate("window.__cd2")
    check("confirmDialog: Esc ergibt false", cd_esc is False, str(cd_esc))

    # 10) Composer ohne Modell deaktiviert
    page.evaluate("async () => { await unloadModel(); }")
    page.wait_for_timeout(150)
    composer = page.evaluate("""() => {
      const i = document.querySelector('#input');
      const s = document.querySelector('#btn-send');
      return { inputDisabled: i.disabled, sendDisabled: s.disabled };
    }""")
    check("Composer ohne Modell deaktiviert", composer["inputDisabled"] and composer["sendDisabled"], json.dumps(composer))

    # 11) Update-Dialog: update:available-Event öffnet Dialog mit Version + Notes
    page.evaluate("""() => {
      const info = {
        updateAvailable: true, currentVersion: '1.0.0',
        latest: { tag: 'v2.0.0', name: 'ModelHarbor 2.0.0', body: 'Ein grosses Update mit vielen Neuerungen.', assets: [{ name: 'ModelHarbor-2.0.0.AppImage', url: 'https://x', size: 5 }] },
        asset: { name: 'ModelHarbor-2.0.0.AppImage', url: 'https://x', size: 5 },
      };
      showUpdateDialog(info);
    }""")
    page.wait_for_timeout(150)
    upd_dlg = page.evaluate("""() => {
      const d = document.querySelector('#update-dialog');
      return { open: d.open, sub: document.querySelector('#update-sub').textContent,
               notes: document.querySelector('#update-notes').textContent,
               nowHidden: document.querySelector('#update-now').classList.contains('is-hidden'),
               progressHidden: document.querySelector('#update-progress').classList.contains('is-hidden') };
    }""")
    check("Update-Dialog: öffnet mit Version + Notes",
          upd_dlg["open"] and "2.0.0" in upd_dlg["sub"] and "viel" in upd_dlg["notes"] and not upd_dlg["nowHidden"] and upd_dlg["progressHidden"],
          json.dumps(upd_dlg, ensure_ascii=False))

    # 12) Download starten: Leiste sichtbar, Progress simuliert die füllende Leiste
    # Wichtig: ; true statt Promise-Rückgabe — sonst wartet page.evaluate auf den ganzen Download
    page.evaluate("startUpdateDownload(); true")
    page.wait_for_timeout(120)
    page.evaluate("""() => {
      const p = { phase: 'download', percent: 42, doneBytes: 440401, totalBytes: 1048576 };
      const fill = document.querySelector('#update-progress-fill');
      fill.style.width = p.percent + '%';
      document.querySelector('#update-progress-pct').textContent = '42 %';
      document.querySelector('#update-progress-text').textContent = '0,4 MB von 1,0 MB';
    }""")
    page.wait_for_timeout(100)
    upd_prog = page.evaluate("""() => {
      const fill = document.querySelector('#update-progress-fill');
      return { width: fill.style.width, pct: document.querySelector('#update-progress-pct').textContent,
               txt: document.querySelector('#update-progress-text').textContent,
               progressVisible: !document.querySelector('#update-progress').classList.contains('is-hidden') };
    }""")
    check("Update-Fortschritt: Balken füllt sich", upd_prog["width"] == "42%" and upd_prog["pct"] == "42 %" and upd_prog["progressVisible"], json.dumps(upd_prog, ensure_ascii=False))

    # 13) Download abschließen: Open-Button erscheint, Jetzt-aktualisieren verschwindet
    page.wait_for_timeout(700)
    upd_done = page.evaluate("""() => {
      const now = document.querySelector('#update-now');
      const open = document.querySelector('#update-open');
      const later = document.querySelector('#update-later');
      return { nowHidden: now.classList.contains('is-hidden'), openVisible: !open.classList.contains('is-hidden'),
               laterText: later.textContent, width: document.querySelector('#update-progress-fill').style.width };
    }""")
    check("Update fertig: Open-Button + 100 %", upd_done["nowHidden"] and upd_done["openVisible"] and upd_done["laterText"] == "Schließen" and upd_done["width"] == "100%", json.dumps(upd_done, ensure_ascii=False))

    # 14) Manueller Check ohne Update: Toast 'Du bist aktuell'
    page.evaluate("""() => {
      state.info = { version: '1.1.0' };
      document.querySelector('#btn-check-update').click();
    }""")
    page.wait_for_timeout(200)
    upd_check = page.evaluate("[...document.querySelectorAll('#toast-wrap .toast-msg')].map(t => t.textContent)")
    check("Manueller Check: 'Du bist aktuell'-Toast", any("aktuell" in t for t in upd_check), str(upd_check))

    # 15) i18n: Default Deutsch, Sprachwechsel im Setup wirkt sofort
    page.evaluate("setView('setup')")
    page.wait_for_timeout(200)
    i18n_de = page.evaluate("""() => {
      const sel = document.querySelector('#set-language');
      const onboard = document.querySelector('#onboard-language');
      const titles = [...document.querySelectorAll('#setup-body .section-title')].map(e => e.textContent.trim());
      return { lang: document.documentElement.lang, sel: sel ? sel.value : null,
               onboard: onboard ? onboard.value : null, titles };
    }""")
    check("i18n: Default Deutsch + Sprachauswahl vorhanden",
          i18n_de["lang"] == "de" and i18n_de["sel"] == "de" and i18n_de["onboard"] == "de"
          and "Einstellungen" in i18n_de["titles"] and "Willkommen bei ModelHarbor" in i18n_de["titles"],
          json.dumps(i18n_de, ensure_ascii=False))

    page.select_option("#set-language", "en")
    page.wait_for_timeout(300)
    i18n_en = page.evaluate("""() => {
      const nav = [...document.querySelectorAll('.nav-item span')].map(e => e.textContent.trim());
      const titles = [...document.querySelectorAll('#setup-body .section-title')].map(e => e.textContent.trim());
      return { lang: document.documentElement.lang, nav, titles,
               hint: document.querySelector('#composer-hint').textContent.trim(),
               modelsTitle: document.querySelector('#view-models h1').textContent.trim(),
               calls: window.__settingsCalls.filter(c => c.language) };
    }""")
    check("i18n: Sprachwechsel auf Englisch rendert sofort um",
          i18n_en["lang"] == "en" and i18n_en["nav"] == ["Chat", "Models", "Server", "Setup"]
          and "Settings" in i18n_en["titles"] and "Your system" in i18n_en["titles"]
          and i18n_en["modelsTitle"] == "Models"
          and i18n_en["hint"] == "Load a model to start chatting"
          and any(c["language"] == "en" for c in i18n_en["calls"]),
          json.dumps(i18n_en, ensure_ascii=False))

    page.select_option("#set-language", "de")
    page.wait_for_timeout(300)
    i18n_back = page.evaluate("""() => {
      const nav = [...document.querySelectorAll('.nav-item span')].map(e => e.textContent.trim());
      return { lang: document.documentElement.lang, nav, calls: window.__settingsCalls.filter(c => c.language) };
    }""")
    check("i18n: Rueckwechsel auf Deutsch",
          i18n_back["lang"] == "de" and i18n_back["nav"] == ["Chat", "Modelle", "Server", "Einrichtung"]
          and any(c["language"] == "de" for c in i18n_back["calls"]),
          json.dumps(i18n_back, ensure_ascii=False))

    # Runde 3: ctx-Obergrenze wird erzwungen (max-Attribut allein reicht nicht)
    page.evaluate("setView('setup')")
    page.wait_for_timeout(250)
    ctx_clamp = page.evaluate("""async () => {
      const el = document.querySelector('#set-ctx');
      el.value = '999999';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      const ngl = document.querySelector('#set-ngl');
      ngl.value = '5000';
      ngl.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      return { ctx: el.value, ngl: ngl.value,
               calls: window.__settingsCalls.filter(c => c.ctx !== undefined || c.gpuLayers !== undefined).slice(-2) };
    }""")
    check("Setup: ctx/ngl werden auf ihre Obergrenze begrenzt",
          ctx_clamp["ctx"] == "131072" and ctx_clamp["ngl"] == "999"
          and any(c.get("ctx") == 131072 for c in ctx_clamp["calls"])
          and any(c.get("gpuLayers") == 999 for c in ctx_clamp["calls"]),
          json.dumps(ctx_clamp))

    # Runde 3: Download-Abschluss darf nur EINE Meldung erzeugen
    page.evaluate("setView('models')")
    page.wait_for_timeout(200)
    dl = page.evaluate("""async () => {
      clearToasts();
      await new Promise(r => setTimeout(r, 350));
      const count = () => document.querySelectorAll('#toast-wrap .toast').length;
      const before = count();
      await startDownload('test/model', 'model.Q4_K_M.gguf', null);
      await new Promise(r => setTimeout(r, 250));
      const afterStart = count();
      const h = (window.__handlers || {})['download:progress'];
      if (h) h({ phase: 'done', downloadId: 'test/model::model.Q4_K_M.gguf', repo: 'test/model', percent: 100 });
      await new Promise(r => setTimeout(r, 800));
      return { before, afterStart, afterEvent: count(), hasHandler: !!h };
    }""")
    check("Download: Abschlussmeldung nur einmal (kein Doppel-Toast)",
          dl["hasHandler"] and dl["afterStart"] == dl["before"] + 1 and dl["afterEvent"] == dl["afterStart"],
          json.dumps(dl))

    # Feature: Modelle aus zusaetzlichen Ordnern (extern markiert, nicht loeschbar)
    page.evaluate("setView('models'); setTab('local')")
    page.wait_for_timeout(200)
    feat = page.evaluate("""async () => {
      window.api.models.local = async () => ([
        { id: 'owner__model/model-Q4_K_M.gguf', repo: 'owner/model', file: 'model-Q4_K_M.gguf',
          sizeLabel: '4.2 GB', path: '/tmp/models/owner__model/model-Q4_K_M.gguf', quant: 'Q4_K_M',
          external: false, fit: { verdict: 'gpu', label: 'GPU', detail: 'passt', gpuLayers: 999 } },
        { id: 'ext0:fremd/modell-Q4_K_M.gguf', repo: 'fremd/modell', file: 'modell-Q4_K_M.gguf',
          sizeLabel: '5.0 GB', path: '/tmp/andere-platte/fremd/modell-Q4_K_M.gguf', quant: 'Q4_K_M',
          external: true, sourceDir: '/tmp/andere-platte', sourceIndex: 0,
          fit: { verdict: 'gpu', label: 'GPU', detail: 'passt', gpuLayers: 999 } },
      ]);
      window.__sources = [{ index: 0, dir: '/tmp/andere-platte', exists: true }];
      window.api.models.sources = async () => window.__sources;
      window.api.models.addSource = async () => {
        window.__sources = [...window.__sources, { index: window.__sources.length, dir: '/tmp/zweiter', exists: true }];
        return { canceled: false, dir: '/tmp/zweiter', count: 3, sources: window.__sources };
      };
      window.api.models.removeSource = async (dir) => {
        window.__sources = window.__sources.filter(s => s.dir !== dir);
        return { removed: dir, sources: window.__sources };
      };
      await refreshLocal();
      await refreshModelSources();
      const rows = [...document.querySelectorAll('#local-list .row')];
      const ext = rows.find(r => r.textContent.includes('fremd/modell'));
      const own = rows.find(r => r.textContent.includes('owner/model'));
      return {
        rowCount: rows.length,
        extBadge: ext ? ext.textContent.includes('Extern') : false,
        extHasDelete: ext ? !!ext.querySelector('[data-act="delete-local"]') : null,
        ownHasDelete: own ? !!own.querySelector('[data-act="delete-local"]') : null,
        extHasLoad: ext ? !!ext.querySelector('[data-act="load-local"]') : false,
        extShowsSource: ext ? ext.textContent.includes('/tmp/andere-platte') : false,
      };
    }""")
    check("Zusatzordner: externes Modell mit Badge, Laden ja / Loeschen nein",
          feat["rowCount"] == 2 and feat["extBadge"] and feat["extHasLoad"]
          and feat["extHasDelete"] is False and feat["ownHasDelete"] is True
          and feat["extShowsSource"],
          json.dumps(feat, ensure_ascii=False))

    # Lange Herkunfts-Pfade (NAS, zweite Platte) duerfen die Zeile nicht sprengen
    longpath = page.evaluate("""async () => {
      const long = '/mnt/sehr-lange-freigabe/auf-dem-nas/modell-sammlung/unterordner/noch-einer';
      window.api.models.local = async () => ([
        { id: 'ext0:x/y.gguf', repo: 'x/y', file: 'y-Q4_K_M.gguf', sizeLabel: '4.2 GB',
          path: long + '/y-Q4_K_M.gguf', quant: 'Q4_K_M', external: true, sourceDir: long, sourceIndex: 0,
          fit: { verdict: 'gpu', label: 'GPU', detail: 'passt', gpuLayers: 999 } },
      ]);
      await refreshLocal();
      const row = document.querySelector('#local-list .row');
      const sub = row.querySelector('.row-sub');
      return { wrap: getComputedStyle(sub).overflowWrap,
               overflow: row.scrollWidth - row.clientWidth,
               showsPath: sub.textContent.includes(long) };
    }""")
    check("Langer Herkunftspfad bricht um statt ueberzulaufen",
          longpath["wrap"] == "anywhere" and longpath["overflow"] <= 1 and longpath["showsPath"],
          json.dumps(longpath, ensure_ascii=False))

    page.evaluate("setView('setup')")
    page.wait_for_timeout(250)
    src = page.evaluate("""async () => {
      clearToasts();
      renderSetup();
      const count = () => document.querySelectorAll('[data-act="remove-source"]').length;
      const before = count();
      const hasAdd = !!document.querySelector('[data-act="add-source"]');
      document.querySelector('[data-act="add-source"]').click();
      await new Promise(r => setTimeout(r, 500));
      const afterAdd = count();
      const toasts = [...document.querySelectorAll('#toast-wrap .toast-msg')].map(e => e.textContent);
      document.querySelector('[data-act="remove-source"]').click();
      await new Promise(r => setTimeout(r, 500));
      return { before, afterAdd, afterRemove: count(), hasAdd, toasts,
               listed: [...document.querySelectorAll('.path-box')].map(e => e.textContent) };
    }""")
    check("Zusatzordner: hinzufuegen/entfernen in den Einstellungen",
          src["hasAdd"] and src["before"] == 1 and src["afterAdd"] == 2 and src["afterRemove"] == 1
          and any("3 Modelle" in x for x in src["toasts"]),
          json.dumps(src, ensure_ascii=False))

    # Feature: modellspezifische Einstellungen mit K/V-Cache-Quantisierung
    page.evaluate("setView('models'); setTab('local')")
    page.wait_for_timeout(200)
    ms = page.evaluate("""async () => {
      window.__msStore = {};
      window.__msCalls = [];
      const ID = 'owner__model/model-Q4_K_M.gguf';
      window.api.modelSettings = {
        schema: async () => ({ cacheTypes: ['f16','bf16','f32','q8_0','q5_1','q5_0','q4_1','q4_0','iq4_nl'], defaultCache: 'f16', limits: {}, keys: [] }),
        get: async (id) => ({ key: id, stored: window.__msStore[id] || {}, resolved: {}, summary: '' }),
        set: async (id, patch) => {
          window.__msCalls.push(['set', id, patch]);
          // wie das echte Backend: leere Overrides entfernen den Eintrag
          if (Object.keys(patch).length) window.__msStore[id] = patch; else delete window.__msStore[id];
          return { key: id, stored: patch };
        },
        reset: async (id) => { window.__msCalls.push(['reset', id]); delete window.__msStore[id]; return { key: id, stored: {} }; },
      };
      window.api.models.local = async () => {
        const st = window.__msStore[ID] || {};
        return [{ id: ID, repo: 'owner/model', file: 'model-Q4_K_M.gguf', sizeLabel: '4.2 GB',
          path: '/tmp/models/owner__model/model-Q4_K_M.gguf', quant: 'Q4_K_M', external: false,
          kvBaseGB: 2.0, fitCtx: 8192, modelSettings: st,
          settingsSummary: Object.keys(st).length ? 'K q4_0 · V q4_0 · FA' : '',
          fit: { verdict: 'gpu', label: 'GPU', detail: 'passt', gpuLayers: 999 } }];
      };
      await refreshLocal();
      const gear = document.querySelector('[data-act="model-settings"]');
      if (!gear) return { error: 'kein Zahnrad-Button' };
      gear.click();
      await new Promise(r => setTimeout(r, 450));
      const dlg = document.querySelector('#model-settings-dialog');
      const kSel = document.querySelector('#ms-cacheTypeK');
      const vSel = document.querySelector('#ms-cacheTypeV');
      if (!kSel || !vSel) return { error: 'Cache-Auswahl fehlt', open: dlg.open };
      const before = document.querySelector('#ms-kv').textContent;
      kSel.value = 'q4_0'; kSel.dispatchEvent(new Event('change'));
      vSel.value = 'q4_0'; vSel.dispatchEvent(new Event('change'));
      const after = document.querySelector('#ms-kv').textContent;
      const noteVisible = !document.querySelector('#ms-note').classList.contains('is-hidden');
      const ctxEl = document.querySelector('#ms-ctx');
      ctxEl.value = '16384'; ctxEl.dispatchEvent(new Event('input'));
      const afterCtx = document.querySelector('#ms-kv').textContent;
      // Kopf und Aktionen muessen ohne Scrollen sichtbar bleiben (nur Felder scrollen)
      const dlgRect = dlg.getBoundingClientRect();
      const saveRect = document.querySelector('#ms-save').getBoundingClientRect();
      const fields = document.querySelector('#ms-fields');
      return {
        open: dlg.open,
        saveVisible: saveRect.bottom <= dlgRect.bottom + 1 && saveRect.top >= dlgRect.top - 1
                     && saveRect.bottom <= window.innerHeight,
        fieldsScroll: fields.scrollHeight > fields.clientHeight,
        bodyOverflow: getComputedStyle(document.querySelector('.ms-body')).overflow,
        kOptions: [...kSel.options].map(o => o.value),
        hasFields: ['ctx','gpuLayers','batchSize','ubatchSize','threads','mlock','noMmap','ropeFreqBase','ropeFreqScale','flashAttn']
          .every(k => !!document.querySelector('[data-ms="' + k + '"]')),
        before, after, afterCtx, noteVisible,
      };
    }""")
    check("Modell-Einstellungen: Dialog mit K/V-Cache-Auswahl und allen Feldern",
          ms.get("open") is True and ms.get("hasFields") is True
          and ms.get("saveVisible") is True and ms.get("fieldsScroll") is True
          and "" in ms.get("kOptions", []) and "q4_0" in ms.get("kOptions", [])
          and "iq4_nl" in ms.get("kOptions", []) and len(ms.get("kOptions", [])) == 10,
          json.dumps(ms, ensure_ascii=False))
    check("KV-Anzeige reagiert live auf Quantisierung und Kontext",
          ms.get("before") != ms.get("after") and "28 %" in (ms.get("after") or "")
          and ms.get("noteVisible") is True and ms.get("after") != ms.get("afterCtx"),
          json.dumps({k: ms.get(k) for k in ("before", "after", "afterCtx", "noteVisible")}, ensure_ascii=False))

    save = page.evaluate("""async () => {
      clearToasts();
      document.querySelector('#ms-save').click();
      await new Promise(r => setTimeout(r, 550));
      const row = document.querySelector('#local-list .row');
      return { closed: !document.querySelector('#model-settings-dialog').open,
               calls: window.__msCalls,
               badge: row ? row.textContent.includes('Eigene') : false,
               toasts: [...document.querySelectorAll('#toast-wrap .toast-msg')].map(e => e.textContent) };
    }""")
    patch_sent = (save.get("calls") or [[None, None, {}]])[0]
    check("Speichern: nur ausgefuellte Felder als Overrides, Badge erscheint",
          save.get("closed") is True and patch_sent[0] == "set"
          and patch_sent[2].get("cacheTypeK") == "q4_0" and patch_sent[2].get("cacheTypeV") == "q4_0"
          and patch_sent[2].get("ctx") == 16384 and "batchSize" not in patch_sent[2]
          and save.get("badge") is True and len(save.get("toasts", [])) >= 1,
          json.dumps(save, ensure_ascii=False))

    reset = page.evaluate("""async () => {
      document.querySelector('[data-act="model-settings"]').click();
      await new Promise(r => setTimeout(r, 450));
      const k = document.querySelector('#ms-cacheTypeK').value;
      const ctx = document.querySelector('#ms-ctx').value;
      document.querySelector('#ms-reset').click();
      await new Promise(r => setTimeout(r, 550));
      const row = document.querySelector('#local-list .row');
      return { k, ctx, calls: window.__msCalls.map(c => c[0]),
               badge: row ? row.textContent.includes('Eigene') : false,
               closed: !document.querySelector('#model-settings-dialog').open };
    }""")
    check("Zuruecksetzen: gespeicherte Werte werden geladen und dann entfernt",
          reset.get("k") == "q4_0" and reset.get("ctx") == "16384"
          and "reset" in reset.get("calls", []) and reset.get("badge") is False
          and reset.get("closed") is True,
          json.dumps(reset, ensure_ascii=False))

    empty = page.evaluate("""async () => {
      window.__msCalls = [];
      document.querySelector('[data-act="model-settings"]').click();
      await new Promise(r => setTimeout(r, 450));
      document.querySelector('#ms-save').click();
      await new Promise(r => setTimeout(r, 450));
      return { calls: window.__msCalls, store: window.__msStore };
    }""")
    check("Leerer Dialog speichert keine Overrides (Standard bleibt)",
          len(empty.get("calls", [])) == 1 and empty["calls"][0][2] == {}
          and empty.get("store", {}) == {},
          json.dumps(empty, ensure_ascii=False))

    # Feature: Server-Tab (API fuer Agenten) inkl. LAN-Schalter
    nav_order = page.evaluate("() => [...document.querySelectorAll('.nav-item')].map(b => b.dataset.view)")
    check("Navigation: Server zwischen Modelle und Einrichtung",
          nav_order == ["chat", "models", "server", "setup"], json.dumps(nav_order))

    page.evaluate("setView('server')")
    page.wait_for_timeout(500)
    srv = page.evaluate("""async () => {
      window.__srvCfgCalls = [];
      window.api.models.local = async () => ([
        { id: 'owner__model/model-Q4_K_M.gguf', repo: 'owner/model', file: 'model-Q4_K_M.gguf',
          sizeLabel: '4.2 GB', path: '/tmp/models/owner__model/model-Q4_K_M.gguf', quant: 'Q4_K_M',
          external: false, nativeCtx: 40960, kvBaseGB: 2.0, fitCtx: 8192, modelSettings: {}, settingsSummary: '',
          fit: { verdict: 'gpu', label: 'GPU', detail: 'passt', gpuLayers: 999 } },
      ]);
      await refreshServerView();
      const ids = ['srv-model','srv-preset','srv-start','srv-stop','srv-port','srv-lan','srv-key','srv-cors','srv-parallel','srv-agents','srv-log'];
      const agents = document.querySelector('#srv-agents').textContent;
      return {
        present: ids.every(i => !!document.querySelector('#' + i)),
        modelOptions: [...document.querySelector('#srv-model').options].map(o => o.value),
        port: document.querySelector('#srv-port').value,
        lanChecked: document.querySelector('#srv-lan').checked,
        noWarning: !document.querySelector('#srv-warning'),
        keyPresent: document.querySelector('#srv-key').value.startsWith('mh-'),
        hasLocalUrl: agents.includes('http://127.0.0.1:1234/v1'),
        hasModelName: agents.includes('ModelHarbor'),
        hasCurl: agents.includes('curl http://127.0.0.1:1234/v1/chat/completions'),
        hasPython: agents.includes('from openai import OpenAI'),
        hasJson: agents.includes('"base_url"'),
        hasEndpoints: agents.includes('/v1/chat/completions') && agents.includes('/health'),
        status: document.querySelector('#srv-status').textContent,
        copyButtons: document.querySelectorAll('[data-act="srv-copy"]').length,
      };
    }""")
    check("Server-Tab: Modellwahl, Zugang, Agenten-Karte mit Snippets",
          srv["present"] and srv["port"] == "1234" and srv["lanChecked"] is False
          and srv["noWarning"] is True and srv["keyPresent"] is True and srv["hasLocalUrl"] and srv["hasModelName"]
          and srv["hasCurl"] and srv["hasPython"] and srv["hasJson"] and srv["hasEndpoints"]
          and srv["copyButtons"] >= 5 and "owner__model/model-Q4_K_M.gguf" in srv["modelOptions"],
          json.dumps(srv, ensure_ascii=False))

    lan = page.evaluate("""async () => {
      const el = document.querySelector('#srv-lan');
      el.checked = true; el.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 350));
      const agents = document.querySelector('#srv-agents').textContent;
      return {
        saved: window.__srvCfgCalls.slice(),
        noWarning: !document.querySelector('#srv-warning'),
        lanUrl: agents.includes('http://192.0.2.50:1234/v1'),
        curlLan: agents.includes('curl http://192.0.2.50:1234/v1/chat/completions'),
        hasAuth: agents.includes('Authorization: Bearer ' + window.__srvCfg.apiKey),
      };
    }""")
    check("LAN-Schalter: Key bleibt aktiv, keine Warnung, LAN-Adresse sichtbar",
          lan["noWarning"] is True and lan["lanUrl"] and lan["curlLan"] and lan["hasAuth"]
          and any(c.get("lan") is True for c in lan["saved"]),
          json.dumps(lan, ensure_ascii=False))

    key = page.evaluate("""async () => {
      document.querySelector('[data-act="srv-genkey"]').click();
      await new Promise(r => setTimeout(r, 400));
      const agents = document.querySelector('#srv-agents').textContent;
      return {
        fieldValue: document.querySelector('#srv-key').value,
        curlHasAuth: agents.includes('Authorization: Bearer ' + document.querySelector('#srv-key').value),
        jsonHasKey: agents.includes('"api_key": "' + document.querySelector('#srv-key').value + '"'),
        saved: window.__srvCfgCalls.slice(),
      };
    }""")
    check("Key neu erzeugen: neuer Key in Feld und curl/Python/JSON",
          key["fieldValue"].startswith("mh-regen-")
          and key["curlHasAuth"] and key["jsonHasKey"]
          and any(c.get("apiKey", "").startswith("mh-") for c in key["saved"]),
          json.dumps(key, ensure_ascii=False))

    cfg = page.evaluate("""async () => {
      const port = document.querySelector('#srv-port');
      port.value = '999999'; port.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 300));
      const cors = document.querySelector('#srv-cors');
      cors.checked = false; cors.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 300));
      const par = document.querySelector('#srv-parallel');
      par.value = '8'; par.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 300));
      return { saved: window.__srvCfgCalls.slice(),
               agents: document.querySelector('#srv-agents').textContent };
    }""")
    check("Server-Konfiguration wird gespeichert (Port/CORS/Slots)",
          any(c.get("port") == 999999 for c in cfg["saved"])
          and any(c.get("cors") is False for c in cfg["saved"])
          and any(c.get("parallel") == 8 for c in cfg["saved"]),
          json.dumps(cfg["saved"], ensure_ascii=False))

    origins = page.evaluate("""async () => {
      window.__srvCfgCalls = [];
      const el = document.querySelector('#srv-cors-origins');
      const before = { present: !!el, hasHint: !!document.querySelector('.settings-label span') };
      el.value = 'https://app.example, http://192.0.2.50:3000';
      el.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 300));
      return { ...before, saved: window.__srvCfgCalls.slice() };
    }""")
    check("CORS-Origins: Feld vorhanden und wird gespeichert",
          origins["present"] and any(
              c.get("corsOrigins") == "https://app.example, http://192.0.2.50:3000"
              for c in origins["saved"]),
          json.dumps(origins, ensure_ascii=False))

    reveal = page.evaluate("""async () => {
      const field = document.querySelector('#srv-key');
      const btn = document.querySelector('[data-act="srv-reveal"]');
      const kindClosed = field.type;
      btn.click();
      await new Promise(r => setTimeout(r, 120));
      const kindOpen = field.type;
      const pressedOpen = btn.getAttribute('aria-pressed');
      btn.click();
      await new Promise(r => setTimeout(r, 120));
      return { kindClosed, kindOpen, pressedOpen, kindClosedAgain: field.type,
               label: btn.getAttribute('title') };
    }""")
    check("API-Key im Feld: standardmäßig verdeckt, per Auge umschaltbar",
          reveal["kindClosed"] == "password" and reveal["kindOpen"] == "text"
          and reveal["pressedOpen"] == "true" and reveal["kindClosedAgain"] == "password",
          json.dumps(reveal, ensure_ascii=False))

    masked = page.evaluate("""() => {
      const cell = document.querySelector('.srv-kv.srv-kv-key .srv-value');
      const full = window.__srvCfg.apiKey;
      const shown = cell ? cell.textContent : '';
      return { shown, full, leaks: !!shown && shown.includes(full),
               copyValue: (state.srvCopy || {}).key === full };
    }""")
    check("Agenten-Karte zeigt den Key maskiert, Kopieren liefert den vollen Wert",
          masked["shown"] and not masked["leaks"] and masked["copyValue"] is True,
          json.dumps(masked, ensure_ascii=False))

    restart = page.evaluate("""async () => {
      window.__srvInfo = { ...window.__srvInfo, restartRequired: true };
      await refreshServerConfig();
      updateServerAccessUi();
      await new Promise(r => setTimeout(r, 150));
      const shown = !!document.querySelector('#srv-restart .srv-restart');
      const hasBtn = !!document.querySelector('[data-act="srv-restart"]');
      const text = document.querySelector('#srv-restart').textContent.trim();
      window.__srvInfo = { ...window.__srvInfo, restartRequired: false };
      await refreshServerConfig();
      updateServerAccessUi();
      await new Promise(r => setTimeout(r, 150));
      return { shown, hasBtn, text, goneWhenFalse: !document.querySelector('#srv-restart .srv-restart') };
    }""")
    check("Neustart-Hinweis erscheint nur bei restartRequired und verschwindet wieder",
          restart["shown"] and restart["hasBtn"] and restart["goneWhenFalse"] is True
          and len(restart["text"]) > 0,
          json.dumps(restart, ensure_ascii=False))

    copy = page.evaluate("""async () => {
      clearToasts();
      document.querySelector('[data-act="srv-copy"][data-copy-key="localUrl"]').click();
      await new Promise(r => setTimeout(r, 350));
      return { toasts: [...document.querySelectorAll('#toast-wrap .toast-msg')].map(e => e.textContent),
               expected: state.srvCopy.localUrl };
    }""")
    check("Kopieren-Button liefert die Base-URL",
          len(copy["toasts"]) >= 1 and copy["expected"].startswith("http://") and copy["expected"].endswith("/v1"),
          json.dumps(copy, ensure_ascii=False))

    start = page.evaluate("""async () => {
      window.__apiCalls = [];
      document.querySelector('#srv-start').click();
      await new Promise(r => setTimeout(r, 600));
      return { calls: window.__apiCalls.filter(c => c[0] === 'start'),
               view: state.view };
    }""")
    started = (start["calls"] or [[None, {}]])[0][1]
    check("Server starten: nutzt das gewaehlte Modell und bleibt im Server-Tab",
          started.get("modelPath") == "/tmp/models/owner__model/model-Q4_K_M.gguf"
          and started.get("modelId") == "owner__model/model-Q4_K_M.gguf"
          and start["view"] == "server",
          json.dumps(start, ensure_ascii=False))

    # Enter soll den Fokus im Chatfeld lassen (auch waehrend des Streamens)
    focus = page.evaluate("""async () => {
      // Offene modale Dialoge aus frueheren Checks machen den Rest inert -> schliessen
      document.querySelectorAll('dialog[open]').forEach(d => d.close());
      setView('chat');
      state.server.running = true;
      state.chat.streaming = false;
      renderChatState();
      const input = document.querySelector('#input');
      input.focus();
      input.value = 'Hallo';
      const before = document.activeElement === input;
      // Stream-Zustand: das Feld darf nicht disabled werden (das kostet den Fokus)
      state.chat.streaming = true;
      renderChatState();
      const duringDisabled = input.disabled;
      const duringFocus = document.activeElement === input;
      state.chat.streaming = false;
      renderChatState();
      return { before, duringDisabled, duringFocus,
               afterDisabled: input.disabled, afterFocus: document.activeElement === input,
               diag: { hasFocus: document.hasFocus(),
                       active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
                       dlgOpen: [...document.querySelectorAll('dialog')].filter(d => d.open).map(d => d.id),
                       viewActive: document.querySelector('#view-chat').classList.contains('is-active'),
                       display: getComputedStyle(input).display,
                       inert: !!input.closest('[inert]') } };
    }""")
    check("Chat: Enter/Streaming behaelt den Fokus im Textfeld",
          focus["before"] and focus["duringDisabled"] is False and focus["duringFocus"]
          and focus["afterDisabled"] is False and focus["afterFocus"],
          json.dumps(focus))

    page.evaluate(FOCUS_JS)
    page.fill("#input", "Hallo")
    page.click("#btn-send")
    page.wait_for_timeout(1500)
    click_focus = page.evaluate("() => ({ active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none', msgs: state.chat.messages.length, streaming: state.chat.streaming })")
    check("Chat: Fokus bleibt nach Klick auf Senden im Textfeld",
          click_focus["active"] == "input", json.dumps(click_focus))

    page.evaluate(FOCUS_JS)
    page.fill("#input", "Hallo3")
    page.focus("#input")
    page.evaluate("() => { const h = window.__handlers && window.__handlers['server:state']; if (h) h({ running: false }); }")
    page.wait_for_timeout(200)
    st_false = page.evaluate("() => ({ active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none', disabled: document.querySelector('#input').disabled })")
    page.evaluate("() => { const h = window.__handlers && window.__handlers['server:state']; if (h) h({ running: true, port: 9931, model: '/tmp/models/m.gguf', preset: 'balanced' }); }")
    page.wait_for_timeout(200)
    st_back = page.evaluate("() => ({ active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none', disabled: document.querySelector('#input').disabled })")
    print("STATEFALSE", json.dumps(st_false), "STATBACK", json.dumps(st_back))

    page.evaluate(FOCUS_JS)
    page.fill("#input", "Hallo4")
    page.click("#btn-send")
    page.evaluate("() => document.querySelector('#btn-send').focus()")
    page.wait_for_function("() => !state.chat.streaming", timeout=10000)
    page.wait_for_timeout(300)
    back_focus = page.evaluate("() => ({ active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none' })")
    check("Chat: Fokus kehrt nach dem Stream-Ende ins Textfeld zurueck",
          back_focus["active"] == "input", json.dumps(back_focus))

    relevant = [e for e in errors if "favicon" not in e and "Preload" not in e]
    check("Keine Renderer-Fehler", len(relevant) == 0, "; ".join(relevant[:5]))

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n=== {len(results) - len(fails)}/{len(results)} bestanden ===")
sys.exit(1 if fails else 0)