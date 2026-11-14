# ModelHarbor

Lokale KI-Chatmodelle per Klick: ohne Terminal, ohne Cloud, ohne Konto.

ModelHarbor schaut, welche Hardware du hast, sucht das passende llama.cpp-Backend heraus,
lädt Modelle direkt von HuggingFace und öffnet danach einen Chat, der schon passend
eingestellt ist.

```
┌──────────────┐   1. Hardware erkennen     ┌───────────────────────────┐
│  ModelHarbor │ ─────────────────────────► │ CPU / GPU / VRAM / NPU    │
│  (Desktop)   │                            └───────────────────────────┘
│              │   2. Backend wählen        CUDA · ROCm · Vulkan · Metal
│              │   3. Modell laden          HuggingFace (GGUF, mit Resume)
│              │   4. llama-server starten  Presets: Kreativ / Deterministisch / …
└──────────────┘
```

## Was es kann

- **Einrichtung ohne Vorwissen.** ModelHarbor erkennt Betriebssystem, CPU, RAM sowie GPUs
  (NVIDIA, AMD, Intel, Apple) und NPUs. Danach empfiehlt es ein Backend und lädt es herunter.
- **Viele Backends.** Je nach Plattform stehen llama.cpp-Builds für CUDA (12.4 / 13.5),
  ROCm/HIP, Vulkan, Metal, SYCL, OpenVINO und CPU zur Verfügung.
- **Modelle, die zu deinem Rechner passen.** Der Katalog zeigt bei jedem Modell, ob es
  komplett in den VRAM passt, teilweise auf die GPU ausgelagert wird oder nur im RAM läuft.
  Die Quantisierung (Q4_K_M, Q6_K usw.) wählt die App gleich mit.
- **HuggingFace-Suche.** Du kannst beliebige GGUF-Repos durchsuchen, Dateigröße und
  Hardware-Einschätzung vor dem Download prüfen und dann laden. Der Download lässt sich
  fortsetzen, und mehrteilige Modelle werden komplett geholt.
- **Vier Presets** mit echten llama.cpp-Sampler-Ketten:
  - **Balanced**: für den Alltag, Fragen und Erklärungen
  - **Kreativ**: mehr Abwechslung (DRY + XTC)
  - **Deterministisch**: Greedy-Sampling mit festem Seed, also reproduzierbar
  - **Code / Reasoning**: kühles Sampling mit Wiederholungsbremse
- **NPU-Erkennung.** Intel-NPU, AMD-XDNA und Apple Neural Engine werden angezeigt. Wo es
  Sinn ergibt (Intel-NPU mit OpenVINO), gibt es dafür eine experimentelle Option. Ansonsten
  läuft der Chat ehrlich über GPU oder CPU.
- **Denkmodelle.** Modelle wie Qwen3 zeigen ihren `reasoning_content` als aufklappbaren
  Gedankengang, die eigentliche Antwort bleibt davon getrennt.
- **Tempo-Anzeige.** Nach jeder Antwort stehen unter dem Chat die Prompt-Token, die
  Antwort-Token und die tatsächlich erreichte Rate in `tok/s` — gemessen vom ersten bis
  zum letzten Stream-Delta, nicht geschätzt.
- **Bedienung.** Stop-Button (oder `Esc`) während einer Antwort, Chatverlauf mit Kopieren
  und Neu generieren. Die Oberfläche ist deutsch und läuft nach dem ersten Download offline.
- **Entladen & Neuladen.** Ein Klick auf **Entladen** gibt sofort Rückmeldung und räumt das
  Modell aus dem Speicher. Danach wird der rote Button zum grünen **„Letztes Modell laden“** —
  das zuletzt verwendete Modell ist damit mit einem Klick wieder da (inkl. Preset und GPU-Fit).
- **Rundum bedienbar.** Die Modell-Tabs lassen sich mit den Pfeiltasten wechseln, der aktive
  Tab hat einen deutlichen Unterstrich, und jede Aktion hat sichtbares Fokus- und
  Druck-Feedback. Bestätigungen (Modell wechseln, Löschen, Backend entfernen) erscheinen als
  eigene Dialoge, Meldungen als schließbare Hinweise, die auch Screenreader mitbekommen.
- **Auto-Update.** Beim Start prüft die App still gegen die GitHub-Releases, ob eine neuere
  Version da ist. Wenn ja, fragt ein Dialog: **Jetzt aktualisieren** lädt das passende Paket
  (AppImage/Installer) direkt herunter — eine Statusleiste zeigt den Fortschritt — und du
  öffnest die Datei anschließend mit einem Klick. Ohne Update keine Unterbrechung. In der
  Einrichtung geht auch ein manueller Check („Nach Updates suchen“).

## Installation

Die fertigen Pakete liegen in `dist/`:

| Plattform | Datei | Stand |
|---|---|---|
| Windows 10/11 (x64) | `dist/windows/ModelHarbor Setup 1.1.0.exe` | bauen mit `npm run dist:win` (Windows oder Wine; 1.0.0-Installer liegt bereit) |
| Linux (x64) | `dist/ModelHarbor-1.1.0.AppImage` | gebaut, im Alltagsbetrieb getestet (121 MB) |
| macOS (Apple Silicon / Intel) | `ModelHarbor-1.1.0-arm64.dmg` / `-x64.dmg` | bauen mit `npm run dist:mac` (auf einem Mac) |

Beim ersten Start führt dich die App durch die Einrichtung: Hardware prüfen, Backend
installieren, Modell auswählen.

> Die Pakete sind nicht signiert. Windows zeigt beim ersten Start eine SmartScreen-Warnung
> („Weitere Informationen“ → „Trotzdem ausführen“). macOS verlangt beim ersten Start
> einen Rechtsklick → „Öffnen“.
> ModelHarbor sendet keine Telemetrie. Downloads kommen nur von `huggingface.co` und
> `github.com`.

## Selbst bauen

Du brauchst Node.js ≥ 20 und npm.

```bash
npm install
npm start                 # Entwicklungsmodus
npm test                  # Backend-Unit-Tests (Hardware, Presets, Server-Args)
python3 scripts/ui-smoke.py   # Renderer-Smoke-Test (braucht Playwright + Chromium)
npm run dist:linux        # AppImage
npm run dist:win          # NSIS-Installer
npm run dist:mac          # DMG
```

Der Renderer-Smoke-Test (`scripts/ui-smoke.py`) lädt die Oberfläche headless in Chromium,
mockt die Electron-Bridge und prüft die wichtigsten Abläufe: Entladen → „Letztes Modell laden“,
Toast-Meldungen, Tab-Navigation per Tastatur, Bestätigungsdialoge. Erwarteter Exit-Code: 0.

Die Pakete landen in `dist/`. Windows- und macOS-Pakete baust du am besten auf dem jeweiligen
System (oder in der CI). Cross-Builds von Linux nach Windows funktionieren nur mit Wine.

Bisher getestet habe ich: Linux (Entwicklung und AppImage, CPU-Backend, Modell-Download,
Chat mit Qwen3-4B) sowie Windows 11 (Hardware-Erkennung, CUDA-Empfehlung, Installation des
NSIS-Pakets). Weitere Hardware-Kombinationen sind als Nächstes geplant. Mehr dazu unten.

## Datenpfade

| Inhalt | Windows | Linux | macOS |
|---|---|---|---|
| Einstellungen | `%APPDATA%\ModelHarbor` | `~/.config/ModelHarbor` | `~/Library/Application Support/ModelHarbor` |
| Modelle | `…\ModelHarbor\models` | `~/.config/ModelHarbor/models` | `…/ModelHarbor/models` |
| Backends | `…\ModelHarbor\backends` | `~/.config/ModelHarbor/backends` | `…/ModelHarbor/backends` |

Modell- und Backend-Ordner kannst du in der App unter **Einrichtung → Einstellungen** ändern.

## So erkennt ModelHarbor die Hardware

| Plattform | GPU | VRAM | NPU |
|---|---|---|---|
| Windows | `nvidia-smi`, WMI (`Win32_VideoController`) | `nvidia-smi`; bei AMD und Intel eine Schätzung | `Get-PnpDevice` (ComputeAccelerator / AI Boost / XDNA / Hexagon) |
| Linux | `nvidia-smi`, `lspci`, sysfs | `nvidia-smi`, `/sys/class/drm/*/mem_info_vram_total` | `lspci` (Processing Accelerators), `/dev/accel/*` |
| macOS | `system_profiler SPDisplaysDataType` | Unified Memory (Apple Silicon: etwa 66 % des RAM) | Apple Neural Engine (nur als Information) |

Das Backend empfiehlt die App nach dieser Logik:

1. **Apple Silicon**: Metal-Build.
2. **NVIDIA**: CUDA, weil es deutlich schneller ist als Vulkan. Vulkan ist die Alternative.
3. **AMD unter Linux**: ROCm, wenn die Runtime vorhanden ist. Sonst Vulkan.
4. **AMD unter Windows**: Vulkan, weil es stabil läuft. ROCm gibt es als experimentelle Option.
5. **Intel**: Vulkan. SYCL ist experimentell. OpenVINO nur, wenn eine Intel-NPU erkannt wird.
6. **Keine GPU**: CPU-Build.

## Wie der Modell-Fit berechnet wird

Den Speicherbedarf schätze ich so:

```
Bedarf ≈ Dateigröße + KV-Cache + Overhead
KV-Cache ≈ Parameter × 0,045 GB × (Kontext / 4096)
```

Daraus ergeben sich vier Stufen: **passt in den VRAM**, **teilweise auf GPU**,
**läuft im RAM** und **zu groß**. Bei der Quantisierung nimmt die App den größten Quant,
der mit Reserve hineinpasst. Dabei bleibt sie unter 65 % des Budgets, damit die
Geschwindigkeit nicht leidet.

## Presets im Detail

| Preset | Temp | Top-K | Top-P | Min-P | Besonderheit |
|---|---|---|---|---|---|
| Balanced | 0,70 | 40 | 0,92 | 0,05 | Standard-Sampler-Kette |
| Kreativ | 1,05 | 80 | 0,96 | 0,02 | DRY 0,8 + XTC 0,4 |
| Deterministisch | 0,00 | 1 | 1,00 | 0,00 | Seed 42, Greedy |
| Code / Reasoning | 0,20 | 20 | 0,95 | 0,05 | DRY 0,5, langer Repeat-Bereich |

Beim Modellstart übergibt die App alle Preset-Parameter an `llama-server`. Im Chat setzt sie
die Hauptparameter bei jeder Anfrage neu. So wirkt ein Presetwechsel sofort.

## Technik

- **Electron**: Hauptprozess und Renderer mit `contextIsolation`, Node läuft nicht im Renderer.
- **llama.cpp**: Binaries aus den offiziellen `ggml-org/llama.cpp`-Releases. Die App nimmt
  automatisch den neuesten Build mit Binär-Assets.
- **llama-server** läuft als lokaler Prozess und stellt eine OpenAI-kompatible API auf
  `127.0.0.1` bereit.
- Der Chat streamt per SSE direkt aus dem Renderer.
- **Updates** kommen von den GitHub-Releases (`Goitonthefloor/modelharbor`): semver-Vergleich
  im Hauptprozess, Download des plattformpassenden Pakets mit Fortschritts-Status. Der Check
  ist ein stiller `GET /repos/…/releases/latest` — ohne Konto, ohne Telemetrie.
- Keine Telemetrie. Außer HuggingFace und GitHub-Releases gibt es keine Cloud-Aufrufe.

> **Sandbox-Hinweis (Linux-AppImage):** Ein AppImage kann das setuid-Binary für die
> Chromium-Sandbox nicht mitliefern. Deshalb startet das Paket mit `--no-sandbox`. Das ist bei
> AppImages üblich. Die App lädt nur lokale Dateien (`file://`) und spricht nur mit dem
> selbst gestarteten `llama-server` auf `127.0.0.1`. Wenn du die Sandbox willst, baust du mit
> `npm run dist:linux -- --dir` und startest `dist/linux-unpacked/modelharbor` mit deiner
> eigenen `chrome-sandbox`. Die Fensterzuordnung läuft über `desktopName` und
> `syncDesktopName` (`StartupWMClass=modelharbor`).

## Fehlerbehebung

**„Kein Backend installiert“**: Öffne die Einrichtung und installiere das empfohlene Backend.
Dafür brauchst du einmal Internet. Danach läuft alles offline.

**Modell lädt nicht oder stürzt ab**: Meist reicht der VRAM nicht. Reduziere in der Einrichtung
die GPU-Layers (z. B. von 999 auf 20) oder senke die Kontextgröße.

**AMD unter Windows ist langsam**: Vulkan ist der stabile Weg. ROCm ist experimentell und
hängt vom Treiber ab.

**Apple Silicon**: Metal ist automatisch aktiv. Die angezeigte VRAM-Zahl ist bei Unified Memory
nur eine Schätzung.

## Feedback gesucht

ModelHarbor läuft bisher auf meinen eigenen Rechnern. Die Hardware-Erkennung und die
Backend-Auswahl sind deshalb vor allem für Konfigurationen getestet, die ich selbst habe.
Als Nächstes möchte ich weitere Kombinationen testen, zum Beispiel AMD-GPUs, Intel-Systeme,
Notebooks mit Hybrid-Grafik und macOS.

Wenn du ModelHarbor ausprobierst, sag mir gern:

- **Was für ein System du hast** (Betriebssystem, CPU, RAM, GPU, ggf. NPU)
- **Welches Backend erkannt und installiert wurde** und ob der Chat läuft
- **Was nicht geklappt hat**, am besten mit dem Fehlertext oder einem Screenshot

Das geht am einfachsten über ein [Issue](https://github.com/Goitonthefloor/modelharbor/issues).
Auch kurze Rückmeldungen wie „läuft“ oder „läuft nicht“ helfen mir schon weiter.

## Lizenz

**ModelHarbor License 1.0: freie Nutzung, Vertrieb nur mit Lizenz.**

| Erlaubt ohne Gebühr | Nur mit schriftlicher Lizenz (gebührenpflichtig) |
|---|---|
| Private, schulische und interne Nutzung | Weitergabe an Dritte |
| Kommerzielle Nutzung **im eigenen** Unternehmen, auf beliebig vielen Geräten | Veröffentlichen, Spiegeln, Upload auf andere Seiten, App-Stores, Paketquellen |
| Ausprobieren, Testen, Benchmarking | Verkauf, Vermietung, Bündelung mit Produkten |
| Änderungen für den eigenen Bedarf | Betrieb als Dienst für Dritte (SaaS/PaaS) |

Forks und öffentliche Kopien sind nicht erlaubt. Die Fork-Funktion dieses Repositories
ist zusätzlich abgeschaltet.

Das ist bewusst **keine** Open-Source-Lizenz im Sinne der OSI, sondern eine
*source-available*-Lizenz. Der verbindliche Text steht englisch in [`LICENSE`](LICENSE),
am Ende gibt es eine unverbindliche deutsche Kurzfassung.

Fragen zur Lizenz gern als Issue im Repository oder über die Kontaktdaten im GitHub-Profil.

**Drittkomponenten** behalten ihre eigenen Lizenzen: Electron (MIT), llama.cpp (MIT; wird zur
Laufzeit vom Nutzer geladen und nicht mitgeliefert), yauzl (MIT), tar (ISC).
