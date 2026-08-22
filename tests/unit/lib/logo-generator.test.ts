import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateLogoSvgs,
  ICON_BASELINE,
  ICON_SIDE_TOP,
  loadBundledFont,
  MAX_ASPECT,
  renderWordmark,
  resolveSingleStoryA,
  writeLogoSvgs,
} from '../../../src/lib/logo-generator.js';

const ICON_SVG = readFileSync(
  join(process.cwd(), 'carbon/src/client/assets/logo-icon.svg'),
  'utf8',
);
const viewBoxWidth = (svg: string) => Number(svg.match(/viewBox="0 0 ([\d.]+) /)?.[1]);
const viewBoxHeight = (svg: string) => Number(svg.match(/viewBox="0 0 [\d.]+ ([\d.]+)"/)?.[1]);

describe('resolveSingleStoryA', () => {
  it('returns the ss01 alternate glyph for a, distinct from the default a', () => {
    const font = loadBundledFont();
    const defaultA = font.charToGlyphIndex('a');
    const alt = resolveSingleStoryA(font);
    expect(typeof alt).toBe('number');
    expect(alt).not.toBe(defaultA);
  });
});

describe('renderWordmark', () => {
  it('bakes the single-story a into the path (differs from the default a)', () => {
    const font = loadBundledFont();
    const ss01 = resolveSingleStoryA(font);
    const withAlt = renderWordmark(font, 'a', { alternateAGid: ss01 });
    const withDefault = renderWordmark(font, 'a', { alternateAGid: null });
    expect(withAlt.d).not.toBe(withDefault.d);
  });

  it('places cap height on the icon vertical side for a normal name', () => {
    const font = loadBundledFont();
    const wm = renderWordmark(font, 'HILT', {});
    expect(wm.scaled).toBe(false);
    expect(Math.abs(wm.inkTop - ICON_SIDE_TOP)).toBeLessThan(2);
    expect(Math.abs(wm.inkBottom - ICON_BASELINE)).toBeLessThan(2);
  });

  it('caps a very long name width and leaves short names unscaled', () => {
    const font = loadBundledFont();
    const short = renderWordmark(font, 'Acme', {});
    const long = renderWordmark(font, 'Northwind Analytics Platform', {});
    expect(short.scaled).toBe(false);
    expect(long.scaled).toBe(true);
    expect(long.aspect).toBeLessThanOrEqual(MAX_ASPECT + 0.05);
  });
});

describe('generateLogoSvgs', () => {
  const build = () =>
    generateLogoSvgs({ font: loadBundledFont(), iconSvg: ICON_SVG, displayName: 'CarbonApp' });

  it('produces the four logo files', () => {
    expect(Object.keys(build()).sort()).toEqual([
      'logo-dark.svg',
      'logo-light.svg',
      'logo-wordmark-dark.svg',
      'logo-wordmark-light.svg',
    ]);
  });

  it('every file is an svg on the 1012 canvas', () => {
    for (const svg of Object.values(build())) {
      expect(svg.trimStart()).toMatch(/^<svg/);
      expect(viewBoxHeight(svg)).toBe(1012);
    }
  });

  it('wordmark ink is white for the dark variant and black for the light variant', () => {
    const out = build();
    expect(out['logo-wordmark-dark.svg']).toMatch(/fill="(#ffffff|#fff|white)"/i);
    expect(out['logo-wordmark-light.svg']).toMatch(/fill="(#000000|#000|black)"/i);
  });

  it('composite prepends the icon so it is wider than the wordmark alone', () => {
    const out = build();
    expect(viewBoxWidth(out['logo-dark.svg'])).toBeGreaterThan(
      viewBoxWidth(out['logo-wordmark-dark.svg']),
    );
    expect(out['logo-dark.svg']).toContain('linearGradient');
  });
});

describe('writeLogoSvgs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-logo-'));
    writeFileSync(join(dir, 'logo-icon.svg'), ICON_SVG);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the four generated logo files into the assets dir', () => {
    writeLogoSvgs('CarbonApp', dir);
    for (const f of [
      'logo-wordmark-dark.svg',
      'logo-wordmark-light.svg',
      'logo-dark.svg',
      'logo-light.svg',
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  it('does not overwrite the hex icon', () => {
    writeLogoSvgs('CarbonApp', dir);
    expect(readFileSync(join(dir, 'logo-icon.svg'), 'utf8')).toBe(ICON_SVG);
  });
});
