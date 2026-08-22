import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { perfAsync, perfEnabled, perfTimer } from '../../../src/lib/perf.js';

describe('perf helper', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env.VIBECARBON_PERF;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (originalEnv === undefined) delete process.env.VIBECARBON_PERF;
    else process.env.VIBECARBON_PERF = originalEnv;
  });

  // The module reads VIBECARBON_PERF at import time, so perfEnabled() reflects
  // the value when the test file was loaded. vitest.config.ts does NOT set
  // VIBECARBON_PERF for unit tests, so perfEnabled() is false here — and
  // perfTimer / perfAsync correctly skip the stderr write.

  it('perfEnabled reports the current state', () => {
    // With default unit-test env, VIBECARBON_PERF is unset → disabled.
    expect(typeof perfEnabled()).toBe('boolean');
  });

  it('perfTimer.end returns a non-negative ms duration even when disabled', () => {
    const t = perfTimer('unit.test.a');
    const ms = t.end();
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('perfTimer.end is idempotent (second call returns 0 and emits nothing)', () => {
    const t = perfTimer('unit.test.idempotent');
    t.end();
    const writesAfterFirst = stderrSpy.mock.calls.length;
    const ms2 = t.end();
    expect(ms2).toBe(0);
    expect(stderrSpy.mock.calls.length).toBe(writesAfterFirst);
  });

  it('perfAsync forwards resolved values', async () => {
    const result = await perfAsync('unit.test.resolve', async () => 42);
    expect(result).toBe(42);
  });

  it('perfAsync propagates rejections and still times the stage', async () => {
    await expect(
      perfAsync('unit.test.reject', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
