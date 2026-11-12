/**
 * `destroy -purge` of buckets that do not exist, through each provider's
 * real store class, with only the HTTP answers faked.
 *
 * A NoSuchBucket at the recorded region starts a search (locateBucket), and
 * the search asks only the regions the keys can address (keyRegions). On
 * Vultr and Linode the keys work on one cluster, and every other cluster
 * answers 403 for any bucket. Asking those turned a purge of a bucket that
 * was never created (a deploy that died in s3-setup, or a rerun after an
 * earlier purge) into a leak and exit 2. Now such a store asks only its own
 * cluster, and the purge says "not found" and exits 0, as before the
 * search. Where the keys reach every region (Hetzner, DigitalOcean,
 * Scaleway) every region is asked, and any answer but not found still
 * fails closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

/** Which host holds nothing (404) and what every other host answers. */
const world = vi.hoisted(() => ({
  elsewhere: 'missing' as 'missing' | 'forbidden',
  forbiddenHost: '' as string,
  asked: [] as string[],
}));

const notFound = (name: string) =>
  Object.assign(new Error('The specified bucket does not exist'), {
    name,
    $metadata: { httpStatusCode: 404 },
  });
const forbidden = () =>
  Object.assign(new Error(''), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });

vi.mock('@aws-sdk/client-s3', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  class S3Client {
    host: string;
    middlewareStack = { add() {} };
    constructor(config: { endpoint: string }) {
      this.host = new URL(config.endpoint).host;
    }
    async send(command: { constructor: { name: string } }) {
      world.asked.push(this.host);
      if (world.forbiddenHost && this.host === world.forbiddenHost) throw forbidden();
      // No bucket anywhere: a bucket command says NoSuchBucket, a HEAD says NotFound.
      throw notFound(
        command.constructor.name === 'HeadBucketCommand' ? 'NotFound' : 'NoSuchBucket',
      );
    }
    destroy() {}
  }
  return { ...real, S3Client };
});

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    providerFor: () => ({
      NAME: 'the provider',
      promptObjectStorageCredentials: async () => ({
        accessKey: 'A'.repeat(20),
        secretKey: 'x'.repeat(40),
      }),
    }),
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
const { getObjectStorageProvider } = await import('../../../src/lib/providers/index.js');

/** Each provider at a storage region that is not the first its class lists. */
const CASES = [
  { provider: 'vultr', region: 'ams1', scope: 'own' },
  { provider: 'linode', region: 'us-iad-10', scope: 'own' },
  { provider: 'hetzner', region: 'nbg1', scope: 'all' },
  { provider: 'digitalocean', region: 'fra1', scope: 'all' },
  { provider: 'scaleway', region: 'nl-ams', scope: 'all' },
] as const;

const APP = 'myapp-cd9ecc-staging-storage';
const BACKUPS = 'myapp-cd9ecc-backups';

async function hostsOf(provider: string, region: string) {
  const store = (await getObjectStorageProvider(
    provider,
    'A'.repeat(20),
    'x'.repeat(40),
    region,
  )) as {
    endpoint: string;
    addressableRegions(): string[];
    constructor: { ENDPOINTS: Record<string, string> };
  };
  const host = (r: string) => new URL(store.constructor.ENDPOINTS[r]).host;
  return {
    own: new URL(store.endpoint).host,
    addressable: store.addressableRegions().map(host),
    others: Object.keys(store.constructor.ENDPOINTS)
      .filter((r) => r !== region)
      .map(host),
  };
}

/** Purge staging's app bucket and backups bucket, neither of which exists. */
async function purge(provider: string, region: string) {
  const envConfig = {
    provider,
    envName: 'staging',
    deployMode: 'compose',
    status: 'deployed',
    s3: { bucket: APP, region },
    backupS3: { bucket: BACKUPS, region },
  };
  const projectConfig = {
    projectName: 'myapp',
    bucketSalt: 'cd9ecc',
    environments: { staging: envConfig },
  };
  const messages: string[] = [];
  const results: Record<string, unknown> & { leaks: ReturnType<typeof createLeakLedger> } = {
    leaks: createLeakLedger(),
    s3Bucket: null,
  };
  const ctx = {
    envConfig,
    projectConfig,
    environment: 'staging',
    args: { purgeBackups: true },
    results,
    spinner: {
      start: (m?: string) => messages.push(`start:${m ?? ''}`),
      stop: (m?: string) => messages.push(`stop:${m ?? ''}`),
      message: (m?: string) => messages.push(`message:${m ?? ''}`),
    },
    isK8s: false,
  };
  await DESTROY_EFFECTS.deleteAppBucket(ctx);
  await DESTROY_EFFECTS.handleBackupBucket(ctx);
  return { results, stops: messages.filter((m) => m.startsWith('stop:')) };
}

beforeEach(() => {
  world.asked = [];
  world.forbiddenHost = '';
});

describe.each(CASES)(
  '-purge of buckets that do not exist on $provider (keys: $scope)',
  ({ provider, region, scope }) => {
    it('says not found and exits 0, asking only the regions the keys can address', async () => {
      const { own, addressable, others } = await hostsOf(provider, region);
      // A cluster the keys cannot address answers 403 for any bucket.
      if (scope === 'own') world.forbiddenHost = others[0];
      const { results, stops } = await purge(provider, region);

      const where = scope === 'own' ? '' : ' in any region';
      expect(stops).toContain(
        `stop:S3 bucket not found${where} (already deleted or never created)`,
      );
      expect(stops).toContain(
        `stop:Backup bucket not found${where} (already deleted or never created)`,
      );
      expect(results.leaks.entries).toEqual([]);
      expect(results.leaks.exitCode()).toBe(0);
      // Nothing found is never a delete: the fence keeps the record's bucket.
      expect(results.appBucketPurged).toBeUndefined();
      expect(results.backupsPurged).toBe(true);
      expect(new Set(world.asked)).toEqual(new Set(scope === 'own' ? [own] : addressable));
    });

    if (scope === 'all') {
      it('a region that answers 403 during the search still fails closed: a leak, never purged', async () => {
        const { others } = await hostsOf(provider, region);
        world.forbiddenHost = others[0];
        const { results, stops } = await purge(provider, region);

        expect(stops.some((m) => /^stop:S3 deletion failed: .* answered "/.test(m))).toBe(true);
        expect(results.leaks.exitCode()).toBe(2);
        expect(results.appBucketPurged).toBeUndefined();
        expect(results.backupsPurged).toBeUndefined();
      });
    }
  },
);
