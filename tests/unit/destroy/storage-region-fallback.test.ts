/**
 * A destroy -purge opens its object storage client in the region the
 * environment recorded (`s3.region`, the state bucket's `s3.stateBucketRegion`).
 * Every deploy records it, so a record without one was edited by hand. The
 * destroy then takes the region the deploy itself would have placed the
 * buckets in: the provider's own mapping of the environment's compute region,
 * which answers that provider's default for an unknown one. It used to take
 * `fsn1`, a Hetzner location, for every provider, and every other provider's
 * S3 client refuses it ("Invalid region: fsn1"), so the purge failed and its
 * leak line named a Hetzner region.
 */
import * as prompts from '@clack/prompts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const APP = 'myapp-cd9ecc-prod-storage';
const STATE = 'myapp-cd9ecc-storage-pulumi-state-aaaaaa';

const opened: Array<{ provider: string; region: string }> = [];
const s3 = {
  emptyAndDeleteBucket: vi.fn(async (_b: string) => ({ deleted: true, objectsRemoved: 1 })),
};

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    providerFor: () => ({
      NAME: 'Cloud',
      promptObjectStorageCredentials: async () => ({ accessKey: 'ak', secretKey: 'sk' }),
    }),
    getObjectStorageProvider: async (
      provider: string,
      _ak: string,
      _sk: string,
      region: string,
    ) => {
      opened.push({ provider, region });
      return s3;
    },
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

// The pasted Hetzner key's fence sync, and the local secrets it forgets.
const fenced = vi.fn(async (_opts: Record<string, unknown>) => ({}));
vi.mock('../../../src/lib/deploy/app-storage-credential.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    localAppStorageSecrets: () => ({ get: () => '', set: () => {} }),
    syncHetznerFences: (opts: Record<string, unknown>) => fenced(opts),
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
const { getProviderClass, PROVIDERS } = await import('../../../src/lib/providers/index.js');
const PROVIDER_IDS = Object.keys(PROVIDERS);

/** The storage region the provider's own S3 class maps a compute region to. */
async function ownStorageRegion(provider: string, region: string | undefined) {
  const S3Class = await getProviderClass(provider).getObjectStorageProviderClass();
  return S3Class.resolveS3Region(region) as string;
}

function purge(provider: string, region: string | undefined) {
  const envConfig = {
    provider,
    envName: 'prod',
    deployMode: 'compose',
    status: 'deployed',
    ...(region && { region }),
    // No `region` here: the record lost it.
    s3: { bucket: APP, stateBucket: STATE },
  };
  const projectConfig = {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    stateBucketGeneration: 'aaaaaa',
    environments: { prod: envConfig },
  };
  store.reset(structuredClone(projectConfig));
  return {
    envConfig,
    projectConfig,
    environment: 'prod',
    args: { purgeBackups: true },
    results: { leaks: createLeakLedger() } as Record<string, unknown> & {
      leaks: ReturnType<typeof createLeakLedger>;
    },
    spinner: { start: vi.fn(), stop: vi.fn(), message: vi.fn() },
  };
}

describe('a -purge of an environment whose record has no storage region', () => {
  beforeEach(() => {
    opened.length = 0;
    s3.emptyAndDeleteBucket.mockClear();
    vi.spyOn(prompts.log, 'warn').mockImplementation(() => {});
  });

  // Each provider with a compute region it sells, and with none recorded.
  const cases = PROVIDER_IDS.flatMap((provider: string) => [
    [provider, getProviderClass(provider).DEFAULT_REGION as string],
    [provider, undefined],
  ]);

  it.each(cases)(
    "%s (compute region %s): the app bucket is deleted in the provider's own storage region",
    async (provider, region) => {
      const ctx = purge(provider, region);
      await DESTROY_EFFECTS.deleteAppBucket(ctx);
      expect(opened).toEqual([{ provider, region: await ownStorageRegion(provider, region) }]);
      expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(APP);
      expect(ctx.results.leaks.entries).toEqual([]);
    },
  );

  it.each(cases)(
    "%s (compute region %s): the state bucket is purged in the provider's own storage region",
    async (provider, region) => {
      const ctx = purge(provider, region);
      await DESTROY_EFFECTS.retainStateBucket(ctx);
      expect(opened).toEqual([{ provider, region: await ownStorageRegion(provider, region) }]);
      expect(s3.emptyAndDeleteBucket).toHaveBeenCalledWith(STATE);
      expect(ctx.results.leaks.entries).toEqual([]);
    },
  );

  // A pasted key is Hetzner's alone (appKeyScoping 'paste-fence'), so this
  // one only ever ran with Hetzner's own storage default; it follows the same
  // rule now, so a Helsinki environment fences from Helsinki.
  it.each([
    ['hel1', 'hel1'],
    [undefined, 'fsn1'],
  ])(
    'hetzner (compute region %s): a pasted key is retired from the %s storage client',
    async (region, expected) => {
      const ctx = purge('hetzner', region);
      (ctx.envConfig.s3 as Record<string, unknown>).appKey = {
        id: 'AK_S',
        scoping: 'paste-fence',
        tier: 'fenced',
      };
      await DESTROY_EFFECTS.revokeAppStorageKey({ ...ctx, cwd: '/nonexistent' });
      expect(opened).toEqual([{ provider: 'hetzner', region: expected }]);
      expect(fenced).toHaveBeenCalledTimes(1);
      fenced.mockClear();
    },
  );

  it('never hands a non-Hetzner provider a Hetzner location', async () => {
    const hetznerRegions = Object.keys(getProviderClass('hetzner').REGIONS ?? {});
    expect(hetznerRegions).toContain('fsn1');
    for (const provider of PROVIDER_IDS.filter((id: string) => id !== 'hetzner')) {
      opened.length = 0;
      await DESTROY_EFFECTS.deleteAppBucket(purge(provider, undefined));
      await DESTROY_EFFECTS.retainStateBucket(purge(provider, undefined));
      expect(opened).toHaveLength(2);
      for (const { region } of opened) expect(hetznerRegions, provider).not.toContain(region);
    }
  });
});
