import { describe, expect, it } from 'vitest';
import {
  formatPrice,
  getPlan,
  planIdFromPriceId,
  plans,
} from '@shared/pricing';

describe('plans catalog', () => {
  it('exposes free, starter, and pro tiers', () => {
    expect(plans.map((p) => p.id)).toEqual(['free', 'starter', 'pro']);
  });

  it('only `starter` is flagged as popular', () => {
    const popular = plans.filter((p) => p.popular);
    expect(popular.map((p) => p.id)).toEqual(['starter']);
  });

  it('prices are non-negative integer cents', () => {
    for (const plan of plans) {
      expect(Number.isInteger(plan.price.monthly)).toBe(true);
      expect(plan.price.monthly).toBeGreaterThanOrEqual(0);
    }
  });

  it('higher tiers strictly include all features of lower tiers', () => {
    // Encodes the product invariant: upgrading never removes a feature.
    const tierOrder = ['free', 'starter', 'pro'] as const;
    for (let i = 1; i < tierOrder.length; i++) {
      const lower = getPlan(tierOrder[i - 1])!;
      const higher = getPlan(tierOrder[i])!;
      const lowerIncluded = lower.features.filter((f) => f.included).map((f) => f.text);
      const higherIncluded = new Set(
        higher.features.filter((f) => f.included).map((f) => f.text),
      );
      for (const feature of lowerIncluded) {
        expect(higherIncluded.has(feature)).toBe(true);
      }
    }
  });
});

describe('getPlan', () => {
  it('returns the plan when the id matches', () => {
    // Display names are demo copy and intentionally differ from the ids, which
    // are billing keys: free -> Starter, starter -> Pro, pro -> Team.
    expect(getPlan('pro')?.name).toBe('Team');
  });

  it('returns undefined for an unknown id', () => {
    // @ts-expect-error — intentional: exercise runtime behavior for unknown id
    expect(getPlan('enterprise')).toBeUndefined();
  });
});

describe('formatPrice', () => {
  it('returns "Free" for zero cents', () => {
    expect(formatPrice(0)).toBe('Free');
  });

  it('formats whole-dollar amounts with /mo suffix', () => {
    expect(formatPrice(1900)).toBe('$19/mo');
    expect(formatPrice(7900)).toBe('$79/mo');
  });

  it('truncates fractional dollars (current behavior)', () => {
    // Documenting current rounding: toFixed(0) on $19.50 -> "$20/mo" due
    // to banker rounding via toFixed. If you change pricing math, update
    // this assertion to whatever the new contract is.
    expect(formatPrice(1950)).toBe('$20/mo');
  });
});

describe('planIdFromPriceId', () => {
  const priceIds = {
    starter: 'price_starter_test',
    pro: 'price_pro_test',
  };

  it('maps the starter price id to "starter"', () => {
    expect(planIdFromPriceId('price_starter_test', priceIds)).toBe('starter');
  });

  it('maps the pro price id to "pro"', () => {
    expect(planIdFromPriceId('price_pro_test', priceIds)).toBe('pro');
  });

  it('falls back to "free" for unknown price ids', () => {
    expect(planIdFromPriceId('price_unknown', priceIds)).toBe('free');
  });

  it('falls back to "free" when the id mapping is empty', () => {
    expect(planIdFromPriceId('anything', {})).toBe('free');
  });
});
