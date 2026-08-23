#!/usr/bin/env python3
"""Generate the README hero banners: docs/assets/banner-{light,dark}.svg.

Both files come from this one source; the light/dark pair differs only in the
theme token block below. Their geometry is byte-identical.

WHY THIS SCRIPT EXISTS
  The banner's text is baked into <path> outlines, not <text> elements, so a
  copy change (headline, chip labels) CANNOT be hand-edited in the SVG
  — edit COPY below and re-run this. Outlining is deliberate: GitHub renders
  README SVGs inside <img>, where a font-family would resolve against whatever
  fonts the *viewer* has, shifting advance widths and breaking the text-sized
  chip pills. Outlines render identically everywhere and reference nothing.

BRAND FIDELITY
  The mark, the wordmark and the mark's gradient are read straight out of
  carbon/src/client/assets/logo-light.svg at generation time and emitted
  verbatim — they are never transcribed into this file, so they cannot drift
  from the logo. Type is Noto Sans + JetBrains Mono, matching the app's
  --font-sans / --font-mono.

DEPENDENCIES
  pip install fonttools
  Two OFL variable fonts, in $BANNER_FONT_DIR (default: <repo>/.banner-fonts):
    ns.ttf   Noto Sans        google/fonts ofl/notosans/NotoSans[wdth,wght].ttf
    jbm.ttf  JetBrains Mono   google/fonts ofl/jetbrainsmono/JetBrainsMono[wght].ttf
  Fetch with:
    mkdir -p .banner-fonts
    curl -sSL -o .banner-fonts/ns.ttf \\
      https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf
    curl -sSL -o .banner-fonts/jbm.ttf \\
      https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf

USAGE
  python3 scripts/banner-generator.py                 # -> docs/assets/
  python3 scripts/banner-generator.py 80 /tmp/try     # headline size, out dir
                                                      # (for eyeballing variants)

Regeneration is byte-stable: re-running with no changes reproduces both files
exactly, so this can be wired to a drift check.

AFTER EDITING, RE-VALIDATE. Reading the markup is not enough — two render bugs
here were invisible in the source and only showed up in a raster: a `--` inside
an XML comment (illegal, both files failed to parse) and glyph path data
emitted without its <path> wrapper (valid XML, text rendered invisibly). Parse
both files, grep for external references, and actually rasterise them.
"""
import math
import os
import re
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

REPO = Path(__file__).resolve().parent.parent
LOGO = REPO / "carbon/src/client/assets/logo-light.svg"
OUT = REPO / "docs/assets"
FONT_DIR = Path(os.environ.get("BANNER_FONT_DIR") or (REPO / ".banner-fonts"))
NOTO = FONT_DIR / "ns.ttf"
JBM = FONT_DIR / "jbm.ttf"

# ---------------------------------------------------------------- copy
# The only strings in the artwork. Everything else is geometry.
HEAD_A, HEAD_B = "Idea", "production SaaS"       # joined by the drawn arrow
CHIPS = ["compose", "compose-ha", "k8s", "k8s-ha"]
ALT = ("Vibecarbon - Idea to production SaaS. Deployment modes: compose, "
       "compose-ha, k8s, k8s-ha.")

# ---------------------------------------------------------------- theme tokens
# Values are carbon/src/client/index.css tokens converted oklch -> sRGB, except
# `accent`, which is sampled from the logo mark's own gradient so the arrow and
# the mark are literally the same teal rather than two that nearly match.
THEMES = {
    "light": dict(
        base="#FFFFFF",                # brief: white base
        fg="#07101A",                  # --foreground        oklch(.17 .025 250)
        muted="#46555F",               # --muted-foreground  oklch(.44 .025 240)
        accent_stop=1,                 # -> #0D9488, the gradient's dark end
        wash_op=0.05,                  # --canvas-wash light alpha
        line="#2E3B44", line_op=0.22,  # --border            oklch(.45 .03 230 / .22)
    ),
    "dark": dict(
        base="#0B0F14",                # brief: #0b0f14-family
        fg="#EEF3F4",                  # --foreground        oklch(.96 .005 210)
        muted="#95A4AB",               # --muted-foreground  oklch(.71 .02 228)
        accent_stop=0,                 # -> #5EEAD4, the gradient's light end
        wash_op=0.08,                  # app uses .09; brief caps the wash at 8%
        line="#D7E3E6", line_op=0.20,  # --border            oklch(.9 .03 200 / .2)
    ),
}

# ---------------------------------------------------------------- layout
# 8px rhythm: 8 within a group / 24 between elements / 48 between sections.
W, H = 1280, 320
GAP_SECTION, GAP_ELEM, GAP_GROUP = 48, 24, 8
MARK_H = 176                  # mark height; the stacked wordmark shares its column
MARK_WORD_GAP = 16            # mark -> wordmark; tighter than GAP_ELEM, they are one lockup
WORD_W_RATIO = 1.4            # wordmark width relative to mark width
HEAD_SIZE, HEAD_WGHT, HEAD_TRACK = 72, 650, -0.018
CHIP_SIZE, CHIP_WGHT, CHIP_TRACK = 14, 500, 0.02
CHIP_H, CHIP_R, CHIP_PAD = 32, 8, 16
PANEL_R = 16
HAIRLINE = 1.5                # ~1px once GitHub scales 1280 -> ~880


# ---------------------------------------------------------------- svg path bbox
def _tokens(d):
    return re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?", d)


def _cubic_ts(p0, p1, p2, p3):
    ts = [0.0, 1.0]
    a, b, c = -p0 + 3 * p1 - 3 * p2 + p3, 2 * (p0 - 2 * p1 + p2), -p0 + p1
    if abs(a) < 1e-12:
        if abs(b) > 1e-12 and 0 < -c / b < 1:
            ts.append(-c / b)
    else:
        disc = b * b - 4 * a * c
        if disc >= 0:
            sq = math.sqrt(disc)
            ts += [t for t in ((-b + sq) / (2 * a), (-b - sq) / (2 * a)) if 0 < t < 1]
    return ts


def _cubic_at(p0, p1, p2, p3, t):
    m = 1 - t
    return m ** 3 * p0 + 3 * m ** 2 * t * p1 + 3 * m * t * t * p2 + t ** 3 * p3


def path_bbox(d, acc=None):
    """Exact bbox of an SVG path (bezier extrema solved, not sampled)."""
    tk, i = _tokens(d), 0
    cx = cy = sx = sy = 0.0
    cmd = None
    xs, ys = ([], []) if acc is None else acc

    def add(x, y):
        xs.append(x)
        ys.append(y)

    while i < len(tk):
        if re.match(r"[A-Za-z]", tk[i]):
            cmd = tk[i]
            i += 1
        if cmd in "Mm":
            x, y = float(tk[i]), float(tk[i + 1])
            i += 2
            if cmd == "m":
                x, y = cx + x, cy + y
            cx, cy = sx, sy = x, y
            add(cx, cy)
            cmd = "L" if cmd == "M" else "l"
        elif cmd in "Ll":
            x, y = float(tk[i]), float(tk[i + 1])
            i += 2
            if cmd == "l":
                x, y = cx + x, cy + y
            cx, cy = x, y
            add(cx, cy)
        elif cmd in "Hh":
            x = float(tk[i])
            i += 1
            cx = cx + x if cmd == "h" else x
            add(cx, cy)
        elif cmd in "Vv":
            y = float(tk[i])
            i += 1
            cy = cy + y if cmd == "v" else y
            add(cx, cy)
        elif cmd in "Cc":
            x1, y1, x2, y2, x, y = (float(v) for v in tk[i:i + 6])
            i += 6
            if cmd == "c":
                x1, y1, x2, y2, x, y = (cx + x1, cy + y1, cx + x2,
                                        cy + y2, cx + x, cy + y)
            for t in _cubic_ts(cx, x1, x2, x):
                add(_cubic_at(cx, x1, x2, x, t), cy)
            for t in _cubic_ts(cy, y1, y2, y):
                add(cx, _cubic_at(cy, y1, y2, y, t))
            cx, cy = x, y
            add(cx, cy)
        elif cmd in "Zz":
            cx, cy = sx, sy
            add(cx, cy)
        else:
            raise SystemExit("unhandled path command %r" % cmd)
    return (xs, ys) if acc is not None else (min(xs), min(ys), max(xs), max(ys))


# ---------------------------------------------------------------- logo source
def read_logo():
    """Pull the mark, the wordmark and the gradient out of the real logo file.

    Emitted verbatim, so the banner cannot drift from carbon's logo. Both are
    theme-invariant in the source (logo-light/dark differ only in wordmark
    fill), which is why one geometry serves both banners.
    """
    src = LOGO.read_text()
    mark = re.search(r'<path d="([^"]+)" fill="url\(#paint0[^"]*\)"/>', src)
    if not mark:
        raise SystemExit("could not find the gradient mark path in %s" % LOGO)
    mark_d = mark.group(1)
    word_ds = re.findall(r'<path d="([^"]+)" fill="black"/>', src)
    if len(word_ds) != 10:
        raise SystemExit("expected 10 wordmark paths in %s, found %d"
                         % (LOGO, len(word_ds)))
    g = re.search(r'<linearGradient[^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"', src)
    stops = re.findall(r'stop-color="(#[0-9A-Fa-f]{6})"', src)
    if not g or len(stops) != 2:
        raise SystemExit("could not read the mark gradient from %s" % LOGO)

    acc = ([], [])
    for d in word_ds:
        path_bbox(d, acc)
    wx0, wy0 = min(acc[0]), min(acc[1])
    wx1, wy1 = max(acc[0]), max(acc[1])
    mx0, my0, mx1, my1 = path_bbox(mark_d)
    return dict(mark_d=mark_d, word_ds=word_ds,
                mark_box=(mx0, my0, mx1 - mx0, my1 - my0),
                word_box=(wx0, wy0, wx1 - wx0, wy1 - wy0),
                grad_y=(g.group(1), g.group(2)), stops=stops)


# ---------------------------------------------------------------- font utils
_cache = {}


def load(path, wght):
    key = (str(path), wght)
    if key not in _cache:
        if not Path(path).exists():
            raise SystemExit(
                "missing font %s — see DEPENDENCIES in this file's docstring "
                "(or set BANNER_FONT_DIR)" % path)
        f = instancer.instantiateVariableFont(
            TTFont(path), {"wght": wght}, updateFontNames=False)
        _cache[key] = (f, f["head"].unitsPerEm, f.getBestCmap(), f["hmtx"],
                       f.getGlyphSet(), kerning(f))
    return _cache[key]


def kerning(font):
    """(g1, g2) -> xAdvance, from the GPOS 'kern' feature's PairPos subtables."""
    pairs = {}
    if "GPOS" not in font:
        return pairs
    gpos = font["GPOS"].table
    if not (gpos and gpos.FeatureList and gpos.LookupList):
        return pairs
    idxs = set()
    for rec in gpos.FeatureList.FeatureRecord:
        if rec.FeatureTag == "kern":
            idxs.update(rec.Feature.LookupListIndex)
    for i in idxs:
        lk = gpos.LookupList.Lookup[i]
        for st in lk.SubTable:
            st = st.ExtSubTable if lk.LookupType == 9 else st
            if st.__class__.__name__ == "PairPos":
                _pairpos(st, pairs)
    return pairs


def _pairpos(st, pairs):
    if st.Format == 1:
        for gi, pset in enumerate(st.PairSet):
            g1 = st.Coverage.glyphs[gi]
            for r in pset.PairValueRecord:
                adv = getattr(getattr(r, "Value1", None), "XAdvance", 0)
                if adv:
                    pairs[(g1, r.SecondGlyph)] = adv
    elif st.Format == 2:
        cd1 = st.ClassDef1.classDefs if st.ClassDef1 else {}
        cd2 = st.ClassDef2.classDefs if st.ClassDef2 else {}
        c1g, c2g = {}, {}
        for g in st.Coverage.glyphs:
            c1g.setdefault(cd1.get(g, 0), []).append(g)
        for g, c in cd2.items():
            c2g.setdefault(c, []).append(g)
        for c1, rec1 in enumerate(st.Class1Record):
            for c2, rec2 in enumerate(rec1.Class2Record):
                adv = getattr(getattr(rec2, "Value1", None), "XAdvance", 0)
                if not adv:
                    continue
                for g1 in c1g.get(c1, []):
                    for g2 in c2g.get(c2, []):
                        pairs.setdefault((g1, g2), adv)


def shape(text, path, wght, size, tracking=0.0):
    """-> ([(glyph, x_px)], advance_px), kerned."""
    _, upem, cmap, hmtx, _, kern = load(path, wght)
    s = size / upem
    out, x, prev = [], 0.0, None
    for ch in text:
        gn = cmap.get(ord(ch))
        if gn is None:
            raise SystemExit("font has no glyph for %r (U+%04X)" % (ch, ord(ch)))
        if prev is not None:
            x += kern.get((prev, gn), 0) * s
        out.append((gn, x))
        x += hmtx[gn][0] * s + tracking * size
        prev = gn
    return out, (x - tracking * size if out else 0.0)


def outline(text, path, wght, size, x0, baseline, tracking=0.0):
    """-> (path data, advance). Transform is baked in, so a run is one <path>."""
    _, upem, _, _, gs, _ = load(path, wght)
    placed, adv = shape(text, path, wght, size, tracking)
    s = size / upem
    pen = SVGPathPen(gs, ntos=fmt2)
    for gn, dx in placed:
        gs[gn].draw(TransformPen(pen, (s, 0, 0, -s, x0 + dx, baseline)))
    return pen.getCommands(), adv


def ink_extent(labels, path, wght, size):
    """Union ink range of `labels` in px above/below baseline (y-up)."""
    from fontTools.pens.boundsPen import BoundsPen
    _, upem, cmap, _, gs, _ = load(path, wght)
    lo = hi = None
    for ch in set("".join(labels)):
        bp = BoundsPen(gs)
        gs[cmap[ord(ch)]].draw(bp)
        if bp.bounds is None:
            continue
        _, y0, _, y1 = bp.bounds
        lo = y0 if lo is None else min(lo, y0)
        hi = y1 if hi is None else max(hi, y1)
    return lo * size / upem, hi * size / upem


def stem_width(path, wght, size):
    """Stem weight, measured off 'l'. NOT off 'I' — Noto Sans's cap I is
    serifed, so it measures ~2.2x too wide and the arrow comes out far too
    heavy."""
    from fontTools.pens.boundsPen import BoundsPen
    _, upem, cmap, _, gs, _ = load(path, wght)
    bp = BoundsPen(gs)
    gs[cmap[ord("l")]].draw(bp)
    return (bp.bounds[2] - bp.bounds[0]) * size / upem


def _fmt(v, nd):
    if isinstance(v, str):
        return v
    r = round(float(v), nd)
    return str(int(r)) if r == int(r) else (("%." + str(nd) + "f") % r).rstrip("0").rstrip(".")


def fmt(v):
    """Layout numbers."""
    return _fmt(v, 3)


def fmt2(v):
    """Glyph coordinates; 2dp is ~0.01px, far below a rendered pixel."""
    return _fmt(v, 2)


# ---------------------------------------------------------------- compose
def build(theme, logo, head_size=None, left=None):
    head_size = head_size or HEAD_SIZE
    t = THEMES[theme]
    accent = logo["stops"][t["accent_stop"]]
    gid = lambda n: "vc-%s-%s" % (n, theme)   # scoped: the pair never collides
    o = []

    # ---- left column: mark stacked over wordmark (classic lockup)
    mx0, my0, mw, mh = logo["mark_box"]
    wx0, wy0, ww, wh = logo["word_box"]
    ms = MARK_H / mh                                  # scale by visible ink
    mark_w = mw * ms
    word_w = round(mark_w * WORD_W_RATIO)
    ws = word_w / ww
    word_h = wh * ws
    col_w = max(mark_w, word_w)
    col_h = MARK_H + MARK_WORD_GAP + word_h
    col_x = (left if left is not None else 64)
    col_y = (H - col_h) / 2

    # ---- vertical rhythm of the copy block, centred as one unit
    f, upem = load(NOTO, HEAD_WGHT)[0], load(NOTO, HEAD_WGHT)[1]
    cap, xh = f["OS/2"].sCapHeight / upem, f["OS/2"].sxHeight / upem
    head_cap = cap * head_size
    block = head_cap + GAP_ELEM + CHIP_H
    top = (H - block) / 2
    head_base = round(top + head_cap)
    chip_top = round(head_base + GAP_ELEM)

    # ---- horizontal: column | hairline rule | copy, 48 either side of the rule
    rule_x = round(col_x + col_w + GAP_SECTION)
    text_x = rule_x + GAP_SECTION

    # ---- headline: "Idea" + the accent arrow + "production SaaS"
    a_d, a_adv = outline(HEAD_A, NOTO, HEAD_WGHT, head_size, text_x, head_base, HEAD_TRACK)
    arrow_pad = round(0.30 * head_size)
    arrow_x = text_x + a_adv + arrow_pad
    arrow_len, arrow_head = round(0.71875 * head_size, 2), round(0.1875 * head_size, 2)
    arrow_y = head_base - xh * head_size / 2          # optical centre of lowercase
    sw = round(stem_width(NOTO, HEAD_WGHT, head_size) * 0.92, 2)  # strokes read heavier than stems
    b_x = arrow_x + arrow_len + arrow_pad
    b_d, b_adv = outline(HEAD_B, NOTO, HEAD_WGHT, head_size, b_x, head_base, HEAD_TRACK)
    head_right = b_x + b_adv

    # ---- chips: one shared baseline, centred on the whole row's ink
    chips, cx = [], text_x
    for label in CHIPS:
        _, tw = shape(label, JBM, CHIP_WGHT, CHIP_SIZE, CHIP_TRACK)
        cw = round(tw + 2 * CHIP_PAD)
        chips.append((cx, cw, label, tw))
        cx += cw + GAP_GROUP
    chip_right = cx - GAP_GROUP
    ilo, ihi = ink_extent(CHIPS, JBM, CHIP_WGHT, CHIP_SIZE)
    chip_base = round(chip_top + CHIP_H / 2 + (ihi + ilo) / 2, 2)

    # ---------------------------------------------------------------- emit
    o.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
             'viewBox="0 0 %d %d" fill="none" role="img" aria-label="%s">'
             % (W, H, W, H, ALT))
    o.append("<!-- Vibecarbon hero banner (%s theme). GENERATED by "
             "scripts/banner-generator.py - do not hand-edit.\n"
             "     Text is outlined, so copy changes must go through that script.\n"
             "     Mark, wordmark and gradient are emitted verbatim from\n"
             "     carbon/src/client/assets/logo-light.svg. -->" % theme)

    o.append("<defs>")
    o.append('<linearGradient id="%s" gradientUnits="userSpaceOnUse" x1="0" y1="%s" '
             'x2="0" y2="%s"><stop stop-color="%s"/><stop offset="1" stop-color="%s"/>'
             "</linearGradient>"
             % (gid("mark"), logo["grad_y"][0], logo["grad_y"][1],
                logo["stops"][0], logo["stops"][1]))
    # canvas wash, mirroring the app's radial-gradient(120% 80% at 75% -20%)
    o.append('<radialGradient id="%s" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" '
             'gradientTransform="translate(%s %s) scale(%s %s)">'
             '<stop offset="0" stop-color="%s" stop-opacity="%s"/>'
             '<stop offset="0.55" stop-color="%s" stop-opacity="0"/></radialGradient>'
             % (gid("wash"), fmt(W * 0.75), fmt(-H * 0.20), fmt(W * 1.2), fmt(H * 0.8),
                accent, t["wash_op"], accent))
    o.append('<clipPath id="%s"><rect width="%d" height="%d" rx="%d"/></clipPath>'
             % (gid("panel"), W, H, PANEL_R))
    o.append("</defs>")

    o.append('<g clip-path="url(#%s)">' % gid("panel"))
    o.append('<rect width="%d" height="%d" fill="%s"/>' % (W, H, t["base"]))
    o.append('<rect width="%d" height="%d" fill="url(#%s)"/>' % (W, H, gid("wash")))
    o.append("</g>")
    o.append('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" stroke="%s" '
             'stroke-opacity="%s" stroke-width="%s" fill="none"/>'
             % (fmt(HAIRLINE / 2), fmt(HAIRLINE / 2), fmt(W - HAIRLINE),
                fmt(H - HAIRLINE), fmt(PANEL_R - HAIRLINE / 2), t["line"],
                t["line_op"], fmt(HAIRLINE)))

    # mark, centred over the wordmark
    o.append('<g transform="translate(%s %s) scale(%s)">'
             % (fmt(col_x + (col_w - mark_w) / 2 - mx0 * ms), fmt(col_y - my0 * ms), fmt(ms)))
    o.append('<path d="%s" fill="url(#%s)"/>' % (logo["mark_d"], gid("mark")))
    o.append("</g>")

    # wordmark, in the banner's foreground ink so it matches the headline
    o.append('<g transform="translate(%s %s) scale(%s)" fill="%s">'
             % (fmt(col_x + (col_w - word_w) / 2 - wx0 * ws),
                fmt(col_y + MARK_H + MARK_WORD_GAP - wy0 * ws), fmt(ws), t["fg"]))
    for d in logo["word_ds"]:
        o.append('<path d="%s"/>' % d)
    o.append("</g>")

    # the rule bounds the identity column, so the wordmark never hangs past it
    o.append('<path d="M%s %sV%s" stroke="%s" stroke-opacity="%s" stroke-width="%s"/>'
             % (fmt(rule_x), fmt(col_y), fmt(col_y + col_h),
                t["line"], t["line_op"], fmt(HAIRLINE)))

    o.append('<path fill="%s" d="%s%s"/>' % (t["fg"], a_d, b_d))
    o.append('<path d="M%s %sH%s M%s %sL%s %sL%s %s" stroke="%s" stroke-width="%s" '
             'stroke-linecap="butt" stroke-linejoin="miter"/>'
             % (fmt(arrow_x), fmt(arrow_y), fmt(arrow_x + arrow_len),
                fmt(arrow_x + arrow_len - arrow_head), fmt(arrow_y - arrow_head),
                fmt(arrow_x + arrow_len), fmt(arrow_y),
                fmt(arrow_x + arrow_len - arrow_head), fmt(arrow_y + arrow_head),
                accent, fmt(sw)))
    for cx0, cw, _, _ in chips:
        o.append('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" stroke="%s" '
                 'stroke-opacity="%s" stroke-width="%s" fill="none"/>'
                 % (fmt(cx0 + HAIRLINE / 2), fmt(chip_top + HAIRLINE / 2),
                    fmt(cw - HAIRLINE), fmt(CHIP_H - HAIRLINE),
                    fmt(CHIP_R - HAIRLINE / 2), t["line"], t["line_op"], fmt(HAIRLINE)))
    chip_d = ""
    for cx0, cw, label, tw in chips:
        d, _ = outline(label, JBM, CHIP_WGHT, CHIP_SIZE,
                       cx0 + (cw - tw) / 2, chip_base, CHIP_TRACK)
        chip_d += d
    o.append('<path fill="%s" d="%s"/>' % (t["muted"], chip_d))
    o.append("</svg>")

    m = dict(col=(col_x, col_x + col_w), col_y=(col_y, col_y + col_h), rule=rule_x,
             text_x=text_x, mark_w=mark_w, word_w=word_w, word_h=word_h,
             head_right=head_right, chip_right=chip_right,
             head_base=head_base, chip_top=chip_top, stroke=sw)
    return "\n".join(o) + "\n", m


def render(theme, logo, head_size=None):
    """Two passes: measure the content, then re-lay it out horizontally centred."""
    _, m = build(theme, logo, head_size)
    content = max(m["head_right"], m["chip_right"], m["col"][1]) - 64
    return build(theme, logo, head_size, left=round((W - content) / 2))


if __name__ == "__main__":
    head = float(sys.argv[1]) if len(sys.argv) > 1 else None
    outdir = Path(sys.argv[2]) if len(sys.argv) > 2 else OUT
    outdir.mkdir(parents=True, exist_ok=True)
    logo = read_logo()
    for theme in ("light", "dark"):
        svg, m = render(theme, logo, head)
        p = outdir / ("banner-%s.svg" % theme)
        p.write_text(svg)
        print("%-6s %6d bytes  %s" % (theme, len(svg), p))
    print()
    for k, v in m.items():
        print("  %-11s %s" % (k, v))
    print("  margins: left %.1f | right: head %.1f  chips %.1f"
          % (m["col"][0], W - m["head_right"], W - m["chip_right"]))
