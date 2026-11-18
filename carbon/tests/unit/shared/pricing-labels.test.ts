import { describe, expect, it, vi } from 'vitest';
import type { CatalogTier } from '@shared/billing-catalog.types';

/**
 * src/shared/pricing.ts beyond tests/unit/shared/pricing.test.ts: the price
 * labels for a demo plan and a catalog tier, the price-id edges, the order of
 * the catalog snapshot, and the tier ordering of the demo plans.
 */

function tier(over: Partial<CatalogTier>): CatalogTier {
  return {
    priceId: 'price_1',
    name: 'Pro',
    description: null,
    features: [],
    amount: 14900,
    currency: 'usd',
    interval: 'one_time',
    type: 'one_time',
    ...over,
  };
}

// An unsorted snapshot, as `vibecarbon configure` could write one.
vi.mock('@shared/billing-catalog', () => ({
  billingCatalog: {
    provider: 'stripe',
    generatedAt: '2026-01-01T00:00:00.000Z',
    tiers: [
      tier({ priceId: 'p3', name: 'Enterprise', amount: 49900 }),
      tier({ priceId: 'p1', name: 'Starter', amount: 0 }),
      tier({ priceId: 'p2', name: 'Pro', amount: 14900 }),
    ],
  },
}));

const {
  catalogTiers,
  formatPlanPrice,
  formatPrice,
  formatTierPrice,
  getPlan,
  planIdFromPriceId,
  plans,
} = await import('@shared/pricing');

type Plan = (typeof plans)[number];

function plan(over: Partial<Plan>): Plan {
  const starter = getPlan('starter');
  if (!starter) throw new Error('no starter plan');
  return { ...starter, ...over };
}

describe('getPlan', () => {
  it.each(['free', 'starter', 'pro'] as const)('returns the %s plan by its id', (id) => {
    expect(getPlan(id)?.id).toBe(id);
  });
});

describe('formatPrice', () => {
  it('formats a three-digit dollar amount', () => {
    expect(formatPrice(10000)).toBe('$100/mo');
  });
});

describe('planIdFromPriceId edges', () => {
  const priceIds = { starter: 'price_starter_monthly', pro: 'price_pro_monthly' };

  it('falls back to free for an empty price id', () => {
    expect(planIdFromPriceId('', priceIds)).toBe('free');
  });

  it('falls back to free when the matching id is missing from the mapping', () => {
    expect(planIdFromPriceId('price_starter_monthly', {})).toBe('free');
    expect(planIdFromPriceId('price_pro_monthly', { starter: 'other' })).toBe('free');
  });

  it('falls back to free when the mapping holds undefined ids', () => {
    expect(planIdFromPriceId('price_pro_monthly', { starter: undefined, pro: undefined })).toBe(
      'free'
    );
  });
});

describe('formatPlanPrice', () => {
  it('returns "Free" for zero', () => {
    expect(formatPlanPrice(plan({ price: { monthly: 0 } }))).toBe('Free');
  });

  it('formats whole-dollar USD monthly with no decimals', () => {
    expect(
      formatPlanPrice(plan({ price: { monthly: 1900 }, currency: 'usd', interval: 'month' }))
    ).toBe('$19/mo');
  });

  it('uses /yr for a yearly interval', () => {
    expect(
      formatPlanPrice(plan({ price: { monthly: 19000 }, currency: 'usd', interval: 'year' }))
    ).toBe('$190/yr');
  });

  it('drops the suffix for a one-time price', () => {
    expect(
      formatPlanPrice(plan({ price: { monthly: 49900 }, currency: 'usd', type: 'one_time' }))
    ).toBe('$499');
  });

  it('shows cents for an amount that is not whole dollars', () => {
    expect(
      formatPlanPrice(plan({ price: { monthly: 1999 }, currency: 'usd', interval: 'month' }))
    ).toBe('$19.99/mo');
  });

  it('uses a currency other than USD', () => {
    const out = formatPlanPrice(
      plan({ price: { monthly: 1500 }, currency: 'eur', interval: 'month' })
    );
    expect(out).toContain('€');
    expect(out).not.toContain('$');
    expect(out.endsWith('/mo')).toBe(true);
  });

  it('falls back to USD monthly when the catalog fields are absent', () => {
    expect(
      formatPlanPrice(
        plan({ price: { monthly: 7900 }, currency: undefined, interval: undefined, type: undefined })
      )
    ).toBe('$79/mo');
  });
});

describe('formatTierPrice', () => {
  it('returns "Free" for a zero-amount tier', () => {
    expect(formatTierPrice(tier({ amount: 0 }))).toBe('Free');
  });

  it('drops the suffix for a one-time price', () => {
    expect(formatTierPrice(tier({ amount: 14900, type: 'one_time', interval: 'one_time' }))).toBe(
      '$149'
    );
  });

  it('uses /mo for recurring monthly', () => {
    expect(formatTierPrice(tier({ amount: 1900, type: 'recurring', interval: 'month' }))).toBe(
      '$19/mo'
    );
  });

  it('uses /yr for recurring yearly', () => {
    expect(formatTierPrice(tier({ amount: 19000, type: 'recurring', interval: 'year' }))).toBe(
      '$190/yr'
    );
  });

  it('shows cents for an amount that is not whole dollars', () => {
    expect(formatTierPrice(tier({ amount: 1999, type: 'recurring', interval: 'month' }))).toBe(
      '$19.99/mo'
    );
  });

  it('uses a currency other than USD', () => {
    const out = formatTierPrice(tier({ amount: 49900, currency: 'eur' }));
    expect(out).toContain('€');
    expect(out).not.toContain('$');
  });
});

describe('catalogTiers', () => {
  it('sorts the snapshot’s tiers by amount, cheapest first', () => {
    expect(catalogTiers.map((t) => t.name)).toEqual(['Starter', 'Pro', 'Enterprise']);
  });
});

describe('demo plans ordering', () => {
  it('the free plan costs nothing', () => {
    expect(getPlan('free')?.price.monthly).toBe(0);
  });

  it('the paid plans cost something', () => {
    expect(getPlan('starter')?.price.monthly).toBeGreaterThan(0);
    expect(getPlan('pro')?.price.monthly).toBeGreaterThan(0);
  });

  it('the API rate limit rises with each tier', () => {
    const [free, starter, pro] = (['free', 'starter', 'pro'] as const).map(
      (id) => getPlan(id)?.limits.apiRequestsPerMinute ?? 0
    );
    expect(starter).toBeGreaterThan(free);
    expect(pro).toBeGreaterThan(starter);
  });
});
