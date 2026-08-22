import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tests for the requirePlan middleware logic.
 * Re-implements the pattern from carbon/src/server/middleware/requirePlan.ts.
 *
 * The middleware resolves a caller's highest active/trialing plan and gates on a
 * minimum tier. Price IDs come from getProviderPriceIds(), which returns
 * { starter?, pro? } only — there are no yearly variants (yearly pricing was
 * deferred from the product). The `drift guards` block at the bottom reads the
 * real source to pin these facts.
 */

// ============================================================================
// TYPES & LOGIC (mirror requirePlan.ts)
// ============================================================================

type PlanId = 'free' | 'starter' | 'pro';

const planHierarchy: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  pro: 2,
};

// Mirror of pricing.ts planIdFromPriceId — provider-agnostic, starter/pro/free only.
function planIdFromPriceId(priceId: string, priceIds: { starter?: string; pro?: string }): PlanId {
  if (priceId === priceIds.starter) return 'starter';
  if (priceId === priceIds.pro) return 'pro';
  return 'free';
}

interface MockUser {
  id: string;
  email?: string;
}

interface RequirePlanContext {
  user: MockUser | null;
  billingConfigured: boolean;
  customer: { id: string } | null;
  // The resolved active/trialing subscription (the real middleware queries
  // .in('status', ['active', 'trialing']), so anything returned is valid).
  subscription: { stripe_price_id: string; status: string } | null;
  priceIds: { starter?: string; pro?: string };
}

interface RequirePlanResult {
  allowed: boolean;
  status?: number;
  error?: string;
  requiredPlan?: PlanId;
  currentPlan?: PlanId;
}

/**
 * Simulate the requirePlan middleware as a pure function.
 */
function checkPlanAccess(minimumPlan: PlanId, ctx: RequirePlanContext): RequirePlanResult {
  // If billing isn't configured, allow all requests.
  if (!ctx.billingConfigured) {
    return { allowed: true };
  }

  if (!ctx.user) {
    return { allowed: false, status: 401, error: 'Unauthorized' };
  }

  // Free plan requires no subscription check.
  if (minimumPlan === 'free') {
    return { allowed: true };
  }

  // Find customer.
  if (!ctx.customer) {
    return { allowed: false, status: 403, error: 'Upgrade required', requiredPlan: minimumPlan };
  }

  // Find active/trialing subscription.
  if (!ctx.subscription) {
    return { allowed: false, status: 403, error: 'Upgrade required', requiredPlan: minimumPlan };
  }

  const currentPlan = planIdFromPriceId(ctx.subscription.stripe_price_id, ctx.priceIds);

  if (planHierarchy[currentPlan] < planHierarchy[minimumPlan]) {
    return {
      allowed: false,
      status: 403,
      error: 'Upgrade required',
      requiredPlan: minimumPlan,
      currentPlan,
    };
  }

  return { allowed: true };
}

// ============================================================================
// TESTS
// ============================================================================

// Provider price IDs: starter/pro only (mirrors getProviderPriceIds()).
const defaultPriceIds = {
  starter: 'price_starter',
  pro: 'price_pro',
};

const defaultUser: MockUser = { id: 'user-1', email: 'user@test.com' };

describe('requirePlan middleware', () => {
  describe('when billing is not configured', () => {
    it('allows all requests regardless of plan', () => {
      const ctx: RequirePlanContext = {
        user: null,
        billingConfigured: false,
        customer: null,
        subscription: null,
        priceIds: defaultPriceIds,
      };

      expect(checkPlanAccess('pro', ctx).allowed).toBe(true);
      expect(checkPlanAccess('starter', ctx).allowed).toBe(true);
      expect(checkPlanAccess('free', ctx).allowed).toBe(true);
    });

    it('allows even without a user (dev mode / self-hosted)', () => {
      const ctx: RequirePlanContext = {
        user: null,
        billingConfigured: false,
        customer: null,
        subscription: null,
        priceIds: {},
      };

      expect(checkPlanAccess('pro', ctx).allowed).toBe(true);
    });
  });

  describe('when billing is configured', () => {
    describe('authentication', () => {
      it('returns 401 when no user is authenticated', () => {
        const ctx: RequirePlanContext = {
          user: null,
          billingConfigured: true,
          customer: null,
          subscription: null,
          priceIds: defaultPriceIds,
        };

        const result = checkPlanAccess('starter', ctx);
        expect(result.allowed).toBe(false);
        expect(result.status).toBe(401);
      });
    });

    describe('free plan gate', () => {
      it('allows any authenticated user for free plan', () => {
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: null,
          subscription: null,
          priceIds: defaultPriceIds,
        };

        expect(checkPlanAccess('free', ctx).allowed).toBe(true);
      });

      it('allows free plan without customer or subscription', () => {
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: null,
          subscription: null,
          priceIds: defaultPriceIds,
        };

        expect(checkPlanAccess('free', ctx).allowed).toBe(true);
      });
    });

    describe('no customer', () => {
      it('returns 403 with requiredPlan when no customer exists', () => {
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: null,
          subscription: null,
          priceIds: defaultPriceIds,
        };

        const result = checkPlanAccess('starter', ctx);
        expect(result.allowed).toBe(false);
        expect(result.status).toBe(403);
        expect(result.error).toBe('Upgrade required');
        expect(result.requiredPlan).toBe('starter');
      });
    });

    describe('no subscription', () => {
      it('returns 403 when customer exists but no active subscription', () => {
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: { id: 'cust-1' },
          subscription: null,
          priceIds: defaultPriceIds,
        };

        const result = checkPlanAccess('pro', ctx);
        expect(result.allowed).toBe(false);
        expect(result.status).toBe(403);
        expect(result.requiredPlan).toBe('pro');
      });
    });

    describe('plan hierarchy', () => {
      it('allows when current plan meets minimum (starter >= starter)', () => {
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: { id: 'cust-1' },
          subscription: { stripe_price_id: 'price_starter', status: 'active' },
          priceIds: defaultPriceIds,
        };

        expect(checkPlanAccess('starter', ctx).allowed).toBe(true);
      });

      it('allows when current plan exceeds minimum (pro > starter)', () => {
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: { id: 'cust-1' },
          subscription: { stripe_price_id: 'price_pro', status: 'active' },
          priceIds: defaultPriceIds,
        };

        expect(checkPlanAccess('starter', ctx).allowed).toBe(true);
      });

      it('denies when current plan is below minimum (starter < pro)', () => {
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: { id: 'cust-1' },
          subscription: { stripe_price_id: 'price_starter', status: 'active' },
          priceIds: defaultPriceIds,
        };

        const result = checkPlanAccess('pro', ctx);
        expect(result.allowed).toBe(false);
        expect(result.status).toBe(403);
        expect(result.currentPlan).toBe('starter');
        expect(result.requiredPlan).toBe('pro');
      });

      it('denies free plan for starter gate (free < starter)', () => {
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: { id: 'cust-1' },
          subscription: { stripe_price_id: 'price_unknown', status: 'active' },
          priceIds: defaultPriceIds,
        };

        const result = checkPlanAccess('starter', ctx);
        expect(result.allowed).toBe(false);
        expect(result.currentPlan).toBe('free');
      });
    });

    describe('trialing subscriptions', () => {
      it('allows trialing subscriptions (the DB query filters for active|trialing)', () => {
        // The middleware queries .in('status', ['active', 'trialing']), so if a
        // subscription is returned it's already validated as active or trialing.
        const ctx: RequirePlanContext = {
          user: defaultUser,
          billingConfigured: true,
          customer: { id: 'cust-1' },
          subscription: { stripe_price_id: 'price_pro', status: 'trialing' },
          priceIds: defaultPriceIds,
        };

        expect(checkPlanAccess('pro', ctx).allowed).toBe(true);
      });
    });
  });
});

describe('planHierarchy', () => {
  it('orders plans correctly: free < starter < pro', () => {
    expect(planHierarchy.free).toBeLessThan(planHierarchy.starter);
    expect(planHierarchy.starter).toBeLessThan(planHierarchy.pro);
  });

  it('has all plan IDs defined', () => {
    expect(planHierarchy).toHaveProperty('free');
    expect(planHierarchy).toHaveProperty('starter');
    expect(planHierarchy).toHaveProperty('pro');
  });
});

// ============================================================================
// DRIFT GUARDS — pin the real carbon/ source this mirror models.
// ============================================================================

describe('drift guards (carbon/ source)', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

  it('requirePlan resolves the current plan via planIdFromPriceId with provider price IDs', () => {
    const src = read('carbon/src/server/middleware/requirePlan.ts');
    expect(src).toMatch(/planIdFromPriceId\(sub\.stripe_price_id, priceIds\)/);
    expect(src).toMatch(/getProviderPriceIds\(\)/);
    // No yearly price handling — yearly pricing was deferred.
    expect(src).not.toMatch(/yearly/i);
  });

  it('the active-plan query includes trialing subscriptions', () => {
    const src = read('carbon/src/server/middleware/requirePlan.ts');
    expect(src).toMatch(/\.in\('status', \['active', 'trialing'\]\)/);
  });

  it('provider price IDs are starter/pro only (no yearly variants)', () => {
    const src = read('carbon/src/server/billing/index.ts');
    expect(src).toMatch(/\{ starter\?: string; pro\?: string \}/);
    expect(src).not.toMatch(/yearly/i);
  });
});
