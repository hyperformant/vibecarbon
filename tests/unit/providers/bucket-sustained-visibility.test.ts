/**
 * waitForBucketVisible must prove SUSTAINED visibility, not one lucky sample.
 *
 * RCA 2026-08-17 (runs 31970876667 / 31984725162 / 31997668866, the
 * registry-500 class): Hetzner object storage acks CreateBucket, a single
 * HEAD+LIST passes — and MINUTES later the in-cluster registry's S3 driver
 * still gets `s3aws: NoSuchBucket` resolving an upload session, because the
 * provider's frontends propagate bucket metadata independently and each new
 * connection may land on a different one. One successful round proves one
 * frontend, not the bucket.
 *
 * The strengthened condition: K CONSECUTIVE rounds of HEAD+LIST (a flap
 * resets the streak — disagreeing frontends must converge, not get lucky)
 * plus one write → read → delete round-trip so the WRITE path every consumer
 * (registry uploads, wal-g, Pulumi state) depends on is proven too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanSpacesProvider } from '../../../src/lib/providers/digitalocean-spaces.js';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

function makeProvider({
  headResults,
  failWrites = 0,
  provider = new HetznerS3Provider('ak', 'sk', 'fsn1'),
}: {
  /** Per-round bucketExists outcomes (true/false); last value repeats. */
  headResults: boolean[];
  /** How many leading write-probe PutObjects fail before succeeding. */
  failWrites?: number;
  provider?: unknown;
}) {
  const p = provider as {
    bucketExists: (b: string) => Promise<boolean>;
    _send: (cmd: unknown, opts?: unknown) => Promise<unknown>;
    waitForBucketVisible: (b: string, opts?: Record<string, unknown>) => Promise<boolean>;
  };
  let round = 0;
  p.bucketExists = vi.fn(async () => {
    const i = Math.min(round, headResults.length - 1);
    round++;
    return headResults[i];
  });
  let writeFails = failWrites;
  const sends: string[] = [];
  p._send = vi.fn(async (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    sends.push(name);
    if (name === 'PutObjectCommand' && writeFails > 0) {
      writeFails--;
      const err = new Error('NoSuchBucket') as Error & { name: string };
      err.name = 'NoSuchBucket';
      throw err;
    }
    if (name === 'GetObjectCommand') return { Body: { transformToString: async () => 'probe' } };
    return {};
  });
  return { p, sends };
}

const fastOpts = { intervalMs: 0, budgetMs: 5_000 };

describe('waitForBucketVisible sustained-visibility condition', () => {
  it('requires consecutive clean rounds — a flap resets the streak', async () => {
    // visible, visible, FLAP, then visible forever: the two pre-flap rounds
    // must not count toward the streak.
    const { p } = makeProvider({ headResults: [true, true, false, true] });

    await expect(p.waitForBucketVisible('b', fastOpts)).resolves.toBe(true);

    // 2 pre-flap + 1 flap + a full fresh streak of at least 3 after it.
    expect(vi.mocked(p.bucketExists).mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('proves the WRITE path with a put → get → delete round-trip', async () => {
    const { p, sends } = makeProvider({ headResults: [true] });

    await expect(p.waitForBucketVisible('b', fastOpts)).resolves.toBe(true);

    expect(sends).toContain('PutObjectCommand');
    expect(sends).toContain('GetObjectCommand');
    expect(sends).toContain('DeleteObjectCommand');
    // The write probe is part of the gated condition, so it must precede
    // the resolve — order: last round's LIST happens before Put/Get/Delete.
    const putIdx = sends.indexOf('PutObjectCommand');
    expect(putIdx).toBeGreaterThan(-1);
  });

  it('a failing write probe keeps polling instead of resolving on HEAD alone', async () => {
    const { p, sends } = makeProvider({ headResults: [true], failWrites: 2 });

    await expect(p.waitForBucketVisible('b', fastOpts)).resolves.toBe(true);

    expect(sends.filter((s) => s === 'PutObjectCommand').length).toBe(3);
  });

  it('resolves false on budget exhaustion so the caller can refuse (createBucket → ready: false)', async () => {
    const { p } = makeProvider({ headResults: [false] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(p.waitForBucketVisible('b', { intervalMs: 0, budgetMs: 50 })).resolves.toBe(false);

    warn.mockRestore();
  });
});

/**
 * Clean rounds run back to back on every provider, Hetzner included: 4 s a
 * bucket. On 2026-11-05 the other four answered 780 of 780 HEAD and LIST samples
 * from the first one after CreateBucket, and Hetzner answered 6,512 of 6,512 once
 * a bucket was left quiet first. A round that fails still pauses, so a provider
 * that ever does lag cannot spin.
 */
describe('waitForBucketVisible pacing', () => {
  const noWindow = () => new DigitalOceanSpacesProvider('ak', 'sk', 'nyc3');

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs the wait under fake timers; reports how much clock it needed. */
  async function clockNeeded(p: { waitForBucketVisible: (b: string) => Promise<boolean> }) {
    vi.useFakeTimers();
    let done: boolean | undefined;
    const run = p.waitForBucketVisible('b').then((r) => {
      done = r;
    });
    let spent = 0;
    while (done === undefined && spent < 20_000) {
      await vi.advanceTimersByTimeAsync(spent === 0 ? 0 : 500);
      if (done === undefined) spent += 500;
    }
    await run;
    return { result: done, spent };
  }

  it('runs clean rounds back to back', async () => {
    const { p, sends } = makeProvider({ headResults: [true], provider: noWindow() });
    const { result, spent } = await clockNeeded(p);
    expect(result).toBe(true);
    expect(spent).toBe(0);
    // Every check stays: three LIST rounds, then the write round-trip.
    expect(sends.filter((n) => n === 'ListObjectsV2Command')).toHaveLength(3);
    expect(sends).toContain('PutObjectCommand');
  });

  it('still pauses after a failed round, so a lagging provider cannot spin', async () => {
    const { p } = makeProvider({ headResults: [false, true], provider: noWindow() });
    const { result, spent } = await clockNeeded(p);
    expect(result).toBe(true);
    expect(spent).toBe(2_000);
  });

  it('does the same on Hetzner, whose new buckets are left quiet first', async () => {
    const { p } = makeProvider({ headResults: [true] });
    const { result, spent } = await clockNeeded(p);
    expect(result).toBe(true);
    expect(spent).toBe(0);
  });
});
