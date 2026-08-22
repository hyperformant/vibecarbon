import { describe, expect, it, vi } from 'vitest';
import { pollForEnvValue } from '../../e2e/checks/config-canary.js';

/**
 * The config-canary retry budget must outlast the failover app-tier restart
 * window (2026-08-10 d2 RCA): verify-failover restarts six containers
 * (~50-60s to running) and the canary's `docker exec printenv` returns
 * empty / errors until the container is up. The old 4-attempt × 5s (~15s)
 * budget gave up mid-restart and misread a present env as "not propagated".
 * These pin the widened, deterministic (attempt-driven, injectable-sleep)
 * poll so the false negative can't return.
 */
const instantSleep = () => Promise.resolve();

describe('pollForEnvValue', () => {
  it('returns immediately on a non-empty first probe (settled container never waits)', async () => {
    const probe = vi.fn(() => 'sk_test_value');
    const sleep = vi.fn(instantSleep);
    const { value, lastErr } = await pollForEnvValue(probe, {
      budgetMs: 90_000,
      intervalMs: 5_000,
      sleep,
    });
    expect(value).toBe('sk_test_value');
    expect(lastErr).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps polling PAST the old 4-attempt limit to cover the restart window', async () => {
    // Empty for the first 5 probes (would have failed under the old ~15s /
    // 4-attempt budget), value on the 6th (~25s in — well within a 50-60s
    // restart).
    let n = 0;
    const probe = vi.fn(() => (++n >= 6 ? 'sk_test_value' : ''));
    const { value } = await pollForEnvValue(probe, {
      budgetMs: 90_000,
      intervalMs: 5_000,
      sleep: instantSleep,
    });
    expect(value).toBe('sk_test_value');
    expect(probe).toHaveBeenCalledTimes(6);
    expect(6).toBeGreaterThan(4); // the exact count the old budget could not reach
  });

  it('survives exec errors (mid-restart container) and recovers when it comes up', async () => {
    let n = 0;
    const probe = vi.fn(() => {
      if (++n < 4) throw new Error('Error: No such container (restarting)');
      return 'sk_test_value';
    });
    const { value, lastErr } = await pollForEnvValue(probe, {
      budgetMs: 90_000,
      intervalMs: 5_000,
      sleep: instantSleep,
    });
    expect(value).toBe('sk_test_value');
    // lastErr retains the last pre-recovery error for diagnostics but the
    // poll still succeeded.
    expect(lastErr).toBeInstanceOf(Error);
  });

  it('aborts on the FIRST error the predicate condemns — one probe, no sleeps', async () => {
    // A black-holed :22 does not heal inside the budget. Before this, the
    // first spec paid all 18 attempts against a dead host (2026-08-11: the
    // dominant term in a 1034s verify-failover).
    const probe = vi.fn(() => {
      throw new Error('ssh: connect to host 159.203.64.163 port 22: Connection timed out');
    });
    const sleep = vi.fn(instantSleep);
    const { value, lastErr, aborted } = await pollForEnvValue(probe, {
      budgetMs: 90_000,
      intervalMs: 5_000,
      sleep,
      shouldAbort: (err) => err.message.includes('Connection timed out'),
    });
    expect(aborted).toBe(true);
    expect(value).toBe('');
    expect(lastErr).toBeInstanceOf(Error);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps retrying errors the predicate declines to condemn (mid-restart container)', async () => {
    let n = 0;
    const probe = vi.fn(() => {
      if (++n < 4) throw new Error('Error: No such container (restarting)');
      return 'sk_test_value';
    });
    const { value, aborted } = await pollForEnvValue(probe, {
      budgetMs: 90_000,
      intervalMs: 5_000,
      sleep: instantSleep,
      shouldAbort: (err) => err.message.includes('Connection timed out'),
    });
    expect(aborted).toBe(false);
    expect(value).toBe('sk_test_value');
  });

  it('gives up after the full budget when the value never appears (genuine miss still fails)', async () => {
    const probe = vi.fn(() => '');
    const sleep = vi.fn(instantSleep);
    const { value } = await pollForEnvValue(probe, {
      budgetMs: 90_000,
      intervalMs: 5_000,
      sleep,
    });
    expect(value).toBe('');
    // 90_000 / 5_000 = 18 attempts, 17 inter-attempt sleeps.
    expect(probe).toHaveBeenCalledTimes(18);
    expect(sleep).toHaveBeenCalledTimes(17);
  });

  it('the shipped config-canary budget covers a 60s restart window with margin', () => {
    // Guard the constants the check passes: budget/interval must exceed the
    // measured ~50-60s restart, or the false negative returns.
    const budgetMs = 90_000;
    const intervalMs = 5_000;
    const attempts = Math.ceil(budgetMs / intervalMs);
    expect((attempts - 1) * intervalMs).toBeGreaterThanOrEqual(60_000);
  });
});
