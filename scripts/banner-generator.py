#!/usr/bin/env python3
"""Generate the README logo banners: docs/assets/banner-{light,dark}.svg.

Both files come from this one source; the pair differs only in the wordmark
ink below. Their geometry is byte-identical.

The banner is the Vibecarbon lockup alone — the mark stacked over the
wordmark — on a transparent background. No headline, no chips, no set type:
the mark, the wordmark and the mark's gradient are read straight out of
carbon/src/client/assets/logo-light.svg at generation time and emitted
verbatim, so the banner cannot drift from the logo. (Earlier revisions set
outlined Noto Sans copy beside the lockup; the font machinery left with the
copy — see git history if it needs to come back.)

USAGE
  python3 scripts/banner-generator.py            # -> docs/assets/

Regeneration is byte-stable: re-running with no changes reproduces both files
exactly, so this can be wired to a drift check.

AFTER EDITING, RE-VALIDATE. Reading the markup is not enough — parse both
files, grep for external references, and actually rasterise them.
"""
import math
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOGO = REPO / "carbon/src/client/assets/logo-light.svg"
OUT = REPO / "docs/assets"

# ---------------------------------------------------------------- copy
# The only string in the artwork; the graphic itself is the logo, nothing else.
ALT = ("Vibecarbon")

# ---------------------------------------------------------------- theme tokens
# Wordmark ink only — the mark's gradient is theme-invariant and comes from
# the logo file itself. Values are carbon/src/client/index.css --foreground
# converted oklch -> sRGB.
THEMES = {
    "light": dict(fg="#07101A"),   # oklch(.17 .025 250)
    "dark": dict(fg="#EEF3F4"),    # oklch(.96 .005 210)
}

# ---------------------------------------------------------------- layout
MARK_H = 176                  # mark height; the stacked wordmark shares its column
MARK_WORD_GAP = 16            # mark -> wordmark; they are one lockup
WORD_W_RATIO = 1.4            # wordmark width relative to mark width
PAD = 24                      # transparent margin around the lockup


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


def fmt(v):
    r = round(float(v), 3)
    return str(int(r)) if r == int(r) else ("%.3f" % r).rstrip("0").rstrip(".")


# ---------------------------------------------------------------- compose
def build(theme, logo):
    t = THEMES[theme]
    mx0, my0, mw, mh = logo["mark_box"]
    wx0, wy0, ww, wh = logo["word_box"]
    ms = MARK_H / mh                                  # scale by visible ink
    mark_w = mw * ms
    word_w = round(mark_w * WORD_W_RATIO)
    ws = word_w / ww
    word_h = wh * ws
    col_w = max(mark_w, word_w)
    col_h = MARK_H + MARK_WORD_GAP + word_h
    W = math.ceil(col_w + 2 * PAD)
    H = math.ceil(col_h + 2 * PAD)
    col_x = (W - col_w) / 2
    col_y = (H - col_h) / 2
    gid = "vc-mark-%s" % theme    # scoped: the pair never collides
    o = []

    o.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
             'viewBox="0 0 %d %d" fill="none" role="img" aria-label="%s">'
             % (W, H, W, H, ALT))
    o.append("<!-- Vibecarbon logo banner (%s theme). GENERATED by "
             "scripts/banner-generator.py - do not hand-edit.\n"
             "     Mark, wordmark and gradient are emitted verbatim from\n"
             "     carbon/src/client/assets/logo-light.svg. -->" % theme)

    o.append("<defs>")
    o.append('<linearGradient id="%s" gradientUnits="userSpaceOnUse" x1="0" y1="%s" '
             'x2="0" y2="%s"><stop stop-color="%s"/><stop offset="1" stop-color="%s"/>'
             "</linearGradient>"
             % (gid, logo["grad_y"][0], logo["grad_y"][1],
                logo["stops"][0], logo["stops"][1]))
    o.append("</defs>")

    # mark, centred over the wordmark
    o.append('<g transform="translate(%s %s) scale(%s)">'
             % (fmt(col_x + (col_w - mark_w) / 2 - mx0 * ms), fmt(col_y - my0 * ms), fmt(ms)))
    o.append('<path d="%s" fill="url(#%s)"/>' % (logo["mark_d"], gid))
    o.append("</g>")

    # wordmark, in the theme's foreground ink
    o.append('<g transform="translate(%s %s) scale(%s)" fill="%s">'
             % (fmt(col_x + (col_w - word_w) / 2 - wx0 * ws),
                fmt(col_y + MARK_H + MARK_WORD_GAP - wy0 * ws), fmt(ws), t["fg"]))
    for d in logo["word_ds"]:
        o.append('<path d="%s"/>' % d)
    o.append("</g>")
    o.append("</svg>")
    return "\n".join(o) + "\n", dict(W=W, H=H, mark_w=mark_w, word_w=word_w,
                                     word_h=word_h)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    logo = read_logo()
    for theme in ("light", "dark"):
        svg, m = build(theme, logo)
        p = OUT / ("banner-%s.svg" % theme)
        p.write_text(svg)
        print("%-6s %6d bytes  %dx%d  %s" % (theme, len(svg), m["W"], m["H"], p))
