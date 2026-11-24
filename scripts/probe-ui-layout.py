#!/usr/bin/env python3
"""UI-Layout-Pruefung fuer alle vier Views: Ueberlauf, Scrollbarkeit, Wheel-Reaktion,
horizontaler Ueberlauf. Nutzt den Mock aus scripts/ui-smoke.py.

Ausfuehrung: <playwright-venv>/bin/python3 scripts/probe-ui-layout.py
Exit 1, wenn eine aktive View Inhalt abschneidet, ohne scrollbar zu sein.
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = (ROOT / 'ui' / 'index.html').as_uri()
MOCK = re.search(r'API_MOCK = """(.*?)"""', (ROOT / 'scripts' / 'ui-smoke.py').read_text(encoding='utf-8'), re.S).group(1)

VIEWS = ['chat', 'models', 'server', 'setup']

MEASURE = """
() => {
  const v = document.querySelector('.view.is-active');
  if (!v) return null;
  const cs = getComputedStyle(v);
  const scroller = [...v.querySelectorAll('*')].find(e => {
    const s = getComputedStyle(e);
    return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 2;
  });
  return {
    id: v.id,
    overflowY: cs.overflowY,
    client: v.clientHeight,
    scroll: v.scrollHeight,
    scrollTop: Math.round(v.scrollTop),
    hOverflow: v.scrollWidth - v.clientWidth,
    innerScroller: scroller ? (scroller.id || scroller.className) : null,
    innerRange: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
  };
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox'])
    results = {}
    problems = []
    for vw, vh in [(1280, 600), (1024, 480)]:
        page = browser.new_page(viewport={'width': vw, 'height': vh})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append('console:' + m.text) if m.type == 'error' else None)
        page.add_init_script(MOCK)
        page.goto(URL)
        page.wait_for_timeout(900)
        for view in VIEWS:
            page.click(f'.nav-item[data-view="{view}"]')
            page.wait_for_timeout(600)
            m = page.evaluate(MEASURE)
            page.mouse.move(vw // 2, vh // 2)
            page.mouse.wheel(0, 700)
            page.wait_for_timeout(250)
            after = page.evaluate(MEASURE)
            moved = after['scrollTop'] - m['scrollTop']
            innerMoved = after['innerRange'] and after['scrollTop'] == m['scrollTop']
            key = f'{vw}x{vh}:{view}'
            results[key] = {**m, 'wheelMoved': moved, 'wheelInInner': bool(innerMoved)}
            needs = m['scroll'] - m['client']
            scrollable = m['overflowY'] in ('auto', 'scroll') or bool(m['innerScroller'])
            if needs > 2 and moved == 0 and not innerMoved:
                problems.append(f'{key}: Inhalt {needs}px abgeschnitten, Wheel bewegt nichts (overflowY={m["overflowY"]})')
            if m['hOverflow'] > 2:
                problems.append(f'{key}: horizontaler Ueberlauf {m["hOverflow"]}px')
            page.evaluate("() => { const v = document.querySelector('.view.is-active'); v.scrollTop = 0; }")
        results[f'{vw}x{vh}__errors'] = errors
        shot = ROOT / f'.runtime/probe-{vw}x{vh}.png'
        shot.parent.mkdir(exist_ok=True)
        page.screenshot(path=str(shot), full_page=False)
        page.close()
    browser.close()

print(json.dumps(results, indent=1, ensure_ascii=False))
print('\nPROBLEME:' if problems else '\nKEINE LAYOUT-PROBLEME')
for pr in problems:
    print(' -', pr)
sys.exit(1 if problems else 0)
