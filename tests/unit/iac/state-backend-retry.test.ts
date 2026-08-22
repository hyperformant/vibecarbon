import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — JS module without types
import { withStateBackendRetry } from '../../../src/lib/iac/index.js';
// @ts-expect-error — JS module without types
import { classifyStateError } from '../../../src/lib/iac/state-error.js';

const noSleep = () => Promise.resolve();

describe('throttle vocabulary (via classifyStateError — the old exported pattern is gone)', () => {
  it('classifies every S3 throttle spelling as retryable backpressure', () => {
    for (const sig of [
      'error: 503 SlowDown: Please reduce your request rate',
      'ServiceUnavailable',
      'RequestLimitExceeded',
      'operation error S3: throttled',
      'too many requests',
      'got 503 from backend',
    ]) {
      const got = classifyStateError({ message: sig, operation: 'up' });
      expect(got.cause, sig).toBe('throttle');
      expect(got.recovery, sig).toBe('retry-in-place');
    }
  });

  it('does NOT treat ordinary pulumi errors as throttle', () => {
    for (const sig of ['hcloud: server not found (not_found)']) {
      expect(classifyStateError({ message: sig, operation: 'up' }).cause).not.toBe('throttle');
    }
  });

  it('classifies a held lock as retryable CONTENTION, distinct from throttle', () => {
    // A SlowDown-interrupted `up` leaves its own lock behind on the fresh state
    // bucket; the retry must be able to clear + reacquire it. Distinct cause on
    // purpose — collapsing the two is what made overload and self-inflicted
    // contention indistinguishable in our logs.
    const got = classifyStateError({
      message: 'the stack is currently locked by 1 lock(s)',
      operation: 'up',
    });
    expect(got.cause).toBe('lock-contention');
    expect(got.recovery).toBe('retry-in-place');
  });
});

describe('withStateBackendRetry', () => {
  it('retries on a SlowDown throttle then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('error: 503 SlowDown'))
      .mockResolvedValueOnce('ok');
    const out = await withStateBackendRetry(fn, 'up', { sleep: noSleep });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-throttle error (throws immediately)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('no stack named foo'));
    await expect(withStateBackendRetry(fn, 'up', { sleep: noSleep })).rejects.toThrow(
      'no stack named foo',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and rethrows the throttle', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('SlowDown'));
    await expect(
      withStateBackendRetry(fn, 'destroy', { attempts: 3, sleep: noSleep }),
    ).rejects.toThrow('SlowDown');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // Fresh-state-bucket propagation race: Hetzner can 404 (NoSuchBucket) a
  // just-created bucket. The deploy-path ops (stack select, pre-up refresh,
  // up) opt into retrying it via extraPattern — on the destroy path a
  // NoSuchBucket is a real answer.

  it('does NOT retry NoSuchBucket without extraPattern (destroy-path semantics)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('NoSuchBucket'));
    await expect(withStateBackendRetry(fn, 'destroy', { sleep: noSleep })).rejects.toThrow(
      'NoSuchBucket',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry staleness spellings — they fail loudly by name (band-aid removal 2026-08-16)', async () => {
    // The extraPattern escape hatch is deleted: per-call widening past the
    // classifier is exactly how band-aids accreted. Every staleness spelling
    // now surfaces on the FIRST attempt.
    for (const msg of [
      'error: could not read bucket: NoSuchBucket: status code: 404',
      'error: blob (key ".pulumi/locks/organization/vibecarbon/e1/x.json") (code=NotFound): NoSuchKey: status code: 404',
      "error: no stack named 'e1' found",
    ]) {
      const fn = vi.fn().mockRejectedValue(new Error(msg));
      await expect(withStateBackendRetry(fn, 'up', { sleep: noSleep })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});
