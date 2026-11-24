# ModelHarbor — Nacht-Testlauf

- **Datum:** 2026-11-24 22:50 CET
- **Lauf:** `20261124-214736`
- **Ziel:** installierte Windows-App (v2.0.0) auf dem Spiele-PC, gesteuert über den
  Windows-Accessibility-Tree (Plugin `vercel-agent-desktop-support`), plus alle
  automatisierten Suiten auf der Linux-VM.

## Ergebnis auf einen Blick

| Bereich | Ergebnis |
| --- | --- |
| Unit-Tests (Node) | ✅ 273/273 bestanden, 0 Fehler |
| ONNX-Server-Harness | ✅ 72 PASS / 0 FAIL |
| UI-Smoke (Playwright, gemockte API) | ✅ 61/61 bestanden |
| Web-Modus-Smoke (headless `serve`) | ✅ 11/11 bestanden |
| GUI-E2E Windows (echte Klicks) | ❌ 0/0 Schritte |

## Umgebung

- Hardware/Backend: siehe `shots/tab_Einrichtung.png` (Einrichtungs-Tab dieses Laufs)

## 1. Automatisierte Suiten (Linux-VM)

**Unit-Tests** (`npm test`, Node `node --test`)

```
tests 273  pass 273  fail 0  cancelled 0  skipped 0
```

**ONNX-Server-Harness:** 72 PASS, 0 FAIL — alle ONNX-Server-Checks bestanden

**UI-Smoke:** 61/61 bestanden

**Web-Modus-Smoke:** 11/11 bestanden

## 2. GUI-E2E auf dem Windows-PC

Kein Ergebnis empfangen — der Windows-Teil hat nicht abgeschlossen.

## 3. Auffälligkeiten

Keine Fehler in den ausgewerteten Schritten.

## 4. Rohdaten und Belege

Auf dem Testrechner unter `~/.hermes/state/modelharbor-nightly/20261124-214736/`:

- `unit.log` — 303776 Bytes
- `onnx.log` — 4926 Bytes
- `ui.log` — 11519 Bytes
- `web.log` — 1613 Bytes
- `e2e.log` — 1783 Bytes
- `result.json` — 0 Bytes

Screenshots (Belege, nicht im Repo):

- `shots/benchmark_laufend.png` (92 KiB)
- `shots/chat_antwort.png` (155 KiB)
- `shots/tab_Benchmark.png` (87 KiB)
- `shots/tab_Chat.png` (154 KiB)
- `shots/tab_Einrichtung.png` (202 KiB)
- `shots/tab_Modelle.png` (193 KiB)
- `shots/tab_Server.png` (126 KiB)

## 5. E2E-Protokoll (Auszug)

```
﻿22:47:37 === nightly e2e begin ===
22:47:37 PASS app_verfuegbar :: pid=20144
22:47:37 PASS fenster :: w-458990 1320.0x880.0
22:47:39 PASS click_Modelle :: ref=@s2cvp9pbp4v25c:e4
22:47:41 shot tab_Modelle
22:47:42 snap tab_Modelle refs=29
22:47:43 PASS click_Server :: ref=@s3o5i2x7s9wl7:e5
22:47:45 shot tab_Server
22:47:46 snap tab_Server refs=30
22:47:47 PASS click_Benchmark :: ref=@s3pj9g1mclz7fh:e6
22:47:49 shot tab_Benchmark
22:47:50 snap tab_Benchmark refs=38
22:47:52 PASS click_Einrichtung :: ref=@s1bdy733whz04r:e7
22:47:54 shot tab_Einrichtung
22:47:54 snap tab_Einrichtung refs=27
22:47:56 PASS click_Chat :: ref=@s29am34py5ww3q:e3
22:47:58 shot tab_Chat
22:47:59 snap tab_Chat refs=22
22:48:00 PASS click_Modelle :: ref=@s37zbbvwtadjqv:e4
22:48:02 snap modelle refs=29
22:48:02 PASS modelle_gelistet :: Installiert (5)
22:48:04 PASS click_Server :: ref=@s2g65ybd1ua1x2:e5
22:48:06 PASS click_Server starten :: ref=@s20lqu9j3e49y4:e12
22:48:10 PASS server_health :: port=1234
22:48:13 FAIL api_key_pflicht :: ohne= mit=
22:48:15 PASS click_Chat :: ref=@s9pwe20sw4e6k:e3
22:48:17 snap chat_vorher refs=23
22:48:18 FAIL chat_getippt :: ref=@s2r953a4fa5n8t:e22 ACTION_FAILED
22:48:20 PASS chat_gesendet :: ref=@sno7vime46epy:e23
22:49:06 shot chat_antwort
22:49:06 snap chat_antwort refs=23
22:49:08 PASS click_Benchmark :: ref=@s2lrsb986lu2lp:e6
22:49:10 snap benchmark refs=38
22:49:11 PASS benchmark_start :: ref=@s21jp1lwm80lak:e9 name=Benchmark starten
22:49:51 shot benchmark_laufend
22:49:52 snap benchmark_nachher refs=38
22:49:54 PASS click_Server :: ref=@slghv6p9cob4:e5
22:49:57 PASS click_Server stoppen :: ref=@s286c9gjgo6w1o:e13
22:50:09 PASS server_gestoppt :: health=0
22:50:09 === nightly e2e end (Fehler: 0) ===
```

