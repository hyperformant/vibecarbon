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
import { describe, expect, it } from 'vitest';
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
