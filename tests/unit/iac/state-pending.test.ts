/**
 * The unfinished creates the seal finds after a deploy's up (lib/iac/
 * state-pending.js): which ones the provider can be asked about, which
 * servers count as ours and running untracked (name and ownership labels)
 * and which only share a name, and what the user reads. Where upStack
 * runs it (clear under the lock, then seal) is tests/unit/iac/state-seal.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const {
  classifyPendingCreates,
  forgetPendingReported,
  OWNERSHIP_KEYS,
  pendingCreatesBlock,
  pendingLabel,
  pendingLookupFailed,
  pendingReported,
  recordedOwnership,
  recordPendingReported,
  untrackedServers,
} = await import('../../../src/lib/iac/state-pending.js');
const { SERVER_RESOURCE_TYPES } = await import('../../../src/lib/iac/create-timeout.js');
// @ts-expect-error: JS module without types
const { StateTracker } = await import('../../../src/lib/deploy/state.js');

// Sentinel only: never a real credential.
const TOKEN = 'SENTINEL-pending-token-5b1e';

const create = (type: string, logical: string, inputs: Record<string, unknown>) => ({
  type: 'creating',
  resource: { urn: `urn:pulumi:e1::proj::${type}::${logical}`, type, inputs },
});
const withOps = (ops: unknown[], resources: unknown[] = []) => ({
  deployment: { resources, pending_operations: ops },
});

// The ownership labels every program sets on its servers (create-timeout.js
// SERVER_OWNER_LABELS beside project and environment).
const OWNER = { 'managed-by': 'vibecarbon', project: 'p', environment: 'e1' };
const OWNER_TAGS = ['project:p', 'environment:e1', 'managed-by:vibecarbon', 'role:compose'];

describe('recordedOwnership', () => {
  it('reads the ownership keys the destroy sweep reads too', () => {
    expect([...OWNERSHIP_KEYS].sort()).toEqual(['environment', 'managed-by', 'project']);
  });

  it('a label map (Hetzner) or key:value tags (the others), split on the first colon', () => {
    expect(recordedOwnership({ labels: { ...OWNER, role: 'compose' } }, 'labels')).toEqual(OWNER);
    expect(recordedOwnership({ tags: OWNER_TAGS }, 'tags')).toEqual(OWNER);
    expect(
      recordedOwnership(
        { tags: ['project:p:x', 'environment:e1', 'managed-by:vibecarbon'] },
        'tags',
      ),
    ).toEqual({ ...OWNER, project: 'p:x' });
  });

  it.each([
    ['no labels at all', {}, 'labels'],
    ['no labels input for the type', { labels: OWNER }, undefined],
    ['the labels under another input', { tags: OWNER_TAGS }, 'labels'],
    ['no environment', { labels: { 'managed-by': 'vibecarbon', project: 'p' } }, 'labels'],
    ['managed by something else', { labels: { ...OWNER, 'managed-by': 'terraform' } }, 'labels'],
    ['an empty project', { labels: { ...OWNER, project: '' } }, 'labels'],
    ['a value that is not text', { labels: { ...OWNER, project: 7 } }, 'labels'],
    ['tags without the managed-by tag', { tags: ['project:p', 'environment:e1'] }, 'tags'],
    [
      'a bare tag in place of key:value',
      { tags: ['project:p', 'environment:e1', 'managed-by'] },
      'tags',
    ],
  ])('null when it recorded no full ownership: %s', (_label, inputs, labelsInput) => {
    expect(recordedOwnership(inputs, labelsInput)).toBeNull();
  });
});

describe('classifyPendingCreates', () => {
  it.each([
    [
      'hcloud:index/server:Server',
      'server',
      { name: 'p-e1-worker-1', labels: { ...OWNER, role: 'worker' } },
    ],
    ['digitalocean:index/droplet:Droplet', 'droplet', { name: 'p-e1-worker-1', tags: OWNER_TAGS }],
    ['vultr:index/instance:Instance', 'instance', { label: 'p-e1-worker-1', tags: OWNER_TAGS }],
    ['linode:index/instance:Instance', 'instance', { label: 'p-e1-worker-1', tags: OWNER_TAGS }],
    ['scaleway:instance/server:Server', 'server', { name: 'p-e1-worker-1', tags: OWNER_TAGS }],
  ])(
    '%s: a server create, looked up by the name and ownership it recorded',
    (type, noun, inputs) => {
      const { servers, others } = classifyPendingCreates(
        withOps([create(type, 'worker-1', { ...inputs, userData: TOKEN })]),
        SERVER_RESOURCE_TYPES,
      );
      expect(servers).toEqual([
        {
          urn: `urn:pulumi:e1::proj::${type}::worker-1`,
          noun,
          name: 'p-e1-worker-1',
          owner: OWNER,
        },
      ]);
      expect(others).toEqual([]);
      expect(JSON.stringify(servers)).not.toContain(TOKEN);
    },
  );

  it('a server create without its ownership labels is one vibecarbon can only tell the user about', () => {
    const { servers, others } = classifyPendingCreates(
      withOps([
        create('digitalocean:index/droplet:Droplet', 'web', { name: 'p-e1-web', userData: TOKEN }),
        create('hcloud:index/server:Server', 'db', {
          name: 'p-e1-db',
          labels: { project: 'p', environment: 'e1' },
        }),
      ]),
      SERVER_RESOURCE_TYPES,
    );
    expect(servers).toEqual([]);
    expect(others).toEqual([
      {
        urn: 'urn:pulumi:e1::proj::digitalocean:index/droplet:Droplet::web',
        what: 'droplet',
        name: 'p-e1-web',
        billing: true,
        kept: null,
      },
      {
        urn: 'urn:pulumi:e1::proj::hcloud:index/server:Server::db',
        what: 'server',
        name: 'p-e1-db',
        billing: true,
        kept: null,
      },
    ]);
    expect(JSON.stringify(others)).not.toContain(TOKEN);
  });

  it('anything else is a create vibecarbon has no lookup for, named by its type and the name its console shows', () => {
    const { servers, others } = classifyPendingCreates(
      withOps([
        create('hcloud:index/firewall:Firewall', 'fw', { name: 'p-e1-firewall' }),
        create('digitalocean:index/reservedIpAssignment:ReservedIpAssignment', 'ip', {}),
        create('linode:index/firewall:Firewall', 'lfw', { label: 'p-e1-fw' }),
        // A Vultr firewall group's only name is its description.
        create('vultr:index/firewallGroup:FirewallGroup', 'firewall', {
          description: 'p-e1-firewall',
        }),
        // No name at the provider: the program's names (`ip`, `ingress`) are in no console.
        create('scaleway:instance/ip:Ip', 'ip', { type: 'routed_ipv4', tags: OWNER_TAGS }),
        create('linode:index/reservedIp:ReservedIp', 'ingress', { tags: OWNER_TAGS }),
        // A server whose inputs carry no name: nothing to ask the provider.
        create('hcloud:index/server:Server', 'nameless', { userData: TOKEN, labels: OWNER }),
        { type: 'updating', resource: { urn: 'urn:pulumi:e1::proj::x:y:Z::z', type: 'x:y:Z' } },
      ]),
      SERVER_RESOURCE_TYPES,
    );
    expect(servers).toEqual([]);
    expect(others.map(pendingLabel)).toEqual([
      'firewall p-e1-firewall',
      'unnamed reserved IP assignment',
      'firewall p-e1-fw',
      'firewall group p-e1-firewall',
      'unnamed IP',
      'unnamed reserved IP',
      'unnamed server',
      'unnamed z',
    ]);
    expect(others.map((o) => o.name)).toEqual([
      'p-e1-firewall',
      null,
      'p-e1-fw',
      'p-e1-firewall',
      null,
      null,
      null,
      null,
    ]);
    expect(JSON.stringify(others)).not.toContain(TOKEN);
  });

  it('a create whose URN the state tracks a resource at (an up made it again) carries that one, by id and name, as the one to keep', () => {
    const FW = 'urn:pulumi:e1::proj::hcloud:index/firewall:Firewall::fw';
    const IP = 'urn:pulumi:e1::proj::scaleway:instance/ip:Ip::ip';
    const { others } = classifyPendingCreates(
      withOps(
        [
          create('hcloud:index/firewall:Firewall', 'fw', { name: 'p-e1-firewall' }),
          create('scaleway:instance/ip:Ip', 'ip', { tags: OWNER_TAGS }),
          create('hcloud:index/network:Network', 'network', { name: 'p-e1-network' }),
        ],
        [
          {
            urn: FW,
            type: 'hcloud:index/firewall:Firewall',
            id: '4711',
            inputs: { name: 'p-e1-firewall' },
            outputs: { name: 'p-e1-firewall' },
          },
          { urn: IP, type: 'scaleway:instance/ip:Ip', id: 'fr-par-1/0b1c', outputs: {} },
          // The old half of a replace, on its way out: never the one to keep.
          {
            urn: 'urn:pulumi:e1::proj::hcloud:index/network:Network::network',
            type: 'hcloud:index/network:Network',
            id: '12',
            delete: true,
            outputs: { name: 'p-e1-network' },
          },
        ],
      ),
      SERVER_RESOURCE_TYPES,
    );
    expect(others.map((o) => o.kept)).toEqual([
      { id: '4711', name: 'p-e1-firewall' },
      { id: 'fr-par-1/0b1c', name: null },
      null,
    ]);
  });

  it.each([
    ['hcloud:index/floatingIp:FloatingIp', 'floating IP', true],
    ['hcloud:index/floatingIpAssignment:FloatingIpAssignment', 'floating IP assignment', false],
    ['linode:index/reservedIp:ReservedIp', 'reserved IP', true],
    ['scaleway:instance/ip:Ip', 'IP', true],
    ['digitalocean:index/volume:Volume', 'volume', true],
    ['hcloud:index/loadBalancer:LoadBalancer', 'load balancer', true],
    ['digitalocean:index/spacesBucket:SpacesBucket', 'spaces bucket', true],
    ['vultr:index/sSHKey:SSHKey', 'SSH key', false],
    ['hcloud:index/sshKey:SshKey', 'SSH key', false],
    ['linode:index/vpcSubnet:VpcSubnet', 'VPC subnet', false],
    ['vultr:index/firewallGroup:FirewallGroup', 'firewall group', false],
    ['hcloud:index/placementGroup:PlacementGroup', 'placement group', false],
  ])('%s reads as "%s", billing while it exists: %s', (type, what, billing) => {
    const { others } = classifyPendingCreates(
      withOps([create(type, 'r', { name: 'p-e1-r' })]),
      SERVER_RESOURCE_TYPES,
    );
    expect(others).toEqual([
      { urn: `urn:pulumi:e1::proj::${type}::r`, what, name: 'p-e1-r', billing, kept: null },
    ]);
  });

  it('no pending operations: nothing either way', () => {
    expect(classifyPendingCreates({ deployment: {} }, SERVER_RESOURCE_TYPES)).toEqual({
      servers: [],
      others: [],
    });
  });
});

describe('untrackedServers', () => {
  const WORKER = { urn: 'u', noun: 'server', name: 'p-e1-worker-1', owner: OWNER };
  type Listed = { id: unknown; labels?: Record<string, string> };
  const client = (answer: Record<string, Listed[]>) => {
    const calls: unknown[][] = [];
    return {
      calls,
      findServersByName: async (name: string, options: { strict: boolean }) => {
        calls.push([name, options]);
        return answer[name] ?? [];
      },
      // As each provider decodes its own server objects (provider.serverLabels).
      serverLabels: (server: Listed) => server.labels ?? {},
    };
  };

  it('asks strictly, and leaves out the servers the state tracks, however each spells the id', async () => {
    const state = {
      deployment: {
        resources: [
          { type: 'hcloud:index/server:Server', id: '21' },
          { type: 'scaleway:instance/server:Server', id: 'fr-par-1/0b1c-uuid' },
          // Not a server: its id never shields one.
          { type: 'hcloud:index/firewall:Firewall', id: '777' },
        ],
      },
    };
    const lookup = client({
      'p-e1-worker-1': [
        { id: 21, labels: OWNER },
        { id: '0b1c-uuid', labels: OWNER },
        { id: 777, labels: { ...OWNER, role: 'worker' } },
      ],
    });
    expect(await untrackedServers([WORKER], state, SERVER_RESOURCE_TYPES, lookup)).toEqual({
      ours: [{ ...WORKER, id: '777' }],
      foreign: [],
    });
    expect(lookup.calls).toEqual([['p-e1-worker-1', { strict: true }]]);
  });

  it("a same-name server without this environment's ownership labels is not ours", async () => {
    const lookup = client({
      'p-e1-worker-1': [
        { id: 1 },
        { id: 2, labels: { project: 'p', environment: 'e1' } },
        { id: 3, labels: { ...OWNER, 'managed-by': 'terraform' } },
        { id: 4, labels: { ...OWNER, project: 'other' } },
        { id: 5, labels: { ...OWNER, environment: 'e2' } },
        { id: 6, labels: { ...OWNER, role: 'worker' } },
      ],
    });
    const found = await untrackedServers(
      [WORKER],
      { deployment: { resources: [] } },
      SERVER_RESOURCE_TYPES,
      lookup,
    );
    expect(found.ours.map((s) => s.id)).toEqual(['6']);
    expect(found.foreign.map((s) => s.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('one server listed under two pending creates is named once', async () => {
    const lookup = client({ 'p-e1-worker-1': [{ id: 5, labels: OWNER }, { id: 9 }] });
    const found = await untrackedServers(
      [WORKER, { ...WORKER, urn: 'u2' }],
      { deployment: { resources: [] } },
      SERVER_RESOURCE_TYPES,
      lookup,
    );
    expect(found.ours.map((s) => s.id)).toEqual(['5']);
    expect(found.foreign.map((s) => s.id)).toEqual(['9']);
  });

  it("a lookup that can't answer rejects: it never reads as no server", async () => {
    const failing = {
      findServersByName: async () => {
        throw new Error('HTTP 503');
      },
      serverLabels: () => ({}),
    };
    await expect(
      untrackedServers([WORKER], { deployment: {} }, SERVER_RESOURCE_TYPES, failing),
    ).rejects.toThrow('HTTP 503');
  });
});

describe('the record of what the user was told (pendingReported)', () => {
  it('matches exactly the creates it named, in any order, and forgets them', () => {
    const cwd = createTempDir('pending-ledger-');
    const original = process.cwd;
    process.cwd = () => cwd;
    try {
      const ledger = new StateTracker('proj', 'e1');
      const a = { urn: 'urn:a', what: 'firewall', name: 'a', billing: false };
      const b = { urn: 'urn:b', what: 'firewall', name: 'b', billing: false };
      expect(pendingReported(ledger, 'e1', [a, b])).toBe(false);
      recordPendingReported(ledger, 'e1', [b, a]);
      expect(pendingReported(ledger, 'e1', [a, b])).toBe(true);
      expect(pendingReported(ledger, 'e1', [a])).toBe(false);
      expect(pendingReported(ledger, 'e2', [a, b])).toBe(false);
      forgetPendingReported(ledger, 'e1');
      expect(pendingReported(ledger, 'e1', [a, b])).toBe(false);
    } finally {
      process.cwd = original;
    }
  });
});

describe('what the user reads', () => {
  const OPENING =
    'Your servers in e1 are updated, but vibecarbon left their user data in plain text in the Pulumi state.';

  it('servers of ours running untracked and a resource it can look up neither, together', () => {
    const text = pendingCreatesBlock('e1', {
      untracked: [
        { urn: 'u1', noun: 'droplet', name: 'p-e1-worker-1', owner: OWNER, id: '11' },
        { urn: 'u2', noun: 'droplet', name: 'p-e1-worker-2', owner: OWNER, id: '12' },
      ],
      others: [{ urn: 'u3', what: 'firewall', name: 'p-e1-firewall', billing: false, kept: null }],
      providerName: 'DigitalOcean',
    });
    expect(text).toBe(
      `${OPENING} An earlier run started creating the droplet p-e1-worker-1, the droplet p-e1-worker-2 ` +
        "and the firewall p-e1-firewall and didn't finish, and the state keeps a record of each create, " +
        'which has to go before vibecarbon can seal it. p-e1-worker-1 (id 11) and p-e1-worker-2 (id 12) ' +
        "are running in your account without Pulumi tracking them, so you're billed for them and no " +
        "vibecarbon command will remove them: delete them in your DigitalOcean console. vibecarbon can't " +
        'tell whether that create made the firewall p-e1-firewall, so check your DigitalOcean console for ' +
        "it and delete it if it's this project's. Then deploy again: the next deploy clears the records " +
        'and seals the state.',
    );
  });

  it('names each resource by type and name, and says which may be billing', () => {
    const one = pendingCreatesBlock('e1', {
      untracked: [],
      others: [
        { urn: 'u1', what: 'floating IP', name: 'p-e1-ip', billing: true, kept: null },
        { urn: 'u2', what: 'firewall', name: 'p-e1-firewall', billing: false, kept: null },
      ],
      providerName: 'Hetzner Cloud',
    });
    expect(one).toBe(
      `${OPENING} An earlier run started creating the floating IP p-e1-ip and the firewall ` +
        "p-e1-firewall and didn't finish, and the state keeps a record of each create, which has to " +
        "go before vibecarbon can seal it. vibecarbon can't tell whether those creates made the " +
        'floating IP p-e1-ip and the firewall p-e1-firewall, so check your Hetzner Cloud console for ' +
        "them and delete any that are this project's. The floating IP p-e1-ip may be billing you while " +
        'it exists. Then deploy again: the next deploy clears the records and seals the state.',
    );
    const two = pendingCreatesBlock('e1', {
      untracked: [],
      others: [
        { urn: 'u1', what: 'reserved IP', name: 'p-e1-ip', billing: true, kept: null },
        { urn: 'u2', what: 'instance', name: 'p-e1-web', billing: true, kept: null },
      ],
      providerName: 'Linode',
    });
    expect(two).toContain(
      'The reserved IP p-e1-ip and the instance p-e1-web may be billing you while they exist. Then deploy again',
    );
    const none = pendingCreatesBlock('e1', {
      untracked: [],
      others: [{ urn: 'u2', what: 'firewall', name: 'p-e1-firewall', billing: false, kept: null }],
      providerName: 'Vultr',
    });
    expect(none).not.toContain('billing');
  });

  it('a resource a later run made again: named by its id as the one to keep, and only another of its type and name to look for', () => {
    const text = pendingCreatesBlock('e1', {
      untracked: [],
      others: [
        {
          urn: 'u1',
          what: 'floating IP',
          name: 'p-e1-ip',
          billing: true,
          kept: { id: '4711', name: 'p-e1-ip' },
        },
      ],
      providerName: 'Hetzner Cloud',
    });
    expect(text).toBe(
      `${OPENING} An earlier run started creating the floating IP p-e1-ip and didn't finish, and the ` +
        'state keeps a record of that create, which has to go before vibecarbon can seal it. Keep the ' +
        "floating IP p-e1-ip (id 4711): a later run made it again, and it's the one this project uses. " +
        "vibecarbon can't tell whether the earlier create also made another floating IP named p-e1-ip, " +
        "so check your Hetzner Cloud console for one and delete it if it's this project's. Another " +
        'floating IP named p-e1-ip would be billing you while it exists. Then deploy again: the next ' +
        'deploy clears the record and seals the state.',
    );
    // Never "the floating IP p-e1-ip may be billing you": that one is live, and kept.
    expect(text).not.toContain('may be billing');
  });

  it('several made again, unnamed ones by id, beside one nothing was made for', () => {
    const text = pendingCreatesBlock('e1', {
      untracked: [],
      others: [
        {
          urn: 'u1',
          what: 'firewall',
          name: 'p-e1-firewall',
          billing: false,
          kept: { id: '88', name: 'p-e1-firewall' },
        },
        {
          urn: 'u2',
          what: 'IP',
          name: null,
          billing: true,
          kept: { id: 'fr-par-1/0b1c', name: null },
        },
        { urn: 'u3', what: 'SSH key', name: 'p-e1-key', billing: false, kept: null },
      ],
      providerName: 'Scaleway',
    });
    expect(text).toBe(
      `${OPENING} An earlier run started creating the firewall p-e1-firewall, an unnamed IP and the SSH ` +
        "key p-e1-key and didn't finish, and the state keeps a record of each create, which has to go " +
        "before vibecarbon can seal it. vibecarbon can't tell whether that create made the SSH key " +
        "p-e1-key, so check your Scaleway console for it and delete it if it's this project's. Keep the " +
        'firewall p-e1-firewall (id 88) and an unnamed IP (id fr-par-1/0b1c): a later run made them ' +
        "again, and they're the ones this project uses. vibecarbon can't tell whether the earlier " +
        'creates also made another firewall named p-e1-firewall or another unnamed IP, so check your ' +
        "Scaleway console for those and delete any that are this project's. Another unnamed IP would " +
        'be billing you while it exists. Then deploy again: the next deploy clears the records and ' +
        'seals the state.',
    );
    // The program's own names for them, which no console shows, never appear.
    expect(text).not.toMatch(/\bthe IP ip\b|\bIP u2\b/);
  });

  it('never a raw pulumi command, never an em dash', () => {
    const texts = [
      pendingCreatesBlock('e1', {
        untracked: [{ urn: 'u', noun: 'server', name: 'n', owner: OWNER, id: '1' }],
        others: [{ urn: 'v', what: 'floating IP', name: 'f', billing: true, kept: null }],
        providerName: 'Hetzner Cloud',
      }),
      pendingLookupFailed(
        'e1',
        [{ urn: 'u', noun: 'server', name: 'n', owner: OWNER }],
        'HTTP 503.',
      ),
      pendingLookupFailed(
        'e1',
        [
          { urn: 'u', noun: 'server', name: 'a', owner: OWNER },
          { urn: 'v', noun: 'server', name: 'b', owner: OWNER },
        ],
        'HTTP 503',
      ),
      pendingCreatesBlock('e1', {
        untracked: [],
        others: [
          { urn: 'v', what: 'firewall', name: 'f', billing: false, kept: { id: '1', name: 'f' } },
        ],
        providerName: 'Hetzner Cloud',
      }),
    ];
    for (const text of texts) {
      // A command, not the prose "the Pulumi state".
      expect(text).not.toMatch(/pulumi (refresh|stack|state)/);
      expect(text).not.toContain('`');
      expect(text).not.toContain('—');
    }
    expect(texts[2]).toContain(
      'Before it drops the records of those creates, vibecarbon checks whether those servers exist, and the check failed (HTTP 503).',
    );
    expect(texts[1]).toContain(
      'Before it drops the record of that create, vibecarbon checks whether that server exists',
    );
    expect(texts[1]).toContain('(HTTP 503). The next deploy checks again.');
  });
});
