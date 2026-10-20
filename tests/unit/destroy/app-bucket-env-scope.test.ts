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
};

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

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');

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
  steps: Array<'deleteAppBucket' | 'retainStateBucket' | 'handleBackupBucket'> = [
    'deleteAppBucket',
  ],
  isK8s = false,
) {
  const messages: string[] = [];
  const results: Record<string, unknown> = { leaks: createLeakLedger(), s3Bucket: null };
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
