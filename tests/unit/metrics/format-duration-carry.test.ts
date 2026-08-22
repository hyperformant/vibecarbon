import { describe, expect, it } from 'vitest';

import { formatDuration } from '../../e2e/metrics/reporter.js';

/**
 * `formatDuration` must never emit a 60 in the seconds slot.
 *
 * THE DEFECT. The README's Linode row shipped **"5m 60s"** (CI run a2a91e5,
 * 2026-08-13) for a 359.6s deploy. Minutes and seconds were derived
 * independently from the unrounded total:
 *
 *     const minutes = Math.floor(totalSeconds / 60);   // floor(5.993) = 5
 *     const seconds = Math.round(totalSeconds % 60);   // round(59.6)  = 60
 *
 * Every value in [Xm 59.5s, X+1m) renders as `Xm 60s` — a whole second of
 * every minute, ~1.7% of arbitrary durations, on a table whose entire pitch is
 * "Real numbers, not estimates". A reader who spots `5m 60s` has no reason to
 * trust `4m 37s`.
 *
 * The fix is to round to whole seconds FIRST and decompose from that, so the
 * carry happens before the split rather than being lost across it.
 */
describe('formatDuration carry', () => {
  it('carries into minutes instead of emitting 60s (the Linode `5m 60s` row)', () => {
    expect(formatDuration(359_600)).toBe('6m 0s');
  });

  it('never renders 60 in the seconds slot anywhere in an hour', () => {
    // Sweep every 100ms across an hour — the boundary is periodic, so a
    // hand-picked case would only prove the one case.
    const offenders: string[] = [];
    for (let ms = 60_000; ms < 3_600_000; ms += 100) {
      const out = formatDuration(ms);
      if (/\b60s$/.test(out)) offenders.push(`${ms}ms -> ${out}`);
    }
    expect(offenders.slice(0, 5)).toEqual([]);
  });

  it('carries into hours at the top of the hour', () => {
    expect(formatDuration(3_599_600)).toBe('1h 0m');
    expect(formatDuration(3_600_000)).toBe('1h 0m');
  });

  it('carries out of the sub-minute branch rather than printing 60.0s', () => {
    expect(formatDuration(59_960)).toBe('1m 0s');
  });

  it('leaves the ordinary cases exactly as they were', () => {
    // Regression guard on the formats the README already publishes.
    expect(formatDuration(277_000)).toBe('4m 37s');
    expect(formatDuration(13_700)).toBe('13.7s');
    expect(formatDuration(173)).toBe('173ms');
    expect(formatDuration(29_400)).toBe('29.4s');
    expect(formatDuration(11_500)).toBe('11.5s');
  });
});
