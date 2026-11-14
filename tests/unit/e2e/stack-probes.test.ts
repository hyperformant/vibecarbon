import { describe, expect, it } from 'vitest';
import { PROBED_TYPES, probeFor } from '../../e2e/utils/stack-probes.ts';
import type { RecordedResource } from '../../e2e/utils/sweep-run-stacks.ts';

interface Seen {
  url: string;
  headers: Record<string, string>;
  method: string;
  redirect?: RequestRedirect;
}

function rig(status: number | ((url: string) => number) = 404) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? 'GET',
      redirect: init?.redirect,
    });
    const s = typeof status === 'function' ? status(String(url)) : status;
    return new Response(null, { status: s });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const T = (provider: string, name: string) => {
  const t = PROBED_TYPES[provider].find((x) => x.endsWith(`:${name}`) || x.endsWith(`/${name}`));
  if (!t) throw new Error(`no ${name} type for ${provider}`);
  return t;
};

type Case = {
  provider: string;
  type: string;
  id: string;
  url: string;
  extra?: Partial<RecordedResource>;
};

const BEARER = 'Bearer tok';
const cases: Case[] = [
  // Hetzner: ids are numeric
  ...[
    ['Server', 'servers'],
    ['Firewall', 'firewalls'],
    ['FloatingIp', 'floating_ips'],
    ['Network', 'networks'],
    ['PlacementGroup', 'placement_groups'],
    ['SshKey', 'ssh_keys'],
  ].map(([n, p]) => ({
    provider: 'hetzner',
    type: T('hetzner', n),
    id: '123456',
    url: `https://api.hetzner.cloud/v1/${p}/123456`,
  })),
  // Hetzner NetworkSubnet id is "<network id>-<ip range>" (networkSubnet.d.ts import note)
  {
    provider: 'hetzner',
    type: T('hetzner', 'NetworkSubnet'),
    id: '4242-10.0.1.0/24',
    url: 'https://api.hetzner.cloud/v1/networks/4242',
  },
  // Hetzner FloatingIpAssignment id is the floating IP id (floatingIpAssignment.d.ts import note)
  {
    provider: 'hetzner',
    type: T('hetzner', 'FloatingIpAssignment'),
    id: '777',
    url: 'https://api.hetzner.cloud/v1/floating_ips/777',
  },
  // DigitalOcean
  {
    provider: 'digitalocean',
    type: T('digitalocean', 'Droplet'),
    id: '55',
    url: 'https://api.digitalocean.com/v2/droplets/55',
  },
  {
    provider: 'digitalocean',
    type: T('digitalocean', 'Firewall'),
    id: 'f-1',
    url: 'https://api.digitalocean.com/v2/firewalls/f-1',
  },
  {
    provider: 'digitalocean',
    type: T('digitalocean', 'SshKey'),
    id: '99',
    url: 'https://api.digitalocean.com/v2/account/keys/99',
  },
  {
    provider: 'digitalocean',
    type: T('digitalocean', 'Vpc'),
    id: 'v-1',
    url: 'https://api.digitalocean.com/v2/vpcs/v-1',
  },
  // DO Tag id is the tag name (tag.js import note)
  {
    provider: 'digitalocean',
    type: T('digitalocean', 'Tag'),
    id: 'project:citest-1',
    url: 'https://api.digitalocean.com/v2/tags/project%3Acitest-1',
  },
  // Linode
  {
    provider: 'linode',
    type: T('linode', 'Firewall'),
    id: '12',
    url: 'https://api.linode.com/v4/networking/firewalls/12',
  },
  {
    provider: 'linode',
    type: T('linode', 'Instance'),
    id: '13',
    url: 'https://api.linode.com/v4/linode/instances/13',
  },
  {
    provider: 'linode',
    type: T('linode', 'SshKey'),
    id: '14',
    url: 'https://api.linode.com/v4/profile/sshkeys/14',
  },
  {
    provider: 'linode',
    type: T('linode', 'Vpc'),
    id: '15',
    url: 'https://api.linode.com/v4/vpcs/15',
  },
  // Linode ReservedIp id is the address (reservedIp.js import note)
  {
    provider: 'linode',
    type: T('linode', 'ReservedIp'),
    id: '203.0.113.1',
    url: 'https://api.linode.com/v4/networking/reserved/ips/203.0.113.1',
  },
  // Linode VpcSubnet: import id is "<vpc>,<subnet>"; a state id holds the subnet alone and the vpc is in outputs
  {
    provider: 'linode',
    type: T('linode', 'VpcSubnet'),
    id: '7654321',
    extra: { outputs: { vpcId: 1234567 } },
    url: 'https://api.linode.com/v4/vpcs/1234567/subnets/7654321',
  },
  {
    provider: 'linode',
    type: T('linode', 'VpcSubnet'),
    id: '1234567,7654321',
    url: 'https://api.linode.com/v4/vpcs/1234567/subnets/7654321',
  },
  // Vultr
  {
    provider: 'vultr',
    type: T('vultr', 'Instance'),
    id: 'a-b',
    url: 'https://api.vultr.com/v2/instances/a-b',
  },
  {
    provider: 'vultr',
    type: T('vultr', 'FirewallGroup'),
    id: 'g-1',
    url: 'https://api.vultr.com/v2/firewalls/g-1',
  },
  {
    provider: 'vultr',
    type: T('vultr', 'SSHKey'),
    id: 'k-1',
    url: 'https://api.vultr.com/v2/ssh-keys/k-1',
  },
  // Scaleway: zoned ids "<zone>/<uuid>" (server.js, ip.js, securityGroup.js import notes); iam SshKey is a bare uuid
  {
    provider: 'scaleway',
    type: T('scaleway', 'Server'),
    id: 'fr-par-1/1111-aaaa',
    url: 'https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/1111-aaaa',
  },
  {
    provider: 'scaleway',
    type: T('scaleway', 'Ip'),
    id: 'nl-ams-2/2222-bbbb',
    url: 'https://api.scaleway.com/instance/v1/zones/nl-ams-2/ips/2222-bbbb',
  },
  {
    provider: 'scaleway',
    type: T('scaleway', 'SecurityGroup'),
    id: 'pl-waw-1/3333-cccc',
    url: 'https://api.scaleway.com/instance/v1/zones/pl-waw-1/security_groups/3333-cccc',
  },
  {
    provider: 'scaleway',
    type: T('scaleway', 'SshKey'),
    id: '4444-dddd',
    url: 'https://api.scaleway.com/iam/v1alpha1/ssh-keys/4444-dddd',
  },
];

const res = (c: Case): RecordedResource => ({ type: c.type, id: c.id, ...c.extra });
const opts = (fetchImpl: typeof fetch, _provider: string) => ({
  token: 'tok',
  env: {},
  fetchImpl,
});

describe('probeFor: one URL per type', () => {
  it.each(cases)('$provider $type $id', async (c) => {
    const r = rig(404);
    const probe = probeFor(c.provider, opts(r.fetchImpl, c.provider));
    expect(await probe(res(c))).toBe('gone');
    expect(r.seen.map((s) => s.url)).toEqual([c.url]);
    expect(r.seen[0].method).toBe('GET');
    if (c.provider === 'scaleway') expect(r.seen[0].headers['X-Auth-Token']).toBe('tok');
    else expect(r.seen[0].headers.Authorization).toBe(BEARER);
  });

  it.each(cases)('maps statuses to answers for $provider $type', async (c) => {
    const answer = async (status: number) =>
      probeFor(c.provider, opts(rig(status).fetchImpl, c.provider))(res(c));
    expect(await answer(200)).toBe('present');
    expect(await answer(204)).toBe('present');
    expect(await answer(500)).toBe('unknown');
    expect(await answer(429)).toBe('unknown');
    expect(await answer(401)).toBe('unknown');
  });

  it.each(cases)('a thrown error is unknown for $provider $type', async (c) => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    expect(await probeFor(c.provider, opts(fetchImpl, c.provider))(res(c))).toBe('unknown');
  });
});

describe('probeFor: edges', () => {
  it('an unlisted type is unknown and makes no request', async () => {
    const r = rig(404);
    const probe = probeFor('hetzner', opts(r.fetchImpl, 'hetzner'));
    expect(await probe({ type: 'hcloud:index/somethingNew:SomethingNew', id: '1' })).toBe(
      'unknown',
    );
    expect(r.seen).toEqual([]);
  });

  it('an unknown provider probes everything as unknown', async () => {
    const r = rig(404);
    const probe = probeFor('nope', opts(r.fetchImpl, 'nope'));
    expect(await probe({ type: 'x:y:Z', id: '1' })).toBe('unknown');
    expect(r.seen).toEqual([]);
  });

  it('a Hetzner subnet whose id has no network part is unknown', async () => {
    const r = rig(404);
    const probe = probeFor('hetzner', opts(r.fetchImpl, 'hetzner'));
    expect(await probe({ type: T('hetzner', 'NetworkSubnet'), id: 'garbage' })).toBe('unknown');
    expect(r.seen).toEqual([]);
  });

  it('a Linode subnet with no vpc anywhere is unknown', async () => {
    const r = rig(404);
    const probe = probeFor('linode', opts(r.fetchImpl, 'linode'));
    expect(await probe({ type: T('linode', 'VpcSubnet'), id: '7' })).toBe('unknown');
    expect(r.seen).toEqual([]);
  });

  it('Scaleway ids are never sent without their zone', async () => {
    const r = rig(404);
    const probe = probeFor('scaleway', opts(r.fetchImpl, 'scaleway'));
    expect(await probe({ type: T('scaleway', 'Server'), id: 'bare-uuid' })).toBe('unknown');
    expect(r.seen).toEqual([]);
  });

  it('ids are percent-encoded into the path', async () => {
    const r = rig(404);
    const probe = probeFor('vultr', opts(r.fetchImpl, 'vultr'));
    await probe({ type: T('vultr', 'Instance'), id: '../x?y' });
    expect(r.seen[0].url).toBe('https://api.vultr.com/v2/instances/..%2Fx%3Fy');
  });
});

describe('probeFor: transport', () => {
  it('never follows redirects, and a 301 is unknown', async () => {
    const r = rig(301);
    const probe = probeFor('hetzner', opts(r.fetchImpl, 'hetzner'));
    expect(await probe({ type: T('hetzner', 'Server'), id: '1' })).toBe('unknown');
    expect(r.seen[0].redirect).toBe('manual');
  });

  it('cancels the response body after reading the status', async () => {
    let cancelled = 0;
    const fetchImpl = (async () => ({
      status: 404,
      body: { cancel: async () => void cancelled++ },
    })) as unknown as typeof fetch;
    const probe = probeFor('hetzner', opts(fetchImpl, 'hetzner'));
    expect(await probe({ type: T('hetzner', 'Server'), id: '1' })).toBe('gone');
    expect(cancelled).toBe(1);
  });

  it('a body that will not cancel does not change the answer', async () => {
    const fetchImpl = (async () => ({
      status: 200,
      body: {
        cancel: async () => {
          throw new Error('locked');
        },
      },
    })) as unknown as typeof fetch;
    const probe = probeFor('hetzner', opts(fetchImpl, 'hetzner'));
    expect(await probe({ type: T('hetzner', 'Server'), id: '1' })).toBe('present');
  });
});

describe('probeFor: Vultr FirewallRule', () => {
  const rule = (id: string, inputs: Record<string, unknown> = { firewallGroupId: 'grp-1' }) => ({
    type: T('vultr', 'FirewallRule'),
    id,
    inputs,
  });
  const byUrl = (groupStatus: number, ruleStatus: number) =>
    rig((u) => (u.includes('/rules/') ? ruleStatus : groupStatus));

  it('probes the rule under its group', async () => {
    const r = byUrl(200, 404);
    const probe = probeFor('vultr', opts(r.fetchImpl, 'vultr'));
    expect(await probe(rule('3'))).toBe('gone');
    expect(r.seen.map((s) => s.url)).toEqual([
      'https://api.vultr.com/v2/firewalls/grp-1',
      'https://api.vultr.com/v2/firewalls/grp-1/rules/3',
    ]);
  });

  it('is gone when the group answers 404, whatever the rule says', async () => {
    const r = byUrl(404, 500);
    const probe = probeFor('vultr', opts(r.fetchImpl, 'vultr'));
    expect(await probe(rule('3'))).toBe('gone');
  });

  it('is present when the rule answers 200', async () => {
    const r = byUrl(200, 200);
    expect(await probeFor('vultr', opts(r.fetchImpl, 'vultr'))(rule('3'))).toBe('present');
  });

  it('is unknown when the rule errors and the group is still there', async () => {
    const r = byUrl(200, 500);
    expect(await probeFor('vultr', opts(r.fetchImpl, 'vultr'))(rule('3'))).toBe('unknown');
  });

  it('takes the group from outputs, or from an import-shaped id "<group>,<rule>"', async () => {
    const r1 = byUrl(200, 404);
    await probeFor(
      'vultr',
      opts(r1.fetchImpl, 'vultr'),
    )({
      ...rule('3', {}),
      outputs: { firewallGroupId: 'grp-2' },
    });
    expect(r1.seen[1].url).toBe('https://api.vultr.com/v2/firewalls/grp-2/rules/3');
    const r2 = byUrl(200, 404);
    await probeFor('vultr', opts(r2.fetchImpl, 'vultr'))(rule('grp-3,9', {}));
    expect(r2.seen[1].url).toBe('https://api.vultr.com/v2/firewalls/grp-3/rules/9');
  });

  it('is unknown with no group anywhere', async () => {
    const r = byUrl(404, 404);
    expect(await probeFor('vultr', opts(r.fetchImpl, 'vultr'))(rule('3', {}))).toBe('unknown');
    expect(r.seen).toEqual([]);
  });
});

describe('PROBED_TYPES', () => {
  it('lists the five providers, with tokens taken from the SDK classes', () => {
    expect(Object.keys(PROBED_TYPES).sort()).toEqual(
      ['digitalocean', 'hetzner', 'linode', 'scaleway', 'vultr'].sort(),
    );
    expect(PROBED_TYPES.hetzner).toContain('hcloud:index/server:Server');
    expect(PROBED_TYPES.scaleway).toContain('scaleway:instance/server:Server');
    expect(PROBED_TYPES.vultr).toContain('vultr:index/sSHKey:SSHKey');
  });
});
