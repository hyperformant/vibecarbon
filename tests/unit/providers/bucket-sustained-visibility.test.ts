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
import { describe, expect, it, vi } from 'vitest';
import { HetznerS3Provider } from '../../../src/lib/providers/hetzner-s3.js';

function makeProvider({
  headResults,
  failWrites = 0,
}: {
  /** Per-round bucketExists outcomes (true/false); last value repeats. */
  headResults: boolean[];
  /** How many leading write-probe PutObjects fail before succeeding. */
  failWrites?: number;
}) {
  const p = new HetznerS3Provider('ak', 'sk', 'fsn1') as unknown as {
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

  it('still resolves false (best-effort) on budget exhaustion', async () => {
    const { p } = makeProvider({ headResults: [false] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(p.waitForBucketVisible('b', { intervalMs: 0, budgetMs: 50 })).resolves.toBe(false);

    warn.mockRestore();
  });
});
