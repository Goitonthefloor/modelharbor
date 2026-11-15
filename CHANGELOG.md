# Changelog

All notable changes to ModelHarbor are documented in this file.

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
