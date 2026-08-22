import { describe, expect, it } from 'vitest';
import {
  healthProbeDelayMs,
  RESTORE_PROMOTE_POLL_MS,
} from '../../../src/lib/deploy/compose/index.js';

describe('healthProbeDelayMs (F4) — app-health probe ramp', () => {
  it('probes fast (2s) for the first five gaps, then backs off to 10s', () => {
    // Gap BEFORE probe i (the loop applies it only when i>0).
    expect(healthProbeDelayMs(1)).toBe(2000);
    expect(healthProbeDelayMs(5)).toBe(2000);
    expect(healthProbeDelayMs(6)).toBe(10000);
    expect(healthProbeDelayMs(18)).toBe(10000);
  });

  it('never returns the old flat 10s for the early attempts (faster detection)', () => {
    for (let i = 1; i <= 5; i++) {
      expect(healthProbeDelayMs(i)).toBeLessThan(10000);
    }
  });
});

describe('RESTORE_PROMOTE_POLL_MS (restore-promote poll tightening)', () => {
  it('polls the post-restore promotion at 2s (tighter than the old flat 5s)', () => {
    expect(RESTORE_PROMOTE_POLL_MS).toBe(2000);
    expect(RESTORE_PROMOTE_POLL_MS).toBeLessThan(5000);
  });
});
