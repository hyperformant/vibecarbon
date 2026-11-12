/**
 * The unfinished creates the seal finds after a deploy's up (lib/iac/
 * state-pending.js): which ones the provider can be asked about, which
 * servers count as running untracked, and what the user reads. Where upStack
 * runs it (clear under the lock, then seal) is tests/unit/iac/state-seal.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const {
  classifyPendingCreates,
  forgetPendingReported,
  pendingCreatesBlock,
  pendingLookupFailed,
  pendingReported,
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

describe('classifyPendingCreates', () => {
  it.each([
    ['hcloud:index/server:Server', 'server', { name: 'p-e1-worker-1' }],
    ['digitalocean:index/droplet:Droplet', 'droplet', { name: 'p-e1-worker-1' }],
    ['vultr:index/instance:Instance', 'instance', { label: 'p-e1-worker-1' }],
    ['linode:index/instance:Instance', 'instance', { label: 'p-e1-worker-1' }],
    ['scaleway:instance/server:Server', 'server', { name: 'p-e1-worker-1' }],
  ])('%s: a server create, looked up by the name the program gave it', (type, noun, inputs) => {
    const { servers, others } = classifyPendingCreates(
      withOps([create(type, 'worker-1', { ...inputs, userData: TOKEN })]),
      SERVER_RESOURCE_TYPES,
    );
    expect(servers).toEqual([
      { urn: `urn:pulumi:e1::proj::${type}::worker-1`, noun, name: 'p-e1-worker-1' },
    ]);
    expect(others).toEqual([]);
    expect(JSON.stringify(servers)).not.toContain(TOKEN);
  });

  it('anything else is a create vibecarbon has no lookup for, named by its provider-side name', () => {
    const { servers, others } = classifyPendingCreates(
      withOps([
        create('hcloud:index/firewall:Firewall', 'fw', { name: 'p-e1-firewall' }),
        create('digitalocean:index/reservedIpAssignment:ReservedIpAssignment', 'ip', {}),
        create('linode:index/firewall:Firewall', 'lfw', { label: 'p-e1-fw' }),
        // A server whose inputs carry no name: nothing to ask the provider.
        create('hcloud:index/server:Server', 'nameless', { userData: TOKEN }),
        { type: 'updating', resource: { urn: 'urn:pulumi:e1::proj::x:y:Z::z', type: 'x:y:Z' } },
      ]),
      SERVER_RESOURCE_TYPES,
    );
    expect(servers).toEqual([]);
    expect(others.map((o) => `${o.what} ${o.name}`)).toEqual([
      'firewall p-e1-firewall',
      'reserved ip assignment ip',
      'firewall p-e1-fw',
      'server nameless',
      'z z',
    ]);
    expect(JSON.stringify(others)).not.toContain(TOKEN);
  });

  it('no pending operations: nothing either way', () => {
    expect(classifyPendingCreates({ deployment: {} }, SERVER_RESOURCE_TYPES)).toEqual({
      servers: [],
      others: [],
    });
  });
});

describe('untrackedServers', () => {
  const WORKER = { urn: 'u', noun: 'server', name: 'p-e1-worker-1' };
  const client = (answer: Record<string, Array<{ id: unknown }>>) => {
    const calls: unknown[][] = [];
    return {
      calls,
      findServersByName: async (name: string, options: { strict: boolean }) => {
        calls.push([name, options]);
        return answer[name] ?? [];
      },
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
      'p-e1-worker-1': [{ id: 21 }, { id: '0b1c-uuid' }, { id: 777 }],
    });
    expect(await untrackedServers([WORKER], state, SERVER_RESOURCE_TYPES, lookup)).toEqual([
      { ...WORKER, id: '777' },
    ]);
    expect(lookup.calls).toEqual([['p-e1-worker-1', { strict: true }]]);
  });

  it('one server listed under two pending creates is named once', async () => {
    const lookup = client({ 'p-e1-worker-1': [{ id: 5 }] });
    const found = await untrackedServers(
      [WORKER, { ...WORKER, urn: 'u2' }],
      { deployment: { resources: [] } },
      SERVER_RESOURCE_TYPES,
      lookup,
    );
    expect(found.map((s) => s.id)).toEqual(['5']);
  });

  it("a lookup that can't answer rejects: it never reads as no server", async () => {
    const failing = {
      findServersByName: async () => {
        throw new Error('HTTP 503');
      },
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
      const a = { urn: 'urn:a', what: 'firewall', name: 'a' };
      const b = { urn: 'urn:b', what: 'firewall', name: 'b' };
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

  it('servers running untracked and a resource it can look up neither, together', () => {
    const text = pendingCreatesBlock('e1', {
      untracked: [
        { urn: 'u1', noun: 'droplet', name: 'p-e1-worker-1', id: '11' },
        { urn: 'u2', noun: 'droplet', name: 'p-e1-worker-2', id: '12' },
      ],
      others: [{ urn: 'u3', what: 'firewall', name: 'p-e1-firewall' }],
      providerName: 'DigitalOcean',
    });
    expect(text).toBe(
      `${OPENING} An earlier run started creating the droplet p-e1-worker-1, the droplet p-e1-worker-2 ` +
        "and the firewall p-e1-firewall and didn't finish, and the state keeps a record of each create, " +
        'which has to go before vibecarbon can seal it. p-e1-worker-1 (id 11) and p-e1-worker-2 (id 12) ' +
        "are running in your account without Pulumi tracking them, so you're billed for them and no " +
        'vibecarbon command will remove them: delete them in your DigitalOcean console. Nothing in ' +
        'vibecarbon can look up the firewall p-e1-firewall, so check your DigitalOcean console for it ' +
        "and delete it if it's there. Then deploy again: the next deploy clears the records and seals the state.",
    );
  });

  it('never a raw pulumi command, never an em dash', () => {
    const texts = [
      pendingCreatesBlock('e1', {
        untracked: [{ urn: 'u', noun: 'server', name: 'n', id: '1' }],
        others: [],
        providerName: 'Hetzner Cloud',
      }),
      pendingLookupFailed('e1', [{ urn: 'u', noun: 'server', name: 'n' }], 'HTTP 503.'),
      pendingLookupFailed(
        'e1',
        [
          { urn: 'u', noun: 'server', name: 'a' },
          { urn: 'v', noun: 'server', name: 'b' },
        ],
        'HTTP 503',
      ),
    ];
    for (const text of texts) {
      // A command, not the prose "the Pulumi state".
      expect(text).not.toMatch(/pulumi (refresh|stack|state)/);
      expect(text).not.toContain('`');
      expect(text).not.toContain('—');
    }
    expect(texts[2]).toContain(
      'checks whether those servers exist, and the check failed (HTTP 503).',
    );
    expect(texts[1]).toContain('(HTTP 503). The next deploy checks again.');
  });
});
