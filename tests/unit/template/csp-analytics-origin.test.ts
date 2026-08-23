/**
 * `configure analytics` must actually result in working analytics.
 *
 * LIVE RCA (vibecarbon.com, 2026-08-23): the Plausible tag rendered
 * perfectly — `var d = 'vibecarbon.com'`, script injection armed — and the
 * dashboard showed 0 visitors, because the template's CSP hardcodes the
 * legacy Cloudflare Insights origins and never allows the Plausible one.
 * The browser blocked the script load (script-src) and would have blocked
 * the /api/event beacon (connect-src); every pageview silently dropped.
 * `configure analytics` sets only VITE_PLAUSIBLE_* env — nothing wired the
 * CSP, on ANY generated project.
 *
 * Contract pinned here: the CSP derives the analytics origin from the
 * CONFIGURED script URL (so plausible.io and self-hosted instances both
 * work), in BOTH script-src and connect-src, gated on the same env that
 * gates the tag injection — no analytics configured, no extra origin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_INDEX = join(process.cwd(), 'carbon', 'src', 'server', 'index.ts');

describe('template CSP ↔ analytics contract', () => {
  const src = readFileSync(SERVER_INDEX, 'utf-8');
  const cspBlock = src.slice(src.indexOf('contentSecurityPolicy'), src.indexOf('objectSrc'));

  it('derives the analytics origin from the configured script URL', () => {
    expect(src).toMatch(/VITE_PLAUSIBLE_SCRIPT_URL/);
    // Origin must be COMPUTED (self-hosted instances change it), never a
    // second hardcoded literal that drifts from the injected tag.
    expect(src).toMatch(/new URL\([^)]*VITE_PLAUSIBLE_SCRIPT_URL/);
  });

  it('adds the derived origin to script-src AND connect-src', () => {
    const scriptSrc = cspBlock.slice(cspBlock.indexOf('scriptSrc'), cspBlock.indexOf('styleSrc'));
    const connectSrc = cspBlock.slice(cspBlock.indexOf('connectSrc'), cspBlock.indexOf('fontSrc'));
    expect(scriptSrc, 'script-src must carry the analytics origin').toMatch(/plausibleOrigin/);
    expect(connectSrc, 'connect-src must carry the analytics origin').toMatch(/plausibleOrigin/);
  });

  it('gates the origin on the same env the tag injection uses', () => {
    // index.html injects when VITE_PLAUSIBLE_DOMAIN is non-empty; the CSP
    // must open exactly then, not unconditionally.
    expect(src).toMatch(/VITE_PLAUSIBLE_DOMAIN/);
  });
});
