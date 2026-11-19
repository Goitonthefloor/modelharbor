# Changelog

All notable changes to ModelHarbor are documented in this file.

## [1.7.2] - 2026-11-19

### Fixed

- **Lokaler API-Server startet nie mehr ohne Schlüssel (Security-Review):** Der Server läuft jetzt
  ausschließlich mit API-Key — für **llama.cpp und ONNX** an derselben Grenze durchgesetzt. Ist kein
  Key gespeichert, wird beim Laden der Einstellungen einer erzeugt und **sofort persistiert**:
  Neustarts behalten ihn, bei Agenten hinterlegte Konfigurationen bleiben gültig. Vorher startete der
  Server auf `127.0.0.1` ohne API-Key-Flag — damit konnte jeder lokale Prozess und jede Webseite, die eine
  Anfrage dorthin schickt, Inferenz auslösen und Modellantworten lesen.
- **Ein Key aus Leerzeichen gilt nicht als Key:** die Startprüfung trimmt den Wert jetzt selbst.
  Vorher rutschte ein nur aus Leerzeichen bestehender Wert als „vorhanden" durch die Prüfung.

### Changed

- Das Key-Feld im Server-Tab ist immer gefüllt; wird es geleert, entsteht ein neuer Key.
  Der Button heißt jetzt **„Key neu erzeugen"**.
- Die LAN-Warnung „ohne Key kann jedes Gerät im Netzwerk dein Modell benutzen" ist entfernt —
  dieser Zustand kann nicht mehr eintreten.
- Die Agenten-Beispiele (curl, Python, JSON) tragen immer den Key; der Ohne-Key-Platzhalter
  ist entfallen.

### Added

- `server-config.ensureKey()` (erzeugt nur wenn nötig, ersetzt einen gespeicherten Key nie) und
  Tests für Key-Erzeugung, Stabilität und Startverweigerung ohne Key. Suite: **172 Tests**.
- Runtime-Nachweis gegen die echte App: die Prozess-argv enthält den Key, und der Key bleibt über
  einen App-Neustart hinweg derselbe. Rot-Grün: auf dem Code vor diesem Release schlagen 5 der
  neuen/angepassten Tests fehl (der Server startet dort tatsächlich ohne Key).

## [1.7.1] - 2026-11-19

### Fixed

- **Integrität aller Downloads (Security-Review):** Heruntergeladene Backend-Archive, GGUF-Modelle,
  ONNX-Dateien und das uv-Archiv werden jetzt **vor dem Entpacken bzw. Umbenennen per Hash geprüft**.
  Erwartungswerte kommen aus der GitHub-Release-API (`assets[].digest`) und der HuggingFace-API
  (`lfs.sha256` für LFS-Dateien, `blobId` = Git-Blob-SHA1 für kleine Config-Dateien). Bisher wurde
  nur die Dateigröße verglichen — eine gleich große, inhaltlich andere Datei blieb unbemerkt.
  **Fail closed:** fehlt der Digest oder weicht er ab, wird die Datei verworfen (und bei Abweichung
  gelöscht, damit kein Resume sie später übernimmt). Neues Modul `electron/integrity.js`.
- **Renderer-Navigation und IPC-Absender (Security-Review):** Das Fenster beschränkt Navigationen
  jetzt per `will-navigate`/`will-frame-navigate` auf die eigene `ui/index.html`; Datei-Drops,
  Link-Klicks und iframes auf fremde Dokumente laden nicht mehr. Zusätzlich prüft **jeder** der
  36 IPC-Handler den Absender (`event.senderFrame.url`) gegen die App-Datei. Vorher bekam ein
  fremdes Dokument nach einer Navigation die komplette `window.api`-Brücke (Modelle löschen,
  Einstellungen schreiben, Backends entfernen, Server starten). Neues Modul `electron/window-guard.js`.
- **Archiv-Budgets gegen Zip-Bomben (Security-Review):** `extractZipSafe` begrenzt jetzt die
  entpackte Gesamtgröße (16 GiB) und die Eintragszahl (20 000) — geprüft gegen die deklarierte
  Größe **und** die tatsächlich geschriebenen Bytes. Dasselbe Budget gilt für `tar.gz`/`.tgz`
  (Vorabprüfung der Header-Summen). Vorher konnte ein Archiv das Installationslaufwerk füllen.
- **Hänger bei manipulierten ZIP-Headern (Security-Review, DoS):** Ist die deklarierte
  `uncompressedSize` kleiner als die real entpackten Daten, liefert yauzl weder Bytes noch einen
  Fehler und die Installation hing endlos. ModelHarbor inflatiert Deflate-Einträge jetzt selbst
  (`decompress: false` + `zlib.createInflateRaw()`), zählt die echten Bytes und bricht kontrolliert
  ab. Unbekannte Kompressionsmethoden (alles außer Store/Deflate) werden abgelehnt.

### Added

- `test/security-round3.test.js`: 22 Regressionstests mit Angriffs-Triggern, alternativen
  bösartigen Darstellungen (gleiche Größe/anderer Inhalt, lügender ZIP-Header, Präfix-Kollision
  bei der App-URL) und Gegenproben für legitimes Verhalten. Die Modell-Download-Tests fahren
  den echten Download-Pfad gegen einen lokalen HTTPS-Server. Gesamt: **170 Tests**.
- Rot-Grün-Nachweis: Auf dem Code vor diesem Release schlagen 9 der neuen Tests fehl und der
  Lying-Header-Test läuft in einen Timeout (der behobene Hänger).

## [1.7.0] - 2026-11-18

### Added

- **Neuer Menüpunkt „Server"** (zwischen „Modelle" und „Einrichtung"): stellt das geladene Modell
  als **OpenAI-kompatiblen API-Server für Agenten** bereit — analog zum lokalen Server in LM Studio.
  Modell und Preset wählen, **Server starten**, fertig.
- **Agenten-Karte mit Verbindungsdaten:** Base-URL (`http://127.0.0.1:1234/v1`), stabiler
  Modellname **`ModelHarbor`** (bleibt gleich, wenn das Modell wechselt), Endpunkt-Übersicht und
  kopierbare Beispiele für **curl**, **Python (openai-SDK)** und **JSON**. Ein Klick kopiert.
- **LAN-Schalter:** bindet den Server an `0.0.0.0` und zeigt die echten LAN-Adressen des Rechners,
  damit andere Geräte im Netz ihn nutzen können. Ohne API-Key erscheint eine sichtbare Warnung.
- **API-Key mit einem Klick erzeugen** (`mh-…`). Ist ein Key gesetzt, wird er auf allen `/v1/*`-Aufrufen
  erzwungen (401 ohne/falschen Key); `/health` bleibt für Monitoring offen. Der eingebaute Chat
  sendet den Key automatisch mit.
- **CORS umschaltbar** (alle Origins vs. nur same-origin) und **parallele Anfragen** (Slots).
  Hinweis in der UI: llama.cpp teilt das Kontextfenster auf die Slots auf.
- **Server-Log live im Tab**, Status-Anzeige (Läuft / Startet / Gestoppt), Start/Stop direkt im Tab.
  Der Chat bleibt im selben Server — ein Modellwechsel aus dem Server-Tab heraus wechselt nicht
  die Ansicht.
- **Natives Kontextfenster pro Modell:** `context_length` wird direkt aus den **GGUF-Metadaten**
  gelesen (neues Modul `electron/gguf-meta.js`, überspringt große Tokenizer-Arrays) und im
  Einstellungsdialog angezeigt. Wird das trainierte Fenster überschritten, warnt der Dialog
  sichtbar und verweist auf RoPE-Skalierung.
- **Port-Prüfung vor dem Start:** ist der Port belegt, kommt eine klare Meldung mit dem Verweis
  auf den Server-Tab statt eines stillen Ausweichens oder eines hängenden Starts.
- **Gleiche Zugangsregeln für ONNX-Modelle:** der OGA-Server bekommt jetzt `--host`, `--api-key`
  und `--cors-origins`. Damit erzwingt auch ein ONNX-Modell im LAN den API-Key (401 ohne/falschen
  Key, `/health` bleibt offen) und blockt fremde Origins bei eingeschränktem CORS mit 403.
  Vorher wäre ein ONNX-Server im LAN trotz angezeigtem Key ungeschützt gewesen.

### Fixed

- **Server-Konfiguration ging bei Teil-Änderungen verloren.** `saveSettings` ersetzte das
  `server`-Objekt durch den Teil-Patch, bevor es zusammengeführt wurde — eine Änderung von nur
  CORS setzte dadurch Port, LAN-Schalter, API-Key und Slots auf die Standardwerte zurück.
  Die vorherige Konfiguration wird jetzt vor dem Merge gesichert.
- **Chat: Enter nahm den Fokus aus dem Textfeld.** Das Eingabefeld wurde während des Streamens
  `disabled`, was den Fokus dauerhaft kostete. Es ist jetzt nur noch bei gestopptem Server
  deaktiviert und behält den Fokus beim Senden und während der Antwort.

### Tests

- Node: **148/148** (neu: 18 für GGUF-Metadaten, Server-Konfiguration, Agenten-Beispiele,
  llama-server-Flags und Port-Prüfung).
- UI-Smoke: **41/41** (neu: Navigation, Server-Tab, LAN-Schalter, Key-Erzeugung, Kopieren,
  Start mit Modellwahl, Enter-Fokus).
- ONNX-Server: **21/21** (neu: 8 für Key-Pflicht, falscher Key, offenes `/health`, CORS `*`
  vs. `localhost`, Gegenprobe ohne Origin, OPTIONS-Preflight).
- **Echter End-to-End-Nachweis** mit llama.cpp b12527 und einem realen GGUF: Start über die App,
  LAN-Erreichbarkeit über die LAN-IP, Key-Pflicht (401/200), echte Chat-Completion über LAN,
  CORS an/aus (fremde Origin wird mit 403 blockiert), modellspezifisches Kontextfenster im
  laufenden Prozess, LAN aus = nur lokal, belegter Port wird gemeldet, Konfiguration persistiert.
- Die Server-Flags wurden gegen die **echte Binary** (`--help`) und live geprüft:
  `--host`, `--port`, `--api-key`, `--cors-origins` (nicht `--cors`), `--alias`, `--parallel`.

## [1.6.0] - 2026-11-18

### Added

- **Modellspezifische Einstellungen** (Zahnrad an jeder Modellzeile und am Chat-Header beim
  geladenen Modell). Gespeichert wird pro Modell in `<userData>/model-settings.json`,
  unabhängig von den globalen Einstellungen. Leere Felder = Standard, gesetzte Felder = Override.
- **K- und V-Cache getrennt quantisierbar** — wie in LM Studio. Zur Auswahl stehen die von
  llama.cpp unterstützten Typen `f16, bf16, f32, q8_0, q5_1, q5_0, q4_1, q4_0, iq4_nl`;
  sie werden als `--cache-type-k` / `--cache-type-v` an den Server gegeben.
- **Flash-Attention pro Modell** (Auto / An / Aus → `--flash-attn auto|on|off`).
  Ein quantisierter V-Cache **erzwingt** Flash-Attention (llama.cpp-Vorgabe); der Dialog
  weist sichtbar darauf hin, statt einen Startfehler zu produzieren.
- **Live-Speicheranzeige im Dialog:** „KV-Cache bei N Tokens: ~X GB · Y % von f16“,
  aktualisiert sich sofort bei Typ- und Kontextänderung.
- **Die Fit-Bewertung berücksichtigt die Cache-Quantisierung.** q4_0/q4_0 braucht rund
  28 % des f16-Caches — ein Modell kann dadurch von „zu groß“ auf „passt“ wechseln.
- Weitere Werte pro Modell: **Kontextlänge, GPU-Layers, Batch-Größe, Micro-Batch,
  CPU-Threads, mlock, mmap aus, RoPE-Frequenzbasis/-skalierung** (Nachkommastellen erlaubt).
- Badge **„Eigene“** plus Kurzfassung (z. B. `K q4_0 · V q8_0 · FA · ctx 16384`) in der
  Modellzeile; „Auf Standard zurücksetzen“ entfernt alle Overrides des Modells.
- Vorrangregeln: **global < modellspezifisch < expliziter Aufruf**. Die Einstellungen
  hängen am Modell, nicht am Ordner — auch Modelle aus Zusatzordnern behalten sie,
  wenn sich die Ordnerreihenfolge ändert.

### Changed

- Neues Modul `electron/model-settings.js` (Schema, Validierung, Vorrang, Flags, Persistenz)
  und `ui/kvcache.js` (Cache-Typen/Bytes/Faktor als **eine** Quelle für Backend und Renderer).
- `server.buildArgs` nimmt die effektiven Werte entgegen; die alten gekoppelten
  `cacheTypeKV`-Overrides sind entfernt (K und V sind jetzt getrennt).
- `models.evaluateFit` rechnet den KV-Anteil mit dem Quantisierungsfaktor; neuer
  Export `models.kvCacheGB` als f16-Basis für die UI-Anzeige.
- Dialog-Layout: nur der Feldbereich scrollt, Kopf/KV-Anzeige/Aktionen bleiben sichtbar.
- `npm test`: **130** Unit-Tests (vorher 108; +22 für Validierung, Vorrang, Cache-Faktoren,
  Flags, Persistenz und die Verdrahtung in `buildArgs`/`evaluateFit`).
  UI-Smoke **33/33** (+5 Checks: Dialogfelder, Live-KV-Anzeige, Speichern nur ausgefüllter
  Felder, Zurücksetzen, leerer Dialog erzeugt keine Overrides).
- Echt End-to-End gegen den laufenden Electron-Prozess geprüft (**15/15**): ein Schein-Backend
  schreibt seine echte `argv` — die Kommandozeile enthält `--cache-type-k q4_0`,
  `--cache-type-v q8_0`, `--flash-attn on`, `--ctx-size 16384`, `--n-gpu-layers 24`,
  `--batch-size 512`, `--ubatch-size 128`, `--threads 6`, `--mlock`, `--no-mmap`,
  `--rope-freq-base 500000`, `--rope-freq-scale 0.5`, ohne doppelte Flags.

## [1.5.1] - 2026-11-18

### Fixed

- **Lange Herkunfts-Pfade sprengten die Modellzeile.** Der neue Zusatzordner-Pfad steht in
  der Modellzeile; ein langer, ununterbrochener Pfad (NAS-Freigabe, tiefer Ordnerbaum) hatte
  keine Umbruchstelle. `.row-sub` bricht jetzt überall um (`overflow-wrap: anywhere`).
- Doku: der Tab heißt **„Installiert“** (nicht „Lokal“) — CHANGELOG und README entsprechend
  korrigiert.

### Changed

- UI-Smoke **28/28** (+1 Check: langer Herkunftspfad bricht um, statt überzulaufen;
  Rot-Grün geprüft: ohne den CSS-Fix fällt der Check durch).

## [1.5.0] - 2026-11-18

### Added

- **Modelle aus weiteren Ordnern laden.** Unter Setup → „Weitere Modellordner“ lassen sich
  beliebige Ordner hinzufügen, die schon Modelle enthalten — z. B. eine bestehende
  LM-Studio-Sammlung, eine zweite Platte oder eine NAS-Freigabe. Die Modelle erscheinen im
  Tab „Installiert“ mit Badge **Extern** und Angabe des Herkunftsordners und lassen sich genau wie
  heruntergeladene Modelle laden.
  - Fremde Ablagen werden **zwei Ebenen tief** durchsucht (`<publisher>/<model>/<datei>.gguf`),
    der eigene Modellordner bleibt bei einer Ebene (Repo-Ordner).
  - Erkannt werden GGUF (inkl. Split-Parts, die zu einem Modell gruppiert werden) und
    ONNX-/GenAI-Ordner.
  - Die **Fit-Bewertung** (GPU / teilweise / nur RAM / zu groß) gilt auch für externe Modelle.
  - Externe Modelle werden **nie gelöscht**: die Dateien gehören nicht dieser App. Der
    Lösch-Button fehlt, und ein Löschversuch über die API wird mit klarer Meldung abgelehnt.
  - „Entfernen“ nimmt nur den Ordner aus der Liste — die Dateien bleiben unangetastet.
  - Doppelte Ordner, der Haupt-Modellordner selbst und nicht existierende Pfade werden
    abgelehnt; fehlende Ordner werden in der Liste als „nicht gefunden“ markiert.
- Neue IPC-Schnittstelle `models:sources` / `models:addSource` / `models:removeSource`
  (Ordnerwahl über den nativen Dialog, Validierung und Persistenz im Hauptprozess).
- `server:start` prüft den Modellpfad jetzt gegen **alle** eingerichteten Modellordner
  (`withinAnyRoot`), nicht mehr nur gegen den Hauptordner.

### Changed

- `models.listLocal(modelsDir, extraDirs)` ist in `modelsInDir` / `scanModelRoot` zerlegt;
  externe Modelle tragen `external`, `sourceDir`, `sourceIndex` und eine eindeutige ID
  (`ext<Index>:<pfad>/<datei>`), damit sich Ordner mit gleichen Namen nicht in die Quere kommen.
- `npm test`: **108** Unit-Tests (vorher 98; +10 für Zusatzordner, verschachtelte Ablagen,
  ONNX im Fremdordner, Split-Gruppierung, Löschschutz, `withinAnyRoot`).
  UI-Smoke **27/27** (+2 Checks: Extern-Badge mit Laden-ja/Löschen-nein, Ordner
  hinzufügen/entfernen in den Einstellungen).
- Zusätzlich echt End-to-End geprüft (reale Electron-App, echte Dateien, echte IPC):
  14/14 Checks inkl. Persistenz in `settings.json` und intakter Fremddateien nach Remove.

## [1.4.5] - 2026-11-18

### Fixed

- **ONNX-/NPU-Chat hing nach der Antwort endlos.** Der SSE-Handler sendete unter
  HTTP/1.1 `Connection: keep-alive` ohne `Content-Length` und ohne chunked
  Encoding — es gab kein Stream-Ende, der Client wartete nach `[DONE]` für immer.
  Die Antwort setzt jetzt `Connection: close` und beendet die Verbindung.
- **ONNX: Antworten wurden abgeschnitten oder blieben leer.** `max_length` ist bei
  OnnxRuntime-GenAI die **Gesamtlänge** (Prompt + neue Tokens), gesetzt wurde aber
  nur `max_tokens`. Bei langem Prompt blieb kein Platz für die Antwort. Die
  Prompt-Länge wird jetzt eingerechnet (`search_options`, rein und getestet).
- **ONNX: deterministisches Preset war nicht greedy.** `do_sample` wurde immer auf
  `True` gesetzt, auch bei `temperature: 0`. Sampling ist jetzt nur bei
  `temperature > 0` aktiv.
- **Löschen eines Modells zerstörte andere Quants.** `deleteModel` entfernte immer
  den ganzen Repo-Ordner, obwohl der Dialog nur eine Datei nannte — alle anderen
  Quantisierungen desselben Repos waren weg. Jetzt werden nur die Dateien des
  gewählten Modells (inkl. Split-Parts) gelöscht; der Ordner bleibt, außer er ist
  danach leer. ONNX-Ordner werden weiterhin als Ganzes entfernt.
- **Leere Modell-ID löschte den gesamten Modell-Ordner.** `deleteModel('')` lief
  auf das Root-Verzeichnis hinaus. Leere IDs, `.` und `..` werden jetzt abgelehnt.
- **mmproj-Dateien wurden als eigenständige Modelle gelistet.** `listLocal` filtert
  Hilfsdateien (mmproj, imatrix, README) jetzt wie schon die Repo-Dateiliste.
- **Intel-Arc-iGPU wurde als diskrete Karte behandelt.** „Intel Arc Graphics“ und
  „Arc 140V/130V“ (Core Ultra) haben keinen eigenen VRAM; nur Arc mit Modellnummer
  (A770, B580, Arc Pro …) gilt als diskret. Das Modell-Budget war sonst falsch.
- **Doppelte Abschlussmeldung bei Downloads.** Sowohl `startDownload` als auch der
  `download:progress`-Handler zeigten Toast, Refresh und Tab-Wechsel — alles
  erschien zweimal. Der Event-Handler räumt jetzt nur den Fortschrittseintrag ab.
- **Kontextgröße hatte keine wirksame Obergrenze.** Das `max`-Attribut allein hält
  keine eingetippte Zahl ab; ein zu großer `ctx` sprengt den KV-Cache. `ctx` wird
  jetzt auf 1024–131072 begrenzt, `gpuLayers` auf 0–999, und das Feld zeigt den
  tatsächlich gespeicherten Wert.
- **Unbehandelte Promise-Rejections im Renderer.** Mehrere IPC-Aufrufe ohne
  `catch` (`reveal`, `showModels`, `openExternal`, `openReleases`, Rescan, Preset,
  Ordnerwahl, Onboarding, Einstellungen) konnten als unbehandelte Rejection
  enden — u. a. wenn der neue Pfad-Guard einen Pfad ablehnt. Fehler erscheinen
  jetzt als Toast.
- **Fortschritts-Update konnte den Renderer brechen.** Der Repo-Name wurde in
  einen CSS-Selektor interpoliert; Sonderzeichen hätten ihn ungültig gemacht.
  Die Karte wird jetzt über einen Datenvergleich gesucht.

### Changed

- `npm test`: **98** Unit-Tests (vorher 88; +10 für Modellverwaltung,
  Intel-Arc-Klassifikation und den ONNX-Server). UI-Smoke **25/25** (+2 Checks:
  ctx/ngl-Obergrenzen, einfache Abschlussmeldung).
- Neuer Python-Test `scripts/test_onnx_server.py` (13 Checks, läuft ohne
  Onnxruntime/Modell und wird von `npm test` mitausgeführt, sofern python3 da ist).

## [1.4.4] - 2026-11-18

### Fixed

- **Chat-Stream: das letzte Delta ging verloren.** Die SSE-Schleife verarbeitete
  nur Zeilen mit abschließendem Newline. Endet der Stream ohne Newline (beim
  letzten `data:`-Block üblich), wurde die Zeile verworfen — betroffen war oft der
  Usage-Block (Token-Anzeige/tok/s blieb leer) oder das letzte Textstück. Neues
  `ui/sse.js` (`parseSseChunk`) wertet am Stream-Ende den Restpuffer aus und
  flusht den TextDecoder.
- **Update-Download konnte die App crashen.** `updater.downloadFile` schrieb ohne
  `error`-Handler auf den Datei-Stream; ein Schreibfehler (EISDIR, ENOSPC, EACCES)
  war ein unbehandeltes `error`-Event und beendete den Prozess. Jetzt `pipeline()`:
  Fehler jeder Stream-Stufe werden abgefangen, die Teildatei wird entfernt.
- **Update-Download hatte keinen Timeout.** Ein hängender Server ließ den Download
  endlos laufen. Neu: Inaktivitäts-Timeout (60 s ohne Daten, per Option änderbar).
- **Update-Dateiname aus dem Renderer erlaubte Pfad-Ausbruch.** `update:download`
  baute das Ziel per `path.join(userData, 'downloads', name)`; ein Name wie
  `../../../../tmp/boese.exe` schrieb außerhalb des Download-Ordners. Neues
  `electron/paths.js` (`childPath`) verwirft Verzeichnisteile und lehnt `..`/`.` ab.
- **`update:openFile` und `models:reveal` öffneten beliebige Pfade.** Beide prüfen
  den Pfad jetzt per `withinRoot()` gegen den Download- bzw. Modellordner.
- **Linux: VRAM wurde der falschen GPU zugeordnet.** Die sysfs-Suche matchte nur
  den Vendor — bei APU + diskreter Radeon-Karte bekam die dGPU den VRAM der iGPU
  und damit ein falsches Modell-Budget. Jetzt wird die PCI-Adresse der Karte mit
  dem lspci-Eintrag abgeglichen (`pciAddressMatches`).
- **VRAM-Schätzung ignorierte explizite Größenangaben.** „RTX 4060 Ti 16GB“ wurde
  als 8 GB geschätzt. Eine GB-Angabe im Gerätenamen hat jetzt Vorrang vor der
  Modell-Tabelle (Laptop-/iGPU-Ablehnung bleibt bestehen).
- **Debug-Log rotierte nur beim App-Start.** In langen Sitzungen wuchs die Datei
  unbegrenzt; die Rotation läuft jetzt auch während der Betriebzeit (150-KB-Limit).

### Changed

- `npm test`: **88** Unit-Tests (vorher 73; +15 für SSE-Restpuffer, Update-Download
  inkl. Schreibfehler/Timeout, Pfad-Guards, Log-Rotation und VRAM-Zuordnung).
  UI-Smoke **23/23**.
- Neue Module: `ui/sse.js` (SSE-Parsing, in Node testbar) und `electron/paths.js`
  (Pfad-Guards für Renderer-Werte).

## [1.4.3] - 2026-11-18

### Fixed

- **Download-Fortsetzung meldete falsche Byte-Zahlen.** Antwortet ein Server auf
  einen Range-Request mit `200` (Range ignoriert) statt `206`, wird die Zieldatei
  neu geschrieben. `downloadFile` (Modelle) und `downloadToFile` (Backends)
  zählten trotzdem ab der alten Dateigröße weiter: gemeldete Bytes > Dateigröße,
  Fortschritt über 100 % und danach die Meldung „Download unvollständig“, obwohl
  die Datei vollständig auf der Platte lag. Bei `200` beginnt der Zähler jetzt bei 0.
- **`removeBackend()` konnte Verzeichnisse außerhalb des Backend-Ordners löschen.**
  Die Prüfung war ein reiner String-Präfixvergleich (`dir.startsWith(installRoot)`)
  ohne `path.resolve()`. Eine aus dem Renderer kommende ID wie `../backends-evil`
  wurde akzeptiert und das Nachbarverzeichnis rekursiv gelöscht. Erlaubt sind
  jetzt nur bekannte Backend-IDs; zusätzlich wird das Ziel per `path.resolve()`
  gegen den Install-Root geprüft.
- **Relative Redirects brachen Downloads ab.** `downloadFile`, `downloadToFile`
  und `backends.getJson` gaben den `Location`-Header unverändert weiter; ein
  relatives Ziel (z. B. `/datei`) ist keine gültige URL. Alle drei lösen Redirects
  jetzt gegen die Ausgangs-URL auf (wie `models.getJson` es bereits tat).
- **Beenden der App konnte den Modell-Server liegenlassen.** Der `before-quit`-
  Handler war async ohne `event.preventDefault()` — Electron wartet nicht darauf.
  Der Handler hält das Beenden jetzt an, stoppt den Server und beendet danach die App.
- **`nvidia-smi`-Parsing: fehlende Zahlenwerte ergaben 0 statt „unbekannt“.**
  `vramBytes`/`vramFreeBytes` (Linux und Windows) liefern jetzt `null`, wenn eine
  Spalte nicht parsebar ist, statt `0 MB` anzuzeigen.

### Changed

- `npm test`: **73** Unit-Tests (vorher 63; +10 für Range/200-Zählung, echte
  206-Fortsetzung, relative Redirects, 416 und `removeBackend`-Traversal).
  `models.downloadFile` ist dafür exportiert.

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
