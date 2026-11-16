# Changelog

All notable changes to ModelHarbor are documented in this file.

## [1.4.2] - 2026-11-16

### Added

- **NPU-/Ryzen-AI-Modelle in den Vorschlägen.** Der Katalog enthält jetzt echte,
  per HuggingFace-API verifizierte AMD-Ryzen-AI-Repos mit `genai_config.json` im
  Repo-Root: `amd/Qwen3.5_9B_rai_1.9.0_npu` (RAI 1.9.0, ~15,4 GB), 
  `amd/Qwen3-8B-awq-quant-onnx-hybrid` (~8,8 GB) und
  `amd/Phi-4-mini-instruct-onnx-ryzenai-hybrid` (~5,1 GB). Sie sind mit
  **„Ryzen AI“** gekennzeichnet und werden als kompletter Ordner geladen
  (`onnxSub: null` = Repo-Root ohne README/LICENSE/Logs/`cache/`).
- **Zweite Suchgruppe in der HuggingFace-Suche.** Neben der GGUF-Suche läuft eine
  parallele ONNX-Suche (`filter=onnx`); Treffer mit ONNX-/NPU-Muster im Repo-Namen
  (`onnx`, `ryzenai`, `rai`, `npu`, …) erscheinen als eigene Gruppe
  „ONNX-/Ryzen-AI-Modelle (Ordner-Download)“ unter den GGUF-Treffern und haben
  einen direkten Ordner-Download-Button.
- **`estimateVramFromName()`** in `electron/hardware.js`: schätzt den typischen VRAM
  bekannter GPUs (RTX 40/30, GTX 16, RX 7000/9000, Arc A750/A770) aus dem
  Gerätenamen — Laptop-/Mobil-Varianten und integrierte Grafiken bewusst nicht.
- **Optionale erweiterte Debug-Logdatei.** Neues `electron/logger.js`; Schalter
  **„Erweitertes Log (Debug)“** in Setup → Einstellungen. Schreibt Hardware-,
  Server- und Fehlerdetails nach `<userData>/logs/modelharbor-debug.log`
  (150-KB-Rotation) — hilfreich beim Debuggen von Erkennung/Server/Downloads.

### Fixed

- **dGPU-VRAM wurde nur als 4 GB angezeigt.** Ursache war `Win32_VideoController.
  AdapterRAM` (UInt32, kappt oberhalb von 4 GB). Die Windows-Erkennung liest jetzt
  zusätzlich `HardwareInformation.qwMemorySize` (QWORD) aus der Registry
  (`HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-…}\00*`) und ordnet
  den Wert über die Treiberbeschreibung (`DriverDesc`) der passenden GPU zu. Fehlt
  ein plausibler Wert (< 1 GB bei einer diskreten Karte), greift die
  Namens-Schätzung (`vramApprox: true`). Integrierte GPUs bleiben unverändert.
- **`listLocal` erkannte Ryzen-AI-Ordner nicht.** Voraussetzung war
  `genai_config.json` **plus** `.onnx`/`.onnx.data`. Jetzt genügt eine echte große
  Modelldatei (`.onnx`, `.onnx.data`, `.fconst` oder `.state` ab 50 MB) neben
  `genai_config.json` — reine Config-Ordner bleiben weiterhin draußen.

### Changed

- Suchtreffer tragen jetzt `onnx`/`onnxSub`-Marker; ONNX-Katalogeinträge zeigen
  keine Quant-/Dateiangabe mehr, sondern ihre Kennzeichnung („NPU/ONNX“ bzw.
  „Ryzen AI“).
- `npm test`: **61** Unit-Tests (vorher 53; +8: VRAM-Schätzung, Registry-Zuordnung,
  `parseOnnxFolderFiles`, Ryzen-AI-`listLocal`); UI-Smoke **23/23**.

## [1.4.1] - 2026-11-16

### Added

- **ONNX-Katalog-Vorschläge** im Model-Download-Tab: drei kuratierte, OGA-taugliche
  Repos (Phi-3 Mini 4K, Phi-4 Mini, Llama 3.2 1B) mit `onnx:true` — sie werden wie
  andere Vorschläge angezeigt und per **Mehrfach-Download** als vollständiger
  Modellordner (`genai_config.json` + `.onnx`/`.onnx.data` + Tokenizer) geladen.
- **Python-3.12-Mitinstallation** für das `onnx`-Backend: fehlt ein passendes
  System-Python (3.10–3.12), lädt der Installer die `astral/uv`-Binary, installiert
  eine isolierte Python-3.12-Instanz und baut damit das OGA-Venv (`uv pip install
  onnxruntime-genai`). Kein manuelles Python-Setup mehr nötig.

### Fixed

- **HuggingFace-Redirects** in `getJson` (relative `location`-Pfade) — betraf
  `onnx-community/Llama-3.2-1B-ONNX`, das auf `…-Instruct-GENAI-ONNX` umleitet.
- `pickSystemPython` erkannte bei ausführbarem Test-Befehl (Exec->NULL) fälschlich
  „kein Python" — jetzt über `spawnSync`.

### Changed

- `npm test`: **53** Unit-Tests (vorher 47; +6: ONNX-Katalog, `parseOnnxFiles`,
  `uvAssetFor`); UI-Smoke weiterhin **23/23**.

## [1.4.0] - 2026-11-16

### Added

- **ONNX-/NPU-Modelle (OnnxRuntime GenAI).** ModelHarbor unterstützt jetzt zusätzlich
  zu llama.cpp/GGUF auch ONNX-Modelle: lokale ONNX-Modellordner (`genai_config.json`
  + `.onnx`) erscheinen im Modell-Fenster und werden über einen eigenen OGA-Chat-Server
  gestartet — die Chat-Oberfläche bleibt identisch (OpenAI-kompatibel, SSE-Streaming).
- **`onnx`-Backend** in der Einrichtung: legt ein Python-Venv (3.10–3.12) mit
  `onnxruntime-genai` an und startet darüber den OGA-Server. Basis für AMD-Ryzen-AI-NPU,
  Intel-OpenVINO-NPU, DirectML und CPU — ohne NPU läuft alles als CPU-Fallback.

### Fixed

- **Gemischte Responses** bei `hf`-CLI-Downloads sind hier nicht betroffen; stattdessen:
  **`node --test test/` scheiterte** in der gebündelten Node-Version — das Test-Skript nutzt
  jetzt explizite Globs (`"test/*.test.js"`). *(Hinweis aus 1.3.0, hier fixiert.)*

### Changed

- `npm test`: **47** Unit-Tests (vorher 43), davon 4 neue ONNX-/NPU-Tests
  (`listLocal`, `listInstalled`, `server.js`-Verbindung); UI-Smoke weiterhin **23/23**.
- `electron/onnx_server.py`: erweiterte OpenAI-kompatible Ausgabe (`/health`,
  `chat/completions` mit `stream:true` SSE + Usage + `[DONE]`, `stream:false` JSON).

## [1.3.0] - 2026-11-16

### Fixed

- **Download-Button reagierte nicht**, wenn ein Modell keine herunterladbare
  Datei bot („not available“) oder nicht gefunden wurde: der Katalog-Handler
  brach stillschweigend ab. Jetzt erscheint eine klare Fehlermeldung und der
  Button wird deaktiviert — auch bei fehlender `file`-Referenz im
  Dateipanel-Download.
- **AMD-integrierte GPUs und Intel-Arc-dGPUs falsch klassifiziert.** Bisher
  galt nur Intel generell als „integriert“, wodurch AMD-APU-iGPUs
  (Radeon 6xxM/7xxM/8xxM, Renoir/Phoenix/Cezanne/…) fälschlich als diskret und
  Intel-Arc-Karten fälschlich als integriert erschienen. Neue, hersteller- und
  namensbasierte Klassifikation (`isIntegrated`) korrigiert die Anzeige und den
  Hardware-Mismatch in der Einrichtung.
- **Modell-Budget basierte auf dem iGPU-VRAM** geteilter Speicher. Bei reinen
  APU-Systemen wird das Budget jetzt aus dem System-RAM berechnet und klar als
  „integrierte GPU, geteilter Speicher“ ausgewiesen.
- **Nutzbarkeit des Test-Skripts:** `npm test` nutzt jetzt explizite Glob-Pfade
  statt `node --test test/`, das in der gebündelten Node-Version fehlschlug.

### Added

- **AMD-NPUs klar benannt:** werden nicht über ROCm/llama.cpp, sondern über die
  Ryzen-AI-Software (ONNX-Runtime) angesprochen. Die Einrichtung zeigt dafür
  einen eigenen Hinweistext, statt irreführend „experimentell“ zu melden.
- 6 neue Unit-Tests zur integrated/discrete-Klassifikation
  (`test/unit.test.js`, `isIntegrated`).

### Changed

- `npm test`: 43 Unit-Tests (vorher 37) + 23 UI-Smoke-Checks, alle grün.

## [1.2.2] - 2026-11-15

### Fixed

- **`ReferenceError: activeUpdate is not defined` beim Update-Download.** Der
  IPC-Handler `update:download` nutzte die Variable `activeUpdate`, ohne sie zu
  deklarieren (nur `activeDownload` existierte). Unter `'use strict'` brach
  damit jeder Klick auf „Jetzt aktualisieren“ und „Erneut versuchen“ ab; im
  Renderer erschien „Download fehlgeschlagen: … ReferenceError: activeUpdate is
  not defined“. Die Variable ist jetzt deklariert, die Logik bleibt unverändert:
  ein zweiter paralleler Download wird wieder sauber mit „Ein Update-Download
  läuft bereits.“ abgewiesen.

### Changed

- **README komplett auf Englisch.** Struktur, Tabellen, Code-Blöcke und URLs
  unverändert; Versionstabelle auf 1.2.2 aktualisiert, Hinweis auf die
  Sprachumschaltung und den zweisprachigen Lizenztext ergänzt.

## [1.2.1] - 2026-11-15

### Added

- **Englische Oberfläche über Sprachauswahl (Deutsch/Englisch).** Die Sprache
  lässt sich beim ersten Start im Einrichtungs-Workflow und jederzeit im
  Einstellungsbereich des Setup-Views umschalten. Der Wechsel wirkt sofort
  ohne Neustart: alle statischen Texte, Dialoge, Toasts, Preset-Namen,
  Modellkarten und Fit-Badges werden neu gerendert.
- Die gewählte Sprache wird in `settings.json` (`language`) gespeichert und
  beim Start wieder geladen; unbekannte Werte fallen auf Deutsch zurück.
- Fehlermeldungen aus dem Main-Prozess (laufender Download, fehlendes Backend,
  laufender Update-Download) folgen der gewählten Sprache.

## [1.0.1] - 2026-11-14

### Security

- **Replace `extract-zip` 2.0.1** with a self-contained `yauzl`-based extractor
  (`extractZipSafe`). Every archive entry is normalized and checked against the
  target directory, symlinks and absolute paths are rejected. Closes
  CVE-2026-19693 and CVE-2026-56876 (arbitrary file writes via symlink archive
  entries).
- **Pin `minimatch` to 11.0.1** for `app-builder-lib` and `@electron/universal`
  via npm overrides. Closes CVE-2026-118764 (globparts amplification DoS) in
  the build-time dependency tree. `glob`/`@electron/asar` keep their
  unaffected 3.x line.

### Fixed

- Recognize `cudart` packages with and without a build number in the asset
  name on all platforms.
- Associate the ModelHarbor window correctly on Linux
  (`desktopName` + `syncDesktopName`); document the AppImage sandbox hint in
  the README.

### Added

- Show tokens per second after every chat response.
- README rewrite in more natural German, plus a download hint pointing to
  the GitHub Releases page.

### Changed

- Add regression tests for the safe ZIP extraction (traversal, absolute
  paths, symlinks, normalized escapes) in `test/zip-security.test.js`
  (28 tests total, all green).
- Update the README third-party component list (`yauzl` instead of
  `extract-zip`).

## [1.0.0] - 2026-11-14

### Added

- ModelHarbor 1.0.0: local AI chat models with one click.
- Hardware detection (GPU/VRAM, NPU, RAM) with per-machine backend and model
  recommendations.
- llama.cpp backend installer (official ggml-org releases) for Windows,
  Linux and macOS, incl. CUDA, Vulkan, ROCm, SYCL, OpenVINO and CPU builds.
- HuggingFace model catalog, search, split-file download with resume and
  local model management.
- Four sampling presets (Balanced, Creative, Deterministic, Code / Reasoning)
  mapped to llama-server flags.
- German UI with chat streaming, reasoning display and token usage.

### License

- ModelHarbor License 1.0: free use, distribution only under license.
