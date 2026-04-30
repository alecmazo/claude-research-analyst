"""Generate the iOS app icon + splash screen for the DGA Research mobile app.

Outputs:
  mobile/assets/icon.png            (1024×1024 — App Store + home screen)
  mobile/assets/adaptive-icon.png   (1024×1024 — Android adaptive)
  mobile/assets/splash.png          (1284×2778 — iOS launch screen)
  mobile/assets/favicon.png         (48×48 — web)

Design language matches the existing DGA Capital website / web app:
  • Navy #0A1628 background
  • Gold #C9A84C accent
  • "DGA" wordmark with the vertical bar separator from the existing logo
  • Tight square composition (iOS masks the corners with a rounded rect anyway)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "mobile" / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)

NAVY = (10, 22, 40)            # #0A1628
NAVY_DEEP = (5, 12, 24)        # subtle gradient bottom
GOLD = (201, 168, 76)          # #C9A84C
GOLD_BRIGHT = (231, 195, 96)   # highlight
WHITE = (255, 255, 255)
WHITE_SOFT = (245, 240, 225)

# Premium fonts — Didot is the closest match to the existing wordmark style;
# falls back to Times then Helvetica if Didot is missing.
FONT_PATHS = [
    "/System/Library/Fonts/Supplemental/Didot.ttc",
    "/System/Library/Fonts/Times.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
]


def load_font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    for path in FONT_PATHS:
        try:
            # Didot.ttc has multiple faces — index 1 = Bold
            return ImageFont.truetype(path, size, index=1 if bold and "Didot" in path else 0)
        except OSError:
            continue
    return ImageFont.load_default()


def make_icon(size: int = 1024) -> Image.Image:
    """Square app icon. iOS will mask to a rounded square automatically."""
    img = Image.new("RGB", (size, size), NAVY)
    draw = ImageDraw.Draw(img)

    # ── Subtle vertical gradient (navy → deeper navy at bottom) ──────────────
    for y in range(size):
        t = y / size
        r = int(NAVY[0] * (1 - t) + NAVY_DEEP[0] * t)
        g = int(NAVY[1] * (1 - t) + NAVY_DEEP[1] * t)
        b = int(NAVY[2] * (1 - t) + NAVY_DEEP[2] * t)
        draw.line([(0, y), (size, y)], fill=(r, g, b))

    # ── Soft gold radial glow behind the wordmark (depth) ────────────────────
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx, cy = size // 2, int(size * 0.46)
    for r in range(int(size * 0.42), 0, -8):
        alpha = int(28 * (1 - r / (size * 0.42)))
        gd.ellipse([cx - r, cy - r, cx + r, cy + r],
                   fill=(GOLD[0], GOLD[1], GOLD[2], alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=size // 18))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    draw = ImageDraw.Draw(img)

    # ── "DGA" wordmark — large, gold, bold serif (Didot) ─────────────────────
    dga_font = load_font(int(size * 0.42), bold=True)
    dga_text = "DGA"
    # Measure
    bbox = draw.textbbox((0, 0), dga_text, font=dga_font)
    dga_w = bbox[2] - bbox[0]
    dga_h = bbox[3] - bbox[1]
    dga_x = (size - dga_w) // 2 - bbox[0]
    dga_y = int(size * 0.27) - bbox[1]
    draw.text((dga_x, dga_y), dga_text, fill=GOLD, font=dga_font)

    # ── Vertical bar separator (matches the website's "DGA | CAPITAL") ───────
    bar_w = max(3, int(size * 0.005))
    bar_h = int(size * 0.13)
    bar_y_top = int(size * 0.69)
    draw.rectangle(
        [(size // 2 - bar_w // 2, bar_y_top),
         (size // 2 + bar_w // 2, bar_y_top + bar_h)],
        fill=GOLD,
    )

    # ── "CAPITAL" sub-wordmark — smaller, white, wide tracking ───────────────
    cap_font = load_font(int(size * 0.075), bold=True)
    # Render letter-by-letter with extra spacing for that "tracked-out" look
    cap_text = "CAPITAL"
    letter_spacing = int(size * 0.018)
    # First measure total width with spacing
    letter_widths = []
    for ch in cap_text:
        b = draw.textbbox((0, 0), ch, font=cap_font)
        letter_widths.append(b[2] - b[0])
    total_w = sum(letter_widths) + letter_spacing * (len(cap_text) - 1)
    cap_x = (size - total_w) // 2
    cap_y = bar_y_top + bar_h + int(size * 0.025)
    cur_x = cap_x
    for ch, w in zip(cap_text, letter_widths):
        draw.text((cur_x, cap_y), ch, fill=WHITE_SOFT, font=cap_font)
        cur_x += w + letter_spacing

    # ── Outer gold hairline (only for non-iOS-masked uses) ───────────────────
    # iOS clips this anyway — we draw it just inside the safe zone so it
    # survives the masking with a thin gold rim that's visible.
    inset = int(size * 0.018)
    line_w = max(2, int(size * 0.006))
    draw.rounded_rectangle(
        [(inset, inset), (size - inset, size - inset)],
        radius=int(size * 0.22),
        outline=GOLD, width=line_w,
    )

    return img


def make_adaptive_icon(size: int = 1024) -> Image.Image:
    """Android adaptive icon — content stays in the inner 66% safe zone.

    Android applies its own circle/rounded-square mask of varying size, so
    everything important must fit inside a centred circle of diameter ≈ 0.66 × size.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))   # transparent outer
    # Solid navy fill — full canvas (becomes the "background layer" colour)
    draw = ImageDraw.Draw(img)
    draw.rectangle([(0, 0), (size, size)], fill=(*NAVY, 255))

    # Gold radial glow (subtler than iOS — Android masks more aggressively)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx, cy = size // 2, size // 2
    for r in range(int(size * 0.32), 0, -8):
        alpha = int(20 * (1 - r / (size * 0.32)))
        gd.ellipse([cx - r, cy - r, cx + r, cy + r],
                   fill=(GOLD[0], GOLD[1], GOLD[2], alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=size // 22))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # "DGA" centred — must fit in inner 66% safe zone
    dga_font = load_font(int(size * 0.32), bold=True)
    bbox = draw.textbbox((0, 0), "DGA", font=dga_font)
    w = bbox[2] - bbox[0]
    x = (size - w) // 2 - bbox[0]
    y = int(size * 0.42) - bbox[1]
    draw.text((x, y), "DGA", fill=GOLD, font=dga_font)

    return img


def make_splash(width: int = 1284, height: int = 2778) -> Image.Image:
    """iPhone Pro Max splash screen — the same icon centred on a navy field."""
    img = Image.new("RGB", (width, height), NAVY)

    # Subtle gradient
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / height
        r = int(NAVY[0] * (1 - t) + NAVY_DEEP[0] * t)
        g = int(NAVY[1] * (1 - t) + NAVY_DEEP[1] * t)
        b = int(NAVY[2] * (1 - t) + NAVY_DEEP[2] * t)
        draw.line([(0, y), (width, y)], fill=(r, g, b))

    # Drop a 600px icon centred
    icon = make_icon(600)
    paste_x = (width - 600) // 2
    paste_y = (height - 600) // 2 - 80
    img.paste(icon, (paste_x, paste_y))

    return img


# ── Run ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    icon = make_icon(1024)
    icon.save(ASSETS / "icon.png", "PNG", optimize=True)
    print(f"  ✓ icon.png             1024×1024  ({(ASSETS / 'icon.png').stat().st_size // 1024} KB)")

    adaptive = make_adaptive_icon(1024)
    adaptive.save(ASSETS / "adaptive-icon.png", "PNG", optimize=True)
    print(f"  ✓ adaptive-icon.png    1024×1024  ({(ASSETS / 'adaptive-icon.png').stat().st_size // 1024} KB)")

    splash = make_splash(1284, 2778)
    splash.save(ASSETS / "splash.png", "PNG", optimize=True)
    print(f"  ✓ splash.png           1284×2778  ({(ASSETS / 'splash.png').stat().st_size // 1024} KB)")

    fav = make_icon(48)
    fav.save(ASSETS / "favicon.png", "PNG", optimize=True)
    print(f"  ✓ favicon.png          48×48      ({(ASSETS / 'favicon.png').stat().st_size // 1024} KB)")
