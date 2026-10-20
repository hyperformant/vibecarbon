/**
 * The bucket settle gate. A brand-new Hetzner bucket answers inconsistently
 * for about 16 minutes (2026-10-20 probes), so verification waits for three
 * consecutive clean rounds of fresh-connection probes before it uploads. The
 * deploy never waits on it; these pin the pure pieces both sides share.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BUCKET_SETTLE_BUDGET_MS,
  BUCKET_SETTLE_ROUND_INTERVAL_MS,
  BUCKET_SETTLE_ROUND_SIZE,
  BUCKET_SETTLE_STREAK,
  bucketNeedsSettle,
  bucketSettleNote,
  makeAppBucketProbeRound,
  settleWindowFor,
  storageSettleStatus,
  waitForBucketSettled,
} from '../../../src/lib/deploy/bucket-settle.js';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

const MIN = 60_000;
const W = 20 * MIN;
const now = Date.parse('2026-10-20T12:00:00Z');

describe('gate constants', () => {
  it('match the plan', () => {
    expect(BUCKET_SETTLE_ROUND_SIZE).toBe(20);
    expect(BUCKET_SETTLE_STREAK).toBe(3);
    expect(BUCKET_SETTLE_ROUND_INTERVAL_MS).toBe(30_000);
    expect(BUCKET_SETTLE_BUDGET_MS).toBe(25 * MIN);
  });
});

describe('bucketNeedsSettle', () => {
  it('is true inside the window or with an unknown age, false past it', () => {
    expect(bucketNeedsSettle(new Date(now - 21 * MIN), now, W)).toBe(false);
    expect(bucketNeedsSettle(new Date(now - 19 * MIN), now, W)).toBe(true);
    expect(bucketNeedsSettle(null, now, W)).toBe(true);
  });

  it('is always false with a 0 window', () => {
    expect(bucketNeedsSettle(new Date(now - 21 * MIN), now, 0)).toBe(false);
    expect(bucketNeedsSettle(new Date(now - 19 * MIN), now, 0)).toBe(false);
    expect(bucketNeedsSettle(null, now, 0)).toBe(false);
  });
});

describe('storageSettleStatus', () => {
  it('reports the time left inside the window', () => {
    expect(storageSettleStatus(new Date(now - 4 * MIN).toISOString(), now, W)).toEqual({
      settling: true,
      remainingMs: 16 * MIN,
    });
  });

  it('is settled past the window', () => {
    expect(storageSettleStatus(new Date(now - 21 * MIN), now, W)).toEqual({
      settling: false,
      remainingMs: 0,
    });
  });

  it('treats an unknown age as settling with no estimate', () => {
    expect(storageSettleStatus(null, now, W)).toEqual({ settling: true, remainingMs: null });
  });

  it('is never settling with a 0 window, whatever the age', () => {
    for (const createdAt of [null, new Date(now - MIN), new Date(now - MIN).toISOString()]) {
      expect(storageSettleStatus(createdAt, now, 0)).toEqual({ settling: false, remainingMs: 0 });
    }
  });
});

describe('bucketSettleNote', () => {
  it('names the minutes left, or the whole window for an unknown age', () => {
    expect(bucketSettleNote({ settling: true, remainingMs: 16 * MIN }, W)).toBe(
      'new storage bucket, browser uploads can fail for about 16 more minutes while it settles; vibecarbon status shows when it is done',
    );
    expect(bucketSettleNote({ settling: true, remainingMs: null }, W)).toContain('about 20 more');
  });
});

describe('settleWindowFor', () => {
  it('reads the provider S3 class window', async () => {
    await expect(settleWindowFor('hetzner')).resolves.toBe(20 * MIN);
    await expect(settleWindowFor('digitalocean')).resolves.toBe(0);
  });
});

/** A probe round that replays `oks` (out of 20), then repeats the last one. */
function scripted(oks: number[]) {
  let i = 0;
  return vi.fn(async () => {
    const ok = oks[Math.min(i, oks.length - 1)];
    i += 1;
    return {
      ok,
      total: 20,
      failures: Array.from({ length: 20 - ok }, () => 'options:403'),
    };
  });
}

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe('waitForBucketSettled', () => {
  it('a failure resets the streak', async () => {
    const clock = fakeClock();
    const r = await waitForBucketSettled({
      probeRound: scripted([20, 19, 20, 20, 20]),
      ...clock,
      budgetMs: BUCKET_SETTLE_BUDGET_MS,
    });
    expect(r).toMatchObject({ settled: true, rounds: 5 });
  });

  it('three clean rounds in a row settle it', async () => {
    const clock = fakeClock();
    const r = await waitForBucketSettled({
      probeRound: scripted([20, 20, 20]),
      ...clock,
      budgetMs: BUCKET_SETTLE_BUDGET_MS,
    });
    expect(r).toMatchObject({ settled: true, rounds: 3 });
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledWith(BUCKET_SETTLE_ROUND_INTERVAL_MS);
  });

  it('an exhausted budget returns unsettled with the last failures, and does not hang', async () => {
    const clock = fakeClock();
    const r = await waitForBucketSettled({
      probeRound: scripted([19]),
      ...clock,
      budgetMs: 25 * MIN,
    });
    expect(r.settled).toBe(false);
    expect(r.rounds).toBeLessThanOrEqual(Math.ceil((25 * MIN) / 30_000) + 1);
    expect(r.lastFailures.length).toBeGreaterThan(0);
  });
});

describe('makeAppBucketProbeRound', () => {
  const opts = {
    endpoint: 'https://fsn1.your-objectstorage.com',
    bucket: 'p-abc123-storage',
    keyPrefix: 'prod/',
    origin: 'https://app.example.com',
  };

  it('fires half preflights and half signed HeadBucket calls', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', {
          status: 200,
          headers: { 'access-control-allow-origin': opts.origin },
        }),
    );
    const signedHead = vi.fn(async () => {});
    const round = makeAppBucketProbeRound({ ...opts, signedHead, fetchImpl });
    await expect(round()).resolves.toEqual({ ok: 20, total: 20, failures: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(signedHead).toHaveBeenCalledTimes(10);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fsn1.your-objectstorage.com/p-abc123-storage/prod/.settle-probe');
    expect(init).toMatchObject({
      method: 'OPTIONS',
      headers: { Origin: opts.origin, 'Access-Control-Request-Method': 'PUT' },
    });
  });

  it('counts a missing ACAO header, a refused preflight and a HeadBucket error as failures', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response('', { status: 200 });
      if (n === 2) return new Response('', { status: 403 });
      return new Response('', {
        status: 200,
        headers: { 'access-control-allow-origin': opts.origin },
      });
    });
    let h = 0;
    const signedHead = vi.fn(async () => {
      h += 1;
      if (h === 1) {
        const err = new Error('gone');
        err.name = 'NoSuchBucket';
        throw err;
      }
    });
    const r = await makeAppBucketProbeRound({ ...opts, signedHead, fetchImpl })();
    expect(r.ok).toBe(17);
    expect(r.total).toBe(20);
    expect(r.failures.sort()).toEqual(['head:NoSuchBucket', 'options:200-no-acao', 'options:403']);
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
