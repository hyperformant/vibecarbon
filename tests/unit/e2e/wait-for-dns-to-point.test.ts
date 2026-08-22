/**
 * verify-failover DNS-propagation gate.
 *
 * Live RCA (overnight matrix run 2, 2026-07-09): after the failover
 * readiness-gate apikey fix, `vibecarbon failover` completed in 71.6s —
 * fast enough that verify-failover's checks resolved the domain BEFORE the
 * A-record flip propagated to the pinned resolvers (1.1.1.1/8.8.8.8). The
 * checks hit the OLD scaled-down primary (Kong 502 upstream, "missing"
 * tables) and failed; the failure diagnostics 30s later showed DNS already
 * on the promoted IP with a 200. Yesterday's buggy 4m48s gate stall had
 * been masking exactly this race. The gate: before running verify-failover
 * checks, wait (bounded) until the domain resolves to the promoted IP.
 */
import { describe, expect, it, vi } from 'vitest';
import { waitForDnsToPoint } from '../../e2e/checks/health.js';

const noSleep = () => Promise.resolve();

describe('waitForDnsToPoint', () => {
  it('returns true once the resolver reports the expected IP', async () => {
    const answers = ['1.1.1.1-stale', '1.1.1.1-stale', '5.75.213.3'];
    const resolve = vi.fn(async () => answers.shift() ?? '5.75.213.3');
    const ok = await waitForDnsToPoint('e4.appcarbon.dev', '5.75.213.3', {
      budgetMs: 10_000,
      intervalMs: 1,
      resolve,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('returns false (never throws) when the budget lapses on a stale record', async () => {
    const resolve = vi.fn(async () => '178.0.0.1');
    const ok = await waitForDnsToPoint('e4.appcarbon.dev', '5.75.213.3', {
      budgetMs: 5,
      intervalMs: 1,
      resolve,
      sleep: noSleep,
    });
    expect(ok).toBe(false);
  });

  it('keeps polling through null answers (resolver returning nothing yet)', async () => {
    const answers: Array<string | null> = [null, null, '5.75.213.3'];
    const resolve = vi.fn(async () => answers.shift() ?? null);
    const ok = await waitForDnsToPoint('e4.appcarbon.dev', '5.75.213.3', {
      budgetMs: 10_000,
      intervalMs: 1,
      resolve,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
  });
});
