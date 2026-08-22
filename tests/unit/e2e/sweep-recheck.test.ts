import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain JS ops script, no types
import { CLOUD_KINDS, delWithRetry } from '../../../scripts/sweep-hetzner.js';

describe('delWithRetry', () => {
  it('returns true without retrying when the first DELETE succeeds', async () => {
    let calls = 0;
    const ok = await delWithRetry('floating_ips', 1, {
      delayMs: 0,
      doDelete: async () => {
        calls += 1;
        return true;
      },
    });
    expect(ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('retries a transiently-locked resource until the DELETE succeeds', async () => {
    // The RCA case: a floating IP is action-locked (HTTP 423) while its
    // server's deletion is still unassigning it; the lock clears shortly.
    let calls = 0;
    const ok = await delWithRetry('floating_ips', 1, {
      delayMs: 0,
      doDelete: async () => {
        calls += 1;
        return calls >= 3;
      },
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('returns false after exhausting all attempts', async () => {
    let calls = 0;
    const ok = await delWithRetry('floating_ips', 1, {
      attempts: 4,
      delayMs: 0,
      doDelete: async () => {
        calls += 1;
        return false;
      },
    });
    expect(ok).toBe(false);
    expect(calls).toBe(4);
  });
});

describe('sweep recheck coverage', () => {
  // The sweep's final recheck iterates CLOUD_KINDS; preflight's
  // hetzner-clean iterates its own endpoint table. If preflight ever scans
  // a kind the sweep does not clean and re-verify, a leak of that kind
  // wedges every subsequent matrix run: sweep exits 0, preflight aborts
  // (exactly how the 2026-07-16 floating-IP leak played out — deletes
  // FAILED, recheck only covered servers). Pin sweep ⊇ preflight.
  it('CLOUD_KINDS covers every resource kind preflight scans', () => {
    const preflightSrc = readFileSync(join(__dirname, '../../e2e/utils/preflight.ts'), 'utf-8');
    // Scoped to `checkHetznerProjectClean` specifically — `sweep-hetzner.js`
    // only ever cleans Hetzner resources, so this invariant only makes
    // sense against Hetzner's endpoint table. `checkDigitalOceanProjectClean`
    // (added alongside the d1/d2 e2e reference scenarios) has its own
    // endpoint table with no corresponding sweep script yet — that's a
    // real, tracked gap (DO scenarios are opt-in/non-release-gating and
    // don't run for real until Phase B), not something this invariant
    // should silently swallow or falsely flag.
    const hetznerFnMatch = preflightSrc.match(
      /async function checkHetznerProjectClean[\s\S]*?\n}\n/,
    );
    expect(hetznerFnMatch, 'checkHetznerProjectClean not found in preflight.ts').toBeTruthy();
    const preflightKinds = [
      ...(hetznerFnMatch as RegExpMatchArray)[0].matchAll(/url: '([a-z_]+)\?per_page=\d+'/g),
    ].map((m) => m[1]);
    expect(preflightKinds.length).toBeGreaterThanOrEqual(7); // servers … volumes today
    const sweepKinds = new Set(CLOUD_KINDS.map(([type]: [string]) => type));
    for (const kind of preflightKinds) {
      expect(sweepKinds, `preflight scans '${kind}' but the sweep does not clean it`).toContain(
        kind,
      );
    }
  });

  it('servers are swept first — they hold references to every other kind', () => {
    expect(CLOUD_KINDS[0][0]).toBe('servers');
  });
});
