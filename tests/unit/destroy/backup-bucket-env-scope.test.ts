/**
 * Each environment archives WAL-G under its own `backups/<project>/<env>/`
 * prefix in the project's backup bucket. `-purge` on one environment removes
 * only that prefix; the bucket itself goes only with the last live environment.
 * Plain destroy keeps everything for recovery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const BACKUPS = 'myapp-cd9ecc-backups';

const s3 = {
  deletePrefix: vi.fn(async (_b: string, _p: string) => ({ objectsRemoved: 5 })),
  emptyAndDeleteBucket: vi.fn(async (_b: string) => ({
    deleted: true,
    objectsRemoved: 0,
    warnings: [],
  })),
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

function env(name: string) {
  return {
    provider: 'hetzner',
    envName: name,
    deployMode: 'compose',
    status: 'deployed',
    backupS3: { bucket: BACKUPS, region: 'fsn1' },
  };
}

const project = (names: string[], destroyedEnvironments?: Record<string, unknown>) => ({
  projectName: 'myapp',
  bucketSalt: 'cd9ecc',
  environments: Object.fromEntries(names.map((n) => [n, env(n)])),
  ...(destroyedEnvironments ? { destroyedEnvironments } : {}),
});

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
    expect(messages.join('\n')).toMatch(/bucket kept/);
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
    expect(messages.join('\n')).not.toContain('preserved backups of staging');
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
