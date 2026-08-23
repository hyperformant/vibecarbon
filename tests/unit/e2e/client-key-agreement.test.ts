import { describe, expect, it } from 'vitest';
import {
  evaluateKeyAgreement,
  extractAssetUrls,
  extractSupabaseJwts,
} from '../../e2e/checks/client-key-agreement.js';

/**
 * The client-key-agreement check closes the blindspot that let vibecarbon.com
 * 2026-08-22 ship broken browser auth with an all-green e2e run: every auth
 * check passed the harness's own (server-side) anon key, so nobody ever
 * asserted what key the SERVED BUNDLE bakes. These tests pin the pure logic:
 * asset discovery, JWT extraction, and the verdict matrix.
 */

const JWT_A = `eyJ${'a'.repeat(30)}.eyJpc3MiOiJzdXBhYmFzZSJ9.${'x'.repeat(30)}`;
const JWT_B = `eyJ${'b'.repeat(30)}.eyJpc3MiOiJzdXBhYmFzZSJ9.${'y'.repeat(30)}`;

describe('extractAssetUrls', () => {
  it('finds script src and modulepreload href asset paths', () => {
    const html = [
      '<script type="module" crossorigin src="/assets/index-D1pg7kGi.js"></script>',
      '<link rel="modulepreload" crossorigin href="/assets/supabase-lsoa_38C.js">',
      '<link rel="stylesheet" href="/assets/index-C00l.css">',
    ].join('\n');
    expect(extractAssetUrls(html)).toEqual([
      '/assets/index-D1pg7kGi.js',
      '/assets/supabase-lsoa_38C.js',
    ]);
  });

  it('deduplicates repeated asset references', () => {
    const html =
      '<script src="/assets/a-1.js"></script><link rel="modulepreload" href="/assets/a-1.js">';
    expect(extractAssetUrls(html)).toEqual(['/assets/a-1.js']);
  });

  it('returns an empty list for HTML without JS assets', () => {
    expect(extractAssetUrls('<html><body>hi</body></html>')).toEqual([]);
  });
});

describe('extractSupabaseJwts', () => {
  it('finds a JWT-shaped token inlined in a JS bundle', () => {
    const js = `const k="${JWT_A}";export{k};`;
    expect(extractSupabaseJwts(js)).toEqual([JWT_A]);
  });

  it('deduplicates the same token appearing twice', () => {
    const js = `a="${JWT_A}";b="${JWT_A}"`;
    expect(extractSupabaseJwts(js)).toEqual([JWT_A]);
  });

  it('ignores short eyJ-prefixed strings that are not JWTs', () => {
    expect(extractSupabaseJwts('x="eyJhbGciOi"')).toEqual([]);
  });
});

describe('evaluateKeyAgreement', () => {
  it('passes when the only baked JWT equals the expected anon key', () => {
    const v = evaluateKeyAgreement([JWT_A], JWT_A);
    expect(v.status).toBe('pass');
  });

  it('fails when a baked JWT differs from the expected anon key', () => {
    const v = evaluateKeyAgreement([JWT_B], JWT_A);
    expect(v.status).toBe('fail');
    // Never leak whole tokens into logs — prefixes only.
    expect(v.errorMessage).not.toContain(JWT_B);
    expect(v.errorMessage).toContain(JWT_B.slice(0, 12));
  });

  it('fails when both a matching and a stale JWT are baked', () => {
    const v = evaluateKeyAgreement([JWT_A, JWT_B], JWT_A);
    expect(v.status).toBe('fail');
  });

  it('fails loudly when no JWT is baked at all (SPA cannot auth)', () => {
    const v = evaluateKeyAgreement([], JWT_A);
    expect(v.status).toBe('fail');
    expect(v.errorMessage).toMatch(/no.*jwt/i);
  });
});
