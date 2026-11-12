/**
 * A -purge destroy that keeps the environment's entry (entryKeptReason)
 * keeps every bucket for the rerun, the way retainStateBucket keeps the state
 * bucket: the app bucket with its uploads, and this environment's backups.
 * A kept entry is a live environment, and another environment's fenced
 * deploy looks for every live record's buckets and stops when one is gone,
 * so nothing is deleted and no appBucketPurged or backupsPurged is written.
 * The clean rerun (`vibecarbon destroy <env> -purge`, which the kept line
 * names) deletes them and records both, as any clean -purge does.
 *
 * The steps run here in their plan order (destroy-plan.js composeTail).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const APP = 'myapp-cd9ecc-staging-storage';
const STATE = 'myapp-cd9ecc-storage-pulumi-state-aaaaaa';
const BACKUPS = 'myapp-cd9ecc-fsn1-backups';
const PREFIX = 'backups/myapp/staging/';

const store = projectConfigStore();
const KEYS = { accessKey: 'ak', secretKey: 'sk' };
const promptCreds = vi.fn(async () => KEYS as typeof KEYS | null);
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

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      store.updateProjectConfig(fn),
  };
});

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    providerFor: () => ({ NAME: 'Hetzner Cloud', promptObjectStorageCredentials: promptCreds }),
    getObjectStorageProvider: async () => s3,
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');

/** The project's only environment, with its own app bucket and its region's backups bucket. */
function project() {
  return {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    stateBucketGeneration: 'aaaaaa',
    environments: {
      staging: {
        provider: 'hetzner',
        envName: 'staging',
        deployMode: 'compose',
        status: 'deployed',
        s3: { bucket: APP, stateBucket: STATE, region: 'fsn1' },
        backupS3: { bucket: BACKUPS, region: 'fsn1' },
      },
    },
  };
}

/**
 * A -purge destroy's ctx. `kept` puts a line a rerun can act on in the
 * ledger, as a teardown that could not delete a server leaves: the entry is
 * kept. `purge: false` is a plain destroy.
 */
function destroyCtx({ kept = false, purge = true, unverified = false } = {}) {
  const projectConfig = project();
  store.reset(structuredClone(projectConfig));
  const leaks = createLeakLedger();
  if (kept) {
    leaks.leak({
      resourceClass: 'server',
      resource: 'myapp-staging-master',
      reason: 'delete failed: 503',
      hint: 'Delete it via the Hetzner Cloud console.',
    });
  }
  const stops: string[] = [];
  return {
    ctx: {
      envConfig: projectConfig.environments.staging,
      projectConfig,
      environment: 'staging',
      args: purge ? { purgeBackups: true } : {},
      results: { leaks, pulumiDestroyFailed: unverified } as Record<string, unknown> & {
        leaks: ReturnType<typeof createLeakLedger>;
      },
      spinner: {
        start: () => {},
        stop: (m?: string) => stops.push(m ?? ''),
        message: () => {},
      },
      isK8s: false,
    },
    stops,
  };
}

/** The bucket steps and the config write, in their plan order. */
async function bucketTail(ctx: ReturnType<typeof destroyCtx>['ctx']) {
  await DESTROY_EFFECTS.deleteAppBucket(ctx);
  await DESTROY_EFFECTS.retainStateBucket(ctx);
  await DESTROY_EFFECTS.handleBackupBucket(ctx);
  await DESTROY_EFFECTS.updateProjectConfig(ctx);
}

type Saved = {
  stateBucketGeneration?: string;
  environments: Record<string, unknown>;
  destroyedEnvironments?: Record<string, { appBucketPurged?: boolean; backupsPurged?: boolean }>;
};
const onDisk = () => (store.lastWrite() ?? store.state.disk) as unknown as Saved;

describe('a -purge destroy that keeps the entry keeps its buckets for the rerun', () => {
  beforeEach(() => {
    store.reset();
    promptCreds.mockClear();
    s3.deletePrefix.mockClear();
    s3.emptyAndDeleteBucket.mockClear();
  });

  it('deletes nothing, asks for no keys, and marks nothing purged', async () => {
    const { ctx } = destroyCtx({ kept: true });
    await bucketTail(ctx);

    expect(promptCreds).not.toHaveBeenCalled();
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(ctx.results.appBucketPurged).toBeUndefined();
    expect(ctx.results.backupsPurged).toBeUndefined();
    // Only the teardown's own line: keeping a bucket for the rerun is no leak.
    expect(ctx.results.leaks.entries.map((e) => e.resourceClass)).toEqual(['server']);

    const saved = onDisk();
    expect(saved.environments.staging).toBeDefined();
    expect(saved.destroyedEnvironments?.staging).toBeUndefined();
    expect(saved.stateBucketGeneration).toBe('aaaaaa');
  });

  it('says why each bucket is kept, and names the -purge rerun that deletes it', async () => {
    const { ctx, stops } = destroyCtx({ kept: true });
    await bucketTail(ctx);
    const because = 'the leak report lists what a re-run can still find and remove (server)';

    expect(stops).toContain(
      `S3 bucket kept with its uploads: ${APP}. This destroy keeps staging's entry because ` +
        `${because}, and a kept environment keeps its uploads; a clean ` +
        '`vibecarbon destroy staging -purge` deletes it then.',
    );
    expect(stops).toContain(
      `Backups kept: ${PREFIX} in ${BACKUPS}. This destroy keeps staging's entry because ` +
        `${because}, and a kept environment keeps its backups; a clean ` +
        '`vibecarbon destroy staging -purge` deletes them then.',
    );
    expect(stops).toContain(
      `Configuration kept: ${because}, so the next \`vibecarbon destroy staging -purge\` can retry`,
    );
  });

  it('the clean rerun deletes both buckets and records both marks', async () => {
    const first = destroyCtx({ kept: true });
    await bucketTail(first.ctx);
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();

    const { ctx } = destroyCtx();
    await bucketTail(ctx);

    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, PREFIX);
    expect(s3.emptyAndDeleteBucket.mock.calls.map(([b]) => b)).toEqual([APP, STATE, BACKUPS]);
    const saved = onDisk();
    expect(saved.environments.staging).toBeUndefined();
    expect(saved.destroyedEnvironments?.staging).toMatchObject({
      appBucketPurged: true,
      backupsPurged: true,
    });
  });

  it('an unverified Pulumi destroy keeps the buckets too, and its hint names the -purge rerun', async () => {
    const { ctx } = destroyCtx({ unverified: true });
    await bucketTail(ctx);

    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    const config = ctx.results.leaks.entries.find((e) => e.resourceClass === 'project-config');
    expect(config?.hint).toContain('re-run `vibecarbon destroy staging -purge`;');
  });

  it('a plain destroy that keeps the entry names a plain rerun', async () => {
    const { ctx, stops } = destroyCtx({ kept: true, purge: false });
    await bucketTail(ctx);

    expect(stops.join('\n')).toContain('so the next `vibecarbon destroy staging` can retry');
    expect(stops.join('\n')).not.toContain('-purge` can retry');
  });
});
