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
 * The one env read this directory is allowed: check.js's
 * `env.VIBECARBON_API_BASE`, which only redirects which host the license
 * check is posted to. It changes no entitlement input: every field the
 * decision table reads comes out of verifyVerdictToken(), so pointing the
 * request somewhere else yields an answer that does not verify, never a
 * better verdict.
 */
const ALLOWED_ENV_READS = new Set(['VIBECARBON_API_BASE']);

/**
 * Any construction of a Date, or a read of `Date.now()`. Widened from the
 * original `new Date()`-only (empty parens) match: `new Date(someMs)` reads
 * the wall clock exactly as much as `new Date()` does when `someMs` traces
 * back to an uncontrolled source, so a narrower regex would miss that
 * variant of the same bypass entirely.
 */
const CLOCK_READ_RE = /\bDate\.now\s*\(|\bnew Date\s*\(/g;

/**
 * The clock reads this directory may hold, and why each is safe:
 *   - check.js (1): stamps `checkedAt` into the verdict cache. Display only,
 *     nothing reads it back, and a cached verdict is trusted solely because
 *     its token verifies.
 *   - index.js (2): todayUtc() supplies the DEFAULT `now` the deploy gate
 *     compares against a SERVER-SIGNED periodEnd, plus the `activatedAt`
 *     stamp activateLicense writes into the stored file. Moving the machine
 *     clock can only end a grace period sooner or later; it can never
 *     manufacture a subscription, because `now` is never consulted without
 *     a verified verdict, and `activatedAt` feeds no decision.
 *   - entitlement.js (1): utcMsToYmd()'s `new Date(ms)` formats an ALREADY-
 *     COMPUTED epoch millisecond value (from ymdToUtcMs() arithmetic over a
 *     verified periodEnd) back into 'YYYY-MM-DD'. It never reads the machine
 *     clock; `ms` never comes from `Date.now()` anywhere in this file.
 *   - validator.js (1): isRealCalendarDate()'s `new Date(Date.UTC(year,
 *     month - 1, day))` builds a Date purely to reject an impossible
 *     calendar date (e.g. Feb 30) parsed OUT of a token/key string. `year`,
 *     `month`, `day` are parsed input, never the machine clock.
 */
const ALLOWED_CLOCK_READS: Record<string, number> = {
  'check.js': 1,
  'index.js': 2,
  'entitlement.js': 1,
  'validator.js': 1,
};

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

  it('no module under src/lib/licensing/ reads the clock outside the allowlist', () => {
    // The wall clock is the one input an operator fully controls. Every
    // entitlement decision is anchored to a server-signed periodEnd, so the
    // clock may only ever be the `now` compared against it. A stray
    // Date.now() inside the decision table would be the date-shaped
    // equivalent of the env-var bypass this file already forbids.
    const offenders: string[] = [];

    for (const file of readdirSync(LICENSING_DIR).filter((f) => f.endsWith('.js'))) {
      const source = codeOnly(readFileSync(join(LICENSING_DIR, file), 'utf-8'));
      const reads = [...source.matchAll(CLOCK_READ_RE)].length;
      const allowed = ALLOWED_CLOCK_READS[file] ?? 0;
      if (reads > allowed) offenders.push(`${file}: ${reads} clock reads, ${allowed} allowed`);
    }

    expect(offenders).toEqual([]);
  });

  it('entitlement.js, the decision table, holds exactly one clock-shaped call, and it is new Date(ms), never the wall clock', () => {
    // Not a literal zero: utcMsToYmd()'s `new Date(ms)` formats an already-
    // computed epoch value, never the machine clock (see
    // ALLOWED_CLOCK_READS's comment above). The budget check above only
    // pins a COUNT (1), which a wall-clock `new Date()` swapped in for
    // `new Date(ms)` would satisfy just as well, unseen. Pin the actual
    // call text instead: the one allowed match must be `new Date(ms)`
    // specifically, and removing exactly that text must leave zero
    // remaining CLOCK_READ_RE matches, so a second, real clock read
    // anywhere else in the file cannot hide behind the same budget slot.
    const source = codeOnly(readFileSync(join(LICENSING_DIR, 'entitlement.js'), 'utf-8'));
    const ALLOWED_CALL_RE = /\bnew Date\s*\(\s*ms\s*\)/g;

    expect([...source.matchAll(ALLOWED_CALL_RE)].map((m) => m[0])).toEqual(['new Date(ms)']);

    const withAllowedCallRemoved = source.replace(ALLOWED_CALL_RE, '');
    expect([...withAllowedCallRemoved.matchAll(CLOCK_READ_RE)].map((m) => m[0])).toEqual([]);
  });

  it('no module under src/lib/licensing/ reads an env var outside the explicit allowlist', () => {
    // The general form of the LICENSE check above: ANY environment read in
    // this directory is a candidate escape hatch, not just one shaped like
    // LICENSE. Every name found here must be justified in
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
