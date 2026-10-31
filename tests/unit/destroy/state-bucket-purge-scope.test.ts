/**
 * The derived Pulumi state bucket is project-level: every environment derives
 * the same name from the project's app bucket and `stateBucketGeneration`. So
 * `destroy staging -purge` while prod is live must keep it (prod's stack state
 * lives there), and only the last live environment's `-purge` deletes it.
 *
 * When it IS deleted, the next deploy must not recreate a bucket of the same
 * name: Hetzner Object Storage can ack writes into a just-recreated same-name
 * bucket and lose them (e4 restore->failover, 2026-08-07). The purge therefore
 * rotates `stateBucketGeneration`, so the next derivation names a fresh bucket.
 * Nothing else rotates it: a kept bucket must stay findable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const STATE = 'myapp-cd9ecc-storage-pulumi-state-aaaaaa';

const store = projectConfigStore();
const promptCreds = vi.fn(async () => ({ accessKey: 'ak', secretKey: 'sk' }));
const s3 = {
  emptyAndDeleteBucket: vi.fn(async (_b: string) => ({ deleted: true, objectsRemoved: 3 })),
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

function env(name: string) {
  return {
    provider: 'hetzner',
    envName: name,
    deployMode: 'kubernetes',
    status: 'deployed',
    s3: { bucket: 'myapp-cd9ecc-storage', stateBucket: STATE, region: 'fsn1' },
  };
}

function project(names: string[]) {
  return {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    stateBucketGeneration: 'aaaaaa',
    environments: Object.fromEntries(names.map((n) => [n, env(n)])) as Record<
      string,
      ReturnType<typeof env>
    >,
  };
}

async function destroy(projectConfig: ReturnType<typeof project>, environment: string) {
  const messages: string[] = [];
  // The file as it was when the destroy loaded it.
  store.reset(structuredClone(projectConfig));
  const ctx = {
    envConfig: projectConfig.environments[environment],
    projectConfig,
    environment,
    args: { purgeBackups: true },
    results: { leaks: createLeakLedger() },
    spinner: {
      start: (m?: string) => messages.push(`start:${m ?? ''}`),
      stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
      message: (m?: string) => messages.push(`message:${m ?? ''}`),
    },
    isK8s: true,
  };
  await DESTROY_EFFECTS.retainStateBucket(ctx);
  await DESTROY_EFFECTS.updateProjectConfig(ctx);
  return { ctx, messages, saved: store.lastWrite() as Record<string, unknown> };
}

describe('derived state bucket under -purge', () => {
  beforeEach(() => {
    store.reset();
    promptCreds.mockClear();
    s3.emptyAndDeleteBucket.mockClear();
  });

  it('keeps the bucket when another environment is still live, and does not rotate the generation', async () => {
    const { ctx, messages, saved } = await destroy(project(['prod', 'staging']), 'staging');
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(promptCreds).not.toHaveBeenCalled();
    expect(messages.join('\n')).toMatch(/kept for 1 other environment/);
    expect(ctx.results.leaks.counts()).toMatchObject({ leak: 0, unverified: 0 });
    expect(saved.stateBucketGeneration).toBe('aaaaaa');
  });

  it('deletes the bucket with the last environment and rotates the generation', async () => {
    const { saved } = await destroy(project(['prod']), 'prod');
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(STATE);
    expect(saved.stateBucketGeneration).toMatch(/^[0-9a-f]{6}$/);
    expect(saved.stateBucketGeneration).not.toBe('aaaaaa');
    expect(saved.retainedStateBucket).toBeUndefined();
  });

  it('does not rotate when the last environment purge found no bucket to delete', async () => {
    s3.emptyAndDeleteBucket.mockResolvedValueOnce({ deleted: false, objectsRemoved: 0 });
    const { saved } = await destroy(project(['prod']), 'prod');
    expect(saved.stateBucketGeneration).toBe('aaaaaa');
  });
});
