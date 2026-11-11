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
 *
 * A destroy that keeps the environment's entry (its Pulumi destroy was not
 * verified, or a reserved IP of ours is not released yet) keeps the bucket
 * too, even under -purge of the last environment: the next destroy of the
 * environment retries from that entry and needs this bucket to do it. The
 * next clean destroy -purge then deletes it.
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
    providerFor: () => ({
      NAME: 'Hetzner Cloud',
      RESERVED_IP_NAME: 'Floating IP',
      promptObjectStorageCredentials: promptCreds,
    }),
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

type Outcome = {
  pulumiDestroyFailed?: boolean;
  unreleasedReservedIps?: string[];
  unsweptReservedIpScopes?: string[];
};

async function destroy(
  projectConfig: ReturnType<typeof project>,
  environment: string,
  outcome: Outcome = {},
) {
  const messages: string[] = [];
  // The file as it was when the destroy loaded it.
  store.reset(structuredClone(projectConfig));
  const ctx = {
    envConfig: projectConfig.environments[environment],
    projectConfig,
    environment,
    args: { purgeBackups: true },
    // What the teardown before these steps decided.
    results: { leaks: createLeakLedger(), ...outcome },
    spinner: {
      start: (m?: string) => messages.push(`start:${m ?? ''}`),
      stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
      message: (m?: string) => messages.push(`message:${m ?? ''}`),
    },
    isK8s: true,
  };
  await DESTROY_EFFECTS.retainStateBucket(ctx);
  await DESTROY_EFFECTS.updateProjectConfig(ctx);
  // The file as it is after the destroy (a kept entry may write nothing).
  return { ctx, messages, saved: store.state.disk as Record<string, unknown> };
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

describe('the last environment under -purge, when its entry is kept', () => {
  beforeEach(() => {
    store.reset();
    promptCreds.mockClear();
    s3.emptyAndDeleteBucket.mockClear();
  });

  const kept: Array<[string, Outcome, RegExp]> = [
    ['its Pulumi destroy was not verified', { pulumiDestroyFailed: true }, /not verified/],
    [
      'a Floating IP of ours is not released yet',
      { unreleasedReservedIps: ['203.0.113.9', '203.0.113.9'] },
      // In the provider's own word.
      /the Floating IP 203\.0\.113\.9 is not released/,
    ],
    [
      'a label listing could not be read',
      { unsweptReservedIpScopes: ['prod'] },
      /the Floating IPs labelled for prod could not be listed/,
    ],
  ];

  it.each(kept)('%s: keeps the bucket, rotates nothing, and says why', async (_, outcome, why) => {
    const before = { ...project(['prod']), retainedStateBucket: STATE };
    const { messages, saved } = await destroy(before, 'prod', outcome);
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(promptCreds).not.toHaveBeenCalled();
    // The entry and everything the next destroy resolves the bucket from stay.
    expect((saved.environments as Record<string, unknown>).prod).toBeDefined();
    expect(saved.stateBucketGeneration).toBe('aaaaaa');
    expect(saved.retainedStateBucket).toBe(STATE);
    const line = messages.find((m) => m.startsWith('stop:Pulumi state bucket kept'));
    expect(line).toContain(STATE);
    expect(line).toMatch(why);
    expect(line).toContain('`vibecarbon destroy prod`');
    expect(line).toContain('`vibecarbon destroy prod -purge`');
    expect(line).not.toMatch(/\u2014/);
  });

  it('a kept bucket is plain output, not a ledger entry', async () => {
    const { ctx, messages } = await destroy(project(['prod']), 'prod', {
      unreleasedReservedIps: ['203.0.113.9'],
    });
    expect(messages.some((m) => m.startsWith('stop:Pulumi state bucket kept'))).toBe(true);
    expect(ctx.results.leaks.counts()).toMatchObject({ leak: 0, unverified: 0 });
  });

  it('the next clean destroy -purge deletes it and rotates the generation', async () => {
    const first = await destroy(project(['prod']), 'prod', { pulumiDestroyFailed: true });
    expect(s3.emptyAndDeleteBucket).not.toHaveBeenCalled();
    const again = structuredClone(first.saved) as ReturnType<typeof project>;
    const { saved } = await destroy(again, 'prod');
    expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(STATE);
    expect(saved.stateBucketGeneration).not.toBe('aaaaaa');
    expect((saved.environments as Record<string, unknown>).prod).toBeUndefined();
  });
});
