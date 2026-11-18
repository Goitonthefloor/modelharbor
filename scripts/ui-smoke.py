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
          i18n_en["lang"] == "en" and i18n_en["nav"] == ["Chat", "Models", "Setup"]
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
          i18n_back["lang"] == "de" and i18n_back["nav"] == ["Chat", "Modelle", "Einrichtung"]
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

    relevant = [e for e in errors if "favicon" not in e and "Preload" not in e]
    check("Keine Renderer-Fehler", len(relevant) == 0, "; ".join(relevant[:5]))

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n=== {len(results) - len(fails)}/{len(results)} bestanden ===")
sys.exit(1 if fails else 0)