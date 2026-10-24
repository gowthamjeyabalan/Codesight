"""Generates the Codesight brand kit (marks, icons, wordmark, lockups) into brand/ from one geometry.

The mark is a lowercase c and i on one circle: the c takes the left side, the i is a short piece of the same circle
on the right, and its dot (Hub Blue) sits further round above it. The pieces never touch. It follows Grapht's
rules: a 100-unit box, round strokes, one blue dot.

Run from the repository root:  python tools/brand/make_brand.py
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'brand')
FONTS = os.path.join(ROOT, 'src', 'Codegram', 'web', 'fonts')

BLUE, NIGHT, PAPER, WHITE = '#0A84FF', '#14161C', '#F5F5F7', '#FFFFFF'
TILE_RADIUS = 22.4  # per 100 units, as Grapht and Overlay
ICON_SCALE = 0.9    # the mark inside the tile


def cut(r, stroke, dot, gap, c_half=72.0):
    """One size of the mark. Angles in degrees, 0 is right, clockwise is positive (y down). The c runs from -c_half
    round the left to +c_half; the i and the dot share what is left of the circle with equal gaps between pieces."""
    cap = math.degrees(stroke / 2 / r)       # how far a round end reaches past its angle
    dot_half = math.degrees(dot / r)
    i_start = c_half - cap - gap - cap
    dot_at = -c_half + cap + gap + dot_half
    i_end = dot_at + dot_half + gap + cap
    return dict(r=r, stroke=stroke, dot=dot, c=(-c_half, c_half), i=(i_end, i_start), dot_at=dot_at)


REGULAR = cut(r=28, stroke=10, dot=8, gap=12)    # 40 px and up
SMALL = cut(r=30, stroke=12.5, dot=9, gap=13)    # 32 px and down: thicker, wider gaps, so it stays open
CENTRE = (50.0, 50.0)


def point(g, a):
    return CENTRE[0] + g['r'] * math.cos(math.radians(a)), CENTRE[1] + g['r'] * math.sin(math.radians(a))


def n(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.')


def arc_path(g, a_from, a_to):
    """SVG arc from a_from to a_to going counterclockwise (decreasing angle)."""
    (x0, y0), (x1, y1) = point(g, a_from), point(g, a_to)
    span = (a_from - a_to) % 360
    return f'M{n(x0)} {n(y0)} A{n(g["r"])} {n(g["r"])} 0 {1 if span > 180 else 0} 0 {n(x1)} {n(y1)}'


def mark_svg_parts(g, stroke_color, dot_color):
    c = arc_path(g, g['c'][0], g['c'][1] - 360)  # from the top end, counterclockwise round the left
    i = arc_path(g, g['i'][1], g['i'][0])
    dx, dy = point(g, g['dot_at'])
    return (f'<g fill="none" stroke="{stroke_color}" stroke-width="{n(g["stroke"])}" stroke-linecap="round">'
            f'<path d="{c}"/><path d="{i}"/></g>'
            f'<circle cx="{n(dx)}" cy="{n(dy)}" r="{n(g["dot"])}" fill="{dot_color}"/>')


def svg(view, body, w=None, h=None):
    size = f' width="{w}" height="{h}"' if w else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}"{size}>{body}</svg>\n'


def write(path, text):
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def icon_svg(g, tile, stroke, dot):
    inner = mark_svg_parts(g, stroke, dot)
    t = (100 - 100 * ICON_SCALE) / 2
    return svg('0 0 100 100', f'<rect width="100" height="100" rx="{TILE_RADIUS}" fill="{tile}"/>'
                              f'<g transform="translate({n(t)} {n(t)}) scale({ICON_SCALE})">{inner}</g>')


# ── raster ──
def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[k:k + 2], 16) for k in (0, 2, 4))


def draw_mark(d, g, ox, oy, s, stroke_color, dot_color):
    """Draws the mark with its 100-unit box at (ox, oy) scaled by s, on a supersampled ImageDraw."""
    cx, cy, r, w = ox + CENTRE[0] * s, oy + CENTRE[1] * s, g['r'] * s, g['stroke'] * s
    box = [cx - r - w / 2, cy - r - w / 2, cx + r + w / 2, cy + r + w / 2]
    col = hex_rgb(stroke_color) + (255,)
    # Pillow draws arcs clockwise from start to end; the c is clockwise from +72 round the left to 288
    for a0, a1 in ((g['c'][1], g['c'][0] + 360), (g['i'][0], g['i'][1])):
        d.arc(box, a0, a1, fill=col, width=max(1, round(w)))
        for a in (a0, a1):  # round ends
            x, y = cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))
            d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=col)
    dx, dy = ox + point(g, g['dot_at'])[0] * s, oy + point(g, g['dot_at'])[1] * s
    dr = g['dot'] * s
    d.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=hex_rgb(dot_color) + (255,))


SS = 8  # supersampling


def icon_png(size, tile, stroke, dot):
    g = SMALL if size <= 32 else REGULAR
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * TILE_RADIUS / 100, fill=hex_rgb(tile) + (255,))
    s = big / 100 * ICON_SCALE
    t = big * (1 - ICON_SCALE) / 2
    draw_mark(d, g, t, t, s, stroke, dot)
    return img.resize((size, size), Image.LANCZOS)


def mark_png(size, stroke, dot):
    big = size * SS
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw_mark(ImageDraw.Draw(img), REGULAR, 0, 0, big / 100, stroke, dot)
    return img.resize((size, size), Image.LANCZOS)


# ── wordmark: "codesight" in Manrope ExtraBold, outlined ──
FONT_FILE = os.path.join(FONTS, 'Manrope-ExtraBold.ttf')
WORD = 'codesight'
TAGLINE = 'Insight into your C# code'


def wordmark_path(scale, x0, baseline):
    """Outlines of the word as one SVG path, with the given font scale, start x and baseline. Returns (d, width)."""
    font = TTFont(FONT_FILE)
    gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font['hmtx']
    parts, x = [], x0
    for ch in WORD:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        parts.append(pen.getCommands())
        x += hmtx[name][0] * scale
    return ' '.join(parts), x - x0


def font_metrics():
    font = TTFont(FONT_FILE)
    return font['head'].unitsPerEm, font['OS/2'].sxHeight


def lockups():
    font = TTFont(FONT_FILE)
    upm, x_height = font['head'].unitsPerEm, font['OS/2'].sxHeight
    asc, desc = font['OS/2'].sCapHeight * 1.02, -font['OS/2'].sTypoDescender
    ring = 2 * (REGULAR['r'] + REGULAR['stroke'] / 2)  # the mark's circle, outside edge
    top = CENTRE[1] - ring / 2
    # the ring spans the lowercase letters, like one more letter (as Overlay's O)
    scale = ring / x_height
    baseline = top + ring
    gap = ring * 0.32
    x0 = CENTRE[0] + ring / 2 + gap
    d, width = wordmark_path(scale, x0, baseline)
    pad = 3
    left = CENTRE[0] - ring / 2 - pad
    right = x0 + width + pad
    word_top = baseline - asc * scale - pad
    word_bottom = baseline + desc * scale + pad
    # the mark's dot rises above the ring; the box takes in whichever is higher
    dot_top = point(REGULAR, REGULAR['dot_at'])[1] - REGULAR['dot'] - pad
    box_top = min(word_top, dot_top)
    sub = '#9898A2'
    for theme, ink, dotc in (('on-dark', PAPER, BLUE), ('on-light', NIGHT, BLUE)):
        body = mark_svg_parts(REGULAR, ink, dotc) + f'<path d="{d}" fill="{ink}"/>'
        write(f'svg/codesight-lockup-horizontal-{theme}.svg',
              svg(f'{n(left)} {n(box_top)} {n(right - left)} {n(word_bottom - box_top)}', body))
        wd, ww = wordmark_path(scale, 0, 0)
        write(f'svg/codesight-wordmark-{theme}.svg',
              svg(f'{-pad} {n(-asc * scale - pad)} {n(ww + 2 * pad)} {n((asc + desc) * scale + 2 * pad)}', f'<path d="{wd}" fill="{ink}"/>'))
        # stacked: the mark above, the word centred below it
        k = 0.46
        s_base = CENTRE[1] + ring / 2 + ring * 0.28 + asc * scale * k
        sd, sw = wordmark_path(scale * k, CENTRE[0] - ww * k / 2, s_base)
        s_left = min(CENTRE[0] - ring / 2, CENTRE[0] - sw / 2) - pad
        s_right = max(CENTRE[0] + ring / 2 + 10, CENTRE[0] + sw / 2) + pad
        s_top = min(dot_top, top - pad)  # the top of the ring or the dot, whichever is higher
        write(f'svg/codesight-lockup-stacked-{theme}.svg',
              svg(f'{n(s_left)} {n(s_top)} {n(s_right - s_left)} {n(s_base + desc * scale * k + pad - s_top)}',
                  mark_svg_parts(REGULAR, ink, dotc) + f'<path d="{sd}" fill="{ink}"/>'))
        # README header: the lockup with the tagline under the word
        t_scale = scale * 0.2
        t_base = word_bottom + ring * 0.12 + 1000 * t_scale * 0.73
        td = tagline_path(t_scale, x0, t_base)
        write(f'svg/codesight-readme-header-{theme}.svg',
              svg(f'{n(left)} {n(box_top)} {n(right - left)} {n(t_base + 240 * t_scale + pad - box_top)}',
                  body + f'<path d="{td}" fill="{sub if theme == "on-dark" else "#52525A"}"/>'))


def tagline_path(scale, x0, baseline):
    font = TTFont(os.path.join(FONTS, 'Inter-Medium.ttf'))
    gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font['hmtx']
    parts, x = [], x0
    for ch in TAGLINE:
        name = cmap.get(ord(ch))
        if name is None:
            continue
        pen = SVGPathPen(gs)
        gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        parts.append(pen.getCommands())
        x += hmtx[name][0] * scale
    return ' '.join(parts)


def banner():
    """1280 x 640: the lockup and tagline centred on Night, for the repository's social preview."""
    W, H = 1280, 640
    big = Image.new('RGBA', (W * 2, H * 2), hex_rgb(NIGHT) + (255,))
    d = ImageDraw.Draw(big)
    upm, x_height = font_metrics()
    ring_px = 150
    s = ring_px / (2 * (REGULAR['r'] + REGULAR['stroke'] / 2))
    font_px = ring_px / (x_height / upm)
    word = ImageFont.truetype(FONT_FILE, int(font_px))
    tag = ImageFont.truetype(os.path.join(FONTS, 'Inter-Medium.ttf'), 64)
    word_w = d.textlength(WORD, font=word)
    gap = ring_px * 0.32
    total = ring_px + gap + word_w
    x = (W * 2 - total) / 2
    top = H * 2 * 0.36 - ring_px / 2
    ox = x - (CENTRE[0] - REGULAR['r'] - REGULAR['stroke'] / 2) * s
    oy = top - (CENTRE[1] - REGULAR['r'] - REGULAR['stroke'] / 2) * s
    draw_mark(d, REGULAR, ox, oy, s, PAPER, BLUE)
    d.text((x + ring_px + gap, top + ring_px), WORD, font=word, fill=hex_rgb(PAPER), anchor='ls')
    tw = d.textlength(TAGLINE, font=tag)
    d.text(((W * 2 - tw) / 2, top + ring_px + 150), TAGLINE, font=tag, fill=(0x98, 0x98, 0xA2), anchor='ls')
    big.resize((W, H), Image.LANCZOS).convert('RGB').save(os.path.join(OUT, 'png', 'codesight-social-banner-1280x640.png'))


def main():
    for sub in ('svg', 'png', 'ico'):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)

    # the mark alone
    view = '5 5 90 90'
    for name, stroke, dot in (('color-on-dark', PAPER, BLUE), ('color-on-light', NIGHT, BLUE), ('white', WHITE, WHITE), ('ink', NIGHT, NIGHT)):
        write(f'svg/codesight-mark-{name}.svg', svg(view, mark_svg_parts(REGULAR, stroke, dot), 1024, 1024))
    # icons: white mark on Hub Blue (the app icon), Paper and blue on Night (the alternate)
    write('svg/codesight-icon-blue.svg', icon_svg(REGULAR, BLUE, WHITE, WHITE))
    write('svg/codesight-icon-blue-small.svg', icon_svg(SMALL, BLUE, WHITE, WHITE))
    write('svg/codesight-icon-dark.svg', icon_svg(REGULAR, NIGHT, PAPER, BLUE))
    write('svg/codesight-icon-dark-small.svg', icon_svg(SMALL, NIGHT, PAPER, BLUE))
    write('svg/favicon.svg', icon_svg(SMALL, BLUE, WHITE, WHITE))

    sizes = (16, 20, 24, 32, 40, 48, 64, 90, 96, 128, 180, 192, 200, 256, 512, 1024)
    for size in sizes:
        icon_png(size, BLUE, WHITE, WHITE).save(os.path.join(OUT, 'png', f'codesight-icon-blue-{size}.png'))
        icon_png(size, NIGHT, PAPER, BLUE).save(os.path.join(OUT, 'png', f'codesight-icon-dark-{size}.png'))
    for name, stroke, dot in (('color-on-dark', PAPER, BLUE), ('color-on-light', NIGHT, BLUE), ('white', WHITE, WHITE)):
        mark_png(1024, stroke, dot).save(os.path.join(OUT, 'png', f'codesight-mark-{name}-1024.png'))

    # Windows icons, each size drawn on its own (the small cut below 40 px)
    ico_sizes = (16, 20, 24, 32, 40, 48, 64, 128, 256)
    for name, tile, stroke, dot in (('codesight', BLUE, WHITE, WHITE), ('codesight-dark', NIGHT, PAPER, BLUE)):
        frames = [icon_png(s, tile, stroke, dot) for s in ico_sizes]
        frames[-1].save(os.path.join(OUT, 'ico', f'{name}.ico'), sizes=[(s, s) for s in ico_sizes], append_images=frames[:-1])

    lockups()
    banner()
    for name, g in (('regular', REGULAR), ('small', SMALL)):
        print(name, {k: tuple(round(x, 2) for x in v) if isinstance(v, tuple) else round(v, 2) for k, v in g.items()})


if __name__ == '__main__':
    main()
