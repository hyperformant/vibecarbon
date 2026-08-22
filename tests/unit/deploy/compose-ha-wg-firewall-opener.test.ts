/**
 * B0-1 — the compose-ha WireGuard cloud-firewall opener converges onto the
 * provider firewall methods AND becomes genuinely non-fatal. Before B0-1 its
 * docstring claimed "non-fatal on error — the deploy continues with a
 * warning", but any throw aborted the compose-ha deploy through
 * haSetupServerFiles' bare Promise.all, and a non-2xx set_rules response was
 * silently swallowed. These tests pin the sanctioned semantics flip: every
 * failure resolves (never rejects) and emits a warning instead.
 *
 * B3: the opener now calls `provider.buildReplicationFirewallRules(...)`
 * instead of importing the free function from deploy/replication.js (moved
 * onto the provider class — see BaseProvider's abstract doc). The stub below
 * delegates to the real HetznerProvider implementation so this file keeps
 * pinning the opener's CONTRACT (find → build → set, non-fatal on error)
 * without duplicating the rule-computation logic that's already covered by
 * tests/unit/deploy/replication-firewall-rules.test.ts.
 *
 * Contract fix (finding review, 2026-07-23): the opener now passes the
 * FIREWALL OBJECT straight through (not a pre-extracted `.rules` array) —
 * the mock below forwards it verbatim to the real HetznerProvider method,
 * which extracts `.rules` internally.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

const warnMock = vi.fn();
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    log: { ...(actual.log as Record<string, unknown>), warn: (...a: unknown[]) => warnMock(...a) },
  };
});

const findFirewallByName = vi.fn();
const setFirewallRules = vi.fn();
const buildReplicationFirewallRules = vi.fn((firewall: object, peerIp: string) =>
  HetznerProvider.prototype.buildReplicationFirewallRules(firewall, peerIp),
);
const provider = { findFirewallByName, setFirewallRules, buildReplicationFirewallRules };

// A rule set with the WG rule already present so buildReplicationFirewallRules
// returns null (idempotent no-op), and one without it so an update is issued.
const WG_RULE = {
  direction: 'in',
  protocol: 'udp',
  port: '51821',
  source_ips: ['9.9.9.9/32'],
  destination_ips: [],
};

beforeEach(() => {
  findFirewallByName.mockReset();
  setFirewallRules.mockReset();
  warnMock.mockReset();
  buildReplicationFirewallRules.mockClear();
  buildReplicationFirewallRules.mockImplementation((firewall: object, peerIp: string) =>
    HetznerProvider.prototype.buildReplicationFirewallRules(firewall, peerIp),
  );
});

describe('openWireguardPortHetznerFirewall (B0-1)', () => {
  it('opens the WG rule through provider.findFirewallByName + setFirewallRules', async () => {
    findFirewallByName.mockResolvedValue({ id: 42, name: 'proj-e2-primary-firewall', rules: [] });
    setFirewallRules.mockResolvedValue(true);
    const { openWireguardPortHetznerFirewall } = await import(
      '../../../src/lib/deploy/compose/ha.js'
    );

    await openWireguardPortHetznerFirewall('proj-e2-primary', '9.9.9.9', provider);

    expect(findFirewallByName).toHaveBeenCalledWith('proj-e2-primary-firewall');
    expect(setFirewallRules).toHaveBeenCalledTimes(1);
    const [id, rules] = setFirewallRules.mock.calls[0];
    expect(id).toBe(42);
    expect(rules).toEqual(expect.arrayContaining([expect.objectContaining(WG_RULE)]));
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('resolves with a warning when setFirewallRules rejects (the sanctioned flip)', async () => {
    findFirewallByName.mockResolvedValue({ id: 42, name: 'proj-e2-primary-firewall', rules: [] });
    setFirewallRules.mockRejectedValue(new Error('set_rules exploded'));
    const { openWireguardPortHetznerFirewall } = await import(
      '../../../src/lib/deploy/compose/ha.js'
    );

    await expect(
      openWireguardPortHetznerFirewall('proj-e2-primary', '9.9.9.9', provider),
    ).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('set_rules exploded');
    expect(String(warnMock.mock.calls[0][0])).toContain('proj-e2-primary-firewall');
  });

  it('no-ops without provider (no credentials)', async () => {
    const { openWireguardPortHetznerFirewall } = await import(
      '../../../src/lib/deploy/compose/ha.js'
    );

    await openWireguardPortHetznerFirewall('proj-e2-primary', '9.9.9.9', null);

    expect(findFirewallByName).not.toHaveBeenCalled();
    expect(setFirewallRules).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('skips set_rules when the rules are already correct (idempotence preserved)', async () => {
    findFirewallByName.mockResolvedValue({
      id: 42,
      name: 'proj-e2-primary-firewall',
      rules: [WG_RULE],
    });
    const { openWireguardPortHetznerFirewall } = await import(
      '../../../src/lib/deploy/compose/ha.js'
    );

    await openWireguardPortHetznerFirewall('proj-e2-primary', '9.9.9.9', provider);

    expect(setFirewallRules).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('returns silently when the firewall is not found (matches pre-B0-1 no-op)', async () => {
    findFirewallByName.mockResolvedValue(null);
    const { openWireguardPortHetznerFirewall } = await import(
      '../../../src/lib/deploy/compose/ha.js'
    );

    await openWireguardPortHetznerFirewall('proj-e2-primary', '9.9.9.9', provider);

    expect(setFirewallRules).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });
});
