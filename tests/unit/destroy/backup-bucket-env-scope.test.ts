/**
 * Each environment archives WAL-G under its own `backups/<project>/<env>/`
 * prefix in the project's backup bucket. `-purge` on one environment removes
 * only that prefix; the bucket itself goes only with the last live environment.
 * Plain destroy keeps everything for recovery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

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

const project = (names: string[]) => ({
  projectName: 'myapp',
  bucketSalt: 'cd9ecc',
  environments: Object.fromEntries(names.map((n) => [n, env(n)])),
});

async function destroy(
  projectConfig: ReturnType<typeof project>,
  environment: string,
  args: Record<string, unknown> = {},
) {
  const results = { leaks: createLeakLedger() };
  const messages: string[] = [];
  const spinner = {
    start: (m?: string) => messages.push(`start:${m ?? ''}`),
    stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
    message: (m?: string) => messages.push(`message:${m ?? ''}`),
  };
  await DESTROY_EFFECTS.handleBackupBucket({
    envConfig: projectConfig.environments[environment],
    projectConfig,
    environment,
    args,
    results,
    spinner,
    isK8s: false,
  });
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

  it('plain destroy preserves the backups', async () => {
    await destroy(project(['prod', 'staging']), 'staging');
    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
  });
});
