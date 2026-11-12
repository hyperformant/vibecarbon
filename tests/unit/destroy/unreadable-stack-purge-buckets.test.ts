/**
 * A k8s -purge destroy whose Pulumi state this project's passphrase cannot
 * open (settleUnreadableStacks), through the bucket steps that follow it.
 *
 * The keep rule is one rule (entryKeptReason), final before
 * delete-app-bucket. A record settleUnreadableStacks keeps (refused before
 * Pulumi ran, or refused by Pulumi when this clone made the passphrase, with
 * no clean backstop) keeps the environment's entry, so -purge keeps the app
 * and backups buckets and the state bucket for the rerun that can read the
 * record, and every rerun those lines name carries -purge. A record it
 * removes unread keeps nothing (`unreadable-stack`), so a clean -purge
 * deletes every bucket and moves the entry, as any clean -purge does.
 *
 * The real destroyK8sInfra effect runs against a provider whose sweeps all
 * succeed, then the bucket steps and the config write in their plan order
 * (destroy-plan.js k8sTail).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const APP = 'myapp-cd9ecc-staging-storage';
const STATE = 'myapp-cd9ecc-storage-pulumi-state-aaaaaa';
const BACKUPS = 'myapp-cd9ecc-fsn1-backups';

const world: { backstop: boolean; pulumiError: Error; madeHere: boolean } = {
  backstop: false,
  pulumiError: new Error('unset'),
  madeHere: false,
};

vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const noop = () => {};
  return {
    ...actual,
    log: { warn: noop, error: noop, info: noop, success: noop, message: noop, step: noop },
  };
});

const store = projectConfigStore();
vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      store.updateProjectConfig(fn),
  };
});

const s3 = {
  deletePrefix: vi.fn(async (_b: string, _p: string) => ({ objectsRemoved: 4 })),
  emptyAndDeleteBucket: vi.fn(async (_b: string) => ({
    deleted: true,
    objectsRemoved: 2,
    warnings: [],
  })),
  locateBucket: vi.fn(async (_b: string): Promise<string | null> => null),
  addressableRegions: vi.fn(() => ['fsn1', 'nbg1', 'hel1']),
  forRegion: vi.fn((_region: string) => s3),
};

/** A provider whose every sweep finds nothing left and succeeds. */
function FakeProvider() {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (prop === 'constructor') return FakeProvider;
        if (prop === 'listServersDetailed') return async () => ({ items: [], complete: true });
        if (prop === 'listVolumesDetailed') return async () => ({ items: [], complete: true });
        if (prop === 'deleteReservedIpsByLabels') return async () => ({ deleted: [], failed: [] });
        if (prop === 'serverLabels') return () => ({});
        if (prop === 'labelValue') return (_k: string, v: string) => v;
        if (/^(serverNetworkIds|serverVolumeIds)$/.test(prop)) return () => [];
        if (/^(delete|remove|destroy|detach|release)/.test(prop)) {
          return async () => ({ deleted: true, everExisted: false, apiError: null });
        }
        if (/^(list|find|get)/.test(prop)) return async () => [];
        return () => undefined;
      },
    },
  );
}
Object.assign(FakeProvider, {
  NAME: 'Hetzner Cloud',
  getPublicIP: () => null,
  promptObjectStorageCredentials: async () => ({ accessKey: 'ak', secretKey: 'sk' }),
});
Object.defineProperty(FakeProvider, 'K8S_DESTROY_BACKSTOP', { get: () => world.backstop });

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    providerFor: () => FakeProvider,
    getObjectStorageProvider: async () => s3,
  };
});

// A live cluster answers the PersistentVolume capture with nothing to
// collect, so the sweeps leave a clean ledger.
vi.mock('../../../src/lib/csi-volumes.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  captureClusterCsiVolumes: () => ({
    ok: true,
    volumes: [],
    volumeIds: [],
    regions: [],
    skippedDrivers: [],
  }),
}));

vi.mock('../../../src/lib/deploy/k8s/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyK8s: async () => {
      throw world.pulumiError;
    },
  };
});

const removeStackState = vi.fn(async (_stackEnv: string, _o: unknown) => ({ removed: true }));
vi.mock('../../../src/lib/iac/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, removeStackState: (e: string, o: unknown) => removeStackState(e, o) };
});

// Whether this clone made the passphrase (git and the process are out of this test).
vi.mock('../../../src/lib/state-passphrase.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    statePassphraseProvenance: () =>
      world.madeHere
        ? { madeHere: true, thisRun: false, head: 'committed', untracked: false }
        : { madeHere: false, thisRun: false, head: 'no-git' },
  };
});

const { StatePassphraseError } = await import('../../../src/lib/state-passphrase.js');
const { DESTROY_EFFECTS, entryKeptReason } = await import('../../../src/destroy.js');

/** Pulumi refused the passphrase it was given (StateUndecryptableError). */
function pulumiRefused() {
  const err = new Error('Couldn’t decrypt the Pulumi state for staging');
  err.name = 'StateUndecryptableError';
  return err;
}

/** The project's only environment: a k8s cluster, its own app bucket, its region's backups. */
function project() {
  return {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    stateBucketGeneration: 'aaaaaa',
    environments: {
      staging: {
        provider: 'hetzner',
        envName: 'staging',
        deployMode: 'k8s',
        status: 'deployed',
        region: 'nbg1',
        servers: [],
        s3: { bucket: APP, stateBucket: STATE, region: 'fsn1' },
        backupS3: { bucket: BACKUPS, region: 'fsn1' },
      },
    },
  };
}

function destroyCtx() {
  const projectConfig = project();
  store.reset(structuredClone(projectConfig));
  const stops: string[] = [];
  const spinner = {
    start: () => {},
    stop: (m?: string) => stops.push(m ?? ''),
    message: () => {},
  };
  return {
    ctx: {
      plan: {
        tier: 'k8s',
        stackEnvs: ['staging'],
        hasPulumiStack: true,
        clusterNames: ['myapp-staging'],
        ownedIps: [],
      },
      envConfig: projectConfig.environments.staging,
      projectConfig,
      environment: 'staging',
      args: { purgeBackups: true },
      providerToken: 'tok',
      results: {
        leaks: createLeakLedger(),
        servers: [] as string[],
        firewalls: [] as string[],
        sshKeys: [] as string[],
        dns: [] as string[],
        healthChecks: [] as string[],
        volumes: [] as string[],
        loadBalancers: [] as string[],
        unreleasedReservedIps: [] as string[],
        pulumiDestroyFailed: false,
      } as Record<string, unknown> & { leaks: ReturnType<typeof createLeakLedger> },
      spinner,
      tracker: { spinner: () => spinner },
      cwd: '/tmp/vibecarbon-unreadable-purge-nowhere',
      isK8s: true,
    },
    stops,
  };
}

type Ctx = ReturnType<typeof destroyCtx>['ctx'];
const effect = (name: string) =>
  (DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>)[name];

/** The teardown, then the bucket steps and the config write, in plan order. */
async function destroyWithPurge(ctx: Ctx) {
  await effect('destroyK8sInfra')(ctx, {});
  await effect('deleteAppBucket')(ctx, {});
  await effect('retainStateBucket')(ctx, {});
  await effect('handleBackupBucket')(ctx, {});
  await effect('updateProjectConfig')(ctx, {});
}

/** Every destroy rerun named in the leak report's hints and the spinner lines. */
function reruns(ctx: Ctx, stops: string[]) {
  const text = [
    ...ctx.results.leaks.entries.map((e: { hint?: string }) => e.hint ?? ''),
    ...stops,
  ].join('\n');
  return [...text.matchAll(/`(vibecarbon destroy[^`]*)`/g)].map((m) => m[1]);
}

type Saved = {
  environments: Record<string, unknown>;
  destroyedEnvironments?: Record<string, { appBucketPurged?: boolean; backupsPurged?: boolean }>;
};
const onDisk = () => (store.lastWrite() ?? store.state.disk) as unknown as Saved;

beforeEach(() => {
  world.backstop = false;
  world.madeHere = false;
  s3.deletePrefix.mockClear();
  s3.emptyAndDeleteBucket.mockClear();
  removeStackState.mockClear();
});

describe('a -purge destroy whose stack record settleUnreadableStacks keeps', () => {
  it.each([
    ['refused before Pulumi ran (missing)', () => new StatePassphraseError('missing', 'unset')],
    [
      'refused before Pulumi ran (mismatch, shell)',
      () => new StatePassphraseError('mismatch', 'x', 'shell'),
    ],
    [
      'refused by Pulumi, passphrase made in this clone',
      () => {
        world.madeHere = true;
        return pulumiRefused();
      },
    ],
  ])('%s: keeps every bucket and the entry, and every rerun carries -purge', async (_, error) => {
    world.pulumiError = error();
    const { ctx, stops } = destroyCtx();
    await destroyWithPurge(ctx);

    expect(removeStackState).not.toHaveBeenCalled();
    const stack = ctx.results.leaks.entries.filter(
      (e: { resourceClass: string }) => e.resourceClass === 'pulumi-stack',
    );
    expect(stack).toHaveLength(1);
    expect(entryKeptReason(ctx.results, ctx.envConfig)).toMatchObject({ unverified: true });

    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(ctx.results.appBucketPurged).toBeUndefined();
    expect(ctx.results.backupsPurged).toBeUndefined();
    expect(onDisk().environments.staging).toBeDefined();
    expect(onDisk().destroyedEnvironments?.staging).toBeUndefined();

    const named = reruns(ctx, stops);
    expect(stack[0].hint).toContain('`vibecarbon destroy staging -purge` again');
    expect(named.length).toBeGreaterThan(2);
    expect(new Set(named)).toEqual(new Set(['vibecarbon destroy staging -purge']));
  });
});

describe('a -purge destroy whose stack record settleUnreadableStacks removes unread', () => {
  it.each([
    ['refused by Pulumi, no backstop', false, pulumiRefused],
    ['refused by Pulumi, clean backstop', true, pulumiRefused],
    [
      'refused before Pulumi ran, clean backstop',
      true,
      () => new StatePassphraseError('missing', 'unset'),
    ],
  ])('%s: deletes every bucket and moves the entry', async (_, backstop, error) => {
    world.backstop = backstop;
    world.pulumiError = error();
    const { ctx } = destroyCtx();
    await destroyWithPurge(ctx);

    expect(removeStackState.mock.calls.map(([e]) => e)).toEqual(['staging']);
    expect(entryKeptReason(ctx.results, ctx.envConfig)).toBeNull();
    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, 'backups/myapp/staging/');
    expect(s3.emptyAndDeleteBucket.mock.calls.map(([b]) => b)).toEqual([APP, STATE, BACKUPS]);
    const saved = onDisk();
    expect(saved.environments.staging).toBeUndefined();
    expect(saved.destroyedEnvironments?.staging).toMatchObject({
      appBucketPurged: true,
      backupsPurged: true,
    });
  });
});
