/**
 * The shared compose network partitions its /24: dynamic allocation lives in
 * the upper /25 (`ip_range: ….128/25`), static `ipv4_address` pins live below
 * .128. Docker's IPAM does NOT reserve statically-pinned addresses against
 * dynamic allocation — without the partition, any recreate wave that releases
 * and re-allocates addresses can hand a pinned address to a dynamic sibling,
 * after which the pin's owner fails "Address already in use" on every
 * subsequent up.
 *
 * Observed 2026-08-06 (d1 warm deploys, twice): the warm recreate wave gave
 * `rest` the observability overlay's Traefik pin (.10); Traefik was left in
 * `Created` and the site stayed down until teardown. Verified empirically on
 * docker 29.7.2 / compose 5.4.0: with ip_range set, a static .10 coexists
 * while dynamics allocate from .129 upward.
 *
 * Pinned here:
 *  - the base network carries BOTH the subnet and the .128/25 ip_range,
 *    derived from the same DEV_SUBNET_PREFIX variable;
 *  - every ipv4_address pin in every template compose file resolves to a
 *    final octet BELOW 128 (i.e., outside the dynamic pool).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Every template compose file that can reach a deployed server. */
function templateComposeFiles(): string[] {
  const files: string[] = [];
  for (const f of readdirSync(join(REPO_ROOT, 'carbon'))) {
    if (/^docker-compose.*\.yml$/.test(f)) files.push(join(REPO_ROOT, 'carbon', f));
  }
  const servicesDir = join(REPO_ROOT, 'services');
  for (const svc of readdirSync(servicesDir)) {
    const composeDir = join(servicesDir, svc, 'compose');
    let entries: string[];
    try {
      entries = readdirSync(composeDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith('.yml') && statSync(join(composeDir, f)).isFile()) {
        files.push(join(composeDir, f));
      }
    }
  }
  return files;
}

describe('compose network IP partition', () => {
  it('base network defines subnet + .128/25 dynamic ip_range from DEV_SUBNET_PREFIX', () => {
    const base = readFileSync(join(REPO_ROOT, 'carbon', 'docker-compose.yml'), 'utf-8');
    expect(base).toMatch(/subnet:\s*\$\{DEV_SUBNET_PREFIX:-172\.30\.0\}\.0\/24/);
    expect(base).toMatch(/ip_range:\s*\$\{DEV_SUBNET_PREFIX:-172\.30\.0\}\.128\/25/);
  });

  it('every ipv4_address pin in template compose files sits below .128 (outside the dynamic pool)', () => {
    const pins: Array<{ file: string; octet: number }> = [];
    for (const file of templateComposeFiles()) {
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/^\s*ipv4_address:\s*(\S+)/gm)) {
        // Both accepted spellings resolve to a literal final octet:
        //   ${DEV_SUBNET_PREFIX:-172.30.0}.10   or   172.30.0.10
        const octetMatch = /\.(\d{1,3})\s*$/.exec(m[1]);
        expect(octetMatch, `${file}: unparseable ipv4_address ${m[1]}`).not.toBeNull();
        pins.push({ file, octet: Number(octetMatch?.[1]) });
      }
    }
    // The Traefik H-9 pin must exist — if this list is empty the grep above
    // has drifted from the template layout, not the pins from the pool.
    expect(pins.length).toBeGreaterThan(0);
    for (const { file, octet } of pins) {
      expect(octet, `${file}: pin .${octet} is inside the dynamic ip_range (.128/25)`).toBeLessThan(
        128,
      );
    }
  });
});
