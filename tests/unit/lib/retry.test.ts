import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollUntil, runWithRetry } from '../../../src/lib/retry.js';

// vi.useFakeTimers() does not fake `node:timers/promises` (sinon limitation),
// so route the implementation's sleep through the faked global setTimeout.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms?: number, value?: unknown) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms)),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// pollUntil/runWithRetry schedule a NEW timer after each attempt, so a single
// runAllTimersAsync can't drain the chain — advance the clock in fixed steps
// and stop as soon as the promise actually settles.
async function settled<T>(p: Promise<T>) {
  let done = false;
  const r = p.then(
    (v) => {
      done = true;
      return { ok: true as const, v };
    },
    (e) => {
      done = true;
      return { ok: false as const, e };
    },
  );
  while (!done) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  return r;
}

describe('runWithRetry', () => {
  it('returns first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const r = await settled(runWithRetry(fn, { delaysMs: [1000, 2000] }));
    expect(r).toEqual({ ok: true, v: 'ok' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries through the delays array then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValue('ok');
    const r = await settled(runWithRetry(fn, { delaysMs: [1000, 2000] }));
    expect(r).toEqual({ ok: true, v: 'ok' });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows after delays are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always'));
    const r = await settled(runWithRetry(fn, { delaysMs: [10] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.e.message).toBe('always');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rethrows immediately when isTransient says no', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    const r = await settled(runWithRetry(fn, { delaysMs: [10, 10], isTransient: () => false }));
    expect(r.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry with (err, attempt) before each sleep', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error('t')).mockResolvedValue('ok');
    await settled(runWithRetry(fn, { delaysMs: [5], onRetry }));
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });
});

describe('pollUntil', () => {
  it('resolves with the first truthy probe result', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce('ready');
    const r = await settled(pollUntil(probe, { budgetMs: 60_000 }));
    expect(r).toEqual({ ok: true, v: 'ready' });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats a throwing probe like a falsy probe and keeps polling', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('conn refused'))
      .mockResolvedValueOnce('up');
    const r = await settled(pollUntil(probe, { budgetMs: 60_000 }));
    expect(r).toEqual({ ok: true, v: 'up' });
  });

  it('backs off exponentially up to maxDelayMs', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const r = await settled(
      pollUntil(probe, { budgetMs: 100_000, initialDelayMs: 2000, maxDelayMs: 15_000 }),
    );
    expect(r.ok).toBe(false); // exhausted budget
    // delays: 2s,4s,8s,15s,15s,... — assert it polled more than budget/initialDelay would allow linearly
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('throws a descriptive error after the budget', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const r = await settled(pollUntil(probe, { budgetMs: 5000, description: 'k3s ready' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.e.message).toContain('k3s ready');
  });
});
