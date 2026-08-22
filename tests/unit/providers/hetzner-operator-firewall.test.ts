/**
 * C9 — operator firewall access moved onto HetznerProvider.
 *
 * findFirewallByName / setFirewallRules are verbatim moves of
 * operator-ip.js's old module-private helpers of the same name (mechanical
 * substitutions only: apiToken param -> this.apiToken, the
 * `https://api.hetzner.cloud/v1` literal -> the `${HetznerProvider.API_BASE}`
 * template). applyOperatorCidrs composes find -> the Hetzner
 * `{direction, port, source_ips}` rule-rewrite (also a verbatim move, from
 * operator-ip.js's old applyToFirewall body) -> set.
 *
 * These go through fetchWithRetry (NOT a raw fetch — unlike getServerSummary,
 * C8), so fetch-retry.js is mocked here per the same pattern as
 * hetzner-get-server-summary.test.ts / hetzner.test.ts's other
 * fetchWithRetry-backed statics.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';

describe('HetznerProvider.findFirewallByName (C9)', () => {
  let provider: HetznerProvider;

  beforeEach(() => {
    provider = new HetznerProvider('test-api-token');
    fetchWithRetryMock.mockReset();
  });

  it('GETs the exact byte-identical URL/headers the old operator-ip.js helper used', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ firewalls: [{ id: 42, name: 'proj-prod-firewall', rules: [] }] }),
    });

    const result = await provider.findFirewallByName('proj-prod-firewall');

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/firewalls?name=proj-prod-firewall',
      { headers: { Authorization: 'Bearer test-api-token' } },
    );
    expect(result).toEqual({ id: 42, name: 'proj-prod-firewall', rules: [] });
  });

  it('URL-encodes the firewall name', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({ ok: true, json: async () => ({ firewalls: [] }) });

    await provider.findFirewallByName('proj env/weird name');

    expect(fetchWithRetryMock).toHaveBeenCalledWith(
      `https://api.hetzner.cloud/v1/firewalls?name=${encodeURIComponent('proj env/weird name')}`,
      expect.anything(),
    );
  });

  it('returns null (does not throw) on a non-2xx response', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await provider.findFirewallByName('proj-prod-firewall');

    expect(result).toBeNull();
  });

  it('returns null when the firewalls array is empty', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({ ok: true, json: async () => ({ firewalls: [] }) });

    const result = await provider.findFirewallByName('nonexistent');

    expect(result).toBeNull();
  });
});

describe('HetznerProvider.setFirewallRules (C9)', () => {
  let provider: HetznerProvider;

  beforeEach(() => {
    provider = new HetznerProvider('test-api-token');
    fetchWithRetryMock.mockReset();
  });

  it('POSTs the exact byte-identical URL/method/headers/body the old helper used', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({ ok: true });
    const rules = [{ direction: 'in', protocol: 'tcp', port: '22', source_ips: ['1.2.3.4/32'] }];

    await provider.setFirewallRules(42, rules);

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchWithRetryMock).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/firewalls/42/actions/set_rules',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-api-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rules }),
      },
    );
  });

  it('throws with status + body text on a non-2xx response', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => 'invalid rule',
    });

    await expect(provider.setFirewallRules(42, [])).rejects.toThrow(
      'Hetzner firewall set_rules failed (422): invalid rule',
    );
  });

  it('swallows a text()-read failure and still throws with an empty body', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('stream closed');
      },
    });

    await expect(provider.setFirewallRules(42, [])).rejects.toThrow(
      'Hetzner firewall set_rules failed (500): ',
    );
  });
});

describe('HetznerProvider.applyOperatorCidrs (C9)', () => {
  let provider: HetznerProvider;

  beforeEach(() => {
    provider = new HetznerProvider('test-api-token');
    fetchWithRetryMock.mockReset();
  });

  // The exact fixture pre-C9's applyToFirewall would have processed: SSH +
  // K8s API ingress rules alongside an unrelated HTTP rule and an egress
  // rule that must be left untouched.
  const existingRules = [
    { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['9.9.9.9/32'] },
    { direction: 'in', protocol: 'tcp', port: '6443', source_ips: ['9.9.9.9/32'] },
    { direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0', '::/0'] },
    { direction: 'out', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0'] },
  ];

  it('produces the same find -> rewrite -> set wire calls the old operator-ip.js path did', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        firewalls: [{ id: 7, name: 'proj-prod-firewall', rules: existingRules }],
      }),
    });
    fetchWithRetryMock.mockResolvedValueOnce({ ok: true });

    const cidrs = ['1.2.3.4/32', '5.6.7.8/32'];
    const result = await provider.applyOperatorCidrs({
      firewallName: 'proj-prod-firewall',
      cidrs,
    });

    expect(result).toBe(true);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(2);

    // Call 1: find, identical URL/headers to findFirewallByName's own test.
    expect(fetchWithRetryMock).toHaveBeenNthCalledWith(
      1,
      'https://api.hetzner.cloud/v1/firewalls?name=proj-prod-firewall',
      { headers: { Authorization: 'Bearer test-api-token' } },
    );

    // Call 2: set, with only the SSH/K8s-API `in` rules rewritten — same
    // rule-JSON shape (direction/port/source_ips) the pre-C9 map() produced.
    const expectedRules = [
      { direction: 'in', protocol: 'tcp', port: '22', source_ips: cidrs },
      { direction: 'in', protocol: 'tcp', port: '6443', source_ips: cidrs },
      { direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0', '::/0'] },
      { direction: 'out', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0'] },
    ];
    expect(fetchWithRetryMock).toHaveBeenNthCalledWith(
      2,
      'https://api.hetzner.cloud/v1/firewalls/7/actions/set_rules',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-api-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rules: expectedRules }),
      },
    );
  });

  it('also rewrites the operator-scoped Supavisor pooler rules (5432/6543)', async () => {
    // Compose deploys firewall the pooler ports to operator CIDRs, same as
    // SSH — `vibecarbon access add/remove/prune` must keep them in lockstep
    // or granting a teammate SSH would silently not grant pooler access.
    const rulesWithPooler = [
      ...existingRules,
      { direction: 'in', protocol: 'tcp', port: '5432', source_ips: ['9.9.9.9/32'] },
      { direction: 'in', protocol: 'tcp', port: '6543', source_ips: ['9.9.9.9/32'] },
    ];
    fetchWithRetryMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        firewalls: [{ id: 7, name: 'proj-prod-firewall', rules: rulesWithPooler }],
      }),
    });
    fetchWithRetryMock.mockResolvedValueOnce({ ok: true });

    const cidrs = ['1.2.3.4/32'];
    await provider.applyOperatorCidrs({ firewallName: 'proj-prod-firewall', cidrs });

    const setBody = JSON.parse(fetchWithRetryMock.mock.calls[1][1].body);
    const byPort = Object.fromEntries(
      setBody.rules.filter((r: any) => r.direction === 'in').map((r: any) => [r.port, r]),
    );
    expect(byPort['5432'].source_ips).toEqual(cidrs);
    expect(byPort['6543'].source_ips).toEqual(cidrs);
    // Public web rules stay world-open; egress untouched.
    expect(byPort['443'].source_ips).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('returns false and never calls set_rules when the firewall does not exist', async () => {
    fetchWithRetryMock.mockResolvedValueOnce({ ok: true, json: async () => ({ firewalls: [] }) });

    const result = await provider.applyOperatorCidrs({
      firewallName: 'not-deployed-firewall',
      cidrs: ['1.2.3.4/32'],
    });

    expect(result).toBe(false);
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('leaves rules with no matching port/direction completely untouched (same object shape)', async () => {
    const onlyUnrelated = [
      { direction: 'in', protocol: 'tcp', port: '80', source_ips: ['0.0.0.0/0'] },
    ];
    fetchWithRetryMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ firewalls: [{ id: 1, rules: onlyUnrelated }] }),
    });
    fetchWithRetryMock.mockResolvedValueOnce({ ok: true });

    await provider.applyOperatorCidrs({ firewallName: 'fw', cidrs: ['1.2.3.4/32'] });

    const setCall = fetchWithRetryMock.mock.calls[1];
    const sentBody = JSON.parse(setCall[1].body);
    expect(sentBody.rules).toEqual(onlyUnrelated);
  });
});
