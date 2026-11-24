#!/usr/bin/env python3
"""Smoke-Test des headless Webmodus: laeuft `model-harbor serve`, oeffnet die Seite in
Chromium und prueft, dass die vorhandene Desktop-Oberflaeche ohne Electron-Preload
funktioniert (window.api ueber HTTP + SSE).

Aufruf: <venv>/python3 scripts/web-smoke.py   (Exit-Code 0 = bestanden)
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CHECKS = []


def check(name, ok, detail=""):
    CHECKS.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" - {detail}" if detail else ""))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_health(port, timeout=20.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(0.2)
    return None


def main():
    home = "/tmp/mh-websmoke"
    subprocess.run(["rm", "-rf", home], check=False)
    port = free_port()
    env = dict(os.environ, MODELHARBOR_HOME=home)
    proc = subprocess.Popen(
        ["node", "bin/model-harbor.js", "serve", "--port", str(port)],
        cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        health = wait_health(port)
        check("serve antwortet auf /api/health", health and health.get("ok") is True,
              json.dumps(health))
        if not health:
            return 1
        check("health meldet headless, Version und Kanalzahl",
              health.get("mode") == "headless" and health.get("channels", 0) >= 30
              and str(health.get("version", "")).startswith("2."), json.dumps(health))

        url = f"http://127.0.0.1:{port}/"
        errors = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1280, "height": 860})
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

            page.goto(url, wait_until="load")
            page.wait_for_timeout(1200)

            api = page.evaluate("() => ({ has: !!window.api, via: window.api && window.api.__via || null })")
            check("window.api wird ohne Electron aufgebaut", api.get("has") is True, json.dumps(api))

            info = page.evaluate("async () => await window.api.info()")
            check("app:info ueber HTTP", info.get("mode") == "headless", json.dumps(info))

            settings = page.evaluate("async () => await window.api.settings.get()")
            check("settings:get ueber HTTP liefert Pfade", settings.get("modelsDir", "").startswith(home),
                  json.dumps(settings))

            nav = page.evaluate("() => [...document.querySelectorAll('.nav-item span')].map(e => e.textContent.trim())")
            check("Navigation ist da (Chat/Modelle/Server/Setup)", len(nav) >= 4, json.dumps(nav, ensure_ascii=False))

            # Modelle anlegen und pruefen, dass die Tabelle sie anzeigt
            models_dir = Path(home) / "models" / "test__model"
            models_dir.mkdir(parents=True, exist_ok=True)
            gguf = models_dir / "model.Q4_K_M.gguf"
            if not gguf.exists():
                with open(gguf, "wb") as fh:
                    fh.write(b"GGUF" + b"\0" * 4096)
            page.evaluate("() => setView('models')")
            page.evaluate("async () => { state.local = await window.api.models.local(); renderLocal(); }")
            page.wait_for_timeout(400)
            row = page.evaluate("() => { const r = document.querySelector('#local-list .row'); return r ? r.textContent.trim() : null; }")
            check("Modellliste zeigt das Testmodell", bool(row) and "model.Q4_K_M.gguf" in (row or ""),
                  str(row)[:120])

            # Server-Tab: Konfiguration kommt ueber HTTP
            page.evaluate("() => setView('server')")
            page.wait_for_timeout(700)
            srv = page.evaluate("() => { const el = document.querySelector('#srv-port'); return el ? el.value : null; }")
            check("Server-Tab rendert die Konfiguration (Port)", bool(srv), str(srv))

            # Benchmark-Ansicht laedt den Verlauf ueber HTTP
            page.evaluate("() => setView('bench')")
            page.wait_for_timeout(600)
            bench = page.evaluate("() => ({ view: state.view, has: !!document.querySelector('#view-bench') })")
            check("Benchmark-Ansicht oeffnet sich", bench.get("view") == "bench" and bench.get("has") is True,
                  json.dumps(bench))

            shot = Path("/tmp/mh-web-$(date +%s)".replace("$(date +%s)", str(int(time.time()))) + ".png")
            page.evaluate("() => setView('models')")
            page.wait_for_timeout(400)
            page.screenshot(path=str(shot), full_page=False)
            check("Screenshot der Web-Oberflaeche", shot.exists() and shot.stat().st_size > 20000, str(shot))

            bad = [e for e in errors if "favicon" not in e]
            check("Keine Renderer-Fehler in der Web-Oberflaeche", not bad, "; ".join(bad[:3]))
            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

    okc = sum(1 for _, ok, _ in CHECKS if ok)
    print(f"\n=== {okc}/{len(CHECKS)} bestanden ===")
    return 0 if okc == len(CHECKS) else 1


if __name__ == "__main__":
    sys.exit(main())
