/**
 * Each environment has its own app bucket (`<project>-<salt>-<env>-storage`),
 * while the backup bucket and the Pulumi state bucket stay per project.
 *
 * Plain destroy keeps the env's app bucket and its uploads, the same way it
 * keeps that env's database backups: uploads and backups are kept or purged
 * together. `-purge` empties and deletes the env's own bucket, purges only
 * that env's backup folder, and deletes the shared backup and state buckets
 * only with the last environment. Destroy never touches the bucket's CORS
 * rule, which deploy owns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const PROD_BUCKET = 'myapp-cd9ecc-prod-storage';
const STAGING_BUCKET = 'myapp-cd9ecc-staging-storage';
const BACKUPS = 'myapp-cd9ecc-backups';
const STATE = 'myapp-cd9ecc-storage-pulumi-state-aaaaaa';

const s3 = {
  deletePrefix: vi.fn(async (_b: string, _p: string) => ({ objectsRemoved: 3 })),
  emptyAndDeleteBucket: vi.fn(async (_b: string) => ({
    deleted: true,
    objectsRemoved: 2,
    warnings: [],
  })),
  getBucketCorsOrigins: vi.fn(async (_b: string) => [] as string[]),
  setBucketCors: vi.fn(async (_b: string, _o: string[]) => {}),
  // Every region is asked (S3CompatibleProvider.locateBucket).
  locateBucket: vi.fn(async (_b: string): Promise<string | null> => null),
  forRegion: vi.fn((_region: string) => s3),
};
const noSuchBucket = () =>
  Object.assign(new Error('The specified bucket does not exist'), {
    name: 'NoSuchBucket',
    $metadata: { httpStatusCode: 404 },
  });

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    providerFor: () => ({
      NAME: 'Hetzner Cloud',
      promptObjectStorageCredentials: async () => ({ accessKey: 'ak', secretKey: 'sk' }),
    }),
    getObjectStorageProvider: async () => s3,
  };
});

const store = projectConfigStore();
vi.mock('../../../src/lib/config.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      store.updateProjectConfig(fn),
  };
});

const { DESTROY_EFFECTS, destroyPreviewBucketFacts } = await import('../../../src/destroy.js');

function env(name: string, bucket: string) {
  return {
    provider: 'hetzner',
    envName: name,
    deployMode: 'compose',
    status: 'deployed',
    domain: `${name}.dev`,
    s3: { bucket, region: 'fsn1', stateBucket: STATE },
    backupS3: { bucket: BACKUPS, region: 'fsn1' },
  };
}

function project(names: Array<'prod' | 'staging'>) {
  const buckets = { prod: PROD_BUCKET, staging: STAGING_BUCKET };
  return {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    stateBucketGeneration: 'aaaaaa',
    environments: Object.fromEntries(names.map((n) => [n, env(n, buckets[n])])) as Record<
      string,
      ReturnType<typeof env>
    >,
  };
}

/** Run the three bucket steps of the destroy tail, in plan order. */
async function destroy(
  projectConfig: ReturnType<typeof project>,
  environment: string,
  args: Record<string, unknown> = {},
  steps: Array<
    'deleteAppBucket' | 'retainStateBucket' | 'handleBackupBucket' | 'updateProjectConfig'
  > = ['deleteAppBucket'],
  isK8s = false,
) {
  const messages: string[] = [];
  const results: Record<string, unknown> = { leaks: createLeakLedger(), s3Bucket: null };
  // The file as the destroy loaded it, for the record the last step writes.
  store.reset(structuredClone(projectConfig));
  const ctx = {
    envConfig: projectConfig.environments[environment],
    projectConfig,
    environment,
    args,
    results,
    spinner: {
      start: (m?: string) => messages.push(`start:${m ?? ''}`),
      stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
      message: (m?: string) => messages.push(`message:${m ?? ''}`),
    },
    isK8s,
  };
  for (const step of steps) await DESTROY_EFFECTS[step](ctx);
  return { results, text: messages.join('\n') };
}

const ALL_BUCKET_STEPS = ['deleteAppBucket', 'retainStateBucket', 'handleBackupBucket'] as const;
const calledBuckets = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((c) => c[0]);
const noSurvivors = (results: Record<string, unknown>) =>
  expect((results.leaks as ReturnType<typeof createLeakLedger>).counts()).toMatchObject({
    leak: 0,
    unverified: 0,
  });

describe('destroy keeps or purges the environment’s own app bucket', () => {
  beforeEach(() => {
    for (const fn of Object.values(s3)) fn.mockClear();
  });

  it('destroy staging -purge deletes only staging’s bucket and backup folder, and keeps the shared buckets', async () => {
    const { results } = await destroy(
      project(['prod', 'staging']),
      'staging',
      { purgeBackups: true },
      [...ALL_BUCKET_STEPS],
    );
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledTimes(1);
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(STAGING_BUCKET);
    expect(s3.deletePrefix).toHaveBeenCalledTimes(1);
    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, 'backups/myapp/staging/');
    const named = [...calledBuckets(s3.emptyAndDeleteBucket), ...calledBuckets(s3.deletePrefix)];
    expect(named).not.toContain(PROD_BUCKET);
    expect(named.filter((b) => b === BACKUPS || b === STATE)).toEqual([BACKUPS]);
    expect(results.s3Bucket).toBe(STAGING_BUCKET);
    expect(results.stateBucketPurged).toBeUndefined();
    noSurvivors(results);
  });

  it('plain destroy staging keeps its bucket and its uploads', async () => {
    const { results, text } = await destroy(project(['prod', 'staging']), 'staging');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(text).toContain(STAGING_BUCKET);
    expect(text).toContain('kept');
    expect(text).toContain('-purge');
    expect(results.s3Bucket).toBeNull();
    noSurvivors(results);
  });

  it('plain destroy of the last environment keeps its bucket too', async () => {
    const { results, text } = await destroy(project(['prod']), 'prod');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(text).toContain('kept');
    expect(results.s3Bucket).toBeNull();
  });

  it('the last environment with -purge deletes its app bucket, the backup bucket and the state bucket', async () => {
    const { results } = await destroy(project(['prod']), 'prod', { purgeBackups: true }, [
      ...ALL_BUCKET_STEPS,
    ]);
    expect(calledBuckets(s3.emptyAndDeleteBucket).sort()).toEqual(
      [PROD_BUCKET, STATE, BACKUPS].sort(),
    );
    expect(results.s3Bucket).toBe(PROD_BUCKET);
    expect(results.stateBucketPurged).toBe(true);
    noSurvivors(results);
  });

  it('destroy staging -purge never deletes a bucket that prod and staging both pin', async () => {
    const SHARED = 'myapp-cd9ecc-storage';
    const config = project(['prod', 'staging']);
    for (const e of Object.values(config.environments)) {
      Object.assign(e.s3, { bucket: SHARED, bucketPin: SHARED });
    }
    const { results, text } = await destroy(config, 'staging', { purgeBackups: true }, [
      ...ALL_BUCKET_STEPS,
    ]);
    expect(calledBuckets(s3.emptyAndDeleteBucket)).not.toContain(SHARED);
    expect(text).toContain(`S3 bucket kept (pinned): ${SHARED}`);
    expect(text).toContain('delete it manually');
    expect(results.s3Bucket).toBeNull();
    noSurvivors(results);
  });

  it('a single pinned environment with -purge keeps its pinned bucket', async () => {
    const PINNED = 'legacy-uploads';
    const config = project(['prod']);
    Object.assign(config.environments.prod.s3, { bucket: PINNED, bucketPin: PINNED });
    const { results, text } = await destroy(config, 'prod', { purgeBackups: true });
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(text).toContain(`S3 bucket kept (pinned): ${PINNED}`);
    expect(results.s3Bucket).toBeNull();
    noSurvivors(results);
  });

  it('destroy staging -purge keeps the per-project bucket an older CLI shared across environments', async () => {
    // Before per-environment app buckets every env persisted the project's
    // one bucket (`<project>-<salt>-storage`, or `...-storage-<gen>`), with no
    // pin. Deleting it would delete prod's uploads too.
    for (const SHARED of ['myapp-cd9ecc-storage', 'myapp-cd9ecc-storage-0f1e2d']) {
      s3.emptyAndDeleteBucket.mockClear();
      const config = project(['prod', 'staging']);
      for (const e of Object.values(config.environments)) e.s3.bucket = SHARED;
      const { results, text } = await destroy(config, 'staging', { purgeBackups: true });
      expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
      expect(text).toContain(`S3 bucket kept: ${SHARED}`);
      expect(text).toContain('delete it manually');
      expect(results.s3Bucket).toBeNull();
      noSurvivors(results);
    }
  });

  it('a single environment on a legacy bucket keeps it under -purge too', async () => {
    const config = project(['prod']);
    config.environments.prod.s3.bucket = 'myapp-cd9ecc-storage';
    const { text } = await destroy(config, 'prod', { purgeBackups: true });
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(text).toContain('S3 bucket kept: myapp-cd9ecc-storage');
  });

  it('never reads or writes the bucket CORS rule', async () => {
    await destroy(project(['prod', 'staging']), 'staging');
    await destroy(project(['prod']), 'prod', { purgeBackups: true });
    expect(s3.getBucketCorsOrigins).not.toHaveBeenCalled();
    expect(s3.setBucketCors).not.toHaveBeenCalled();
  });

  it('an environment with no recorded bucket has nothing to delete, even on k8s', async () => {
    const config = project(['prod']);
    delete (config.environments.prod as Record<string, unknown>).s3;
    const { results, text } = await destroy(
      config,
      'prod',
      { purgeBackups: true },
      ['deleteAppBucket'],
      true,
    );
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(text).toBe('');
    noSurvivors(results);
  });
});

describe('the destroyed record says when -purge deleted the app bucket', () => {
  beforeEach(() => {
    for (const fn of Object.values(s3)) fn.mockClear();
  });
  const recordAfter = async (
    names: Array<'prod' | 'staging'>,
    args: Record<string, unknown>,
    tweak: (cfg: ReturnType<typeof project>) => void = () => {},
  ) => {
    const cfg = project(names);
    tweak(cfg);
    await destroy(cfg, 'staging', args, ['deleteAppBucket', 'updateProjectConfig']);
    return store.lastWrite()?.destroyedEnvironments?.staging;
  };

  it('a deleted bucket is marked, so the app key fence never asks about it again', async () => {
    expect(await recordAfter(['prod', 'staging'], { purgeBackups: true })).toMatchObject({
      s3: { bucket: STAGING_BUCKET },
      appBucketPurged: true,
    });
  });

  it('a bucket emptied but left as a shell for the orphan sweep is not marked: it still exists, so the fence keeps it', async () => {
    s3.emptyAndDeleteBucket.mockResolvedValueOnce({
      deleted: false,
      shellDeferred: true,
      objectsRemoved: 4,
      warnings: [],
    } as never);
    expect(await recordAfter(['prod', 'staging'], { purgeBackups: true })).not.toHaveProperty(
      'appBucketPurged',
    );
  });

  it('a bucket no region has is not marked: nothing was deleted', async () => {
    s3.emptyAndDeleteBucket.mockRejectedValueOnce(noSuchBucket());
    expect(await recordAfter(['prod', 'staging'], { purgeBackups: true })).not.toHaveProperty(
      'appBucketPurged',
    );
    expect(s3.locateBucket).toHaveBeenCalledWith(STAGING_BUCKET);
  });

  it('a plain destroy, and a -purge that keeps a pinned bucket, are not marked', async () => {
    expect(await recordAfter(['prod', 'staging'], {})).not.toHaveProperty('appBucketPurged');
    expect(
      await recordAfter(['prod', 'staging'], { purgeBackups: true }, (cfg) => {
        Object.assign(cfg.environments.staging.s3, { bucketPin: true });
      }),
    ).not.toHaveProperty('appBucketPurged');
  });
});

describe('-purge finds an app bucket its record puts in the wrong region (the old bug, before a redeploy)', () => {
  beforeEach(() => {
    for (const fn of Object.values(s3)) fn.mockClear();
  });

  it('deletes it where it is, says where, and marks the record', async () => {
    // staging's record says fsn1; its uploads bucket is in nbg1.
    s3.emptyAndDeleteBucket.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockResolvedValueOnce('nbg1');
    const { results, text } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    expect(s3.forRegion).toHaveBeenCalledWith('nbg1');
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledTimes(2);
    expect(results.appBucketPurged).toBe(true);
    expect(results.s3Bucket).toBe(STAGING_BUCKET);
    expect(text).toContain(
      'S3 bucket deleted in nbg1, not fsn1 as its record said (2 objects removed)',
    );
    expect(text).not.toContain('not found');
  });

  it('says not found only when no region has it', async () => {
    s3.emptyAndDeleteBucket.mockRejectedValueOnce(noSuchBucket());
    const { results, text } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    expect(s3.locateBucket).toHaveBeenCalledWith(STAGING_BUCKET);
    expect(s3.forRegion).not.toHaveBeenCalled();
    expect(results.appBucketPurged).toBeUndefined();
    expect(text).toContain('S3 bucket not found in any region (already deleted or never created)');
  });

  it('a region search that cannot answer leaves it, as a leak naming the region, never marked', async () => {
    s3.emptyAndDeleteBucket.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockRejectedValueOnce(
      new Error(
        `hel1 answered "AccessDenied" when asked whether it holds bucket ${STAGING_BUCKET}, so where the bucket is cannot be told`,
      ),
    );
    const { results } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    expect(results.appBucketPurged).toBeUndefined();
    const ledger = results.leaks as ReturnType<typeof createLeakLedger>;
    expect(ledger.entries[0]?.reason).toContain(`hel1 answered "AccessDenied"`);
  });
});

describe('destroyPreviewBucketFacts', () => {
  it('names the environment’s own bucket as owned, and a legacy or pinned one as not', () => {
    const config = project(['prod', 'staging']);
    expect(destroyPreviewBucketFacts(config, 'staging').appBucketOwned).toBe(true);
    config.environments.staging.s3.bucket = 'myapp-cd9ecc-storage';
    expect(destroyPreviewBucketFacts(config, 'staging').appBucketOwned).toBe(false);
    const pinned = project(['prod']);
    Object.assign(pinned.environments.prod.s3, { bucketPin: PROD_BUCKET });
    expect(destroyPreviewBucketFacts(pinned, 'prod').appBucketOwned).toBe(false);
  });

  it('says the backup bucket is held while another environment uses it', () => {
    expect(
      destroyPreviewBucketFacts(project(['prod', 'staging']), 'staging').backupBucketHeld,
    ).toBe(true);
    expect(destroyPreviewBucketFacts(project(['prod']), 'prod').backupBucketHeld).toBe(false);
    const withPreserved = {
      ...project(['prod']),
      destroyedEnvironments: { staging: { backupS3: { bucket: BACKUPS }, destroyedAt: 'x' } },
    };
    expect(destroyPreviewBucketFacts(withPreserved, 'prod').backupBucketHeld).toBe(true);
    const withPurged = {
      ...project(['prod']),
      destroyedEnvironments: {
        staging: { backupS3: { bucket: BACKUPS }, backupsPurged: true, destroyedAt: 'x' },
      },
    };
    expect(destroyPreviewBucketFacts(withPurged, 'prod').backupBucketHeld).toBe(false);
  });
});
