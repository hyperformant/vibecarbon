/**
 * Hetzner orphan sweep: the Object Storage bucket half.
 *
 * Until this file the Hetzner sweep logged every bucket-delete error as
 * FAILED and never set enumFailed, so a bucket it could not delete read as
 * clean. It now decides like the DO, Linode, Vultr and Scaleway sweeps:
 * through classifyBucketDeleteError, which counts a "no such bucket" as
 * gone only when locateBucket finds the bucket in no region.
 *
 * The fakes follow what real Hetzner did on 2026-11-15 (one citest- bucket
 * in fsn1): each endpoint's ListBuckets lists only its own location's
 * buckets, and a delete of a deleted bucket throws NoSuchBucket, HTTP 404,
 * "The specified bucket does not exist.". So did a delete through another
 * location's endpoint while the bucket still lived in fsn1, which is why the
 * region search, not the code, decides. Those "no such bucket" cases (a
 * stale listing, the 2026-11-16 leak, a region still holding it) run for
 * every sweep, Hetzner included, in sweep-shared-cases.test.ts.
 *
 * A sweep that could not look must not read clean either: a location whose
 * ListBuckets fails, or missing storage keys, marks the sweep incomplete,
 * as the other four sweeps do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepOrphanedHetznerResources } from '../../e2e/utils/sweep-hetzner.js';

type Deps = NonNullable<Parameters<typeof sweepOrphanedHetznerResources>[3]>;
type StoresLike = NonNullable<Deps['objectStorageByRegion']>;
type StoreLike = StoresLike[string];

function fakeStore(overrides: Partial<StoreLike> = {}): StoreLike {
  return {
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    locateBucket: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** Every Cloud API listing answers one empty, final page; every DELETE succeeds. */
const emptyCloud = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
})) as unknown as typeof fetch;

const TAG = '[test]';
const PROJECT = 'testapp-h1';

describe('sweepOrphanedHetznerResources: buckets', () => {
  it("deletes a region's prefix-matching buckets through that region", async () => {
    const fsn1 = fakeStore({
      listBuckets: vi.fn().mockResolvedValue(['testapp-h1-backups', 'unrelated-bucket']),
      emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 2 }),
    });
    const { counts, enumFailed } = await sweepOrphanedHetznerResources(TAG, PROJECT, 'tok', {
      fetchImpl: emptyCloud,
      objectStorageByRegion: { nbg1: fakeStore(), fsn1, hel1: fakeStore() },
    });
    expect(fsn1.emptyAndDeleteBucket).toHaveBeenCalledTimes(1);
    expect(fsn1.emptyAndDeleteBucket).toHaveBeenCalledWith('testapp-h1-backups');
    expect(counts.s3Buckets).toBe(1);
    expect(enumFailed).toBe(false);
  });

  it('a bucket it cannot delete for any other reason fails the sweep', async () => {
    const locateBucket = vi.fn().mockResolvedValue(null);
    const denied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const hel1 = fakeStore({
      listBuckets: vi.fn().mockResolvedValue(['testapp-h1-app']),
      emptyAndDeleteBucket: vi.fn().mockRejectedValue(denied),
      locateBucket,
    });
    const { enumFailed } = await sweepOrphanedHetznerResources(TAG, PROJECT, 'tok', {
      fetchImpl: emptyCloud,
      objectStorageByRegion: { nbg1: fakeStore(), fsn1: fakeStore(), hel1 },
    });
    expect(enumFailed).toBe(true);
    // Not a missing-bucket answer, so there is nothing for a search to confirm.
    expect(locateBucket).not.toHaveBeenCalled();
  });
});

describe('sweepOrphanedHetznerResources: a bucket sweep that could not look', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('a location whose listing throws marks the sweep incomplete, and the others are still swept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nbg1 = fakeStore({
      listBuckets: vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')),
    });
    const fsn1 = fakeStore({
      listBuckets: vi.fn().mockResolvedValue(['testapp-h1-backups']),
    });
    const { counts, enumFailed } = await sweepOrphanedHetznerResources(TAG, PROJECT, 'tok', {
      fetchImpl: emptyCloud,
      objectStorageByRegion: { nbg1, fsn1, hel1: fakeStore() },
    });
    expect(enumFailed).toBe(true);
    expect(fsn1.emptyAndDeleteBucket).toHaveBeenCalledWith('testapp-h1-backups');
    expect(counts.s3Buckets).toBe(1);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/nbg1/);
  });

  it('a missing storage key marks the sweep incomplete and names the variable, never a value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('HETZNER_ACCESS_KEY', 'HZTESTACCESSVALUE123');
    vi.stubEnv('HETZNER_SECRET_KEY', undefined);
    const { enumFailed } = await sweepOrphanedHetznerResources(TAG, PROJECT, 'tok', {
      fetchImpl: emptyCloud,
    });
    expect(enumFailed).toBe(true);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('HETZNER_SECRET_KEY');
    expect(warned).not.toContain('HETZNER_ACCESS_KEY');
    expect(warned).not.toContain('HZTESTACCESSVALUE123');
  });

  it('with both keys missing, both are named', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('HETZNER_ACCESS_KEY', undefined);
    vi.stubEnv('HETZNER_SECRET_KEY', undefined);
    const { enumFailed } = await sweepOrphanedHetznerResources(TAG, PROJECT, 'tok', {
      fetchImpl: emptyCloud,
    });
    expect(enumFailed).toBe(true);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('HETZNER_ACCESS_KEY');
    expect(warned).toContain('HETZNER_SECRET_KEY');
  });
});
