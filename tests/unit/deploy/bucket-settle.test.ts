/**
 * How long a new bucket counts as young. Only the state lock's scope and the
 * deploy's creation-time record read this; nothing waits on it.
 */
import { describe, expect, it } from 'vitest';
import { bucketIsYoung, settleWindowFor } from '../../../src/lib/deploy/bucket-settle.js';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

const MIN = 60_000;
const W = 20 * MIN;
const now = Date.parse('2026-10-20T12:00:00Z');

describe('bucketIsYoung', () => {
  it('is true inside the window or with an unknown age, false past it', () => {
    expect(bucketIsYoung(new Date(now - 21 * MIN), now, W)).toBe(false);
    expect(bucketIsYoung(new Date(now - 19 * MIN), now, W)).toBe(true);
    expect(bucketIsYoung(null, now, W)).toBe(true);
  });

  it('is always false with a 0 window', () => {
    expect(bucketIsYoung(new Date(now - 21 * MIN), now, 0)).toBe(false);
    expect(bucketIsYoung(new Date(now - 19 * MIN), now, 0)).toBe(false);
    expect(bucketIsYoung(null, now, 0)).toBe(false);
  });
});

describe('settleWindowFor', () => {
  it('reads the provider S3 class window', async () => {
    await expect(settleWindowFor('hetzner')).resolves.toBe(20 * MIN);
    await expect(settleWindowFor('digitalocean')).resolves.toBe(0);
  });
});

describe('S3CompatibleProvider.bucketCreatedAt', () => {
  const make = (listBuckets: () => Promise<unknown>) => {
    const p = new HetznerS3Provider('ak', 'sk', 'fsn1');
    (p as unknown as { listBuckets: unknown }).listBuckets = listBuckets;
    return p;
  };

  it("reads the bucket's ListBuckets CreationDate", async () => {
    const date = new Date('2026-10-20T11:56:00Z');
    const p = make(async () => [
      { name: 'other', creationDate: new Date(0) },
      { name: 'app-b', creationDate: date },
    ]);
    await expect(p.bucketCreatedAt('app-b')).resolves.toEqual(date);
  });

  it('is null for an unlisted bucket, a missing date, or any error', async () => {
    await expect(make(async () => []).bucketCreatedAt('app-b')).resolves.toBeNull();
    await expect(
      make(async () => [{ name: 'app-b', creationDate: undefined }]).bucketCreatedAt('app-b'),
    ).resolves.toBeNull();
    await expect(
      make(async () => {
        throw new Error('AccessDenied');
      }).bucketCreatedAt('app-b'),
    ).resolves.toBeNull();
  });
});
