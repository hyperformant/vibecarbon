import { describe, expect, it } from 'vitest';
import { assertValidPlan, defineStep } from '../../../../src/lib/deploy/plan/step.js';

describe('defineStep + assertValidPlan', () => {
  it('builds a pure descriptor and rejects an unknown-shaped step', () => {
    const s = defineStep({ name: 'a', effect: 'doA', args: { x: 1 } });
    expect(s).toEqual({ name: 'a', effect: 'doA', args: { x: 1 } });
    expect(() => assertValidPlan([{ name: 'a' }])).toThrow(/effect/);
  });
});
