/**
 * The safety-net sweep must actually LOOK for reserved IPs.
 *
 * Reserved/floating IPs are the one resource class that bills while doing
 * nothing, and deleting the server they were attached to does NOT release
 * them — so a destroy that fails midway strands a billing address that only
 * this sweep can catch.
 *
 * All three sweeps used to hardcode:
 *
 *   floatingIps: 0, // reserved IPs are never provisioned by our <X> paths
 *
 * That comment was TRUE when written — the compose tier mints none — and went
 * FALSE the moment the k8s tier landed. linode-k8s.js mints one (its own
 * header even warns "BILLING: reserved IPs bill WHILE UNASSIGNED"), and
 * digitalocean-k8s.js did until 2026-11: DigitalOcean clusters made before
 * then still hold one until a deploy or destroy releases it, so its sweep
 * keeps looking. The ledger then reported zero meaning "we never looked", not
 * "we found none": a false-clean verdict, the same shape as the storage
 * checks that skipped for months.
 *
 * DigitalOcean and Linode attach no name or tag, so an UNASSIGNED one cannot
 * be attributed from the API. Deleting it could destroy someone's production
 * address, so it is REPORTED and the sweep marked incomplete.
 *
 * Vultr's sweep has no reserved-IP pass: no Vultr program makes one (its k8s
 * reserved IP was removed before release, 2026-11-27, and its clusters point
 * DNS at the master, as DigitalOcean's do). That holds only while both of its
 * flags say so, so the census pins the absence to them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const sweep = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../e2e/utils/sweep-${p}.ts`, import.meta.url)), 'utf8');
// Comment-ONLY lines: a naive `//` stripper eats the `//` in https:// too.
const code = (p: string) =>
  sweep(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const K8S_IP_PROVIDERS = ['digitalocean', 'linode'];

describe('reserved-IP sweep coverage', () => {
  it('no sweep still claims reserved IPs are never provisioned', () => {
    // The exact stale comment that caused this. Its return would mean the
    // counter went back to asserting a fact that is no longer true.
    for (const p of [...K8S_IP_PROVIDERS, 'vultr', 'scaleway']) {
      expect(sweep(p), `${p}: the stale never-provisioned claim is back`).not.toMatch(
        /reserved IPs are never provisioned/i,
      );
    }
  });

  it('every provider whose k8s program mints (or minted) a reserved IP actually queries for them', () => {
    for (const p of K8S_IP_PROVIDERS) {
      expect(code(p), `${p}: sweep never queries any reserved-IP endpoint`).toMatch(
        /reserved[_-]?ips|networking\/ips/i,
      );
    }
  });

  it('Vultr looks for no reserved IP only while no Vultr program makes one', () => {
    // Either flag turning true means a Vultr program mints a billing address
    // again: this fails until the sweep has a pass that reaps it.
    expect(VultrProvider.K8S_FLOATING_IP).toBe(false);
    expect(VultrProvider.COMPOSE_FLOATING_IP).toBe(false);
    expect(code('vultr')).not.toMatch(/reserved[_-]?ips/i);
    // And it says why, rather than counting a class it never looked at.
    expect(code('vultr')).not.toMatch(/\['reserved-ips', 'floatingIps'\]/);
    expect(sweep('vultr')).toMatch(/No reserved-IP pass: no Vultr program makes one/);
  });

  it('DO and Linode do NOT delete an unattributable IP, but do fail the sweep', () => {
    // Reporting without markIncomplete would be a warning nobody reads; the
    // CI step must go red so a human decides.
    for (const p of ['digitalocean', 'linode']) {
      const c = code(p);
      expect(c, `${p}: must mark the sweep incomplete`).toMatch(
        /markIncomplete\('unassigned reserved IPs present'\)/,
      );
      expect(c, `${p}: must not auto-delete an unattributable IP`).not.toMatch(
        /reserved_ips\/\$\{[^}]+\}`,\s*\{\s*method: 'DELETE'/,
      );
    }
  });

  it('Scaleway keeps its existing flexible-IP release path', () => {
    // The provider that already did this right must not regress.
    expect(code('scaleway')).toMatch(/releaseFlexibleIP/);
  });
});
