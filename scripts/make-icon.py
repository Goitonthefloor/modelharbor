#!/usr/bin/env python3
"""Erzeugt das ModelHarbor-App-Icon (PNG + ICO) ohne externe Assets."""
from PIL import Image, ImageDraw, ImageFilter
import math, os

S = 1024
OUT = os.path.join(os.path.dirname(__file__), "..", "build")
os.makedirs(OUT, exist_ok=True)

# --- Grundform: abgerundetes Quadrat ---
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=232, fill=255)

# --- Hintergrund-Gradient ---
bg = Image.new("RGB", (S, S))
px = bg.load()
for y in range(S):
    t = y / (S - 1)
    r = int(15 - 7 * t)
    g = int(20 - 9 * t)
    b = int(27 - 12 * t)
    for x in range(S):
        px[x, y] = (r, g, b)
bg = bg.convert("RGBA")

# --- Glow oben rechts ---
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
cx, cy = int(S * 0.74), int(S * 0.22)
for i in range(28, 0, -1):
    rad = int(420 * i / 28)
    alpha = int(9 * (1 - i / 28) ** 1.4) + 2
    gd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=(45, 212, 191, alpha))
glow = glow.filter(ImageFilter.GaussianBlur(60))
bg = Image.alpha_composite(bg, glow)

# --- Hexagon-Gradient ---
hexmask = Image.new("L", (S, S), 0)
hd = ImageDraw.Draw(hexmask)
R = 318
pts = []
for i in range(6):
    ang = math.radians(60 * i - 90)
    pts.append((S / 2 + R * math.cos(ang), S / 2 + R * math.sin(ang)))
hd.polygon(pts, fill=255)

grad = Image.new("RGB", (S, S))
gp = grad.load()
c1 = (45, 212, 191)
c2 = (34, 211, 238)
for y in range(S):
    for x in range(S):
        t = min(1.0, max(0.0, (x * 0.6 + y * 0.4) / S))
        gp[x, y] = tuple(int(c1[k] + (c2[k] - c1[k]) * t) for k in range(3))
grad = grad.convert("RGBA")

hexlayer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hexlayer.paste(grad, (0, 0), hexmask)

# --- Innere Struktur: drei Textzeilen ---
inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
idraw = ImageDraw.Draw(inner)
ink = (5, 34, 30, 255)
bar_h = 40
cx = S // 2
rows = [(-96, 258), (0, 330), (96, 200)]
for dy, w in rows:
    x0 = cx - w // 2
    idraw.rounded_rectangle([x0, S // 2 + dy - bar_h // 2, x0 + w, S // 2 + dy + bar_h // 2], radius=bar_h // 2, fill=ink)
# kleiner Punkt als "Cursor"
idraw.ellipse([cx - 22, S // 2 + 148, cx + 22, S // 2 + 192], fill=ink)

inner = inner.filter(ImageFilter.GaussianBlur(1.2))
hexlayer = Image.alpha_composite(hexlayer, inner)

# dezenter Ring um das Hexagon
ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
ringmask = Image.new("L", (S, S), 0)
rmd = ImageDraw.Draw(ringmask)
for i in range(6):
    ang = math.radians(60 * i - 90)
    pass
rmd.polygon(pts, outline=255, width=10)
ring.paste((45, 212, 191, 120), (0, 0), ringmask)
hexlayer = Image.alpha_composite(hexlayer, ring.filter(ImageFilter.GaussianBlur(4)))

# --- Zusammensetzen ---
icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
icon = Image.alpha_composite(icon, bg)
icon = Image.alpha_composite(icon, hexlayer)
icon.putalpha(mask)

icon.save(os.path.join(OUT, "icon.png"), "PNG")
icon.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"), "PNG")
icon.save(os.path.join(OUT, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("Icon erzeugt:", os.path.join(OUT, "icon.png"))
