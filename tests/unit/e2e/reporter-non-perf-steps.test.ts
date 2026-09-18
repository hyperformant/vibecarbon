import { describe, expect, it } from 'vitest';
import {
  NON_PERF_STEPS,
  PERF_TABLE_ROWS,
  perfDurationMsSum,
  perfDurationSum,
} from '../../e2e/metrics/reporter.js';

describe('non-perf steps', () => {
  it('verify-status is excluded from duration sums', () => {
    expect(NON_PERF_STEPS.has('verify-status')).toBe(true);
    expect(
      perfDurationSum([
        { name: 'deploy', duration_ms: 100 },
        { name: 'verify-status', duration_ms: 50 },
        { name: 'backup', duration_ms: null },
      ]),
    ).toBe(100);
  });
  it('verify-status is excluded from the runner-side durationMs sums too', () => {
    expect(
      perfDurationMsSum([
        { name: 'deploy', durationMs: 100 },
        { name: 'verify-status', durationMs: 50 },
        { name: 'backup', durationMs: 7 },
      ]),
    ).toBe(107);
  });
  it('verify-status is not a published perf row', () => {
    expect(PERF_TABLE_ROWS.some((r) => r.step === 'verify-status')).toBe(false);
  });
});
