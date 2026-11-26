/**
 * The replication openers hand setFirewallRules the firewall they read.
 *
 * Both build the target from findFirewallByName's read, and a Vultr group's
 * rules are separate resources other writers change between that read and
 * the write (an access push from another terminal). Handed the read as its
 * basis, VultrProvider.setFirewallRules deletes only rules that read held,
 * so a rule made since is kept (vultr-set-firewall-rules.test.ts pins the
 * diff). The openers pass the firewall object, not its rules: they hold no
 * knowledge of where a provider keeps them (BaseProvider's
 * buildReplicationFirewallRules doc).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWireguardPortHetznerFirewall } from '../../../src/lib/deploy/compose/ha.js';
import { K8S_HA_EFFECTS } from '../../../src/lib/deploy/effects/k8s-ha.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';

const HTTPS = {
  id: 1,
  ip_type: 'v4',
  protocol: 'tcp',
  subnet: '0.0.0.0',
  subnet_size: 0,
  port: '443',
  notes: 'https',
};
const group = (id: string, description: string) => ({
  id,
  description,
  rules: [{ ...HTTPS }],
  rulesComplete: true,
});

function spies(groups: Record<string, ReturnType<typeof group>>) {
  vi.spyOn(VultrProvider.prototype, 'findFirewallByName').mockImplementation(
    async (name: string) => groups[name] ?? null,
  );
  return vi.spyOn(VultrProvider.prototype, 'setFirewallRules').mockResolvedValue(undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the replication openers pass the firewall they read as the basis', () => {
  it('k8s-ha: each cluster', async () => {
    const primary = group('gid-p', 'acme-prod-primary-firewall');
    const standby = group('gid-s', 'acme-prod-standby-firewall');
    const set = spies({ [primary.description]: primary, [standby.description]: standby });

    await K8S_HA_EFFECTS.haK8sOpenReplicationFirewall({
      options: { provider: 'vultr', apiToken: 't', projectName: 'acme', environment: 'prod' },
      primaryResult: { dbIp: '198.51.100.1' },
      standbyResult: { dbIp: '198.51.100.2' },
    });

    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls[0][0]).toBe('gid-p');
    expect(set.mock.calls[0][2]).toBe(primary);
    expect(set.mock.calls[1][0]).toBe('gid-s');
    expect(set.mock.calls[1][2]).toBe(standby);
  });

  it('compose-ha', async () => {
    const fw = group('gid-1', 'acme-prod-primary-firewall');
    const set = spies({ [fw.description]: fw });

    await openWireguardPortHetznerFirewall(
      'acme-prod-primary',
      '198.51.100.2',
      new VultrProvider('t'),
    );

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe('gid-1');
    expect(set.mock.calls[0][2]).toBe(fw);
  });
});
