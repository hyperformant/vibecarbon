import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Failover-record TTL census (mitigation-audit cluster 6, 2026-08-16).
 *
 * The customer-visible failover tail is bounded by the record TTL — the
 * measured RTO in docs/rto-rpo.md leans on "the 60s record TTL". The audit
 * found the DNS cluster's fix history was budget-guessing around windows
 * (the verify-failover gate was added and its budget raised past the TTL the
 * SAME DAY, 2026-07-09) until condition-probing landed; the surviving
 * time-shaped dependency is the TTL itself, declared per provider DNS module.
 *
 * This census keeps that dependency honest in both directions: every provider
 * DNS module that declares HA_TTL keeps it at or below 60s, and the SET of
 * declaring modules is pinned so a new provider cannot ship failover records
 * with a default (often 3600s) TTL that silently multiplies the RTO by 60.
 *
 * Cloudflare is the documented exception: it creates proxied records with
 * `ttl: 1` (= auto) — flips propagate at the edge, not via resolver caches,
 * so a numeric HA_TTL would be meaningless there.
 */

const DNS_DIR = join(process.cwd(), 'src', 'lib');

// `*-dns.js` matches exactly the six provider record-writers; the shared
// helpers (dns-propagation.js, dns-provider.js) don't carry the suffix.
const dnsModules = () =>
  readdirSync(DNS_DIR)
    .filter((f) => f.endsWith('-dns.js'))
    .sort();

describe('failover-record TTL census', () => {
  it('every provider DNS module either declares HA_TTL <= 60 or is the proxied exception', () => {
    const declaring: string[] = [];
    for (const file of dnsModules()) {
      const src = readFileSync(join(DNS_DIR, file), 'utf-8');
      const m = src.match(/const HA_TTL = (\d+);/);
      if (m) {
        declaring.push(file);
        expect(
          Number(m[1]),
          `${file}: HA_TTL must stay <= 60s — it bounds the failover RTO`,
        ).toBeLessThanOrEqual(60);
      } else {
        expect(
          file,
          `${file} declares no HA_TTL — only cloudflare-dns.js (proxied, ttl:1=auto) may omit it; ` +
            'a new provider without it ships failover records at the provider default TTL, ' +
            'silently multiplying the measured RTO',
        ).toBe('cloudflare-dns.js');
        expect(src).toContain('ttl = 1');
      }
    }
    // Both directions: the declaring set itself is pinned, so a module being
    // renamed/added/dropped surfaces here instead of drifting.
    expect(declaring.sort()).toEqual([
      'digitalocean-dns.js',
      'hetzner-dns.js',
      'linode-dns.js',
      'scaleway-dns.js',
      'vultr-dns.js',
    ]);
  });

  it('the census walks real modules (not vacuously green)', () => {
    expect(dnsModules().length).toBeGreaterThanOrEqual(6);
  });
});
