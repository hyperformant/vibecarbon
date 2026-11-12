/**
 * Each environment archives WAL-G under its own `backups/<project>/<env>/`
 * prefix in its storage region's backups bucket (one per project and region).
 * `-purge` on one environment removes only that prefix; the bucket itself
 * goes when no other environment, live or destroyed with its backups kept,
 * keeps backups in it (backupsBucketHolders). Plain destroy keeps everything
 * for recovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const BACKUPS = 'myapp-cd9ecc-backups';
const FSN1_BACKUPS = 'myapp-cd9ecc-fsn1-backups';

const s3 = {
  deletePrefix: vi.fn(async (_b: string, _p: string) => ({ objectsRemoved: 5 })),
  emptyAndDeleteBucket: vi.fn(async (_b: string) => ({
    deleted: true,
    objectsRemoved: 0,
    warnings: [],
  })),
  // Every region these Hetzner keys address is asked (S3CompatibleProvider.locateBucket).
  locateBucket: vi.fn(async (_b: string): Promise<string | null> => null),
  addressableRegions: vi.fn(() => ['fsn1', 'nbg1', 'hel1']),
  // The same fake at another region; the region is logged with the others.
  forRegion: vi.fn((region: string) => {
    storageClients.push(region);
    return s3;
  }),
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
      OBJECT_STORAGE_ENV: ['HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY'],
      promptObjectStorageCredentials: async () => credentials.value,
    }),
    getObjectStorageProvider: async (...args: unknown[]) => {
      storageClients.push(args[3] as string);
      return s3;
    },
  };
});
/** The region of every storage client the destroy built, in order. */
const storageClients: string[] = [];
/** What the object-storage credential prompt returns: null when none are available. */
const KEYS = { accessKey: 'ak', secretKey: 'sk' };
const credentials: { value: typeof KEYS | null } = { value: KEYS };

const store = projectConfigStore();
const saved = { configs: store.state.writes };
vi.mock('../../../src/lib/config.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      store.updateProjectConfig(fn),
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');

function env(
  name: string,
  backupS3: Record<string, unknown> = { bucket: BACKUPS, region: 'fsn1' },
) {
  return {
    provider: 'hetzner',
    envName: name,
    deployMode: 'compose',
    status: 'deployed',
    backupS3,
  };
}

/** An environment block: env()'s shape, or an older CLI's with no backups record. */
type EnvBlock = Record<string, unknown>;

const project = (names: string[], destroyedEnvironments?: Record<string, unknown>) => ({
  projectName: 'myapp',
  bucketSalt: 'cd9ecc',
  environments: Object.fromEntries(names.map((n) => [n, env(n)])) as Record<string, EnvBlock>,
  ...(destroyedEnvironments ? { destroyedEnvironments } : {}),
});

/**
 * Two storage regions: prod's backups in the project's base bucket in nbg1,
 * staging's in fsn1's own bucket. A third live environment can be added.
 */
function twoRegions(extra: Record<string, unknown> = {}) {
  return {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    environments: {
      prod: env('prod', { bucket: BACKUPS, region: 'nbg1' }),
      staging: env('staging', { bucket: FSN1_BACKUPS, region: 'fsn1' }),
      ...extra,
    } as Record<string, EnvBlock>,
  };
}

async function destroy(
  projectConfig: ReturnType<typeof project>,
  environment: string,
  args: Record<string, unknown> = {},
  withConfigUpdate = false,
) {
  const results: { leaks: ReturnType<typeof createLeakLedger>; backupsPurged?: boolean } = {
    leaks: createLeakLedger(),
  };
  const messages: string[] = [];
  const spinner = {
    start: (m?: string) => messages.push(`start:${m ?? ''}`),
    stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
    message: (m?: string) => messages.push(`message:${m ?? ''}`),
  };
  // The file as it was when the destroy loaded it.
  store.state.disk = structuredClone(projectConfig);
  const ctx = {
    envConfig: projectConfig.environments[environment],
    projectConfig,
    environment,
    args,
    results,
    spinner,
    isK8s: false,
  };
  await DESTROY_EFFECTS.handleBackupBucket(ctx);
  if (withConfigUpdate) await DESTROY_EFFECTS.updateProjectConfig(ctx);
  return { results, messages };
}

describe('handleBackupBucket is scoped to one environment', () => {
  beforeEach(() => {
    for (const fn of Object.values(s3)) fn.mockClear();
    storageClients.length = 0;
  });

  it('-purge on staging while prod is live removes backups/myapp/staging/ and keeps the bucket', async () => {
    const { results } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, 'backups/myapp/staging/');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(results.leaks.counts()).toMatchObject({ leak: 0, unverified: 0 });
  });

  it('-purge on the last environment removes its prefix, then the bucket', async () => {
    await destroy(project(['prod']), 'prod', { purgeBackups: true });
    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, 'backups/myapp/prod/');
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(BACKUPS);
  });

  it('-purge on the last live environment keeps the bucket while a destroyed environment preserved backups in it', async () => {
    // A plain destroy keeps backups for recovery and records the env under
    // destroyedEnvironments with its backupS3. A later -purge of the last
    // live env must not wipe those preserved backups.
    const { messages } = await destroy(
      project(['prod'], {
        staging: { backupS3: { bucket: BACKUPS, region: 'fsn1' }, destroyedAt: 'x' },
      }),
      'prod',
      { purgeBackups: true },
    );
    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, 'backups/myapp/prod/');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(messages.join('\n')).toContain(
      'Backups under backups/myapp/prod/ purged (5 objects removed); bucket kept for staging, which keeps backups there',
    );
  });

  it('a destroyed environment recorded against a different bucket does not hold this one', async () => {
    await destroy(
      project(['prod'], {
        staging: { backupS3: { bucket: 'elsewhere-backups' }, destroyedAt: 'x' },
        prod: { backupS3: { bucket: BACKUPS }, destroyedAt: 'x' },
      }),
      'prod',
      { purgeBackups: true },
    );
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(BACKUPS);
  });

  it('an environment destroyed with -purge no longer holds the bucket for its (deleted) backups', async () => {
    // destroy staging -purge, then destroy prod -purge: staging's folder is
    // gone, so the last environment's -purge deletes the backups bucket.
    saved.configs.length = 0;
    const first = await destroy(
      project(['prod', 'staging']),
      'staging',
      { purgeBackups: true },
      true,
    );
    expect(first.results.backupsPurged).toBe(true);
    const afterStaging = saved.configs.at(-1) as ReturnType<typeof project>;
    expect(afterStaging.destroyedEnvironments?.staging).toMatchObject({ backupsPurged: true });
    s3.emptyAndDeleteBucket.mockClear();

    const { messages } = await destroy(afterStaging, 'prod', { purgeBackups: true }, true);
    expect(s3.deletePrefix).toHaveBeenLastCalledWith(BACKUPS, 'backups/myapp/prod/');
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(BACKUPS);
    expect(messages.join('\n')).not.toContain('kept for staging');
  });

  it('a -purge that could not purge keeps the environment a holder', async () => {
    saved.configs.length = 0;
    s3.deletePrefix.mockRejectedValueOnce(new Error('boom'));
    const { results } = await destroy(
      project(['prod', 'staging']),
      'staging',
      { purgeBackups: true },
      true,
    );
    expect(results.backupsPurged).toBeUndefined();
    const after = saved.configs.at(-1) as ReturnType<typeof project>;
    expect(after.destroyedEnvironments?.staging).not.toHaveProperty('backupsPurged');
    expect(after.destroyedEnvironments?.staging).toMatchObject({ backupS3: { bucket: BACKUPS } });
  });

  it('plain destroy preserves the backups', async () => {
    await destroy(project(['prod', 'staging']), 'staging');
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
  });
});

describe('handleBackupBucket with a backups bucket per storage region', () => {
  beforeEach(() => {
    for (const fn of Object.values(s3)) fn.mockClear();
    storageClients.length = 0;
  });

  it("-purge on staging deletes fsn1's bucket while prod keeps the base bucket in nbg1", async () => {
    const { results, messages } = await destroy(twoRegions(), 'staging', { purgeBackups: true });
    expect(storageClients).toEqual(['fsn1']);
    expect(s3.deletePrefix).toHaveBeenCalledWith(FSN1_BACKUPS, 'backups/myapp/staging/');
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(FSN1_BACKUPS);
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalledWith(BACKUPS);
    expect(messages.join('\n')).not.toContain('bucket kept');
    expect(results.leaks.counts()).toMatchObject({ leak: 0, unverified: 0 });
  });

  it("-purge on prod deletes the base bucket while staging keeps fsn1's", async () => {
    await destroy(twoRegions(), 'prod', { purgeBackups: true });
    expect(storageClients).toEqual(['nbg1']);
    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, 'backups/myapp/prod/');
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(BACKUPS);
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalledWith(FSN1_BACKUPS);
  });

  it("an environment the old bug put in nbg1's base bucket, its uploads in fsn1: -purge reaches the base bucket in nbg1", async () => {
    // Before the backups bucket was per region, staging (uploads in fsn1)
    // archived into the base bucket, which lives in nbg1, and keeps it. Its
    // purge goes where its backups are, never to its uploads region.
    const config = twoRegions();
    config.environments.staging = {
      ...env('staging', { bucket: BACKUPS, region: 'nbg1' }),
      s3: { bucket: 'myapp-cd9ecc-staging-storage', region: 'fsn1' },
    };
    const { messages } = await destroy(config, 'staging', { purgeBackups: true });
    expect(storageClients).toEqual(['nbg1']);
    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, 'backups/myapp/staging/');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(messages.join('\n')).toContain('bucket kept for prod, which keeps backups there');
  });

  it('a live environment an older CLI deployed (no record) keeps the base bucket, and the kept line names it', async () => {
    // `old` archives into the base name in its uploads region: it has no
    // backups record, only `deployedAt`.
    const config = twoRegions({
      old: {
        provider: 'hetzner',
        envName: 'old',
        deployMode: 'compose',
        status: 'deployed',
        deployedAt: '2026-01-01T00:00:00.000Z',
        s3: { bucket: 'myapp-cd9ecc-storage', region: 'nbg1' },
      },
    });
    const { messages } = await destroy(config, 'prod', { purgeBackups: true });
    expect(s3.deletePrefix).toHaveBeenCalledWith(BACKUPS, 'backups/myapp/prod/');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(messages.join('\n')).toContain(
      'Backups under backups/myapp/prod/ purged (5 objects removed); bucket kept for old, which keeps backups there',
    );
  });

  it('the kept line names every holder, live and destroyed with its backups kept', async () => {
    const config = {
      ...project(['prod', 'staging', 'preview']),
      destroyedEnvironments: {
        qa: { backupS3: { bucket: BACKUPS, region: 'fsn1' }, destroyedAt: 'x' },
      },
    };
    const { messages } = await destroy(config, 'staging', { purgeBackups: true });
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(messages.join('\n')).toContain(
      'bucket kept for prod, preview, qa, which keep backups there',
    );
  });

  it('a record naming the wrong region: -purge looks in every region and purges the folder where the bucket is', async () => {
    // The old bug, or a deploy that died before its final save: the record
    // says fsn1, the bucket and staging's folder are in nbg1.
    s3.deletePrefix.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockResolvedValueOnce('nbg1');
    const { results, messages } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    expect(s3.locateBucket).toHaveBeenCalledWith(BACKUPS);
    expect(storageClients).toEqual(['fsn1', 'nbg1']);
    expect(s3.deletePrefix).toHaveBeenCalledTimes(2);
    expect(s3.deletePrefix).toHaveBeenLastCalledWith(BACKUPS, 'backups/myapp/staging/');
    expect(results.backupsPurged).toBe(true);
    expect(messages.join('\n')).toContain(
      'Backups under backups/myapp/staging/ purged in nbg1, not fsn1 as its record said (5 objects removed); bucket kept for prod',
    );
  });

  it('the last environment at a wrong region: the bucket is deleted where it is', async () => {
    s3.deletePrefix.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockResolvedValueOnce('nbg1');
    const { messages } = await destroy(project(['prod']), 'prod', { purgeBackups: true });
    expect(storageClients).toEqual(['fsn1', 'nbg1']);
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(BACKUPS);
    expect(messages.join('\n')).toContain(
      'Backup bucket purged in nbg1, not fsn1 as its record said',
    );
  });

  it('a bucket no region has is purged with nothing to remove, and says so', async () => {
    s3.deletePrefix.mockRejectedValueOnce(noSuchBucket());
    const { results, messages } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    expect(s3.locateBucket).toHaveBeenCalledWith(BACKUPS);
    expect(s3.deletePrefix).toHaveBeenCalledTimes(1);
    expect(results.backupsPurged).toBe(true);
    expect(messages.join('\n')).toContain(
      'Backup bucket not found in any region (already deleted or never created)',
    );
  });

  it('a region search that cannot answer, or a store answering two ways, is never recorded as purged', async () => {
    saved.configs.length = 0;
    s3.deletePrefix.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockRejectedValueOnce(
      new Error('hel1 answered "AccessDenied" when asked whether it holds bucket x'),
    );
    const searched = await destroy(
      project(['prod', 'staging']),
      'staging',
      { purgeBackups: true },
      true,
    );
    expect(searched.results.backupsPurged).toBeUndefined();
    expect(searched.results.leaks.entries[0]?.reason).toContain('hel1 answered "AccessDenied"');
    const after = saved.configs.at(-1) as ReturnType<typeof project>;
    expect(after.destroyedEnvironments?.staging).not.toHaveProperty('backupsPurged');

    s3.deletePrefix.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockResolvedValueOnce('fsn1');
    const twoWays = await destroy(project(['prod', 'staging']), 'staging', { purgeBackups: true });
    expect(twoWays.results.backupsPurged).toBeUndefined();
    expect(twoWays.results.leaks.entries[0]?.reason).toContain(
      'the store is answering two ways, so it was left in place',
    );
  });

  it('N3: a store answering two ways points to the console, never to a destroy rerun that cannot run', async () => {
    // A bucket-purge leak moves the environment to destroyedEnvironments, so
    // "destroy staging" afterwards finds no environment.
    s3.deletePrefix.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockResolvedValueOnce('fsn1');
    const { results } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    const [entry] = results.leaks.entries;
    expect(entry.reason).not.toMatch(/destroy again/i);
    expect(entry.reason).toContain(
      'left in place; look at it in the Object Storage console before deleting anything by hand',
    );
    // prod keeps backups there, so the hint removes this folder only.
    expect(entry.hint).toBe(
      `Delete backups/myapp/staging/ in ${BACKUPS} via the Hetzner Cloud Object Storage console, and leave the bucket: prod keeps backups there.`,
    );
  });

  it('N2: a purge that fails where the bucket was found is reported in that region, not the recorded one', async () => {
    s3.deletePrefix.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockResolvedValueOnce('nbg1');
    s3.deletePrefix.mockRejectedValueOnce(
      new Error(`1 object(s) under backups/myapp/staging/ in ${BACKUPS} were not deleted`),
    );
    const { results } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    expect(storageClients).toEqual(['fsn1', 'nbg1']);
    expect(results.backupsPurged).toBeUndefined();
    expect(results.leaks.entries[0]?.resource).toBe(`${BACKUPS} (nbg1)`);
  });

  it('N2: a search that cannot answer is reported at the recorded region, the only one known', async () => {
    s3.deletePrefix.mockRejectedValueOnce(noSuchBucket());
    s3.locateBucket.mockRejectedValueOnce(new Error('hel1 answered "Forbidden (HTTP 403)"'));
    const { results } = await destroy(project(['prod']), 'prod', { purgeBackups: true });
    const [entry] = results.leaks.entries;
    expect(entry.resource).toBe(`${BACKUPS} (fsn1)`);
    // The last holder: emptying and deleting the bucket is the right step.
    expect(entry.hint).toBe(
      'Empty it via the Hetzner Cloud Object Storage console, then DeleteBucket; it keeps billing until removed.',
    );
  });

  it('a backups record with no region anywhere is refused into the leak ledger, never guessed', async () => {
    const config = project([]);
    config.environments.prod = env('prod', { bucket: BACKUPS });
    const { results } = await destroy(config, 'prod', { purgeBackups: true });
    expect(storageClients).toEqual([]);
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(results.backupsPurged).toBeUndefined();
    const [entry] = results.leaks.entries;
    expect(entry).toMatchObject({ resourceClass: 'bucket', resource: BACKUPS });
    expect(entry.reason).toBe(
      'purge requested (-purge) but the backups bucket has no region on record, so destroy cannot tell which store holds it',
    );
    expect(entry.hint).toBe(
      `Delete backups/myapp/prod/ in ${BACKUPS} via the Hetzner Cloud Object Storage console, and the bucket once no other environment keeps backups there; it keeps billing until removed.`,
    );
  });
});

describe('handleBackupBucket when the purge runs out of time', () => {
  beforeEach(() => {
    for (const fn of Object.values(s3)) fn.mockClear();
    storageClients.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves the bucket in place with the console steps, never a retried destroy', async () => {
    s3.deletePrefix.mockImplementationOnce(() => new Promise(() => {}));
    const pending = destroy(project(['prod', 'staging']), 'staging', { purgeBackups: true });
    await vi.advanceTimersByTimeAsync(180_000);
    const { results } = await pending;
    expect(results.backupsPurged).toBeUndefined();
    const [entry] = results.leaks.entries;
    expect(entry.reason).toBe(
      'purge failed: backup bucket purge exceeded 180s, so it was left in place',
    );
    expect(entry.hint).toBe(
      `Delete backups/myapp/staging/ in ${BACKUPS} via the Hetzner Cloud Object Storage console, and leave the bucket: prod keeps backups there.`,
    );
  });
});

describe('handleBackupBucket with no object-storage credentials', () => {
  // The bucket outlives the destroy, which still moves the environment to
  // destroyedEnvironments, so `destroy <env>` cannot run again: the hint
  // points to the console, and only at what is this environment's to remove.
  beforeEach(() => {
    for (const fn of Object.values(s3)) fn.mockClear();
    storageClients.length = 0;
    credentials.value = null;
  });
  afterEach(() => {
    credentials.value = KEYS;
  });

  it('prod keeps backups in the bucket: the hint removes this folder only and leaves the bucket', async () => {
    const { results, messages } = await destroy(project(['prod', 'staging']), 'staging', {
      purgeBackups: true,
    });
    expect(storageClients).toEqual([]);
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(results.backupsPurged).toBeUndefined();
    expect(messages).toContain('stop:Backup bucket purge skipped (no credentials available)');
    const [entry] = results.leaks.entries;
    expect(entry).toMatchObject({ resourceClass: 'bucket', resource: `${BACKUPS} (fsn1)` });
    expect(entry.reason).toBe(
      'purge requested (-purge) but no object-storage credentials were available',
    );
    expect(entry.hint).toBe(
      `Delete backups/myapp/staging/ in ${BACKUPS} via the Hetzner Cloud Object Storage console, and leave the bucket: prod keeps backups there.`,
    );
    expect(entry.hint).not.toMatch(/re-?run|DeleteBucket|\u2014/);
  });

  it('every holder, live and destroyed with its backups kept, is named', async () => {
    const config = project(['prod', 'dev'], {
      staging: { provider: 'hetzner', backupS3: { bucket: BACKUPS, region: 'fsn1' } },
    });
    const { results } = await destroy(config, 'dev', { purgeBackups: true });
    expect(results.leaks.entries[0]?.hint).toBe(
      `Delete backups/myapp/dev/ in ${BACKUPS} via the Hetzner Cloud Object Storage console, and leave the bucket: prod, staging keep backups there.`,
    );
  });

  it('the last holder: the hint empties and deletes the bucket in the console', async () => {
    const { results } = await destroy(project(['prod']), 'prod', { purgeBackups: true });
    expect(results.leaks.entries[0]?.hint).toBe(
      'Empty it via the Hetzner Cloud Object Storage console, then DeleteBucket; it keeps billing until removed.',
    );
  });
});
