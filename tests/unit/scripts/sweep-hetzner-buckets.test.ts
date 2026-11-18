/**
 * scripts/sweep-hetzner.js: the Object Storage bucket pass and what it does
 * to the script's verdict.
 *
 * Until 2026-11-17 the pass could not fail the script. Missing storage keys,
 * a location whose ListBuckets failed, and a bucket whose delete failed all
 * returned "0 deleted", and with nothing else touched the script printed
 * "clean" and exited 0. The harness sweep (tests/e2e/utils/sweep-hetzner.ts)
 * already treats all three as "could not look, so cannot say clean".
 *
 * The stores are fakes in the shape the pass reads: one per location, with
 * `listBuckets()` (names) and `emptyAndDeleteBucket(name)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error: plain JS ops script, no types
import { canSkipRecheck, sweepS3Buckets, sweepVerdict } from '../../../scripts/sweep-hetzner.js';

const PREFIX = 'testapp-';

function fakeStore(overrides: Record<string, unknown> = {}) {
  return {
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ deleted: true, objectsRemoved: 0 }),
    ...overrides,
  };
}

let out: string[];

beforeEach(() => {
  out = [];
  const keep = (...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sweepS3Buckets', () => {
  it('deletes scratch-prefixed buckets through the location that listed them, and no others', async () => {
    const fsn1 = fakeStore({
      listBuckets: vi.fn().mockResolvedValue(['testapp-k8s-1-backups', 'vibecarbon-web-prod']),
    });
    const hel1 = fakeStore({ listBuckets: vi.fn().mockResolvedValue(['citest-compose-9-app']) });
    const result = await sweepS3Buckets({
      storesByRegion: { nbg1: fakeStore(), fsn1, hel1 },
      prefix: PREFIX,
    });
    expect(fsn1.emptyAndDeleteBucket.mock.calls).toEqual([['testapp-k8s-1-backups']]);
    expect(hel1.emptyAndDeleteBucket).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 1, gaps: [] });
  });

  it('a clean account reports nothing deleted and no gap', async () => {
    const result = await sweepS3Buckets({
      storesByRegion: { nbg1: fakeStore(), fsn1: fakeStore(), hel1: fakeStore() },
      prefix: PREFIX,
    });
    expect(result).toEqual({ deleted: 0, gaps: [] });
  });

  it('missing storage keys are a gap that names the variable, never a value', async () => {
    const result = await sweepS3Buckets({
      accessKey: 'HZTESTACCESSVALUE123',
      secretKey: '',
      prefix: PREFIX,
    });
    expect(result.deleted).toBe(0);
    expect(result.gaps).toEqual(['HETZNER_SECRET_KEY not set']);
    expect(out.join('\n')).toContain('HETZNER_SECRET_KEY');
    expect(out.join('\n')).not.toContain('HZTESTACCESSVALUE123');
  });

  it('with both keys missing, both are named', async () => {
    const result = await sweepS3Buckets({ accessKey: '', secretKey: '', prefix: PREFIX });
    expect(result.gaps).toEqual(['HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY not set']);
  });

  it('a location whose listing fails is a gap, and the other locations are still swept', async () => {
    const nbg1 = fakeStore({
      listBuckets: vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT')),
    });
    const fsn1 = fakeStore({ listBuckets: vi.fn().mockResolvedValue(['testapp-a-backups']) });
    const result = await sweepS3Buckets({
      storesByRegion: { nbg1, fsn1 },
      prefix: PREFIX,
    });
    expect(fsn1.emptyAndDeleteBucket).toHaveBeenCalledWith('testapp-a-backups');
    expect(result.deleted).toBe(1);
    expect(result.gaps).toEqual(['s3/nbg1 bucket listing failed']);
    expect(out.join('\n')).toContain('connect ETIMEDOUT');
  });

  it('a bucket whose delete fails is a gap that names it, and the next bucket is still tried', async () => {
    const emptyAndDeleteBucket = vi
      .fn()
      .mockRejectedValueOnce(new Error('Access Denied'))
      .mockResolvedValue({ deleted: true, objectsRemoved: 3 });
    const fsn1 = fakeStore({
      listBuckets: vi.fn().mockResolvedValue(['testapp-a-app', 'testapp-a-backups']),
      emptyAndDeleteBucket,
    });
    const result = await sweepS3Buckets({ storesByRegion: { fsn1 }, prefix: PREFIX });
    expect(emptyAndDeleteBucket).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ deleted: 1, gaps: ['s3/fsn1/testapp-a-app delete failed'] });
    expect(out.join('\n')).toContain('FAILED: Access Denied');
  });

  it('an emptied bucket whose shell is not removable yet is neither deleted nor a gap (a later sweep collects it)', async () => {
    const fsn1 = fakeStore({
      listBuckets: vi.fn().mockResolvedValue(['testapp-a-app']),
      emptyAndDeleteBucket: vi
        .fn()
        .mockResolvedValue({ deleted: false, shellDeferred: true, objectsRemoved: 4 }),
    });
    const result = await sweepS3Buckets({ storesByRegion: { fsn1 }, prefix: PREFIX });
    expect(result).toEqual({ deleted: 0, gaps: [] });
    expect(out.join('\n')).toContain('empty shell');
  });
});

describe('the verdict with a bucket gap', () => {
  const cleanVolumes = { items: [], complete: true };

  it('"clean" is not printed without the recheck when the bucket pass has a gap', () => {
    expect(canSkipRecheck({ touched: 0, volumes: cleanVolumes, bucketGaps: [] })).toBe(true);
    expect(
      canSkipRecheck({
        touched: 0,
        volumes: cleanVolumes,
        bucketGaps: ['HETZNER_SECRET_KEY not set'],
      }),
    ).toBe(false);
  });

  it('a bucket gap fails the script even when the Cloud API recheck is clean', () => {
    const verdict = sweepVerdict({
      leaked: 0,
      blind: 0,
      bucketGaps: ['s3/fsn1/testapp-a-app delete failed'],
    });
    expect(verdict.code).toBe(1);
    expect(verdict.lines.join('\n')).toContain('s3/fsn1/testapp-a-app delete failed');
    expect(verdict.lines.join('\n')).toContain('cannot certify clean');
  });

  it('leftovers and unreadable listings keep failing it, and a full clean recheck passes', () => {
    expect(sweepVerdict({ leaked: 2, blind: 0, bucketGaps: [] }).code).toBe(1);
    expect(sweepVerdict({ leaked: 0, blind: 1, bucketGaps: [] }).code).toBe(1);
    expect(sweepVerdict({ leaked: 0, blind: 0, bucketGaps: [] })).toEqual({ code: 0, lines: [] });
  });
});
