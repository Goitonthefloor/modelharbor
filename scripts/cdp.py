#!/usr/bin/env python3
"""Steuert die laufende ModelHarbor-App über CDP (Playwright)."""
import sys, json, time, os
from playwright.sync_api import sync_playwright

SHOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".runtime", "shots")
os.makedirs(SHOT, exist_ok=True)

def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "inspect"
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        ctx = browser.contexts[0]
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        if action == "inspect":
            print("TITLE:", page.title())
            print("URL:", page.url)
            page.wait_for_timeout(2500)
            text = page.inner_text("body")
            print("TEXT:", text[:1500])
            page.screenshot(path=f"{SHOT}/01-start.png")
            print("SHOT:", f"{SHOT}/01-start.png")
        elif action == "shot":
            name = sys.argv[2] if len(sys.argv) > 2 else "shot"
            page.wait_for_timeout(1200)
            page.screenshot(path=f"{SHOT}/{name}.png")
            print("SHOT:", f"{SHOT}/{name}.png")
            print(page.inner_text("body")[:1200])
        elif action == "eval":
            expr = sys.argv[2]
            print(json.dumps(page.evaluate(expr), ensure_ascii=False, indent=1)[:4000])
        elif action == "click":
            sel = sys.argv[2]
            page.click(sel)
            page.wait_for_timeout(800)
            print("clicked", sel)
        elif action == "chat":
            text = sys.argv[2]
            page.fill("#input", text)
            page.click("#btn-send")
            print("sent:", text)
        browser.close()

if __name__ == "__main__":
    main()
