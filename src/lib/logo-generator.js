/**
 * Logo generator — draws a project's display name as a vector wordmark (Space
 * Grotesk, single-story "a") and composes it with the bundled hex icon, so a
 * generated app ships its OWN name in the logo instead of the Vibecarbon
 * wordmark. Runs at `create` time; the output SVGs drop into the unchanged
 * Logo.tsx (which loads them as <img>), so text-to-path is required (an <img>
 * SVG can't use a webfont) and the vertical metrics are matched to the icon so
 * the caps sit on its straight right vertical side.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const FONT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'fonts',
  'SpaceGrotesk.ttf',
);

// Geometry of the bundled hex icon (logo-icon.svg), a fixed brand asset. The
// icon canvas is 1012 tall and its straight right vertical edge runs from
// y=257.63 to y=744.93 — measured from that file's path. The wordmark caps are
// mapped onto this band so, at the sidebar's `h-8 w-auto`, they sit on the
// icon's vertical side exactly like the original lockup. If the icon is ever
// replaced these must be re-measured (a rebrand step, documented in the spec).
export const ICON_CANVAS = 1012;
export const ICON_SIDE_TOP = 257.63;
export const ICON_BASELINE = 744.93;
// Gap between the icon and the wordmark in the composite lockup (icon 877 wide;
// original composite 6354 = 877 + 300 + 5177 wordmark).
export const COMPOSITE_GAP = 300;
// Max wordmark aspect (width / 1012-canvas). At `h-8` (32px) this is ≈170px
// wide, which fits the 15rem (240px) expanded sidebar beside the icon; longer
// names are uniformly scaled down to fit rather than overflow.
export const MAX_ASPECT = 5.3;

const XPAD_FRAC = 0.03;

/** Cap height of the font in font units (measured from the H glyph). */
function capHeightUnits(font) {
  const b = font.charToGlyph('H').getPath(0, 0, font.unitsPerEm).getBoundingBox();
  return b.y2 - b.y1;
}

/**
 * Render `text` to wordmark path data, normalized so the caps sit on the icon's
 * vertical side (baseline at ICON_BASELINE, cap height == the icon side span)
 * inside an ICON_CANVAS-tall canvas. Lowercase "a" is swapped for `alternateAGid`
 * (the single-story form) when provided. A name whose natural width exceeds
 * `maxAspect` is uniformly scaled down to fit.
 *
 * @param {import('opentype.js').Font} font
 * @param {string} text
 * @param {{ alternateAGid?: number|null, canvas?: number, capTop?: number, baseline?: number, maxAspect?: number }} [opts]
 * @returns {{ d: string, width: number, aspect: number, inkTop: number, inkBottom: number, scaled: boolean }}
 */
export function renderWordmark(font, text, opts = {}) {
  const {
    alternateAGid = null,
    canvas = ICON_CANVAS,
    capTop = ICON_SIDE_TOP,
    baseline = ICON_BASELINE,
    maxAspect = MAX_ASPECT,
  } = opts;
  const upm = font.unitsPerEm;
  const capFrac = capHeightUnits(font) / upm;
  const targetCap = baseline - capTop;
  let fontSize = targetCap / capFrac;

  const glyphs = [...text].map((ch) =>
    ch === 'a' && alternateAGid != null ? font.glyphs.get(alternateAGid) : font.charToGlyph(ch),
  );
  const advanceEm = glyphs.reduce((sum, g) => sum + g.advanceWidth / upm, 0);
  const widthAt = (fs) => advanceEm * fs + 2 * (fs * XPAD_FRAC);

  let scaled = false;
  if (widthAt(fontSize) / canvas > maxAspect) {
    fontSize *= (maxAspect * canvas) / widthAt(fontSize);
    scaled = true;
  }

  const xpad = fontSize * XPAD_FRAC;
  let x = xpad;
  const paths = [];
  for (const g of glyphs) {
    paths.push(g.getPath(x, baseline, fontSize));
    x += (g.advanceWidth / upm) * fontSize;
  }
  let inkTop = Infinity,
    inkBottom = -Infinity,
    x2 = -Infinity;
  for (const p of paths) {
    const b = p.getBoundingBox();
    inkTop = Math.min(inkTop, b.y1);
    inkBottom = Math.max(inkBottom, b.y2);
    x2 = Math.max(x2, b.x2);
  }
  const width = x2 + xpad;
  return {
    d: paths.map((p) => p.toPathData(2)).join(' '),
    width,
    aspect: width / canvas,
    inkTop,
    inkBottom,
    scaled,
  };
}

const INK = { dark: '#ffffff', light: '#000000' };

/** Parse the hex icon SVG for its dimensions and inner markup. */
function parseIconSvg(iconSvg) {
  const vb = iconSvg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) throw new Error('logo-icon.svg has no parseable "0 0 W H" viewBox');
  const inner = iconSvg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
  return { iconWidth: Number(vb[1]), canvas: Number(vb[2]), inner };
}

function wordmarkFile(d, width, canvas, ink) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${canvas}"><path d="${d}" fill="${ink}"/></svg>`;
}

function compositeFile(iconInner, d, wmWidth, iconWidth, canvas, ink) {
  const tx = iconWidth + COMPOSITE_GAP;
  const total = tx + wmWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total.toFixed(2)} ${canvas}"><g>${iconInner}</g><g transform="translate(${tx.toFixed(2)} 0)"><path d="${d}" fill="${ink}"/></g></svg>`;
}

/**
 * Build the four generated logo SVGs from a display name: the wordmark alone
 * (dark/light ink) and the full lockup (icon + wordmark, dark/light ink). The
 * hex icon and favicon are NOT generated — they stay the shipped mark.
 *
 * @param {{ font: import('opentype.js').Font, iconSvg: string, displayName: string }} args
 * @returns {Record<string, string>} filename -> SVG markup
 */
export function generateLogoSvgs({ font, iconSvg, displayName }) {
  const { iconWidth, canvas, inner } = parseIconSvg(iconSvg);
  const alternateAGid = resolveSingleStoryA(font);
  const wm = renderWordmark(font, displayName, { alternateAGid, canvas });
  return {
    'logo-wordmark-dark.svg': wordmarkFile(wm.d, wm.width, canvas, INK.dark),
    'logo-wordmark-light.svg': wordmarkFile(wm.d, wm.width, canvas, INK.light),
    'logo-dark.svg': compositeFile(inner, wm.d, wm.width, iconWidth, canvas, INK.dark),
    'logo-light.svg': compositeFile(inner, wm.d, wm.width, iconWidth, canvas, INK.light),
  };
}

/**
 * Generate the wordmark + lockup SVGs from `displayName` and write them into
 * `assetsDir`, reading the hex icon from `<assetsDir>/logo-icon.svg` (which is
 * left untouched, along with favicon.svg). Called at `create` time after the
 * template's assets are copied.
 *
 * @param {string} displayName
 * @param {string} assetsDir - the generated project's src/client/assets dir
 * @returns {string[]} the filenames written
 */
export function writeLogoSvgs(displayName, assetsDir) {
  const font = loadBundledFont();
  const iconSvg = readFileSync(join(assetsDir, 'logo-icon.svg'), 'utf8');
  const files = generateLogoSvgs({ font, iconSvg, displayName });
  for (const [name, svg] of Object.entries(files)) {
    writeFileSync(join(assetsDir, name), svg);
  }
  return Object.keys(files);
}

/** Load the bundled Space Grotesk font as an opentype.js Font. */
export function loadBundledFont() {
  const buf = readFileSync(FONT_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return opentype.parse(ab);
}

/** Index of `gid` within an OpenType coverage table, or -1. */
function coverageIndex(coverage, gid) {
  if (!coverage) return -1;
  if (coverage.format === 1) return coverage.glyphs.indexOf(gid);
  if (coverage.format === 2) {
    for (const r of coverage.ranges) {
      if (gid >= r.start && gid <= r.end) return r.index + (gid - r.start);
    }
  }
  return -1;
}

/**
 * The single-story "a" — Space Grotesk exposes it as stylistic set `ss01`
 * (a single substitution on the default "a"). Returns the alternate glyph
 * index, or null if the font has no such set.
 *
 * @param {import('opentype.js').Font} font
 * @returns {number|null}
 */
export function resolveSingleStoryA(font) {
  const gsub = font.tables.gsub;
  if (!gsub) return null;
  const aGid = font.charToGlyphIndex('a');
  const lookupToFeat = {};
  for (const f of gsub.features) {
    for (const li of f.feature.lookupListIndexes || []) {
      if (!lookupToFeat[li]) lookupToFeat[li] = new Set();
      lookupToFeat[li].add(f.tag);
    }
  }
  const lookups = gsub.lookups || [];
  for (let li = 0; li < lookups.length; li++) {
    const lk = lookups[li];
    if (lk.lookupType !== 1) continue; // single substitution
    if (!lookupToFeat[li]?.has('ss01')) continue;
    for (const st of lk.subtables || []) {
      const idx = coverageIndex(st.coverage, aGid);
      if (idx === -1) continue;
      return st.substFormat === 1 ? aGid + st.deltaGlyphId : st.substitute[idx];
    }
  }
  return null;
}
