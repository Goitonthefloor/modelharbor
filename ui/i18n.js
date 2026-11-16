/* ModelHarbor — i18n (de/en). Klassisches Script im Renderer, CommonJS im Main-Prozess. */
(function (root) {
  'use strict';

  const DEFAULT_LANG = 'de';
  const LANGS = [
    { id: 'de', label: 'Deutsch' },
    { id: 'en', label: 'English' },
  ];

  /**
   * Nachrichten-Katalog: key -> { de, en }.
   * Platzhalter in {geschweiften Klammern} werden von t() ersetzt.
   */
  const MESSAGES = {
    /* ----------------------------- Allgemein ----------------------------- */
    'common.close': { de: 'Schließen', en: 'Close' },
    'common.cancel': { de: 'Abbrechen', en: 'Cancel' },
    'common.confirm': { de: 'Bestätigen', en: 'Confirm' },
    'common.delete': { de: 'Löschen', en: 'Delete' },
    'common.unknown': { de: 'unbekannt', en: 'unknown' },
    'common.error': { de: 'Fehler: {message}', en: 'Error: {message}' },
    'common.notifications': { de: 'Benachrichtigungen', en: 'Notifications' },
    'common.copy': { de: 'Kopieren', en: 'Copy' },

    /* ----------------------------- Navigation ----------------------------- */
    'brand.subtitle': { de: 'Lokale KI-Modelle', en: 'Local AI models' },
    'nav.chat': { de: 'Chat', en: 'Chat' },
    'nav.models': { de: 'Modelle', en: 'Models' },
    'nav.setup': { de: 'Einrichtung', en: 'Setup' },

    /* ----------------------------- Sidebar ----------------------------- */
    'sidebar.detecting': { de: 'Hardware wird erkannt …', en: 'Detecting hardware …' },
    'sidebar.hardware': { de: 'Hardware', en: 'Hardware' },
    'sidebar.cpuOnly': { de: 'CPU only', en: 'CPU only' },
    'sidebar.backend': { de: 'Backend', en: 'Backend' },
    'sidebar.notConfigured': { de: 'nicht eingerichtet', en: 'not configured' },
    'sidebar.model': { de: 'Modell', en: 'Model' },
    'sidebar.loading': { de: 'lädt …', en: 'loading …' },
    'sidebar.noneLoaded': { de: 'keins geladen', en: 'none loaded' },

    /* ----------------------------- Chat ----------------------------- */
    'chat.noModel': { de: 'Kein Modell geladen', en: 'No model loaded' },
    'chat.modelLoading': { de: 'Modell wird geladen …', en: 'Loading model …' },
    'chat.preset': { de: 'Preset', en: 'Preset' },
    'chat.switchModel': { de: 'Modell wechseln', en: 'Switch model' },
    'chat.unloadTitle': { de: 'Modell aus dem Speicher entladen', en: 'Unload the model from memory' },
    'chat.unload': { de: 'Entladen', en: 'Unload' },
    'chat.unloading': { de: 'Entlade …', en: 'Unloading …' },
    'chat.reloadTitle': { de: 'Zuletzt geladenes Modell wieder laden', en: 'Load the most recent model again' },
    'chat.reload': { de: 'Letztes Modell laden', en: 'Load last model' },
    'chat.emptyTitle': { de: 'Noch kein Modell geladen', en: 'No model loaded yet' },
    'chat.emptyText': {
      de: 'Wähle ein Modell aus dem Katalog — ModelHarbor prüft vorher, ob es zu deiner Hardware passt.',
      en: 'Pick a model from the catalog — ModelHarbor checks first whether it fits your hardware.',
    },
    'chat.browseModels': { de: 'Modelle ansehen', en: 'Browse models' },
    'chat.inputPlaceholder': {
      de: 'Nachricht schreiben … (Enter = senden, Shift+Enter = neue Zeile)',
      en: 'Write a message … (Enter = send, Shift+Enter = new line)',
    },
    'chat.messageLabel': { de: 'Nachricht', en: 'Message' },
    'chat.loadToChat': { de: 'Modell laden, um zu chatten', en: 'Load a model to start chatting' },
    'chat.enterHint': { de: 'Enter = senden · Shift+Enter = neue Zeile', en: 'Enter = send · Shift+Enter = new line' },
    'chat.sendTitle': { de: 'Senden (Enter)', en: 'Send (Enter)' },
    'chat.stopTitle': { de: 'Antwort stoppen (Esc)', en: 'Stop response (Esc)' },
    'chat.you': { de: 'Du', en: 'You' },
    'chat.assistant': { de: 'Assistent', en: 'Assistant' },
    'chat.reasoning': { de: 'Gedankengang · {count} Zeichen', en: 'Reasoning · {count} characters' },
    'chat.serverError': { de: 'Server-Fehler {status}: {body}', en: 'Server error {status}: {body}' },
    'chat.tokenInfo': { de: '{prompt} Prompt-Token · {completion} Antwort-Token{tps}', en: '{prompt} prompt tokens · {completion} response tokens{tps}' },
    'chat.stopped': { de: '— gestoppt —', en: '— stopped —' },
    'chat.error': { de: 'Fehler: {message}', en: 'Error: {message}' },
    'chat.switchModelTitle': { de: 'Modell wechseln', en: 'Switch model' },
    'chat.switchModelMessage': {
      de: 'Es ist bereits ein Modell geladen. Entladen und das neue laden?',
      en: 'A model is already loaded. Unload it and load the new one?',
    },
    'chat.unloadAndLoad': { de: 'Entladen & laden', en: 'Unload & load' },

    /* ----------------------------- Modelle ----------------------------- */
    'models.title': { de: 'Modelle', en: 'Models' },
    'models.subtitle': { de: 'Empfehlungen passend zu deiner Hardware', en: 'Recommendations matching your hardware' },
    'models.openFolder': { de: 'Ordner öffnen', en: 'Open folder' },
    'models.tabsLabel': { de: 'Modell-Ansichten', en: 'Model views' },
    'models.tabRecommended': { de: 'Empfohlen', en: 'Recommended' },
    'models.tabSearch': { de: 'HuggingFace durchsuchen', en: 'Search HuggingFace' },
    'models.tabInstalled': { de: 'Installiert', en: 'Installed' },
    'models.searchPlaceholder': { de: 'z. B. qwen3, llama 3.1, mistral, coder …', en: 'e.g. qwen3, llama 3.1, mistral, coder …' },
    'models.searchButton': { de: 'Suchen', en: 'Search' },
    'models.searchHint': {
      de: 'Durchsucht HuggingFace nach GGUF-Modellen, sortiert nach Downloads.',
      en: 'Searches HuggingFace for GGUF models, sorted by downloads.',
    },
    'models.catalogLoading': { de: 'Katalog wird geladen …', en: 'Loading catalog …' },
    'models.catalogError': { de: 'Katalog konnte nicht geladen werden: {message}', en: 'Could not load the catalog: {message}' },
    'models.searching': { de: 'Suche …', en: 'Searching …' },
    'models.searchError': { de: 'Suche fehlgeschlagen: {message}', en: 'Search failed: {message}' },
    'models.noResults': { de: 'Keine Treffer.', en: 'No results.' },
    'models.rowMeta': { de: '{downloads} Downloads · {likes} Likes', en: '{downloads} downloads · {likes} likes' },
    'models.loadingFiles': { de: 'Lade Dateiliste …', en: 'Loading file list …' },
    'models.filePanelSub': { de: '{count} Quantisierungen · {downloads} Downloads', en: '{count} quantizations · {downloads} downloads' },
    'models.split': { de: 'mehrteilig', en: 'multi-part' },
    'models.download': { de: 'Herunterladen', en: 'Download' },
    'models.showFiles': { de: 'Dateien ansehen', en: 'Show files' },
    'models.openChat': { de: 'Chat öffnen', en: 'Open chat' },
    'models.load': { de: 'Laden', en: 'Load' },
    'models.revealTitle': { de: 'Im Ordner zeigen', en: 'Show in folder' },
    'models.folder': { de: 'Ordner', en: 'Folder' },
    'models.localEmpty': {
      de: 'Noch keine Modelle heruntergeladen.<br>Stöbere im Katalog oder auf HuggingFace.',
      en: 'No models downloaded yet.<br>Browse the catalog or search HuggingFace.',
    },
    'models.localError': { de: 'Lokale Modelle konnten nicht gelesen werden: {message}', en: 'Could not read local models: {message}' },
    'models.deleteTitle': { de: 'Modell wirklich löschen?', en: 'Really delete this model?' },

    /* ----------------------------- Setup ----------------------------- */
    'setup.title': { de: 'Einrichtung', en: 'Setup' },
    'setup.subtitle': { de: 'Hardware prüfen, Backend wählen, Speicher festlegen', en: 'Check hardware, pick a backend, set memory' },
    'setup.checkUpdates': { de: 'Nach Updates suchen', en: 'Check for updates' },
    'setup.rescan': { de: 'Neu erkennen', en: 'Detect again' },
    'setup.welcomeTitle': { de: 'Willkommen bei ModelHarbor', en: 'Welcome to ModelHarbor' },
    'setup.welcomeText': {
      de: 'Wähle zuerst die Sprache der Oberfläche. Du kannst sie später jederzeit in den Einstellungen ändern.',
      en: 'First pick the interface language. You can change it later at any time in the settings.',
    },
    'setup.welcomeContinue': { de: 'Weiter', en: 'Continue' },
    'setup.yourSystem': { de: 'Dein System', en: 'Your system' },
    'setup.system': { de: 'System', en: 'System' },
    'setup.threads': { de: '{count} Threads', en: '{count} threads' },
    'setup.cpu': { de: 'Prozessor', en: 'Processor' },
    'setup.cores': { de: '{count} Kerne', en: '{count} cores' },
    'setup.memory': { de: 'Arbeitsspeicher', en: 'Memory' },
    'setup.freeMem': { de: '{size} GB frei', en: '{size} GB free' },
    'setup.graphics': { de: 'Grafik', en: 'Graphics' },
    'setup.vram': { de: '{label} VRAM', en: '{label} VRAM' },
    'setup.estimated': { de: '(geschätzt)', en: '(estimated)' },
    'setup.driver': { de: 'Treiber {version}', en: 'driver {version}' },
    'setup.noGpu': { de: 'Keine GPU erkannt', en: 'No GPU detected' },
    'setup.noGpuHint': { de: 'Modelle laufen im Arbeitsspeicher (langsamer).', en: 'Models run in system memory (slower).' },
    'setup.npuFound': { de: 'NPU gefunden:', en: 'NPU found:' },
    'setup.npuOpenvino': {
      de: 'Ein OpenVINO-Backend kann sie für kleine Modelle nutzen — als experimentelle Option unten verfügbar.',
      en: 'An OpenVINO backend can use it for small models — available as an experimental option below.',
    },
    'setup.npuUnusable': {
      de: 'Für llama.cpp ist sie nicht nutzbar; Chats laufen über GPU/CPU.',
      en: 'It cannot be used by llama.cpp; chats run on GPU/CPU.',
    },
    'setup.npuRyzenai': {
      de: 'AMD-NPUs laufen nicht über ROCm/llama.cpp, sondern über die Ryzen-AI-Software (ONNX-Runtime). Hierfür gibt es bei llama.cpp keine Modelle — Chats laufen über GPU/CPU.',
      en: 'AMD NPUs do not run via ROCm/llama.cpp but via Ryzen AI software (ONNX Runtime). No llama.cpp models for it — chats run on GPU/CPU.',
    },
    'setup.backendSection': { de: 'Backend (llama.cpp)', en: 'Backend (llama.cpp)' },
    'setup.recommendedBadge': { de: 'Empfohlen', en: 'Recommended' },
    'setup.experimentalBadge': { de: 'experimentell', en: 'experimental' },
    'setup.installedBadge': { de: 'installiert', en: 'installed' },
    'setup.install': { de: 'Installieren', en: 'Install' },
    'setup.remove': { de: 'Entfernen', en: 'Remove' },
    'setup.recommendation': { de: 'Empfehlung für deine Hardware: {name}', en: 'Recommended for your hardware: {name}' },
    'setup.recommendationMeta': { de: '{reason} · {size} Download', en: '{reason} · {size} download' },
    'setup.releaseInfo': { de: 'llama.cpp {tag} · {count} installiert', en: 'llama.cpp {tag} · {count} installed' },
    'setup.backendListLoading': { de: 'Backend-Liste wird geladen …', en: 'Loading backend list …' },
    'setup.backendListError': { de: 'Backend-Liste nicht verfügbar: {message}', en: 'Backend list unavailable: {message}' },
    'setup.removeBackendTitle': { de: 'Backend entfernen?', en: 'Remove backend?' },
    'setup.removeBackendMessage': { de: 'Backend {id} wirklich entfernen?', en: 'Really remove backend {id}?' },
    'setup.settings': { de: 'Einstellungen', en: 'Settings' },
    'setup.language': { de: 'Sprache / Language', en: 'Sprache / Language' },
    'setup.languageHint': { de: 'Sprache der Oberfläche — wirkt sofort', en: 'Interface language — applies immediately' },
    'setup.modelsDir': { de: 'Modellordner', en: 'Model folder' },
    'setup.modelsDirHint': { de: 'Hierhin werden GGUF-Dateien geladen', en: 'GGUF files are downloaded here' },
    'setup.change': { de: 'Ändern', en: 'Change' },
    'setup.open': { de: 'Öffnen', en: 'Open' },
    'setup.ctxLabel': { de: 'Kontextgröße', en: 'Context size' },
    'setup.ctxHint': {
      de: 'Tokens, die das Modell gleichzeitig „sieht“ — höher = mehr VRAM',
      en: 'Tokens the model “sees” at once — higher = more VRAM',
    },
    'setup.gpuLayersLabel': { de: 'GPU-Layers', en: 'GPU layers' },
    'setup.gpuLayersHint': {
      de: '999 = alles auf die GPU. Bei Speicherproblemen reduzieren.',
      en: '999 = everything on the GPU. Lower this if you run out of memory.',
    },

    /* ----------------------------- Dialoge / Update ----------------------------- */
    'dialog.confirmTitle': { de: 'Sicher?', en: 'Are you sure?' },
    'update.available': { de: 'Update verfügbar', en: 'Update available' },
    'update.subtitle': { de: 'Version {version} ist verfügbar — du hast {current}.', en: 'Version {version} is available — you have {current}.' },
    'update.thisVersion': { de: 'diese Version', en: 'this version' },
    'update.noNotes': { de: 'Release-Notes findest du auf der Releases-Seite.', en: 'Release notes are available on the releases page.' },
    'update.downloading': { de: 'Wird heruntergeladen …', en: 'Downloading …' },
    'update.loading': { de: 'Lädt …', en: 'Loading …' },
    'update.done': { de: 'Fertig: {name}', en: 'Done: {name}' },
    'update.later': { de: 'Später', en: 'Later' },
    'update.releasesPage': { de: 'Zur Releases-Seite', en: 'Go to releases page' },
    'update.openFile': { de: 'Datei öffnen', en: 'Open file' },
    'update.updateNow': { de: 'Jetzt aktualisieren', en: 'Update now' },
    'update.retry': { de: 'Erneut versuchen', en: 'Try again' },
    'update.downloadFailed': { de: 'Download fehlgeschlagen: {message}', en: 'Download failed: {message}' },
    'update.progressOf': { de: '{done} von {total}', en: '{done} of {total}' },

    /* ----------------------------- Toasts ----------------------------- */
    'toast.copied': { de: 'In die Zwischenablage kopiert', en: 'Copied to clipboard' },
    'toast.copyFailed': { de: 'Kopieren fehlgeschlagen', en: 'Copy failed' },
    'toast.noModelPath': { de: 'Modellpfad fehlt', en: 'Model path is missing' },
    'toast.loading': { de: 'Lade {file} …', en: 'Loading {file} …' },
    'toast.ready': { de: 'Bereit: {file}', en: 'Ready: {file}' },
    'toast.loadFailed': { de: 'Modell konnte nicht geladen werden', en: 'Could not load the model' },
    'toast.unloading': { de: 'Modell wird entladen …', en: 'Unloading model …' },
    'toast.unloaded': { de: 'Modell entladen — bereit zum Neuladen', en: 'Model unloaded — ready to reload' },
    'toast.unloadFailed': { de: 'Entladen fehlgeschlagen: {message}', en: 'Unload failed: {message}' },
    'toast.upToDate': { de: 'Du bist aktuell (v{version}).', en: 'You are up to date (v{version}).' },
    'toast.updateCheckFailed': { de: 'Update-Check fehlgeschlagen: {message}', en: 'Update check failed: {message}' },
    'toast.rescanning': { de: 'Erkenne Hardware neu …', en: 'Detecting hardware again …' },
    'toast.preset': { de: 'Preset: {name}', en: 'Preset: {name}' },
    'toast.modelMissing': { de: 'Modell ist lokal nicht gefunden — bitte neu herunterladen.', en: 'Model not found locally — please download it again.' },
    'toast.modelDeleted': { de: 'Modell gelöscht', en: 'Model deleted' },
    'toast.backendInstalled': { de: 'Backend installiert: {id}', en: 'Backend installed: {id}' },
    'toast.modelsDirChanged': { de: 'Modellordner geändert', en: 'Model folder changed' },
    'toast.ctx': { de: 'Kontext: {value} Tokens', en: 'Context: {value} tokens' },
    'toast.gpuLayers': { de: 'GPU-Layers: {value}', en: 'GPU layers: {value}' },
    'toast.downloadDone': { de: 'Download abgeschlossen', en: 'Download complete' },
    'toast.downloadFailed': { de: 'Download fehlgeschlagen', en: 'Download failed' },
    'toast.downloadFinished': { de: 'Fertig: {file} ({size})', en: 'Done: {file} ({size})' },
    'toast.modelUnavailable': { de: 'Modell nicht gefunden: {repo}', en: 'Model not found: {repo}' },
    'toast.fileUnavailable': { de: '{repo}: keine herunterladbare Datei verfügbar (Verbindung oder Verfügbarkeit prüfen)', en: '{repo}: no downloadable file available (check connection or availability)' },
    'toast.welcome': { de: 'Willkommen! Richte zuerst ein Backend für deine Hardware ein.', en: 'Welcome! First set up a backend for your hardware.' },
    'toast.startError': { de: 'Startfehler: {message}', en: 'Startup error: {message}' },
    'toast.languageChanged': { de: 'Sprache: {language}', en: 'Language: {language}' },

    /* ----------------------------- Presets ----------------------------- */
    'preset.balanced.name': { de: 'Balanced', en: 'Balanced' },
    'preset.balanced.desc': {
      de: 'Standard für Alltag, Fragen und Erklärungen. Guter Mix aus Fakten und Formulierung.',
      en: 'Everyday default for questions and explanations. A good mix of facts and phrasing.',
    },
    'preset.creative.name': { de: 'Kreativ', en: 'Creative' },
    'preset.creative.desc': {
      de: 'Mehr Vielfalt und überraschende Formulierungen — für Geschichten, Ideen, Brainstorming.',
      en: 'More variety and surprising phrasing — for stories, ideas and brainstorming.',
    },
    'preset.deterministic.name': { de: 'Deterministisch', en: 'Deterministic' },
    'preset.deterministic.desc': {
      de: 'Greedy-Decoding: gleiche Frage → gleiche Antwort. Für Fakten, Extraktion, Tests.',
      en: 'Greedy decoding: same question → same answer. For facts, extraction and tests.',
    },
    'preset.code.name': { de: 'Code / Reasoning', en: 'Code / Reasoning' },
    'preset.code.desc': {
      de: 'Kühles Sampling mit Wiederholungsbremse — für Programmierung, Mathe und Logik.',
      en: 'Cool sampling with a repetition brake — for programming, math and logic.',
    },

    /* ----------------------------- Fit-Badges ----------------------------- */
    'fit.gpu.label': { de: 'Passt in den VRAM', en: 'Fits in VRAM' },
    'fit.gpu.detail': {
      de: '~{need} GB von {vram} GB VRAM — läuft komplett auf der GPU ({gpu}).',
      en: '~{need} GB of {vram} GB VRAM — runs entirely on the GPU ({gpu}).',
    },
    'fit.hybrid.label': { de: 'Teilweise auf GPU', en: 'Partly on GPU' },
    'fit.hybrid.detail': {
      de: '~{need} GB — zu groß für die {vram} GB VRAM, aber mit Offload auf den Arbeitsspeicher nutzbar (langsamer).',
      en: '~{need} GB — too large for {vram} GB VRAM, but usable with offload to system memory (slower).',
    },
    'fit.ram.label': { de: 'Läuft im Arbeitsspeicher', en: 'Runs in system memory' },
    'fit.ram.detail': {
      de: '~{need} GB — ohne GPU-Beschleunigung, spürbar langsamer.',
      en: '~{need} GB — without GPU acceleration, noticeably slower.',
    },
    'fit.tooBig.label': { de: 'Zu groß', en: 'Too large' },
    'fit.tooBig.detail': {
      de: '~{need} GB benötigt, aber nur {available} GB verfügbar. Nimm einen kleineren Quant oder ein kleineres Modell.',
      en: '~{need} GB needed, but only {available} GB available. Pick a smaller quant or a smaller model.',
    },

    /* ----------------------------- Fehler (Main-Prozess) ----------------------------- */
    'error.downloadRunning': {
      de: 'Es läuft bereits ein Download. Bitte warten, bis er fertig ist.',
      en: 'A download is already running. Please wait until it has finished.',
    },
    'error.noBackend': {
      de: 'Kein Backend installiert. Bitte zuerst im Setup ein Backend einrichten.',
      en: 'No backend installed. Please set up a backend in the setup first.',
    },
    'error.updateRunning': { de: 'Ein Update-Download läuft bereits.', en: 'An update download is already running.' },
    'error.downloadIncomplete': {
      de: 'Download unvollständig: {got} GB von {expected} GB — bitte erneut starten (wird fortgesetzt).',
      en: 'Download incomplete: {got} GB of {expected} GB — please start again (it will resume).',
    },
    'error.noFreePort': { de: 'Kein freier Port gefunden', en: 'No free port available' },
    'error.onnxBackendMissing': { de: 'ONNX-Backend (Python-Venv) ist nicht installiert. Installiere es in der Einrichtung.', en: 'ONNX backend (Python venv) is not installed. Install it in Setup.' },
    'error.onnxPythonMissing': { de: 'ONNX-Backend braucht Python 3.10–3.12 im System.', en: 'ONNX backend requires Python 3.10–3.12 on your system.' },
    'error.serverExited': { de: 'Serverprozess ist beendet', en: 'Server process has exited' },
    'error.modelLoadFailed': {
      de: 'Modell konnte nicht geladen werden (letzter Status: {status}).\n{tail}',
      en: 'Could not load the model (last status: {status}).\n{tail}',
    },
    'error.modelAlreadyRunning': {
      de: 'Es läuft bereits ein Modell. Bitte zuerst stoppen.',
      en: 'A model is already running. Please stop it first.',
    },
    'error.backendMissing': { de: 'Backend fehlt: {path}', en: 'Backend missing: {path}' },
    'error.modelFileMissing': { de: 'Modelldatei fehlt: {path}', en: 'Model file missing: {path}' },
    'error.hfRestricted': {
      de: 'Dieses Modell ist bei HuggingFace eingeschränkt (Login/AGB nötig). Bitte ein anderes Modell wählen.',
      en: 'This model is restricted on HuggingFace (login/terms required). Please choose another model.',
    },
    'error.hfInvalidResponse': { de: 'Ungültige Antwort von HuggingFace', en: 'Invalid response from HuggingFace' },
    'error.hfTimeout': { de: 'Zeitüberschreitung bei HuggingFace', en: 'Timeout while contacting HuggingFace' },
    'error.downloadRefused': {
      de: 'Download verweigert — dieses Repo ist bei HuggingFace eingeschränkt.',
      en: 'Download refused — this repo is restricted on HuggingFace.',
    },
    'error.downloadFailedHttp': { de: 'Download fehlgeschlagen: HTTP {status}', en: 'Download failed: HTTP {status}' },
    'error.downloadTimeout': { de: 'Zeitüberschreitung beim Download', en: 'Timeout during download' },
    'error.fileNotInRepo': { de: 'Datei {file} wurde im Repo nicht gefunden', en: 'File {file} was not found in the repo' },
    'error.invalidPath': { de: 'Ungültiger Pfad', en: 'Invalid path' },
    'error.githubInvalidJson': { de: 'Ungültige JSON-Antwort von GitHub', en: 'Invalid JSON response from GitHub' },
    'error.githubTimeout': { de: 'Zeitüberschreitung bei GitHub', en: 'Timeout while contacting GitHub' },
    'error.noReleaseList': { de: 'GitHub-API lieferte keine Release-Liste', en: 'GitHub API returned no release list' },
    'error.noLlamaBuild': {
      de: 'Kein llama.cpp-Build mit Binärdateien gefunden',
      en: 'No llama.cpp build with binaries found',
    },
    'error.assetMissing': {
      de: 'Asset für {label} fehlt im Release {tag} ({match})',
      en: 'Asset for {label} is missing in release {tag} ({match})',
    },
    'error.backendUnknown': { de: 'Unbekanntes Backend: {id}', en: 'Unknown backend: {id}' },
    'error.platformMismatch': {
      de: '{label} passt nicht zu dieser Plattform ({platform}/{arch})',
      en: '{label} does not match this platform ({platform}/{arch})',
    },
    'error.serverNotFound': {
      de: 'llama-server wurde im entpackten Paket nicht gefunden',
      en: 'llama-server was not found in the extracted package',
    },
    'error.invalidDownloadUrl': { de: 'Ungültige Download-URL', en: 'Invalid download URL' },
    'error.updateDownloadFailed': { de: 'Download fehlgeschlagen (HTTP {status})', en: 'Download failed (HTTP {status})' },

    /* ----------------------------- Hardware-Notizen ----------------------------- */
    'hw.note.virtualGpu': {
      de: 'Virtuelle Grafikkarte erkannt ({name}) — keine GPU-Beschleunigung verfügbar.',
      en: 'Virtual graphics card detected ({name}) — no GPU acceleration available.',
    },
    'hw.note.accelDevice': {
      de: 'NPU-Beschleuniger im System: /dev/accel/{list}',
      en: 'NPU accelerator present: /dev/accel/{list}',
    },
    'hw.note.appleNeuralEngine': {
      de: 'Apple Neural Engine ist vorhanden, wird von llama.cpp aber nicht unterstützt (Metal/GPU ist der richtige Weg).',
      en: 'An Apple Neural Engine is present, but llama.cpp does not support it (Metal/GPU is the right path).',
    },

    /* ----------------------------- Hardware-Empfehlungen ----------------------------- */
    'reason.darwin.apple': {
      de: 'Apple Silicon mit Metal — schnellster Weg auf dem Mac',
      en: 'Apple Silicon with Metal — the fastest route on a Mac',
    },
    'reason.darwin.intel': {
      de: 'Intel-Mac: CPU-Backend (Metal nur eingeschränkt)',
      en: 'Intel Mac: CPU backend (Metal only partially supported)',
    },
    'reason.win.nvidiaCuda': {
      de: 'NVIDIA-GPU erkannt — CUDA ist deutlich schneller als Vulkan',
      en: 'NVIDIA GPU detected — CUDA is clearly faster than Vulkan',
    },
    'reason.win.vulkanNvidia': {
      de: 'Vulkan: nur ~36 MB Download, funktioniert auf NVIDIA/AMD/Intel',
      en: 'Vulkan: only ~36 MB download, works on NVIDIA/AMD/Intel',
    },
    'reason.win.amdVulkan': {
      de: 'AMD-GPU auf Windows: Vulkan ist der stabile Weg',
      en: 'AMD GPU on Windows: Vulkan is the stable route',
    },
    'reason.win.amdRocm': {
      de: 'ROCm/HIP-Build für AMD unter Windows — experimentell, Treiber müssen passen',
      en: 'ROCm/HIP build for AMD on Windows — experimental, drivers must match',
    },
    'reason.win.intelVulkan': {
      de: 'Intel-GPU/Arc: Vulkan ist der stabile Weg',
      en: 'Intel GPU/Arc: Vulkan is the stable route',
    },
    'reason.win.intelNpu': {
      de: 'Intel-NPU erkannt: OpenVINO kann die NPU nutzen — nur kleine Modelle, experimentell',
      en: 'Intel NPU detected: OpenVINO can use the NPU — small models only, experimental',
    },
    'reason.win.noGpu': { de: 'Keine nutzbare GPU erkannt — CPU-Backend', en: 'No usable GPU detected — CPU backend' },
    'reason.win.armCpu': { de: 'Windows on ARM: CPU-Backend für ARM64', en: 'Windows on ARM: CPU backend for ARM64' },
    'reason.win.armVulkan': {
      de: 'Windows on ARM mit Adreno/Qualcomm-GPU',
      en: 'Windows on ARM with Adreno/Qualcomm GPU',
    },
    'reason.win.cudaOption': {
      de: 'CUDA-Build als Option, falls später eine NVIDIA-Karte dazukommt',
      en: 'CUDA build as an option in case an NVIDIA card is added later',
    },
    'reason.win.cpuFallback': {
      de: 'CPU-Fallback (langsam, aber funktioniert immer)',
      en: 'CPU fallback (slow, but always works)',
    },
    'reason.linux.nvidiaCuda': {
      de: 'NVIDIA-GPU erkannt — CUDA ist deutlich schneller als Vulkan',
      en: 'NVIDIA GPU detected — CUDA is clearly faster than Vulkan',
    },
    'reason.linux.vulkanNvidia': {
      de: 'Vulkan: nur ~35 MB, treiberunabhängig',
      en: 'Vulkan: only ~35 MB, driver independent',
    },
    'reason.linux.amdRocm': {
      de: 'AMD-GPU + ROCm-Runtime erkannt — schnellster Weg',
      en: 'AMD GPU + ROCm runtime detected — fastest route',
    },
    'reason.linux.amdVulkan': {
      de: 'AMD-GPU: Vulkan ist ohne ROCm-Installation der einfachste Weg',
      en: 'AMD GPU: Vulkan is the simplest route without installing ROCm',
    },
    'reason.linux.intelVulkan': { de: 'Intel-GPU: Vulkan', en: 'Intel GPU: Vulkan' },
    'reason.linux.intelSycl': {
      de: 'Intel oneAPI/SYCL (Arc-GPUs) — experimentell',
      en: 'Intel oneAPI/SYCL (Arc GPUs) — experimental',
    },
    'reason.linux.intelNpu': {
      de: 'Intel-NPU erkannt: OpenVINO kann die NPU nutzen — nur kleine Modelle, experimentell',
      en: 'Intel NPU detected: OpenVINO can use the NPU — small models only, experimental',
    },
    'reason.linux.noGpu': { de: 'Keine nutzbare GPU erkannt — CPU-Backend', en: 'No usable GPU detected — CPU backend' },
    'reason.linux.cpuFallback': { de: 'CPU-Fallback', en: 'CPU fallback' },
    'reason.linux.armCpu': { de: 'Linux on ARM64: CPU-Backend', en: 'Linux on ARM64: CPU backend' },
    'reason.linux.armVulkan': {
      de: 'Linux on ARM64 mit Vulkan-GPU',
      en: 'Linux on ARM64 with a Vulkan GPU',
    },
    'reason.fallback': { de: 'Standard-Fallback', en: 'Default fallback' },

    /* ----------------------------- Inhalte aus dem Main-Prozess (nur Englisch) ----------------------------- */
    'modelBlurb.ggml-org/gemma-3-1b-it-GGUF': { en: "Runs on practically any hardware. Ideal for trying things out." },
    'modelBlurb.Qwen/Qwen2.5-0.5B-Instruct-GGUF': { en: "Very small and fast — good for weak devices and tests." },
    'modelBlurb.Qwen/Qwen3-1.7B-GGUF': { en: "Compact with a thinking mode. Solid for 4–8 GB VRAM." },
    'modelBlurb.Qwen/Qwen3-4B-GGUF': { en: "Best trade-off between quality and size for 8 GB graphics cards." },
    'modelBlurb.Qwen/Qwen3-8B-GGUF': { en: "The standard for 12 GB cards. Strong German, good reasoning." },
    'modelBlurb.Qwen/Qwen3-14B-GGUF': { en: "Clearly stronger — needs 12–16 GB VRAM or plenty of RAM." },
    'modelBlurb.Qwen/Qwen3-30B-A3B-GGUF': { en: "Great quality, but only 3B parameters active per token — fast when it fits in memory." },
    'modelBlurb.unsloth/Llama-3.2-3B-Instruct-GGUF': { en: "Meta Llama, compact and quick. A good alternative to Qwen 3 4B." },
    'modelBlurb.unsloth/Llama-3.1-8B-Instruct-GGUF': { en: "The classic among open 8B models." },
    'modelBlurb.google/gemma-3-4b-it-qat-q4_0-gguf': { en: "Quantized by Google (QAT) — good quality at only 2.9 GB." },
    'modelBlurb.google/gemma-3-12b-it-qat-q4_0-gguf': { en: "Google's 12B class, QAT-quantized down to 7.5 GB." },
    'modelBlurb.Qwen/Qwen2.5-Coder-7B-Instruct-GGUF': { en: "Specialized in programming — combine it with the “Code” preset." },
    'modelBlurb.bartowski/Mistral-7B-Instruct-v0.3-GGUF': { en: "Solid all-purpose model with good English." },
    'modelBlurb.bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF': { en: "Thinks in steps — strong at math and logic, slower in everyday use." },
    'backendNote.win-cuda-12.4': { en: "Fastest route for NVIDIA on Windows. Requires a current NVIDIA driver." },
    'backendNote.win-cuda-13.5': { en: "Newest CUDA version — only makes sense with a very recent driver." },
    'backendNote.win-vulkan': { en: "Works on all GPUs, small download. A little slower than CUDA/ROCm." },
    'backendNote.win-rocm': { en: "AMD acceleration on Windows. Driver compatibility is delicate — Vulkan is the safe route." },
    'backendNote.win-sycl': { en: "For Intel Arc / integrated Intel GPUs. Requires the Intel driver." },
    'backendNote.win-openvino': { en: "Can use the Intel NPU (Core Ultra). Small models only, experimental." },
    'backendNote.win-cpu-x64': { en: "Always works, even without a GPU. Slow but reliable." },
    'backendNote.win-cpu-arm64': { en: "For Windows on ARM." },
    'backendNote.win-vulkan-arm64': { en: "For Windows-on-ARM devices with an Adreno/Qualcomm GPU." },
    'backendNote.win-cuda-13.5-arm64': { en: "NVIDIA on Windows ARM64." },
    'backendNote.linux-cuda-12.8': { en: "Fastest route for NVIDIA on Linux." },
    'backendNote.linux-vulkan': { en: "Universal, small download, driver independent." },
    'backendNote.linux-rocm': { en: "AMD acceleration on Linux. Requires the ROCm runtime/driver." },
    'backendNote.linux-sycl-fp16': { en: "For Intel Arc on Linux. Requires the oneAPI runtime." },
    'backendNote.linux-openvino': { en: "Can use the Intel NPU. Small models only, experimental." },
    'backendNote.linux-cpu': { en: "Always works, even without a GPU." },
    'backendNote.linux-cpu-arm64': { en: "For ARM64 Linux (Raspberry Pi, Jetson, servers)." },
    'backendNote.linux-vulkan-arm64': { en: "Vulkan on ARM64." },
    'backendNote.macos-arm64': { en: "Metal backend for M1/M2/M3/M4 — GPU and unified memory are used." },
    'backendNote.macos-x64': { en: "For Intel Macs. Metal support is limited there." },
  };

  function modelBlurb(repo, fallback) {
    return t(`modelBlurb.${repo}`, null, fallback);
  }

  function backendNote(id, fallback) {
    return t(`backendNote.${id}`, null, fallback);
  }

  /** Empfehlungsbegründungen kommen bereits übersetzt aus dem Main-Prozess. */
  function reasonText(reason, fallback) {
    return reason || fallback || '';
  }

  let lang = DEFAULT_LANG;

  function normalizeLang(value) {
    return LANGS.some((l) => l.id === value) ? value : DEFAULT_LANG;
  }

  function setLang(next) {
    lang = normalizeLang(next);
    return lang;
  }

  function getLang() { return lang; }

  /** BCP-47-Locale für Datums-/Zahlenformatierung. */
  function locale() { return lang === 'en' ? 'en-US' : 'de-DE'; }

  /** Zahl in der aktiven Sprache formatieren. */
  function num(value) { return Number(value).toLocaleString(locale()); }

  function interpolate(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m));
  }

  /**
   * Übersetzt einen Schlüssel. Fällt auf Deutsch und danach auf `fallback` zurück.
   * @param {string} key
   * @param {object} [vars]
   * @param {string} [fallback]
   */
  function t(key, vars, fallback) {
    const entry = MESSAGES[key];
    let text = entry ? (entry[lang] != null ? entry[lang] : entry[DEFAULT_LANG]) : null;
    if (text == null) text = fallback != null ? fallback : key;
    return interpolate(text, vars);
  }

  const I18N = {
    DEFAULT_LANG,
    LANGS,
    MESSAGES,
    normalizeLang,
    setLang,
    getLang,
    locale,
    num,
    t,
    modelBlurb,
    backendNote,
    reasonText,
  };

  root.I18N = I18N;
  if (typeof module !== 'undefined' && module.exports) module.exports = I18N;
})(typeof globalThis !== 'undefined' ? globalThis : this);
