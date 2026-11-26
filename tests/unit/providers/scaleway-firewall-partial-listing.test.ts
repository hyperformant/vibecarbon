/**
 * Review Focus 3: a short Scaleway listing is never read as the whole truth.
 *
 * findFirewallByName walks each zone's security groups, then the matched
 * group's rules, page by page (`_walkZone`), and a walk that stops early (an
 * error page, or the 20-page cap) is incomplete. Read as complete, a short
 * group walk said "no such group": deleteFirewallByName reported a live group
 * as never having existed, and an access push skipped it as undeployed. A
 * short rules walk was worse: applyOperatorCidrs and the replication write
 * rebuild the whole list from the read and PUT it back in one replace, so a
 * read missing 80 and 443 took the site off the web. Both walks now refuse,
 * and nothing is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithRetryMock = vi.fn();
vi.mock('../../../src/lib/fetch-retry.js', async (orig) => ({
  ...((await orig()) as object),
  fetchWithRetry: (...args: unknown[]) => fetchWithRetryMock(...args),
}));

import { openWireguardPortHetznerFirewall } from '../../../src/lib/deploy/compose/ha.js';
import { K8S_HA_EFFECTS } from '../../../src/lib/deploy/effects/k8s-ha.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';

const NAME = 'acme-prod-primary-firewall';
const PEER = '198.51.100.7';
const ZONES = Object.keys(ScalewayProvider.REGIONS);

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const rule = (port: number, ipRange: string, protocol = 'TCP') => ({
  id: `r-${port}-${ipRange}`,
  action: 'accept',
  protocol,
  direction: 'inbound',
  ip_range: ipRange,
  dest_port_from: port,
  dest_port_to: port,
});
const WEB = [rule(80, '0.0.0.0/0'), rule(80, '::/0'), rule(443, '0.0.0.0/0'), rule(443, '::/0')];

type Api = {
  /** Per zone: the group pages, or a status the listing fails with at `failAt`. */
  groups?: (zone: string, page: number) => ReturnType<typeof json>;
  rules?: (page: number) => ReturnType<typeof json>;
};

/**
 * A Scaleway API whose group listing and rules listing a test shapes. The
 * group is in fr-par-1 unless a test's `groups` says otherwise. Every call is
 * recorded.
 */
function api({ groups, rules }: Api = {}) {
  const calls: { method: string; url: string }[] = [];
  fetchWithRetryMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    const zone = /\/zones\/([^/]+)\//.exec(url)?.[1] ?? '';
    if (/\/security_groups\?name=/.test(url)) {
      if (groups) return groups(zone, page);
      return json({
        security_groups: zone === 'fr-par-1' ? [{ id: 'sg-1', name: NAME }] : [],
      });
    }
    if (/\/security_groups\/sg-1\/rules/.test(url) && method === 'GET') {
      return rules ? rules(page) : json({ rules: WEB });
    }
    if (/\/security_groups\/sg-1$/.test(url) && method === 'GET') return json({});
    if (method === 'PUT' || method === 'DELETE') return json({}, 200);
    return json({}, 404);
  });
  const writes = () => calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE');
  return { calls, writes };
}

/** A full page of 100 groups none of which is ours: the walk asks for the next. */
const fullPageOfOthers = (page: number) =>
  json({
    security_groups: Array.from({ length: 100 }, (_v, i) => ({
      id: `other-${page}-${i}`,
      name: `${NAME}-${page}-${i}`,
    })),
  });

const INCOMPLETE_GROUP_WALKS: [string, Api['groups']][] = [
  ['an error page in the first zone', () => json({ message: 'unavailable' }, 503)],
  [
    'an error page in a later zone, after a complete zone with no match',
    (zone) =>
      zone === 'fr-par-1' ? json({ security_groups: [] }) : json({ message: 'forbidden' }, 403),
  ],
  [
    'an error on the second page',
    (_zone, page) => (page === 1 ? fullPageOfOthers(1) : json({}, 500)),
  ],
  ['twenty full pages (the walk cap)', (_zone, page) => fullPageOfOthers(page)],
];

/** 100 operator rules on the first page; 80 and 443 on the second, which fails. */
const shortRules = (page: number) =>
  page === 1
    ? json({
        rules: Array.from({ length: 100 }, (_v, i) => rule(22, `203.0.113.${i}/32`)),
      })
    : json({ message: 'unavailable' }, 503);

beforeEach(() => {
  fetchWithRetryMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findFirewallByName refuses an incomplete group or rules walk, and nothing is written', () => {
  it('a complete walk with no match is null, and nothing is written (the control)', async () => {
    const { writes } = api({ groups: () => json({ security_groups: [] }) });
    const provider = new ScalewayProvider('t');
    expect(await provider.findFirewallByName(NAME)).toBeNull();
    expect(
      await provider.applyOperatorCidrs({ firewallName: NAME, cidrs: ['198.51.100.9/32'] }),
    ).toBe(false);
    expect(await provider.deleteFirewallByName(NAME)).toEqual({
      deleted: false,
      everExisted: false,
      apiError: null,
    });
    expect(writes()).toEqual([]);
  });

  it('a complete walk finds the group with all its rules, and the push writes (the control)', async () => {
    const { writes } = api();
    const provider = new ScalewayProvider('t');
    const fw = (await provider.findFirewallByName(NAME)) as { zone: string; rules: unknown[] };
    expect(fw.zone).toBe('fr-par-1');
    expect(fw.rules).toHaveLength(WEB.length);
    expect(
      await provider.applyOperatorCidrs({ firewallName: NAME, cidrs: ['198.51.100.9/32'] }),
    ).toBe(true);
    expect(writes().map((c) => c.method)).toEqual(['PUT']);
  });

  describe.each(INCOMPLETE_GROUP_WALKS)('an incomplete group walk: %s', (_what, groups) => {
    it('findFirewallByName throws, naming the zone', async () => {
      const { writes } = api({ groups });
      await expect(new ScalewayProvider('t').findFirewallByName(NAME)).rejects.toThrow(
        /^Scaleway listed only part of zone [a-z]{2}-[a-z]{3}-\d's security groups/,
      );
      expect(writes()).toEqual([]);
    });

    it('the access push rejects, and nothing is written', async () => {
      const { writes } = api({ groups });
      await expect(
        new ScalewayProvider('t').applyOperatorCidrs({
          firewallName: NAME,
          cidrs: ['198.51.100.9/32'],
        }),
      ).rejects.toThrow(/so nothing was changed/);
      expect(writes()).toEqual([]);
    });

    it('destroy reports the group unverified, never as never having existed', async () => {
      const { writes } = api({ groups });
      const result = await new ScalewayProvider('t').deleteFirewallByName(NAME);
      expect(result.deleted).toBe(false);
      expect(result.everExisted).toBe(false);
      expect(result.apiError).toBeInstanceOf(Error);
      expect(result.apiError?.message).toMatch(/security groups/);
      expect(writes()).toEqual([]);
    });
  });

  describe('an incomplete rules walk (80 and 443 on the page that failed)', () => {
    it('findFirewallByName throws, naming the group', async () => {
      const { writes } = api({ rules: shortRules });
      await expect(new ScalewayProvider('t').findFirewallByName(NAME)).rejects.toThrow(
        `Scaleway listed only part of ${NAME}'s rules (HTTP 503), so nothing was changed`,
      );
      expect(writes()).toEqual([]);
    });

    it('the access push rejects, and nothing is written', async () => {
      const { writes } = api({ rules: shortRules });
      await expect(
        new ScalewayProvider('t').applyOperatorCidrs({
          firewallName: NAME,
          cidrs: ['198.51.100.9/32'],
        }),
      ).rejects.toThrow(`${NAME}'s rules`);
      expect(writes()).toEqual([]);
    });

    it('the k8s-ha replication opener writes nothing, and says why', async () => {
      const { writes, calls } = api({ rules: shortRules });
      const { log } = await import('@clack/prompts');
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      await K8S_HA_EFFECTS.haK8sOpenReplicationFirewall({
        options: { provider: 'scaleway', apiToken: 't', projectName: 'acme', environment: 'prod' },
        primaryResult: { stack: 'prod-primary', dbIp: '198.51.100.1' },
        standbyResult: { stack: 'prod-standby', dbIp: PEER },
      });
      // Non-vacuous: the opener read the group's rules.
      expect(calls.some((c) => /\/security_groups\/sg-1\/rules/.test(c.url))).toBe(true);
      expect(writes()).toEqual([]);
      expect(warn.mock.calls.map(([m]) => String(m)).join('\n')).toContain(`${NAME}'s rules`);
    });

    it('the compose-ha replication opener writes nothing', async () => {
      const { writes, calls } = api({ rules: shortRules });
      const { log } = await import('@clack/prompts');
      vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      await openWireguardPortHetznerFirewall('acme-prod-primary', PEER, new ScalewayProvider('t'));
      expect(calls.some((c) => /\/security_groups\/sg-1\/rules/.test(c.url))).toBe(true);
      expect(writes()).toEqual([]);
    });

    it('destroy reports the group unverified, and deletes nothing', async () => {
      const { writes } = api({ rules: shortRules });
      const result = await new ScalewayProvider('t').deleteFirewallByName(NAME);
      expect(result.deleted).toBe(false);
      expect(result.apiError).toBeInstanceOf(Error);
      expect(writes()).toEqual([]);
    });
  });

  it('walks only the zones it needs: the group found in the first zone stops the walk', async () => {
    const { calls } = api();
    await new ScalewayProvider('t').findFirewallByName(NAME);
    const zonesListed = calls
      .filter((c) => /\/security_groups\?name=/.test(c.url))
      .map((c) => /\/zones\/([^/]+)\//.exec(c.url)?.[1]);
    expect(zonesListed).toEqual([ZONES[0]]);
  });
});
