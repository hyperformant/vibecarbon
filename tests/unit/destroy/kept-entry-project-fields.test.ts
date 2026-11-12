/**
 * A destroy that keeps the environment's entry (entryKeptReason) still
 * writes the project-level fields it decided (writeProjectLevelFields), and
 * only those:
 *
 * - The state bucket stays for the retry under -purge, so its generation
 *   never rotates and nothing marks it left for you to delete by hand
 *   (`stateBucketAbandoned` is set only by a purge that ran).
 * - A purge left for you to delete by hand rotates the generation whether or
 *   not the entry stays, as a confirmed delete does: you may delete the
 *   bucket, and the next deploy must not recreate that name.
 * - What the app key fence found about destroyed environments' buckets is
 *   recorded: it is about other environments' records, which the kept entry
 *   does not change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const STATE = 'myapp-cd9ecc-storage-pulumi-state-aaaaaa';
const OLD_APP = 'myapp-cd9ecc-staging-storage';

const store = projectConfigStore();
const promptCreds = vi.fn(async () => null);
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

function project() {
  return {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    stateBucketGeneration: 'aaaaaa',
    environments: {
      prod: {
        provider: 'hetzner',
        envName: 'prod',
        deployMode: 'compose',
        status: 'deployed',
        s3: { bucket: 'myapp-cd9ecc-prod-storage', stateBucket: STATE, region: 'fsn1' },
      },
    },
    destroyedEnvironments: {
      staging: {
        provider: 'hetzner',
        s3: { bucket: OLD_APP, region: 'fsn1' },
        destroyedAt: '2026-11-01T00:00:00.000Z',
      },
    },
  };
}

/** A ctx whose ledger already holds a line a re-run can act on: the entry is kept. */
function keptCtx(results: Record<string, unknown> = {}) {
  const projectConfig = project();
  store.reset(structuredClone(projectConfig));
  const leaks = createLeakLedger();
  leaks.leak({
    resourceClass: 'server',
    resource: 'myapp-prod-master',
    reason: 'delete failed: 503',
    hint: 'Delete it via the Hetzner Cloud console.',
  });
  const messages: string[] = [];
  return {
    ctx: {
      envConfig: projectConfig.environments.prod,
      projectConfig,
      environment: 'prod',
      args: { purgeBackups: true },
      results: { leaks, ...results } as Record<string, unknown> & {
        leaks: ReturnType<typeof createLeakLedger>;
      },
      spinner: {
        start: (m?: string) => messages.push(`start:${m ?? ''}`),
        stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
        message: (m?: string) => messages.push(`message:${m ?? ''}`),
      },
      isK8s: false,
    },
    messages,
  };
}

type Saved = {
  stateBucketGeneration?: string;
  environments: Record<string, unknown>;
  destroyedEnvironments: Record<string, { appBucketNotFound?: string }>;
};
/** The file as it is after the destroy's writes. */
const onDisk = () => (store.lastWrite() ?? store.state.disk) as unknown as Saved;

describe('a destroy that keeps the entry writes only its project-level fields', () => {
  beforeEach(() => {
    store.reset();
    promptCreds.mockClear();
    s3.emptyAndDeleteBucket.mockClear();
  });

  it('-purge keeps the state bucket for the retry: no purge, no rotation, nothing left by hand', async () => {
    const { ctx, messages } = keptCtx();
    await DESTROY_EFFECTS.retainStateBucket(ctx);
    await DESTROY_EFFECTS.updateProjectConfig(ctx);
    expect(promptCreds).not.toHaveBeenCalled();
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(ctx.results.stateBucketAbandoned).toBeUndefined();
    expect(messages.join('\n')).toContain(`Pulumi state bucket kept: ${STATE}.`);
    expect(ctx.results.leaks.entries.map((e) => e.resourceClass)).toEqual(['server']);
    const saved = onDisk();
    expect(saved.stateBucketGeneration).toBe('aaaaaa');
    expect(saved.environments.prod).toBeDefined();
  });

  it('a purge left for you to delete by hand rotates the generation, and the entry stays', async () => {
    const { ctx } = keptCtx({ stateBucketAbandoned: true });
    await DESTROY_EFFECTS.updateProjectConfig(ctx);
    const saved = onDisk();
    expect(saved.stateBucketGeneration).toMatch(/^[0-9a-f]{6}$/);
    expect(saved.stateBucketGeneration).not.toBe('aaaaaa');
    expect(saved.environments.prod).toBeDefined();
  });

  it("records what the fence found about a destroyed environment's bucket", async () => {
    const { ctx } = keptCtx({ fenceGone: [OLD_APP] });
    await DESTROY_EFFECTS.updateProjectConfig(ctx);
    const saved = onDisk();
    expect(saved.destroyedEnvironments.staging.appBucketNotFound).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(saved.environments.prod).toBeDefined();
    expect(saved.stateBucketGeneration).toBe('aaaaaa');
  });
});
