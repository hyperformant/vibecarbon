/**
 * Census: the WireGuard (udp/51821) firewall rule follows the CURRENT HA
 * peer on every provider and in UFW.
 *
 * A server replacement or a role swap hands a node a new peer IP. The
 * replication-rule reconcile must drop the rule naming the old peer, not just
 * append one for the new peer: a stale rule keeps a decommissioned (and
 * possibly re-leased) IP admitted to the tunnel port forever. Hetzner always
 * cleaned up; DigitalOcean, Linode, Vultr, Scaleway and UFW only appended.
 *
 * Walks the provider registry (PROVIDERS), not a hand list. Each provider
 * contributes only how its firewall object wraps an inbound-rules array and
 * one unrelated rule in its own wire shape; the old peer's WireGuard rule is
 * produced by the provider's own buildReplicationFirewallRules, so the
 * fixture can never drift from the shape the provider writes.
 */
import { describe, expect, it, vi } from 'vitest';

const sshCommands: Array<{ ip: string; command: string }> = [];
const ufwStatusByIp = new Map<string, string>();

vi.mock('../../../src/lib/deploy/compose/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const rec = async (ip: string, _k: string, command: unknown) => {
    const c = String(command);
    sshCommands.push({ ip, command: c });
    if (c === 'ufw status') return ufwStatusByIp.get(ip) ?? '';
    return '';
  };
  return { ...actual, sshRun: vi.fn(rec), sshRunAsync: vi.fn(rec) };
});

import { openWireguardPortUfw } from '../../../src/lib/deploy/compose/ha.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

const OLD_PEER = '203.0.113.10';
const NEW_PEER = '198.51.100.20';

type Rule = Record<string, unknown>;
type Fixture = { wrap: (rules: Rule[]) => object; unrelated: Rule };

// Per-provider wire knowledge, kept to the minimum: where the inbound rules
// live on the firewall object, and one non-WireGuard rule to prove the
// reconcile keeps everything else.
const FIXTURES: Record<string, Fixture> = {
  hetzner: {
    wrap: (rules) => ({ id: 1, rules }),
    unrelated: {
      direction: 'in',
      protocol: 'tcp',
      port: '443',
      source_ips: ['0.0.0.0/0', '::/0'],
      destination_ips: [],
    },
  },
  digitalocean: {
    wrap: (rules) => ({ id: 'fw', inbound_rules: rules }),
    unrelated: { protocol: 'tcp', ports: '443', sources: { addresses: ['0.0.0.0/0', '::/0'] } },
  },
  linode: {
    wrap: (rules) => ({ id: 1, rules: { inbound: rules, outbound: [] } }),
    unrelated: {
      label: 'https',
      action: 'ACCEPT',
      protocol: 'TCP',
      ports: '443',
      addresses: { ipv4: ['0.0.0.0/0'], ipv6: ['::/0'] },
    },
  },
  vultr: {
    wrap: (rules) => ({ id: 'grp', rules }),
    unrelated: { ip_type: 'v4', protocol: 'tcp', subnet: '0.0.0.0', subnet_size: 0, port: '443' },
  },
  scaleway: {
    wrap: (rules) => ({ id: 'sg', zone: 'fr-par-1', rules }),
    unrelated: {
      action: 'accept',
      protocol: 'TCP',
      direction: 'inbound',
      ip_range: '0.0.0.0/0',
      dest_port_from: 443,
      dest_port_to: 443,
    },
  },
};

const names = (rule: Rule, ip: string) => JSON.stringify(rule).includes(ip);

describe('WireGuard peer-rule census', () => {
  it('covers every registered provider', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  describe.each(Object.keys(PROVIDERS))('%s', (id) => {
    // biome-ignore lint/suspicious/noExplicitAny: provider classes share BaseProvider's contract
    const provider = new (PROVIDERS as Record<string, any>)[id]('census-token');
    const { wrap, unrelated } = FIXTURES[id] ?? { wrap: () => ({}), unrelated: {} };

    const withOldPeer = () => {
      const rules = provider.buildReplicationFirewallRules(wrap([unrelated]), OLD_PEER);
      expect(rules).not.toBeNull();
      return rules as Rule[];
    };

    it('replaces the old peer rule with exactly one rule for the new peer', () => {
      const rules = provider.buildReplicationFirewallRules(wrap(withOldPeer()), NEW_PEER) as
        | Rule[]
        | null;
      expect(rules).not.toBeNull();
      const wg = (rules as Rule[]).filter((r) => JSON.stringify(r) !== JSON.stringify(unrelated));
      expect(wg.filter((r) => names(r, OLD_PEER))).toEqual([]);
      expect(wg.filter((r) => names(r, NEW_PEER))).toHaveLength(1);
      expect(wg).toHaveLength(1);
      expect(rules).toContainEqual(unrelated);
    });

    it('drops the old peer rule even when the new peer rule is already present', () => {
      const both = provider.buildReplicationFirewallRules(wrap(withOldPeer()), NEW_PEER) as Rule[];
      const oldRule = withOldPeer().find((r) => names(r, OLD_PEER)) as Rule;
      const rules = provider.buildReplicationFirewallRules(wrap([...both, oldRule]), NEW_PEER) as
        | Rule[]
        | null;
      expect(rules).not.toBeNull();
      expect((rules as Rule[]).filter((r) => names(r, OLD_PEER))).toEqual([]);
      expect((rules as Rule[]).filter((r) => names(r, NEW_PEER))).toHaveLength(1);
      expect(rules).toContainEqual(unrelated);
    });

    it('is a no-op once the rules already name only the current peer', () => {
      const current = provider.buildReplicationFirewallRules(
        wrap(withOldPeer()),
        NEW_PEER,
      ) as Rule[];
      expect(provider.buildReplicationFirewallRules(wrap(current), NEW_PEER)).toBeNull();
    });
  });
});

describe('UFW WireGuard peer rule', () => {
  const ufwStatus = (...sources: string[]) =>
    [
      'Status: active',
      '',
      'To                         Action      From',
      '--                         ------      ----',
      '22/tcp                     ALLOW       Anywhere',
      ...sources.map((s) => `51821/udp                  ALLOW       ${s}`),
      'Anywhere on wg0            ALLOW       Anywhere',
      '22/tcp (v6)                ALLOW       Anywhere (v6)',
      '',
    ].join('\n');

  const commandsFor = async (ip: string, status: string) => {
    sshCommands.length = 0;
    ufwStatusByIp.set(ip, status);
    await openWireguardPortUfw(ip, NEW_PEER, '/tmp/census-key');
    return sshCommands.filter((c) => c.ip === ip).map((c) => c.command);
  };

  it('deletes the old peer allow before adding the current peer', async () => {
    const cmds = await commandsFor('192.0.2.1', ufwStatus(OLD_PEER));
    const del = `ufw delete allow from ${OLD_PEER} to any port 51821 proto udp`;
    const add = `ufw allow from ${NEW_PEER} to any port 51821 proto udp`;
    expect(cmds).toContain(del);
    expect(cmds).toContain(add);
    expect(cmds.indexOf(del)).toBeLessThan(cmds.indexOf(add));
  });

  it('keeps the current peer allow and touches no other rule', async () => {
    const cmds = await commandsFor('192.0.2.2', ufwStatus(NEW_PEER));
    expect(cmds.filter((c) => c.startsWith('ufw delete'))).toEqual([]);
    expect(cmds).toContain(`ufw allow from ${NEW_PEER} to any port 51821 proto udp`);
  });

  it('deletes an any-source 51821/udp allow too', async () => {
    const cmds = await commandsFor('192.0.2.3', ufwStatus('Anywhere'));
    expect(cmds).toContain('ufw delete allow 51821/udp');
  });

  it('fails loudly on an unparseable source, never interpolating it', async () => {
    await expect(commandsFor('192.0.2.4', ufwStatus('1.2.3.4;reboot'))).rejects.toThrow(
      /51821\/udp/,
    );
    expect(sshCommands.some((c) => c.command.includes('reboot'))).toBe(false);
  });
});
