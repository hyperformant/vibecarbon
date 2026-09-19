/**
 * Pins the signing-key ingress choke point. VIBECARBON_LICENSE_PRIVATE_KEY
 * can arrive as raw PEM or as base64-of-PEM (vibecarbon-web stores the same
 * value that way), and every createPrivateKey() call must go through
 * normalizePem() so a future call site can't bypass it and silently reject
 * the base64 form. This is a grep-based walk over source text, not behavior,
 * so it catches a regression even in a call site that happens to work today.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const NORMALIZING_FILES = ['scripts/generate-license.js', 'tests/e2e/utils/license-stub.js'];

// The only files allowed to read VIBECARBON_LICENSE_PRIVATE_KEY under
// scripts/ and tests/e2e/utils/: license-stub.js and e2e-env.js consume it
// (through signingKeyOrNull / assertLicenseSigningKey), generate-license.js
// falls back to it directly in run(). Any other match here means a new call
// site is reading the raw env value without going through normalizePem.
const ALLOWED_READERS = new Set([
  'scripts/generate-license.js',
  'tests/e2e/utils/license-stub.js',
  'tests/e2e/utils/e2e-env.js',
]);

describe('every createPrivateKey() call is normalized', () => {
  for (const relPath of NORMALIZING_FILES) {
    it(`${relPath}: every createPrivateKey( argument contains normalizePem(`, () => {
      const text = readFileSync(join(ROOT, relPath), 'utf-8');
      const calls = [...text.matchAll(/createPrivateKey\(([^)]*)\)/g)];
      for (const call of calls) {
        expect(call[1], `${relPath}: ${call[0]} must route through normalizePem(...)`).toContain(
          'normalizePem(',
        );
      }
    });
  }

  it('at least one createPrivateKey( call exists to normalize (sanity: the regex above found something)', () => {
    const text = readFileSync(join(ROOT, 'scripts/generate-license.js'), 'utf-8');
    expect([...text.matchAll(/createPrivateKey\(/g)].length).toBeGreaterThan(0);
  });
});

describe('no other scripts/ or tests/e2e/utils/ file reads VIBECARBON_LICENSE_PRIVATE_KEY', () => {
  it('grep census matches exactly the allowed files', () => {
    let output = '';
    try {
      output = execFileSync(
        'grep',
        ['-rl', 'VIBECARBON_LICENSE_PRIVATE_KEY', 'scripts', 'tests/e2e/utils'],
        { cwd: ROOT, encoding: 'utf-8' },
      );
    } catch (error) {
      // grep exits 1 (not an error here) when nothing matches.
      if (error && typeof error === 'object' && 'stdout' in error) {
        output = String((error as { stdout: unknown }).stdout ?? '');
      } else {
        throw error;
      }
    }
    const matches = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort();

    expect(matches.length).toBeGreaterThan(0); // sanity: the grep actually found something
    for (const m of matches) {
      expect(
        ALLOWED_READERS,
        `unexpected file reading VIBECARBON_LICENSE_PRIVATE_KEY: ${m}`,
      ).toContain(m);
    }
    expect([...ALLOWED_READERS].sort()).toEqual(matches);
  });
});
