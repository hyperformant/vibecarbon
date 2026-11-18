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
 *
 * And "not found" needs one more witness: the provider's own bucket listing,
 * read after the search (bucketListedIn). On 2026-11-16 a new Hetzner bucket
 * answered NoSuchBucket to the delete and 404 to every HeadBucket for 20
 * minutes while ListBuckets on the same endpoint still showed it. Destroy
 * said "not found in any region (already deleted or never created)", exited
 * 0, and left a billable bucket. A bucket the listing still shows is now
 * UNVERIFIED and exit 2, on every provider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';

/**
 * Which host answers 403 to everything, and what each host's ListBuckets
 * shows. No host holds any bucket: every bucket command says NoSuchBucket
 * and every HeadBucket says NotFound, whatever the listings show.
 */
const world = vi.hoisted(() => ({
  elsewhere: 'missing' as 'missing' | 'forbidden',
  forbiddenHost: '' as string,
  asked: [] as string[],
  /** host -> the bucket names its ListBuckets shows (none when absent). */
  listed: {} as Record<string, string[]>,
  /** A host whose ListBuckets answers 403 while its bucket commands still answer. */
  listingRefusedHost: '' as string,
  /** Every request in order, as `Command@host`. */
  sent: [] as string[],
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
      world.sent.push(`${command.constructor.name}@${this.host}`);
      if (world.forbiddenHost && this.host === world.forbiddenHost) throw forbidden();
      if (command.constructor.name === 'ListBucketsCommand') {
        if (world.listingRefusedHost === this.host) throw forbidden();
        return { Buckets: (world.listed[this.host] ?? []).map((Name) => ({ Name })) };
      }
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
  world.listed = {};
  world.listingRefusedHost = '';
  world.sent = [];
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

describe.each(CASES)(
  '-purge of a bucket $provider still lists while it answers NoSuchBucket (the 2026-11-16 leak)',
  ({ provider, region, scope }) => {
    const unverified = (results: { leaks: ReturnType<typeof createLeakLedger> }) =>
      results.leaks.entries.filter((e) => e.severity === 'unverified');

    it('records each bucket as UNVERIFIED and exits 2, never "not found"', async () => {
      const { own } = await hostsOf(provider, region);
      world.listed = { [own]: [APP, BACKUPS, 'someone-elses-bucket'] };
      const { results, stops } = await purge(provider, region);

      expect(stops.some((m) => /not found/.test(m))).toBe(false);
      expect(stops.some((m) => m.startsWith(`stop:S3 bucket not confirmed gone: ${APP} `))).toBe(
        true,
      );
      expect(
        stops.some((m) => m.startsWith(`stop:Backup bucket not confirmed gone: ${BACKUPS} `)),
      ).toBe(true);

      const lines = unverified(results);
      expect(lines.map((e) => e.resourceClass)).toEqual(['bucket', 'bucket']);
      // Each line names its bucket, says why, and says what to do.
      for (const [line, bucket] of [
        [lines[0], APP],
        [lines[1], BACKUPS],
      ] as const) {
        expect(line.resource).toContain(bucket);
        expect(line.reason).toContain(`${bucket} answered NoSuchBucket`);
        expect(line.reason).toMatch(/the bucket listing in \S+ still shows it/);
        expect(line.hint).toContain(bucket);
        expect(line.hint).toMatch(/in about 15 minutes/);
        expect(line.hint).toMatch(/the provider Object Storage console/);
        // A bucket line does not keep the entry, so a rerun finds nothing.
        expect(line.hint).not.toMatch(/vibecarbon destroy/);
      }
      expect(results.leaks.counts().leak).toBe(0);
      expect(results.leaks.exitCode()).toBe(2);
      // Nothing was deleted and nothing is known gone: no record says purged.
      expect(results.appBucketPurged).toBeUndefined();
      expect(results.backupsPurged).toBeUndefined();
    });

    it('reads the listing after the HeadBucket search, once per region, and never tries the delete again', async () => {
      const { own, addressable } = await hostsOf(provider, region);
      world.listed = { [own]: [APP] };
      const ctx = await purge(provider, region);
      expect(unverified(ctx.results).map((e) => e.resource)).toEqual([
        expect.stringContaining(APP),
      ]);

      // The app bucket's requests are the ones before the backups purge starts.
      const appRun = world.sent.slice(0, world.sent.indexOf(`ListObjectsV2Command@${own}`, 1));
      const kinds = appRun.map((c) => c.split('@')[0]);
      const lastHead = kinds.lastIndexOf('HeadBucketCommand');
      const firstList = kinds.indexOf('ListBucketsCommand');
      expect(lastHead).toBeGreaterThan(-1);
      expect(firstList).toBeGreaterThan(lastHead);
      // One delete attempt (it fails at its first request), one search, and
      // the listing read until the bucket shows: no second try, no wait.
      expect(kinds.filter((k) => k === 'ListObjectsV2Command')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'HeadBucketCommand')).toHaveLength(addressable.length);
      expect(kinds.filter((k) => k === 'ListBucketsCommand').length).toBeLessThanOrEqual(
        addressable.length,
      );
    });

    it('a listing that cannot be read cannot vouch for it either: UNVERIFIED, exit 2', async () => {
      const { own } = await hostsOf(provider, region);
      world.listingRefusedHost = own;
      const { results, stops } = await purge(provider, region);

      expect(stops.some((m) => /not found/.test(m))).toBe(false);
      expect(unverified(results)).toHaveLength(2);
      expect(unverified(results)[0].reason).toMatch(/when asked to list its buckets/);
      expect(results.leaks.exitCode()).toBe(2);
      expect(results.backupsPurged).toBeUndefined();
    });

    if (scope === 'all') {
      it('a listing in another region these keys reach counts too', async () => {
        const { others } = await hostsOf(provider, region);
        world.listed = { [others[0]]: [APP] };
        const { results, stops } = await purge(provider, region);

        expect(stops.some((m) => m.startsWith(`stop:S3 bucket not confirmed gone: ${APP} `))).toBe(
          true,
        );
        // The backups bucket is listed nowhere: still "not found", as before.
        expect(stops).toContain(
          'stop:Backup bucket not found in any region (already deleted or never created)',
        );
        expect(unverified(results)).toHaveLength(1);
        expect(results.leaks.exitCode()).toBe(2);
      });
    }
  },
);
