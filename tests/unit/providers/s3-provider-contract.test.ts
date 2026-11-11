/**
 * S3 (object-storage) provider contract suite (2026-08-07 test-architecture
 * audit).
 *
 * The compute half has provider-contract.test.ts; the S3 half had NOTHING
 * iterating its subclasses, and the two existing ones had already diverged
 * in shape unnoticed — HetznerS3Provider.REGIONS was an object
 * {slug: description} (the shape s3-base's getRegions() docblock promises)
 * while DigitalOceanSpacesProvider.REGIONS was a bare array of slugs. Each
 * subclass's hand-written mirror test asserted its own drifted shape, so
 * both stayed green.
 *
 * This suite derives the S3 class list FROM the compute registry
 * (getObjectStorageProviderClass()), so registering a compute provider
 * automatically drafts its object-storage class into every invariant here.
 */
import { describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { S3CompatibleProvider } from '../../../src/lib/providers/s3-base.js';

const ENTRIES: Array<[string, typeof S3CompatibleProvider]> = await Promise.all(
  Object.entries(PROVIDERS).map(
    async ([id, Provider]) =>
      [id, await Provider.getObjectStorageProviderClass()] as [string, typeof S3CompatibleProvider],
  ),
);

describe('S3 provider registry coverage', () => {
  it('every compute provider resolves an S3CompatibleProvider subclass (not vacuously green)', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(2);
    for (const [id, S3Class] of ENTRIES) {
      expect(
        Object.prototype.isPrototypeOf.call(S3CompatibleProvider, S3Class),
        `${id}'s object-storage class does not extend S3CompatibleProvider`,
      ).toBe(true);
    }
  });

  it('no two compute providers share an object-storage class', () => {
    const classes = ENTRIES.map(([, S3Class]) => S3Class);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('OBJECT_STORAGE_ENV names are unique across providers (a collision would cross-wire credentials)', () => {
    const all = Object.values(PROVIDERS).flatMap((P) => P.OBJECT_STORAGE_ENV);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe.each(ENTRIES)('S3 provider contract: %s', (_id, S3Class) => {
  it('REGIONS is a slug → human-description map (the shape getRegions() promises), not an array', () => {
    expect(Array.isArray(S3Class.REGIONS)).toBe(false);
    expect(typeof S3Class.REGIONS).toBe('object');
    for (const [slug, description] of Object.entries(S3Class.REGIONS)) {
      expect(typeof description, `REGIONS.${slug} must be a human-readable description`).toBe(
        'string',
      );
      expect((description as string).length).toBeGreaterThan(3);
    }
  });

  it('REGIONS and ENDPOINTS cover exactly the same slugs', () => {
    expect(Object.keys(S3Class.REGIONS).sort()).toEqual(Object.keys(S3Class.ENDPOINTS).sort());
  });

  it('every endpoint is https and names its own region slug', () => {
    for (const [slug, url] of Object.entries(S3Class.ENDPOINTS)) {
      expect(url, `ENDPOINTS.${slug}`).toMatch(/^https:\/\//);
      expect(url, `ENDPOINTS.${slug} should embed its region slug`).toContain(slug);
    }
  });

  it('resolveS3Region is identity for S3-capable regions and total otherwise', () => {
    for (const slug of Object.keys(S3Class.ENDPOINTS)) {
      expect(S3Class.resolveS3Region(slug)).toBe(slug);
    }
    for (const unknown of ['not-a-region', '', undefined]) {
      const resolved = S3Class.resolveS3Region(unknown as never);
      expect(
        S3Class.ENDPOINTS[resolved],
        `resolveS3Region(${JSON.stringify(unknown)}) → "${resolved}" which has no endpoint`,
      ).toBeDefined();
    }
  });

  it('getRegions() returns the subclass REGIONS map (polymorphic static intact)', () => {
    expect(S3Class.getRegions()).toBe(S3Class.REGIONS);
  });
});

/**
 * An instance never changes region. createBucket used to move the instance
 * to wherever an existing bucket of that name lived, so one bucket's answer
 * moved every later call on the same client: a second environment in fsn1
 * recorded its fsn1 uploads bucket as nbg1 because the project's backups
 * bucket lived in nbg1. A bucket elsewhere is now reached through
 * forRegion(), and each create reports its own bucket's region.
 */
describe.each(ENTRIES)('S3 provider region is fixed at construction: %s', (_id, S3Class) => {
  const [own, other] = Object.keys(S3Class.ENDPOINTS);
  type Internals = S3CompatibleProvider & {
    bucketExists: (b: string) => Promise<boolean>;
    _send: (c: unknown, o?: unknown) => Promise<unknown>;
    findBucketRegion: (b: string) => Promise<string | null>;
    waitForBucketVisible: (b: string) => Promise<boolean>;
  };
  const make = () => new S3Class('AKCONTRACT', 'SKCONTRACT', own) as Internals;
  const s3Error = (name: string, status: number) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it('has at least two regions, so forRegion has another to reach', () => {
    expect(other).toBeDefined();
  });

  it('forRegion(other) is a new instance of the same class at that region, same keys', () => {
    const store = make();
    const there = store.forRegion(other);
    expect(there).not.toBe(store);
    expect(there.constructor).toBe(S3Class);
    expect(there.region).toBe(other);
    expect(there.getEndpoint()).toBe(S3Class.ENDPOINTS[other]);
    expect(there.accessKeyId).toBe('AKCONTRACT');
    expect(there.secretAccessKey).toBe('SKCONTRACT');
    // The original is untouched.
    expect(store.region).toBe(own);
  });

  it('forRegion(own region) is the same instance', () => {
    const store = make();
    expect(store.forRegion(own)).toBe(store);
  });

  it('a bucket found in another region is reported there and the instance stays put', async () => {
    const store = make();
    const clientBefore = store.getClient();
    store.bucketExists = vi.fn(async () => false);
    store._send = vi.fn(async () => {
      throw s3Error('BucketAlreadyExists', 409);
    });
    store.findBucketRegion = vi.fn(async () => other);

    const result = await store.createBucket('elsewhere-bucket');

    expect(result).toEqual({
      name: 'elsewhere-bucket',
      created: false,
      ready: true,
      region: other,
      endpoint: S3Class.ENDPOINTS[other],
      message: 'Bucket already exists',
    });
    expect(store.region).toBe(own);
    expect(store.getEndpoint()).toBe(S3Class.ENDPOINTS[own]);
    expect(store.getClient()).toBe(clientBefore);
  });

  it('a bucket that already answers HEAD here reports this region', async () => {
    const store = make();
    store.bucketExists = vi.fn(async () => true);
    await expect(store.createBucket('here-bucket')).resolves.toMatchObject({
      created: false,
      ready: true,
      region: own,
      endpoint: S3Class.ENDPOINTS[own],
    });
  });

  it('a bucket we already own here (BucketAlreadyOwnedByYou) reports this region', async () => {
    const store = make();
    store.bucketExists = vi.fn(async () => false);
    store._send = vi.fn(async () => {
      throw s3Error('BucketAlreadyOwnedByYou', 409);
    });
    await expect(store.createBucket('mine-bucket')).resolves.toMatchObject({
      created: false,
      ready: true,
      region: own,
      endpoint: S3Class.ENDPOINTS[own],
    });
  });

  it('a bucket this call created reports this region', async () => {
    const quiet = S3Class.bucketQuietMs;
    S3Class.bucketQuietMs = 0;
    try {
      const store = make();
      store.bucketExists = vi.fn(async () => false);
      store._send = vi.fn(async () => ({}));
      store.waitForBucketVisible = vi.fn(async () => true);
      await expect(store.createBucket('new-bucket')).resolves.toEqual({
        name: 'new-bucket',
        created: true,
        ready: true,
        region: own,
        endpoint: S3Class.ENDPOINTS[own],
      });
    } finally {
      S3Class.bucketQuietMs = quiet;
    }
  });
});

describe.each(Object.entries(PROVIDERS))('compute → S3 region totality: %s', (_id, Provider) => {
  it('resolveS3Region answers every deployable compute region with an S3-capable one', async () => {
    const S3Class = await Provider.getObjectStorageProviderClass();
    for (const computeRegion of Object.keys(Provider.REGIONS)) {
      const s3Region = S3Class.resolveS3Region(computeRegion);
      expect(
        S3Class.ENDPOINTS[s3Region],
        `deploy region "${computeRegion}" resolves to "${s3Region}" which has no endpoint`,
      ).toBeDefined();
    }
  });
});
