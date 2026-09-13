/**
 * The distributed package must contain NO local escape hatch around
 * Ed25519 signature verification.
 *
 * The npm tarball is this source tree verbatim (`files: [src, carbon,
 * services]`, `bin -> ./src/cli.js`) — there is no build step to strip a
 * debug branch out. So anything that short-circuits validateLicenseKey in
 * the working tree ships to every customer, and `VIBECARBON_DEV_LICENSE=true`
 * was exactly that: a documented, one-env-var grant of Fullerene to anyone
 * who read validator.js. Test harnesses now activate a genuine signed key
 * (VIBECARBON_TEST_LICENSE_KEY) instead, which is also the path a customer
 * walks.
 *
 * Two guards, deliberately different in kind: the behavioural one proves the
 * env lever is dead at runtime, the census one proves no *new* switch was
 * added next to it. A source-text census is the only thing that can catch a
 * compile-time constant like the former LICENSING_DISABLED, which has no
 * runtime lever to pull.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const LICENSING_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/lib/licensing',
);

/**
 * Source with comments removed, so the census reads CODE and not prose.
 * Without this the guard would forbid naming the removed switches even to
 * explain why they are gone — and the explanation is the part that stops
 * someone re-adding them.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** A key that parses cleanly but carries a signature no private key produced. */
const UNSIGNED_KEY = `vc-f-a1b2c3d4-${'0'.repeat(128)}`;

/**
 * Matches both `process.env.FOO` and a `FOO` read off any bare `env`
 * identifier — the latter catches a function parameter defaulted to
 * `process.env` (e.g. `{ env = process.env } = {}`) and then read as
 * `env.FOO`, which `process\.env\.` alone would miss entirely.
 */
const ENV_READ_RE = /\b(?:process\.env|env)\.([A-Z0-9_]+)/g;

/**
 * The one env read this directory is allowed: refresh.js's
 * `env.VIBECARBON_API_BASE`, which only redirects which host the refresh
 * request goes to. It changes no entitlement input — never the key, the
 * tier, the projectId, or the paidThrough date read back from the
 * response — so it is not an escape hatch.
 */
const ALLOWED_ENV_READS = new Set(['VIBECARBON_API_BASE']);

describe('no local bypass of signature verification', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rejects an unsigned key even with VIBECARBON_DEV_LICENSE=true', async () => {
    // Set before import: the old bypass read process.env at module load, so
    // a stub applied afterwards would prove nothing.
    vi.stubEnv('VIBECARBON_DEV_LICENSE', 'true');
    vi.resetModules();

    const { validateLicenseKey } = await import('../../../src/lib/licensing/validator.js');

    expect(validateLicenseKey(UNSIGNED_KEY).valid).toBe(false);
  });

  it('rejects an unsigned key under every LICENSE-shaped env var', async () => {
    // Guards the "renamed the variable" regression, not just the old spelling.
    for (const name of ['VIBECARBON_DEV_LICENSE', 'VIBECARBON_LICENSE_DISABLED', 'DEV_LICENSE']) {
      vi.stubEnv(name, 'true');
    }
    vi.resetModules();

    const { validateLicenseKey } = await import('../../../src/lib/licensing/validator.js');

    expect(validateLicenseKey(UNSIGNED_KEY).valid).toBe(false);
  });

  it('no module under src/lib/licensing/ reads a LICENSE-shaped env var', () => {
    const offenders: string[] = [];

    for (const file of readdirSync(LICENSING_DIR).filter((f) => f.endsWith('.js'))) {
      const source = codeOnly(readFileSync(join(LICENSING_DIR, file), 'utf-8'));
      for (const match of source.matchAll(ENV_READ_RE)) {
        if (/LICENSE|LICENC/i.test(match[1])) offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no module under src/lib/licensing/ reads a RELEASE/DATE-shaped env var', () => {
    // release-date.js compares the CLI's own release date against a
    // license's paid-through date — an env var here would be exactly the
    // kind of one-variable bypass this file already guards against for
    // license keys (e.g. a fake stamp granting extra runway past expiry).
    // Its inputs are injectable function options, never environment.
    const offenders: string[] = [];

    for (const file of readdirSync(LICENSING_DIR).filter((f) => f.endsWith('.js'))) {
      const source = codeOnly(readFileSync(join(LICENSING_DIR, file), 'utf-8'));
      for (const match of source.matchAll(ENV_READ_RE)) {
        if (/RELEASE|DATE/i.test(match[1])) offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no module under src/lib/licensing/ reads an env var outside the explicit allowlist', () => {
    // The general form of the two checks above: ANY environment read in this
    // directory is a candidate escape hatch, not just one shaped like
    // LICENSE or RELEASE/DATE. Every name found here must be justified in
    // ALLOWED_ENV_READS above, with a comment explaining why it cannot
    // change entitlement.
    const offenders: string[] = [];

    for (const file of readdirSync(LICENSING_DIR).filter((f) => f.endsWith('.js'))) {
      const source = codeOnly(readFileSync(join(LICENSING_DIR, file), 'utf-8'));
      for (const match of source.matchAll(ENV_READ_RE)) {
        if (!ALLOWED_ENV_READS.has(match[1])) offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no module-level kill switch survives in src/lib/licensing/', () => {
    // LICENSING_DISABLED was a `const ... = false` that returned a valid
    // Fullerene result before parsing ever ran — one character from granting
    // the product away, and invisible to any runtime test.
    const offenders: string[] = [];

    for (const file of readdirSync(LICENSING_DIR).filter((f) => f.endsWith('.js'))) {
      const source = codeOnly(readFileSync(join(LICENSING_DIR, file), 'utf-8'));
      for (const ident of ['LICENSING_DISABLED', 'licensingDisabled', 'DEV_MODE', 'devMode']) {
        if (source.includes(ident)) offenders.push(`${file}: ${ident}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
