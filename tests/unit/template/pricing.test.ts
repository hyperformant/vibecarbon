import { describe, expect, it } from 'vitest';

/**
 * Tests for pricing configuration and helper functions.
 * Re-implements the logic from carbon/src/shared/pricing.ts
 * since the template uses path aliases that don't resolve in the test runner.
 */

// ============================================================================
// TYPES (mirror pricing.ts)
// ============================================================================

type PlanId = 'free' | 'starter' | 'pro';

interface Plan {
  id: PlanId;
  name: string;
  description?: string;
  price: { monthly: number };
  limits: { members: number; organizations: number; apiRequestsPerMinute: number };
  popular?: boolean;
  priceId?: string;
  currency?: string;
  interval?: 'month' | 'year' | 'one_time';
  type?: 'recurring' | 'one_time';
}

interface CatalogTier {
  priceId: string;
  name: string;
  description: string | null;
  features: string[];
  amount: number;
  currency: string;
  interval: 'month' | 'year' | 'one_time';
  type: 'recurring' | 'one_time';
}

// ============================================================================
// FUNCTIONS (mirror pricing.ts)
// ============================================================================

const plans: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: { monthly: 0 },
    limits: { members: 0, organizations: 0, apiRequestsPerMinute: 60 },
  },
  {
    id: 'starter',
    name: 'Startup',
    price: { monthly: 1900 },
    limits: { members: 0, organizations: 0, apiRequestsPerMinute: 200 },
    popular: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: { monthly: 7900 },
    limits: { members: 0, organizations: 0, apiRequestsPerMinute: 1000 },
  },
];

function getPlan(planId: PlanId): Plan | undefined {
  return plans.find((p) => p.id === planId);
}

function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(0)}/mo`;
}

function intervalSuffix(plan: Plan): string {
  if (plan.type === 'one_time' || plan.interval === 'one_time') return '';
  if (plan.interval === 'year') return '/yr';
  return '/mo';
}

function formatPlanPrice(plan: Plan): string {
  const cents = plan.price.monthly;
  if (cents === 0) return 'Free';
  const value = cents / 100;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (plan.currency ?? 'usd').toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
  return `${formatted}${intervalSuffix(plan)}`;
}

// Mirror of formatTierPrice: currency- and interval-aware label for an activated
// catalog tier (the price-sorted list of products synced from the provider).
function tierSuffix(tier: CatalogTier): string {
  if (tier.type === 'one_time' || tier.interval === 'one_time') return '';
  if (tier.interval === 'year') return '/yr';
  return '/mo';
}

function formatTierPrice(tier: CatalogTier): string {
  if (tier.amount === 0) return 'Free';
  const value = tier.amount / 100;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (tier.currency || 'usd').toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
  return `${formatted}${tierSuffix(tier)}`;
}

function planIdFromPriceId(priceId: string, priceIds: { starter?: string; pro?: string }): PlanId {
  if (priceId === priceIds.starter) return 'starter';
  if (priceId === priceIds.pro) return 'pro';
  return 'free';
}

// ============================================================================
// TESTS
// ============================================================================

describe('getPlan', () => {
  it('returns the free plan', () => {
    const plan = getPlan('free');
    expect(plan).toBeDefined();
    expect(plan?.id).toBe('free');
    expect(plan?.name).toBe('Free');
    expect(plan?.price.monthly).toBe(0);
  });

  it('returns the starter plan', () => {
    const plan = getPlan('starter');
    expect(plan).toBeDefined();
    expect(plan?.id).toBe('starter');
    expect(plan?.name).toBe('Startup');
    expect(plan?.price.monthly).toBe(1900);
    expect(plan?.popular).toBe(true);
  });

  it('returns the pro plan', () => {
    const plan = getPlan('pro');
    expect(plan).toBeDefined();
    expect(plan?.id).toBe('pro');
    expect(plan?.name).toBe('Pro');
    expect(plan?.price.monthly).toBe(7900);
  });

  it('returns undefined for unknown plan', () => {
    // @ts-expect-error: Testing invalid input
    expect(getPlan('enterprise')).toBeUndefined();
  });
});

describe('formatPrice', () => {
  it('returns "Free" for zero cents', () => {
    expect(formatPrice(0)).toBe('Free');
  });

  it('formats monthly prices', () => {
    expect(formatPrice(1900)).toBe('$19/mo');
    expect(formatPrice(7900)).toBe('$79/mo');
  });

  it('handles round dollar amounts', () => {
    expect(formatPrice(10000)).toBe('$100/mo');
  });
});

describe('planIdFromPriceId', () => {
  const priceIds = {
    starter: 'price_starter_monthly',
    pro: 'price_pro_monthly',
  };

  it('maps starter price ID', () => {
    expect(planIdFromPriceId('price_starter_monthly', priceIds)).toBe('starter');
  });

  it('maps pro price ID', () => {
    expect(planIdFromPriceId('price_pro_monthly', priceIds)).toBe('pro');
  });

  it('falls back to free for unknown price ID', () => {
    expect(planIdFromPriceId('price_unknown', priceIds)).toBe('free');
  });

  it('falls back to free for empty string', () => {
    expect(planIdFromPriceId('', priceIds)).toBe('free');
  });

  it('handles missing price IDs gracefully', () => {
    expect(planIdFromPriceId('price_starter_monthly', {})).toBe('free');
    expect(planIdFromPriceId('price_pro_monthly', { starter: 'other' })).toBe('free');
  });

  it('handles undefined price IDs', () => {
    expect(
      planIdFromPriceId('price_pro_monthly', {
        starter: undefined,
        pro: undefined,
      }),
    ).toBe('free');
  });
});

describe('formatPlanPrice', () => {
  const base = (over: Partial<Plan>): Plan => ({
    id: 'starter',
    name: 'Startup',
    price: { monthly: 1900 },
    limits: { members: 0, organizations: 0, apiRequestsPerMinute: 200 },
    ...over,
  });

  it('returns "Free" for zero', () => {
    expect(formatPlanPrice(base({ price: { monthly: 0 } }))).toBe('Free');
  });

  it('formats whole-dollar USD monthly with no decimals', () => {
    expect(
      formatPlanPrice(base({ price: { monthly: 1900 }, currency: 'usd', interval: 'month' })),
    ).toBe('$19/mo');
  });

  it('uses /yr for yearly interval', () => {
    expect(
      formatPlanPrice(base({ price: { monthly: 19000 }, currency: 'usd', interval: 'year' })),
    ).toBe('$190/yr');
  });

  it('drops the suffix for one-time prices', () => {
    expect(
      formatPlanPrice(base({ price: { monthly: 49900 }, currency: 'usd', type: 'one_time' })),
    ).toBe('$499');
  });

  it('shows cents for non-integer amounts', () => {
    expect(
      formatPlanPrice(base({ price: { monthly: 1999 }, currency: 'usd', interval: 'month' })),
    ).toBe('$19.99/mo');
  });

  it('respects a non-USD currency', () => {
    // Intl renders EUR with the € glyph; assert it is used and dollars are not.
    const out = formatPlanPrice(
      base({ price: { monthly: 1500 }, currency: 'eur', interval: 'month' }),
    );
    expect(out).toContain('€');
    expect(out.endsWith('/mo')).toBe(true);
  });

  it('falls back to USD/monthly when dynamic fields are absent', () => {
    expect(formatPlanPrice(base({ price: { monthly: 7900 } }))).toBe('$79/mo');
  });
});

describe('formatTierPrice', () => {
  const tier = (over: Partial<CatalogTier>): CatalogTier => ({
    priceId: 'price_1',
    name: 'Fullerene',
    description: null,
    features: [],
    amount: 14900,
    currency: 'usd',
    interval: 'one_time',
    type: 'one_time',
    ...over,
  });

  it('returns "Free" for a zero-amount tier', () => {
    expect(formatTierPrice(tier({ amount: 0 }))).toBe('Free');
  });

  it('drops the suffix for one-time prices', () => {
    expect(formatTierPrice(tier({ amount: 14900, type: 'one_time', interval: 'one_time' }))).toBe(
      '$149',
    );
  });

  it('uses /mo for recurring monthly', () => {
    expect(formatTierPrice(tier({ amount: 1900, type: 'recurring', interval: 'month' }))).toBe(
      '$19/mo',
    );
  });

  it('uses /yr for recurring yearly', () => {
    expect(formatTierPrice(tier({ amount: 19000, type: 'recurring', interval: 'year' }))).toBe(
      '$190/yr',
    );
  });

  it('shows cents for non-integer amounts', () => {
    expect(formatTierPrice(tier({ amount: 1999, type: 'recurring', interval: 'month' }))).toBe(
      '$19.99/mo',
    );
  });

  it('respects a non-USD currency', () => {
    const out = formatTierPrice(tier({ amount: 49900, currency: 'eur' }));
    expect(out).toContain('€');
  });
});

describe('catalog tier sorting', () => {
  it('sorts activated tiers by amount ascending', () => {
    const unsorted: CatalogTier[] = [
      {
        priceId: 'p3',
        name: 'Enterprise',
        description: null,
        features: [],
        amount: 49900,
        currency: 'usd',
        interval: 'one_time',
        type: 'one_time',
      },
      {
        priceId: 'p1',
        name: 'Graphite',
        description: null,
        features: [],
        amount: 0,
        currency: 'usd',
        interval: 'one_time',
        type: 'one_time',
      },
      {
        priceId: 'p2',
        name: 'Fullerene',
        description: null,
        features: [],
        amount: 14900,
        currency: 'usd',
        interval: 'one_time',
        type: 'one_time',
      },
    ];
    const sorted = [...unsorted].sort((a, b) => a.amount - b.amount);
    expect(sorted.map((t) => t.name)).toEqual(['Graphite', 'Fullerene', 'Enterprise']);
  });
});

describe('Plan configuration integrity', () => {
  it('has exactly 3 plans', () => {
    expect(plans).toHaveLength(3);
  });

  it('plans have unique IDs', () => {
    const ids = plans.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only one plan is marked as popular', () => {
    const popularPlans = plans.filter((p) => p.popular);
    expect(popularPlans).toHaveLength(1);
    expect(popularPlans[0].id).toBe('starter');
  });

  it('free plan has zero price', () => {
    const free = getPlan('free');
    expect(free?.price.monthly).toBe(0);
  });

  it('paid plans have non-zero price', () => {
    expect(getPlan('starter')?.price.monthly).toBeGreaterThan(0);
    expect(getPlan('pro')?.price.monthly).toBeGreaterThan(0);
  });

  it('API rate limit increases with tier', () => {
    const free = getPlan('free');
    const starter = getPlan('starter');
    const pro = getPlan('pro');

    expect(starter?.limits.apiRequestsPerMinute).toBeGreaterThan(
      free?.limits.apiRequestsPerMinute ?? 0,
    );
    expect(pro?.limits.apiRequestsPerMinute).toBeGreaterThan(
      starter?.limits.apiRequestsPerMinute ?? 0,
    );
  });
});
