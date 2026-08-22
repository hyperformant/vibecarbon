/**
 * compose-ha scale: exactly ONE arm may write apex/wildcard DNS.
 *
 * RCA 2026-08-16 (run 31970876667, compose-ha scale FAIL): both parallel
 * blue-green arms called upsertApexAndWildcard with THEIR OWN new IP.
 * Hetzner's "upsert" is list → delete → create (no PUT), so the two writers
 * interleaved into `Failed to create DNS record: RRSet(s) already
 * exist(s)`. The race predates the failure: the old sequential code's
 * last-writer-wins was documented as benign, but deploy's setupHA points
 * apex at the PRIMARY only and failover is the only legitimate repointer —
 * a standby arm writing apex→standby-IP would strand production traffic on
 * the pilot-light standby. The 409 made a latent correctness bug loud.
 *
 * Rule: the standby's replacement never touches apex DNS. The primary's
 * replacement (or the single server on non-HA compose) does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shouldUpdateApexDns } from '../../../src/scale.js';

const SCALE_SRC = readFileSync(
  join(fileURLToPath(new URL('../../..', import.meta.url)), 'src', 'scale.js'),
  'utf-8',
);

describe('shouldUpdateApexDns', () => {
  it('the standby arm never writes apex DNS', () => {
    expect(shouldUpdateApexDns({ role: 'standby' })).toBe(false);
  });

  it('the primary arm writes apex DNS', () => {
    expect(shouldUpdateApexDns({ role: 'primary' })).toBe(true);
  });

  it('a non-HA single server (no role) writes apex DNS', () => {
    expect(shouldUpdateApexDns({})).toBe(true);
  });

  it('an HA pair yields exactly one writer — the race is structurally impossible', () => {
    const arms = [{ role: 'primary' }, { role: 'standby' }];
    expect(arms.filter(shouldUpdateApexDns)).toHaveLength(1);
  });
});

describe('scaleServers wiring', () => {
  it('step 9a (updateDNS + propagation wait) is gated on shouldUpdateApexDns', () => {
    // Structural pin: the per-arm pipeline's DNS block must consult the
    // predicate — a bare `if (domain)` reintroduces the two-writer race.
    expect(SCALE_SRC).toMatch(/if\s*\(domain\s*&&\s*shouldUpdateApexDns\(server\)\)/);
    // And the perf-tagged updateDNS call lives inside that gated block
    // (within a few hundred chars of the guard).
    const guardIdx = SCALE_SRC.search(/if\s*\(domain\s*&&\s*shouldUpdateApexDns\(server\)\)/);
    const updateIdx = SCALE_SRC.indexOf("'scale.updateDNS'", guardIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(guardIdx);
    expect(updateIdx - guardIdx).toBeLessThan(600);
  });
});
