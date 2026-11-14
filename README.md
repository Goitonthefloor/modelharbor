# ModelHarbor

Lokale KI-Chatmodelle mit einem Klick — ohne Terminal, ohne Cloud, ohne Konto.
ModelHarbor erkennt die Hardware, wählt das passende llama.cpp-Backend, lädt Modelle
direkt von HuggingFace und startet einen fertig konfigurierten Chat.

```
┌──────────────┐   1. Hardware erkennen    ┌───────────────────────────┐
│  ModelHarbor │ ────────────────────────► │ CPU / GPU / VRAM / NPU    │
│  (Desktop)   │                           └───────────────────────────┘
│              │   2. Backend wählen       CUDA · ROCm · Vulkan · Metal
│              │   3. Modell herunterladen  HuggingFace (GGUF, Resume)
│              │   4. llama-server starten   Presets: Kreativ/Deterministisch/…
└──────────────┘
```

## Funktionen

- **Ein-Klick-Einrichtung**: erkennt Betriebssystem, CPU, RAM, GPUs (NVIDIA, AMD, Intel, Apple)
  und NPUs; empfiehlt das beste Backend und lädt es automatisch herunter.
- **Breite Hardware-Unterstützung** über llama.cpp-Builds:
  CUDA (12.4 / 13.5), ROCm/HIP, Vulkan, Metal, SYCL, OpenVINO, CPU — je nach Plattform.
- **Modellvorschläge passend zur Hardware**: Der Katalog zeigt für jedes Modell, ob es
  komplett in den VRAM passt, teilweise offloadet oder im RAM läuft — inklusive
  automatischer Quantisierungswahl (Q4_K_M, Q6_K, …).
- **HuggingFace-Suche**: beliebige GGUF-Repos durchsuchen, Dateien mit Größe und
  Hardware-Einschätzung ansehen und mit Fortschritt herunterladen (resumierbar,
  mehrteilige Modelle werden automatisch komplett geladen).
- **Vier Presets** mit echten llama.cpp-Sampler-Ketten:
  - **Balanced** — Alltag, Fragen, Erklärungen
  - **Kreativ** — mehr Vielfalt (DRY + XTC)
  - **Deterministisch** — Greedy, fester Seed, reproduzierbar
  - **Code / Reasoning** — kühles Sampling, Wiederholungsbremse
- **NPU-Erkennung**: Intel-NPU/AMD-XDNA/Apple-ANE werden angezeigt. Wo sinnvoll
  (Intel NPU + OpenVINO), bietet ModelHarbor eine experimentelle Option an — sonst
  läuft der Chat ehrlich über GPU/CPU.
- **Denk-Modelle**: Qwen3 & Co. liefern ihren `reasoning_content` als aufklappbaren
  Gedankengang — die Antwort selbst bleibt übersichtlich.
- **Stop-Button** während der Antwort (oder `Esc`), Chat-Verlauf mit Kopieren/Neu generieren.
- **Deutschsprachige Oberfläche**, läuft offline nach dem ersten Download.

## Installation

Fertige Pakete liegen unter `dist/`:

| Plattform | Datei | Status |
|---|---|---|
| Windows 10/11 (x64) | `dist/windows/ModelHarbor Setup 1.0.0.exe` | gebaut und installiert getestet, 117 MB |
| Linux (x64) | `dist/ModelHarbor-1.0.0.AppImage` | gebaut und im Vollbetrieb getestet, 121 MB |
| macOS (Apple Silicon / Intel) | `ModelHarbor-1.0.0-arm64.dmg` / `-x64.dmg` | auf einem Mac bauen: `npm run dist:mac` |

Beim ersten Start führt die App durch die Einrichtung: Hardware prüfen →
Backend installieren → Modell wählen.

> Die Pakete sind nicht signiert. Windows zeigt beim ersten Start eine
> SmartScreen-Warnung („Weitere Informationen“ → „Trotzdem ausführen“),
> macOS beim ersten Start einen Gatekeeper-Hinweis (Rechtsklick → Öffnen).
> Die App enthält keine Telemetrie; Downloads kommen ausschließlich von
> `huggingface.co` und `github.com`.

## Selbst bauen

Voraussetzungen: Node.js ≥ 20, npm.

```bash
npm install
npm start                 # Entwicklungsmodus
npm test                  # Unit-Tests
npm run dist:linux        # AppImage
npm run dist:win          # NSIS-Installer
npm run dist:mac          # DMG
```

Die Pakete werden nach `dist/` geschrieben. Für Windows/macOS-Pakete muss der Build
auf dem jeweiligen Betriebssystem laufen (oder in CI). Cross-Builds von Linux nach
Windows funktionieren nur mit Wine.

Getestet wurde bisher: Linux (Entwicklung + AppImage, CPU-Backend, Modell-Download,
Chat mit Qwen3-4B) und Windows 11 (Hardware-Erkennung, Backend-Empfehlung CUDA,
Installation des NSIS-Pakets).

## Datenpfade

| Inhalt | Windows | Linux | macOS |
|---|---|---|---|
| Einstellungen | `%APPDATA%\ModelHarbor` | `~/.config/ModelHarbor` | `~/Library/Application Support/ModelHarbor` |
| Modelle | `…\ModelHarbor\models` | `~/.config/ModelHarbor/models` | `…/ModelHarbor/models` |
| Backends | `…\ModelHarbor\backends` | `~/.config/ModelHarbor/backends` | `…/ModelHarbor/backends` |

Modell- und Backend-Ordner lassen sich in der App unter **Einrichtung → Einstellungen** ändern.

## Wie die Hardware-Erkennung arbeitet

| Plattform | GPU | VRAM | NPU |
|---|---|---|---|
| Windows | `nvidia-smi`, WMI (`Win32_VideoController`) | `nvidia-smi`; bei AMD/Intel Schätzung | `Get-PnpDevice` (ComputeAccelerator / AI Boost / XDNA / Hexagon) |
| Linux | `nvidia-smi`, `lspci`, sysfs | `nvidia-smi`, `/sys/class/drm/*/mem_info_vram_total` | `lspci` (Processing Accelerators), `/dev/accel/*` |
| macOS | `system_profiler SPDisplaysDataType` | Unified Memory (Apple Silicon: ~66 % des RAM) | Apple Neural Engine (nur Information) |

Die Backend-Empfehlung folgt dieser Logik:

1. **Apple Silicon** → Metal-Build.
2. **NVIDIA** → CUDA (deutlich schneller als Vulkan); Vulkan als kleine Alternative.
3. **AMD unter Linux** → ROCm, falls Runtime vorhanden; sonst Vulkan.
4. **AMD unter Windows** → Vulkan (stabil); ROCm als experimentelle Option.
5. **Intel** → Vulkan; SYCL experimentell; OpenVINO nur bei erkannter Intel-NPU.
6. **Keine GPU** → CPU-Build.

## Modell-Fit

Der Speicherbedarf wird geschätzt aus:

```
Bedarf ≈ Dateigröße + KV-Cache + Overhead
KV-Cache ≈ Parameter × 0,045 GB × (Kontext / 4096)
```

Daraus ergeben sich vier Stufen: **Passt in den VRAM** → **Teilweise auf GPU** →
**Läuft im RAM** → **Zu groß**. Die Quantisierungswahl bevorzugt den größten Quant,
der mit Reserve passt (Qualitätsdeckel bei 65 % des Budgets, damit die Geschwindigkeit
nicht leidet).

## Presets im Detail

| Preset | Temp | Top-K | Top-P | Min-P | Besonderheit |
|---|---|---|---|---|---|
| Balanced | 0,70 | 40 | 0,92 | 0,05 | Standard-Sampler-Kette |
| Kreativ | 1,05 | 80 | 0,96 | 0,02 | DRY 0,8 + XTC 0,4 |
| Deterministisch | 0,00 | 1 | 1,00 | 0,00 | Seed 42, Greedy |
| Code / Reasoning | 0,20 | 20 | 0,95 | 0,05 | DRY 0,5, langer Repeat-Bereich |

Beim Modellstart werden die vollen Preset-Parameter an `llama-server` übergeben; beim
Chat werden die Hauptparameter pro Anfrage erneut gesetzt, damit ein Presetwechsel
sofort wirkt.

## Technik

- **Electron** (Hauptprozess + Renderer mit `contextIsolation`, ohne Node im Renderer)
- **llama.cpp**-Binaries aus den offiziellen `ggml-org/llama.cpp`-Releases
  (neuester Build mit Binär-Assets, automatisch erkannt)
- **llama-server** als lokaler Prozess, OpenAI-kompatible API auf `127.0.0.1`
- Streaming-Chat per SSE direkt aus dem Renderer
- Keine Telemetrie, keine Cloud-Aufrufe außer HuggingFace-Downloads und GitHub-Releases

## Fehlerbehebung

**„Kein Backend installiert“** — Einrichtung öffnen und das empfohlene Backend installieren.
Der Download benötigt Internet; danach läuft alles offline.

**Modell lädt nicht / stürzt ab** — Meist zu wenig VRAM. In der Einrichtung die
GPU-Layers reduzieren (z. B. 999 → 20) oder die Kontextgröße senken.

**AMD unter Windows langsam** — Vulkan ist der stabile Weg; ROCm ist experimentell und
hängt vom Treiber ab.

**Apple Silicon** — Metal ist automatisch aktiv; die angezeigte VRAM-Zahl ist eine
Schätzung (Unified Memory).

## Lizenz

MIT — siehe `LICENSE`.
