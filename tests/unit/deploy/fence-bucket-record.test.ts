/**
 * `s3.bucketCreatedAt` is the Hetzner app key fence's proof that a deploy
 * finished (`fenceTargets` in hetzner-app-key-fence.js): a bucket no finished
 * deploy recorded may be skipped when it answers NoSuchBucket. So whether a
 * deploy records it follows the provider's own declaration that it fences a
 * pasted key (`appKeyScoping: 'paste-fence'`), and nothing else: no tuning
 * value can turn the record off and quietly leave a bucket unfenced.
 *
 * A walk over the registry, so a new provider is covered for free, then one
 * class that declares the fence and nothing more. An undeclared scoping
 * warns instead of throwing: the finalize runs after IaC succeeded, and a
 * throw there would skip the final config save and lose the record of what
 * was just provisioned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const classes = vi.hoisted(() => ({
  override: null as Record<string, unknown> | null,
}));

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as { getProviderClass: (id: string) => unknown };
  return {
    ...real,
    getProviderClass: (id: string) =>
      classes.override
        ? { getObjectStorageProviderClass: async () => classes.override }
        : real.getProviderClass(id),
  };
});

const { PROVIDERS } = await import('../../../src/lib/providers/index.js');
const { startAppBucketFinalize } = await import('../../../src/lib/deploy/orchestrator.js');
const { fenceTargets } = await import('../../../src/lib/deploy/hetzner-app-key-fence.js');
const { envS3Record } = await import('../../../src/lib/deploy/s3-record.js');

const CREATED = new Date('2026-11-05T10:00:00.000Z');

function storage(bucketCreatedAt = vi.fn(async () => CREATED)) {
  return {
    bucketCreatedAt,
    createProvider: async () => ({
      getBucketCorsOrigins: async () => ['https://prod.dev'],
      setBucketCors: vi.fn(),
      bucketCreatedAt,
    }),
  };
}

async function finish(providerId: string, createProvider: () => Promise<object>) {
  const log = { warn: vi.fn(), info: vi.fn() };
  const finalize = startAppBucketFinalize({
    providerId,
    createProvider,
    bucket: 'app-b',
    domain: 'prod.dev',
  });
  return { result: await finalize.finish(log), log };
}

afterEach(() => {
  classes.override = null;
});

describe('the fence record, per provider', () => {
  const ids = Object.keys(PROVIDERS);

  it('walks every provider', () => {
    expect(ids.length).toBeGreaterThanOrEqual(5);
  });

  it.each(ids)('%s records bucketCreatedAt exactly when it fences a pasted key', async (id) => {
    const P = PROVIDERS[id as keyof typeof PROVIDERS] as unknown as {
      getObjectStorageProviderClass(): Promise<{ appKeyScoping: string }>;
    };
    const fenced = (await P.getObjectStorageProviderClass()).appKeyScoping === 'paste-fence';
    const { bucketCreatedAt, createProvider } = storage();
    const { result, log } = await finish(id, createProvider);
    expect(Object.hasOwn(result, 'bucketCreatedAt')).toBe(fenced);
    expect(bucketCreatedAt).toHaveBeenCalledTimes(fenced ? 1 : 0);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('the fence record, from the declaration alone', () => {
  it('a class that declares the fence and nothing else records the time', async () => {
    classes.override = { appKeyScoping: 'paste-fence' };
    const { createProvider } = storage();
    const { result, log } = await finish('hetzner', createProvider);
    expect(result).toEqual({ bucketCreatedAt: CREATED.toISOString() });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('records null when the time cannot be read: the key is the proof, not the value', async () => {
    classes.override = { appKeyScoping: 'paste-fence' };
    const unreadable = vi.fn(async () => {
      throw new Error('ListBuckets refused');
    });
    const { result } = await finish('hetzner', storage(unreadable).createProvider);
    expect(result).toEqual({ bucketCreatedAt: null });
  });

  it('an undeclared scoping warns and records nothing, it never throws', async () => {
    classes.override = { name: 'FakeS3' };
    const { bucketCreatedAt, createProvider } = storage();
    const { result, log } = await finish('hetzner', createProvider);
    expect(result).toEqual({});
    expect(bucketCreatedAt).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).toContain('declares no appKeyScoping');
  });
});

describe('the fence reads what a finished deploy recorded', () => {
  const s3Config = {
    bucket: 'app-b',
    region: 'hel1',
    endpoint: 'https://hel1.your-objectstorage.com',
    stateBucket: 'state-b',
  };

  it('an env whose later deploy failed keeps its bucket fenced, never skippable', async () => {
    classes.override = { appKeyScoping: 'paste-fence' };
    const { result } = await finish('hetzner', storage().createProvider);
    const projectConfig = {
      environments: {
        // Not `deployed` any more: the record alone proves a deploy finished.
        prod: { status: 'failed', s3: envS3Record(s3Config, result) },
        staging: {},
      },
    };
    const target = fenceTargets({ projectConfig, environment: 'staging' }).find(
      (t: { bucket: string }) => t.bucket === 'app-b',
    );
    expect(target?.mayBeAbsent).toBe(false);
  });
});
