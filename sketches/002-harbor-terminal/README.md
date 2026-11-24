## Variante: Harbor Terminal

### Design-Stance
Tool-first wie ein Kontrollzentrum: maximale Information pro Zeile, Terminal-Ästhetik (Monospace-Metadaten, Statusleiste), kühles Grün als einziges Akzentlicht.

### Key choices
- **Layout:** kompakte Sidebar (198 px) mit Kürzeln (1/2/3), Modelle als dichte Zeilen statt Karten, fixe Statusleiste unten (Modell · Backend · Port · tok/s)
- **Typografie:** 13 px Basis, Monospace für alles Maschinenhafte (Dateinamen, Werte, Status); kleine Kbd-Badges
- **Farbe:** fast monochromes Anthrazit + **Terminal-Grün** für Aktion/Status; RAM/Hybrid/GPU-Badges als gedämpfte Mono-Chips
- **Interaktion:** 9 px-Radien (kantiger), schnelle Hover-/Fokus-Feedback, Kommandozeilen-Placeholder (› …), Toast im Terminal-Stil

### Trade-offs
- Stark bei: Power-User, viele Modelle, Vergleichbarkeit, schnellem Scan
- Schwach bei: Wärme und Einladung — wirkt technisch, wenig „Ort“

### Best for
- Menschen, die Modelle wie Pakete verwalten wollen: Dateinamen, Quantisierungen, VRAM-Werte direkt sichtbar, alles auf einen Blick.