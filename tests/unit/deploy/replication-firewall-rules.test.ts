/**
 * Symmetric replication firewall (RCA 2026-07-05 follow-on, superseded 2026-07-06
 * by the WireGuard transport): deploy opens the WireGuard tunnel port on the
 * Hetzner firewall so the two supabase nodes' repl-gateway pods can reach each
 * other cross-cluster. buildReplicationFirewallRules is the pure rule
 * computation; deployK8sHA applies it to BOTH clusters' firewalls with the
 * peer IP swapped.
 *
 * Port moved from tcp/5433 (public-IP + TLS era) to udp/51821 (WireGuard) —
 * see src/lib/deploy/wireguard.js for why 51821 (51820 is flannel-wg's).
 *
 * B3: buildReplicationFirewallRules moved off deploy/replication.js onto
 * HetznerProvider (byte-identical body — see BaseProvider's abstract doc for
 * why: the rule-JSON shape is provider wire knowledge). This file now pins
 * the same behavior against the class method instead of a free function.
 *
 * Contract fix (finding review, 2026-07-23): the method now takes the
 * FIREWALL OBJECT (as findFirewallByName returns it), not a pre-extracted
 * rules array — openers must hold zero field knowledge about where a
 * provider's inbound rules live. Fixtures below wrap rule arrays as
 * `{ rules: [...] }`, Hetzner's flat firewall field.
 */

import { describe, expect, it } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const BASE_RULES = [
  { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'] },
  { direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0', '::/0'] },
];

const provider = new HetznerProvider('test-token');

describe('HetznerProvider.buildReplicationFirewallRules', () => {
  it('appends the udp/51821 rule scoped to the peer /32 when absent', () => {
    const updated = provider.buildReplicationFirewallRules({ rules: BASE_RULES }, '203.0.113.7');
    expect(updated).not.toBeNull();
    expect(updated).toContainEqual({
      direction: 'in',
      protocol: 'udp',
      port: '51821',
      source_ips: ['203.0.113.7/32'],
      destination_ips: [],
    });
    // Untouched rules survive.
    expect(updated).toEqual(expect.arrayContaining(BASE_RULES));
  });

  it('returns null (no update needed) when the exact rule already exists', () => {
    const withRule = [
      ...BASE_RULES,
      {
        direction: 'in',
        protocol: 'udp',
        port: '51821',
        source_ips: ['203.0.113.7/32'],
        destination_ips: [],
      },
    ];
    expect(provider.buildReplicationFirewallRules({ rules: withRule }, '203.0.113.7')).toBeNull();
  });

  it('drops the stale tcp 5433/30432 replication-era rules but PRESERVES tcp/5432', () => {
    // 5432 left the stale set when compose deploys gained a legitimate
    // operator-scoped Supavisor pooler rule on that port: the HA
    // replication-firewall reconcile runs on compose-ha too (compose/ha.js)
    // and must not eat the pooler rule. The replication-era direct-5432
    // rule this scrub once targeted never worked and predates every
    // pre-release rig still alive.
    const stale = [
      ...BASE_RULES,
      { direction: 'in', protocol: 'tcp', port: '5432', source_ips: ['198.51.100.1/32'] },
      { direction: 'in', protocol: 'tcp', port: '5433', source_ips: ['198.51.100.1/32'] },
      { direction: 'in', protocol: 'tcp', port: '30432', source_ips: ['198.51.100.1/32'] },
    ];
    const updated = provider.buildReplicationFirewallRules({ rules: stale }, '203.0.113.7');
    expect(updated?.some((r) => r.port === '5432')).toBe(true);
    expect(updated?.some((r) => r.port === '5433')).toBe(false);
    expect(updated?.some((r) => r.port === '30432')).toBe(false);
  });

  it('preserves the operator-scoped pooler rules (5432/6543) untouched', () => {
    const withPooler = [
      ...BASE_RULES,
      { direction: 'in', protocol: 'tcp', port: '5432', source_ips: ['192.0.2.1/32'] },
      { direction: 'in', protocol: 'tcp', port: '6543', source_ips: ['192.0.2.1/32'] },
    ];
    const updated = provider.buildReplicationFirewallRules({ rules: withPooler }, '203.0.113.7');
    expect(updated?.filter((r) => r.port === '5432' || r.port === '6543')).toHaveLength(2);
  });

  it('replaces a udp/51821 rule for a different (stale) peer with the current one', () => {
    const stalePeer = [
      ...BASE_RULES,
      {
        direction: 'in',
        protocol: 'udp',
        port: '51821',
        source_ips: ['198.51.100.9/32'],
        destination_ips: [],
      },
    ];
    const updated = provider.buildReplicationFirewallRules({ rules: stalePeer }, '203.0.113.7');
    const replRules = updated?.filter((r) => r.protocol === 'udp' && r.port === '51821');
    expect(replRules).toEqual([expect.objectContaining({ source_ips: ['203.0.113.7/32'] })]);
  });
});
