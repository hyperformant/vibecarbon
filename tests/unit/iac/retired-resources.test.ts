/**
 * The retired-resource surgery (lib/iac/retired-resources.js) on the state
 * shapes it meets, and where upStack runs it.
 *
 * A DigitalOcean k8s cluster made before 2026-11 holds a reserved IP
 * (`ReservedIp('ingress')`) assigned to its master
 * (`ReservedIpAssignment('ingress-assignment')`); today's program declares
 * neither. Every up and preview takes both out of the stack's state first, so
 * Pulumi never deletes them: the address stays assigned and serving until the
 * deploy has seen DNS move off it and releases it by address.
 *
 * The engine-level proof (import accepted, nothing planned, the IP still
 * assigned) is tests/integration/iac/retired-resources-surgery.test.ts; these
 * pin the transform on a DigitalOcean checkpoint's real shape, and the wiring.
 */
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectStackMock = vi.fn();
const progressLogMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called: it would clobber real state');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));
vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (...args: unknown[]) => progressLogMock(...args),
}));
// upStack opens the stack through getOrCreateStack, whose real passphrase
// check would write a passphrase into the cwd's .env.local and
// .vibecarbon.json (the repo root here), so it is stubbed;
// state-passphrase-census.test.ts covers the real wiring.
vi.mock('../../../src/lib/state-passphrase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async () => 'test-passphrase',
}));

const { dropStackResources } = await import('../../../src/lib/iac/retired-resources.js');
const { __resetStateProbesForTests, dropRetiredStackResources, upStack } = await import(
  '../../../src/lib/iac/index.js'
);
const { StackHeldError } = await import('../../../src/lib/iac/stack-lock.js');
const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');

beforeEach(() => {
  selectStackMock.mockReset();
  progressLogMock.mockReset();
  // Each test's upStack is the stack's first open in the process: its
  // passphrase probe is the export the surgery and the refresh check read.
  __resetStateProbesForTests();
});

const P = 'urn:pulumi:prod::acme';
const STACK = `${P}::pulumi:pulumi:Stack::acme-prod`;
const PROVIDER = `${P}::pulumi:providers:digitalocean::default_4_76_0`;
const FIREWALL = `${P}::digitalocean:index/firewall:Firewall::firewall`;
const MASTER = `${P}::digitalocean:index/droplet:Droplet::master`;
const DB = `${P}::digitalocean:index/droplet:Droplet::db`;
const IP = `${P}::digitalocean:index/reservedIp:ReservedIp::ingress`;
const ASSIGN = `${P}::digitalocean:index/reservedIpAssignment:ReservedIpAssignment::ingress-assignment`;

/** A DigitalOcean k8s checkpoint as the program before 2026-11 left it. */
function doCheckpoint({ ip = true, assignment = true } = {}) {
  return {
    version: 3,
    deployment: {
      manifest: { time: '2026-10-01T00:00:00Z', magic: 'x', version: 'v3.259.0' },
      resources: [
        {
          urn: STACK,
          custom: false,
          type: 'pulumi:pulumi:Stack',
          outputs: { floatingIp: '203.0.113.9' },
        },
        { urn: PROVIDER, custom: true, id: 'prov-1', type: 'pulumi:providers:digitalocean' },
        {
          urn: FIREWALL,
          custom: true,
          id: 'fw-1',
          type: 'digitalocean:index/firewall:Firewall',
          parent: STACK,
          provider: `${PROVIDER}::prov-1`,
        },
        {
          urn: MASTER,
          custom: true,
          id: '5000001',
          type: 'digitalocean:index/droplet:Droplet',
          parent: STACK,
          dependencies: [FIREWALL],
          propertyDependencies: { vpcUuid: [], tags: [FIREWALL] },
          provider: `${PROVIDER}::prov-1`,
        },
        ...(ip
          ? [
              {
                urn: IP,
                custom: true,
                id: '203.0.113.9',
                type: 'digitalocean:index/reservedIp:ReservedIp',
                inputs: { region: 'nyc3' },
                outputs: { ipAddress: '203.0.113.9', region: 'nyc3' },
                parent: STACK,
                provider: `${PROVIDER}::prov-1`,
              },
            ]
          : []),
        ...(assignment
          ? [
              {
                urn: ASSIGN,
                custom: true,
                id: '203.0.113.9-5000001-20261001',
                type: 'digitalocean:index/reservedIpAssignment:ReservedIpAssignment',
                inputs: { dropletId: 5000001, ipAddress: '203.0.113.9' },
                parent: STACK,
                dependencies: [...(ip ? [IP] : []), MASTER],
                propertyDependencies: { ipAddress: ip ? [IP] : [], dropletId: [MASTER] },
                provider: `${PROVIDER}::prov-1`,
              },
            ]
          : []),
        {
          urn: DB,
          custom: true,
          id: '5000002',
          type: 'digitalocean:index/droplet:Droplet',
          parent: STACK,
          dependencies: [MASTER],
          propertyDependencies: { userData: [MASTER] },
          provider: `${PROVIDER}::prov-1`,
        },
      ],
    },
  };
}

const RETIRED = DigitalOceanProvider.RETIRED_STACK_RESOURCES;
const urns = (state: { deployment: { resources: { urn: string }[] } }) =>
  state.deployment.resources.map((r) => r.urn);

describe('RETIRED_STACK_RESOURCES', () => {
  it("DigitalOcean: the old program's reserved IP and its assignment, by type and name", () => {
    expect(RETIRED).toEqual([
      { type: 'digitalocean:index/reservedIp:ReservedIp', name: 'ingress' },
      {
        type: 'digitalocean:index/reservedIpAssignment:ReservedIpAssignment',
        name: 'ingress-assignment',
      },
    ]);
  });

  it('every other provider: none (Linode and Hetzner still use their ingress IP)', () => {
    for (const [id, Provider] of Object.entries(PROVIDERS)) {
      if (id === 'digitalocean') continue;
      expect(
        (Provider as { RETIRED_STACK_RESOURCES: unknown[] }).RETIRED_STACK_RESOURCES,
        id,
      ).toEqual([]);
    }
  });
});

describe('dropStackResources', () => {
  it('both present: removes both, and leaves every other resource as it was', () => {
    const before = doCheckpoint();
    const { deployment, removed, addresses } = dropStackResources(before, RETIRED);
    expect(removed.sort()).toEqual([ASSIGN, IP].sort());
    // The address the IP held, once: the record the release reads it from.
    expect(addresses).toEqual(['203.0.113.9']);
    expect(urns(deployment)).toEqual([STACK, PROVIDER, FIREWALL, MASTER, DB]);
    // Untouched resources are byte-identical; the input is not mutated.
    expect(deployment.deployment.resources.find((r: { urn: string }) => r.urn === DB)).toEqual(
      before.deployment.resources.find((r) => r.urn === DB),
    );
    expect(urns(before)).toContain(IP);
  });

  it('only the IP present (its assignment already gone): removes the IP', () => {
    const { deployment, removed } = dropStackResources(
      doCheckpoint({ assignment: false }),
      RETIRED,
    );
    expect(removed).toEqual([IP]);
    expect(urns(deployment)).not.toContain(IP);
  });

  it('only the assignment present: removes the assignment', () => {
    const { deployment, removed } = dropStackResources(doCheckpoint({ ip: false }), RETIRED);
    expect(removed).toEqual([ASSIGN]);
    expect(urns(deployment)).toEqual([STACK, PROVIDER, FIREWALL, MASTER, DB]);
  });

  it('none present: nothing removed, content unchanged', () => {
    const state = doCheckpoint({ ip: false, assignment: false });
    const { deployment, removed, addresses } = dropStackResources(state, RETIRED);
    expect(removed).toEqual([]);
    expect(addresses).toEqual([]);
    expect(deployment).toEqual(state);
  });

  it('idempotent: a second pass removes nothing', () => {
    const once = dropStackResources(doCheckpoint(), RETIRED).deployment;
    const twice = dropStackResources(once, RETIRED);
    expect(twice.removed).toEqual([]);
    expect(twice.deployment).toEqual(once);
  });

  it('no references to a removed URN survive: dependencies, propertyDependencies, deletedWith, parent, pending ops', () => {
    const state = doCheckpoint();
    const resources = state.deployment.resources as Record<string, unknown>[];
    // A resource that waited on, read from, was deleted with, and was parented
    // to the removed ones; and a pending operation a crashed run left on one.
    resources.push({
      urn: `${P}::digitalocean:index/reservedIp:ReservedIp$digitalocean:index/tag:Tag::note`,
      custom: true,
      id: 'note',
      type: 'digitalocean:index/tag:Tag',
      parent: IP,
      dependencies: [ASSIGN, MASTER],
      propertyDependencies: { name: [IP], other: [MASTER] },
      deletedWith: IP,
    });
    (state.deployment as Record<string, unknown>).pending_operations = [
      { resource: { urn: ASSIGN, type: 'x' }, type: 'creating' },
      { resource: { urn: MASTER, type: 'x' }, type: 'updating' },
    ];
    const { deployment } = dropStackResources(state, RETIRED);
    const text = JSON.stringify(deployment);
    expect(text).not.toContain(IP);
    expect(text).not.toContain('::ingress-assignment');
    const note = deployment.deployment.resources.at(-1);
    expect(note.dependencies).toEqual([MASTER]);
    expect(note.propertyDependencies).toEqual({ name: [], other: [MASTER] });
    expect(note).not.toHaveProperty('deletedWith');
    expect(note.parent).toBe(STACK);
    expect(deployment.deployment.pending_operations).toEqual([
      { resource: { urn: MASTER, type: 'x' }, type: 'updating' },
    ]);
  });

  it('matches by type AND name: a same-named resource of another type stays', () => {
    const state = doCheckpoint({ ip: false, assignment: false });
    (state.deployment.resources as Record<string, unknown>[]).push({
      urn: `${P}::linode:index/reservedIp:ReservedIp::ingress`,
      custom: true,
      id: '1',
      type: 'linode:index/reservedIp:ReservedIp',
    });
    expect(dropStackResources(state, RETIRED).removed).toEqual([]);
  });
});

/** A stack whose state calls land in `order`. */
function fakeStack(state: unknown, order: string[] = [], over: Record<string, unknown> = {}) {
  return {
    name: 'prod',
    exportStack: vi.fn(async () => {
      order.push('export');
      return structuredClone(state);
    }),
    importStack: vi.fn(async () => {
      order.push('import');
    }),
    refresh: vi.fn(async () => {
      order.push('refresh');
    }),
    up: vi.fn(async () => {
      order.push('up');
      return { outputs: { masterIp: { value: '198.51.100.7' } }, summary: {} };
    }),
    ...over,
  };
}

/** A pid that has exited. */
const deadPid = () => spawnSync('true').pid;

/** Pulumi's error for a stack another run holds, as stack-lock.test.ts spells it. */
const lockedError = (holder: string, at = new Date().toISOString()) =>
  new Error(
    'code: 255\n stdout: \n stderr: error: the stack is currently locked by 1 lock(s). Either wait ' +
      'for the other process(es) to end or delete the lock file with `pulumi cancel`.\n' +
      `  s3://b/.pulumi/locks/organization/p/s/u.json?endpoint=https://x&region=y: created by ${holder} at ${at}\n`,
  );

describe('dropRetiredStackResources', () => {
  it('DigitalOcean: imports the state without them, and says so', async () => {
    const stack = fakeStack(doCheckpoint());
    const { removed, addresses, deployment } = await dropRetiredStackResources(
      stack as never,
      'digitalocean',
    );
    expect(removed.sort()).toEqual([ASSIGN, IP].sort());
    expect(addresses).toEqual(['203.0.113.9']);
    expect(stack.importStack).toHaveBeenCalledOnce();
    expect(urns(stack.importStack.mock.calls[0][0])).toEqual([
      STACK,
      PROVIDER,
      FIREWALL,
      MASTER,
      DB,
    ]);
    // The state as it now stands, for the caller to reuse.
    expect(deployment).toEqual(stack.importStack.mock.calls[0][0]);
    expect(progressLogMock.mock.calls.flat().join('\n')).toContain(
      'ingress and ingress-assignment',
    );
  });

  it('records the addresses it takes out before the import, so the record keeps them', async () => {
    const order: string[] = [];
    const stack = fakeStack(doCheckpoint(), order);
    const recordAddresses = vi.fn((addresses: string[]) => {
      order.push(`record ${addresses.join(',')}`);
    });
    await dropRetiredStackResources(stack as never, 'digitalocean', { recordAddresses });
    expect(order).toEqual(['export', 'record 203.0.113.9', 'import']);
  });

  it('a recorder that fails stops before the import: the stack keeps the only record', async () => {
    const stack = fakeStack(doCheckpoint());
    const recordAddresses = vi.fn(() => {
      throw new Error('EACCES: .vibecarbon.json');
    });
    await expect(
      dropRetiredStackResources(stack as never, 'digitalocean', { recordAddresses }),
    ).rejects.toThrow(/Pulumi was not run.*EACCES/s);
    expect(stack.importStack).not.toHaveBeenCalled();
  });

  it('nothing to remove: no import, no record, and the exported state comes back', async () => {
    const state = doCheckpoint({ ip: false, assignment: false });
    const stack = fakeStack(state);
    const recordAddresses = vi.fn();
    const result = await dropRetiredStackResources(stack as never, 'digitalocean', {
      recordAddresses,
    });
    expect(result.removed).toEqual([]);
    expect(result.deployment).toEqual(state);
    expect(stack.importStack).not.toHaveBeenCalled();
    expect(recordAddresses).not.toHaveBeenCalled();
  });

  it('a provider with nothing retired: not even an export', async () => {
    const stack = fakeStack(doCheckpoint());
    for (const id of ['hetzner', 'linode', 'vultr', 'scaleway']) {
      expect(await dropRetiredStackResources(stack as never, id)).toEqual({
        removed: [],
        addresses: [],
        deployment: null,
      });
    }
    expect(stack.exportStack).not.toHaveBeenCalled();
  });

  it('an unreadable or unwritable state throws: the up must not run on it', async () => {
    const unreadable = fakeStack(doCheckpoint(), [], {
      exportStack: vi.fn(async () => {
        throw new Error('blob (code=Unknown): connection reset');
      }),
    });
    await expect(dropRetiredStackResources(unreadable as never, 'digitalocean')).rejects.toThrow(
      /Pulumi was not run.*Nothing changed in the cloud/s,
    );
    const unwritable = fakeStack(doCheckpoint(), [], {
      importStack: vi.fn(async () => {
        throw new Error('error: state file contains errors');
      }),
    });
    await expect(dropRetiredStackResources(unwritable as never, 'digitalocean')).rejects.toThrow(
      /state file contains errors/,
    );
  });

  // The import takes the stack's lock, like every other write.
  it('a lock left by a dead run on this machine is cleared, and the surgery goes on', async () => {
    const importStack = vi
      .fn()
      .mockRejectedValueOnce(lockedError(`u@${hostname()} (pid ${deadPid()})`))
      .mockResolvedValueOnce(undefined);
    const cancel = vi.fn(async () => {});
    const stack = fakeStack(doCheckpoint(), [], { importStack, cancel });
    const { removed } = await dropRetiredStackResources(stack as never, 'digitalocean');
    expect(removed.sort()).toEqual([ASSIGN, IP].sort());
    expect(cancel).toHaveBeenCalledOnce();
    expect(importStack).toHaveBeenCalledTimes(2);
  });

  it('a lock a live run holds stops with StackHeldError, unchanged, and is never cleared', async () => {
    const importStack = vi.fn(async () => {
      throw lockedError('someone@another-laptop (pid 123)');
    });
    const cancel = vi.fn(async () => {});
    const stack = fakeStack(doCheckpoint(), [], { importStack, cancel });
    const err = await dropRetiredStackResources(stack as never, 'digitalocean').catch((e) => e);
    expect(err).toBeInstanceOf(StackHeldError);
    expect(err.message).toMatch(/in use by another run: someone@another-laptop \(pid 123\)/);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('upStack runs the surgery before the refresh and the up', () => {
  it('DigitalOcean: export, import, then refresh and up', async () => {
    const order: string[] = [];
    const stack = fakeStack(doCheckpoint(), order);
    selectStackMock.mockResolvedValue(stack);
    await upStack('prod', () => ({}), { projectName: 'acme', provider: 'digitalocean' });
    expect(order.indexOf('import')).toBeGreaterThan(-1);
    expect(order.indexOf('import')).toBeLessThan(order.indexOf('refresh'));
    expect(order.indexOf('refresh')).toBeLessThan(order.indexOf('up'));
  });

  it("DigitalOcean: one export (the open's passphrase probe) serves the surgery and the refresh check", async () => {
    const order: string[] = [];
    const stack = fakeStack(doCheckpoint(), order);
    selectStackMock.mockResolvedValue(stack);
    await upStack('prod', () => ({}), { projectName: 'acme', provider: 'digitalocean' });
    // The read after the refresh is the Vultr repair's, on every provider.
    const beforeRefresh = order.slice(0, order.indexOf('refresh'));
    expect(beforeRefresh.filter((op) => op === 'export')).toHaveLength(1);
    expect(stack.refresh).toHaveBeenCalledOnce();
  });

  it('hands the addresses the surgery takes out to the caller before the import', async () => {
    const order: string[] = [];
    const stack = fakeStack(doCheckpoint(), order);
    selectStackMock.mockResolvedValue(stack);
    const recordRetiredAddresses = vi.fn((addresses: string[]) => {
      order.push(`record ${addresses.join(',')}`);
    });
    await upStack('prod', () => ({}), {
      projectName: 'acme',
      provider: 'digitalocean',
      recordRetiredAddresses,
    });
    expect(order.slice(0, 3)).toEqual(['export', 'record 203.0.113.9', 'import']);
  });

  it('a failed surgery stops before the refresh: Pulumi never runs', async () => {
    const order: string[] = [];
    const stack = fakeStack(doCheckpoint(), order, {
      importStack: vi.fn(async () => {
        throw new Error('error: state file contains errors');
      }),
    });
    selectStackMock.mockResolvedValue(stack);
    await expect(
      upStack('prod', () => ({}), { projectName: 'acme', provider: 'digitalocean' }),
    ).rejects.toThrow(/Pulumi was not run/);
    expect(stack.refresh).not.toHaveBeenCalled();
    expect(stack.up).not.toHaveBeenCalled();
  });

  it('Hetzner: no import, the up as before', async () => {
    const order: string[] = [];
    const stack = fakeStack(doCheckpoint(), order);
    selectStackMock.mockResolvedValue(stack);
    await upStack('prod', () => ({}), { projectName: 'acme', provider: 'hetzner' });
    expect(stack.importStack).not.toHaveBeenCalled();
    expect(order).toContain('up');
  });
});
