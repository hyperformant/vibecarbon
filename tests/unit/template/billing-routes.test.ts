import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Tests for billing route logic from carbon/src/server/routes/v1/billing.ts
 *
 * These tests re-implement the validation schemas and business-logic patterns
 * inline (the template lives in a separate pnpm project whose node_modules may
 * be absent at unit-test time, so we don't import from carbon/src). The mirror
 * is kept aligned with today's source, and the `drift guards` describe block at
 * the bottom reads the real carbon/ files to pin the signatures this mirror
 * depends on.
 *
 * Current behavior modeled here:
 *  - getProviderPriceIds() returns { starter?, pro? } only — no yearly variants.
 *  - The /prices endpoint emits a monthly-only price map.
 *  - getOrCreateCustomer is NOT mirrored here: it reads and writes Postgres
 *    through Drizzle, and carbon/tests/integration/server/routes/
 *    billing-customer.test.ts tests the real function. The drift guard below
 *    only pins that it stays on the provider abstraction.
 *  - Plans have no trial fields and checkout has no trial logic.
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface MockUser {
  id: string;
  email?: string;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
}

interface MockCustomer {
  id: string;
  stripe_customer_id: string;
  user_id?: string;
  organization_id?: string;
  email: string;
}

interface MockSubscription {
  id: string;
  customer_id: string;
  stripe_price_id: string;
  status: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
}

interface MockMembership {
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

// Mock provider price (Stripe-shaped, used by the subscription endpoint)
interface MockProviderPrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
  product: unknown;
}

// Mock checkout/portal session
interface MockSession {
  id: string;
  url: string | null;
}

// ============================================================================
// VALIDATION SCHEMAS (re-implemented from template)
// ============================================================================

const checkoutSchema = z.object({
  priceId: z.string().min(1, 'Price ID is required'),
  type: z.enum(['user', 'organization']),
  organizationId: z.string().uuid().optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const portalSchema = z.object({
  type: z.enum(['user', 'organization']),
  organizationId: z.string().uuid().optional(),
  returnUrl: z.string().url().optional(),
});

// ============================================================================
// PRICING CONFIG (simplified from shared/pricing.ts)
//
// Plans carry no trial fields — the product deliberately deferred trials.
// ============================================================================

interface Plan {
  id: string;
  name: string;
}

const plans: Plan[] = [
  { id: 'free', name: 'Free' },
  { id: 'starter', name: 'Startup' },
  { id: 'pro', name: 'Pro' },
];

// Mirror of pricing.ts planIdFromPriceId — provider-agnostic, maps only
// starter/pro/free (no yearly variants).
function planIdFromPriceId(priceId: string, priceIds: { starter?: string; pro?: string }): string {
  if (priceId === priceIds.starter) return 'starter';
  if (priceId === priceIds.pro) return 'pro';
  return 'free';
}

// ============================================================================
// TESTS: VALIDATION SCHEMAS
// ============================================================================

describe('Billing Validation Schemas', () => {
  describe('checkoutSchema', () => {
    it('validates valid user checkout request', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'user',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.priceId).toBe('price_123');
        expect(result.data.type).toBe('user');
      }
    });

    it('validates valid organization checkout request', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'organization',
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.organizationId).toBe('550e8400-e29b-41d4-a716-446655440000');
      }
    });

    it('validates optional success and cancel URLs', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'user',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.successUrl).toBe('https://example.com/success');
        expect(result.data.cancelUrl).toBe('https://example.com/cancel');
      }
    });

    it('rejects missing priceId', () => {
      const result = checkoutSchema.safeParse({
        type: 'user',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod's error message for missing field
        expect(result.error.issues[0].message).toMatch(/required|expected/i);
      }
    });

    it('rejects empty priceId', () => {
      const result = checkoutSchema.safeParse({
        priceId: '',
        type: 'user',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Price ID is required');
      }
    });

    it('rejects invalid type', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'invalid',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid organizationId UUID', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'organization',
        organizationId: 'not-a-uuid',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid URL format for successUrl', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'user',
        successUrl: 'not-a-url',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid URL format for cancelUrl', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'user',
        cancelUrl: 'not-a-url',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('portalSchema', () => {
    it('validates valid user portal request', () => {
      const result = portalSchema.safeParse({
        type: 'user',
      });

      expect(result.success).toBe(true);
    });

    it('validates valid organization portal request', () => {
      const result = portalSchema.safeParse({
        type: 'organization',
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.organizationId).toBe('550e8400-e29b-41d4-a716-446655440000');
      }
    });

    it('validates optional returnUrl', () => {
      const result = portalSchema.safeParse({
        type: 'user',
        returnUrl: 'https://example.com/billing',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.returnUrl).toBe('https://example.com/billing');
      }
    });

    it('rejects invalid type', () => {
      const result = portalSchema.safeParse({
        type: 'company',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid organizationId UUID', () => {
      const result = portalSchema.safeParse({
        type: 'organization',
        organizationId: 'invalid-uuid',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid returnUrl format', () => {
      const result = portalSchema.safeParse({
        type: 'user',
        returnUrl: 'invalid-url',
      });

      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TESTS: ROUTE LOGIC PATTERNS
// ============================================================================

describe('Billing Route Logic', () => {
  describe('GET /billing/status', () => {
    it('returns configured status when the provider is configured', () => {
      const isBillingConfigured = () => true;

      const response = {
        configured: isBillingConfigured(),
      };

      expect(response).toEqual({
        configured: true,
      });
    });

    it('returns unconfigured status when the provider is not configured', () => {
      const isBillingConfigured = () => false;

      const response = {
        configured: isBillingConfigured(),
      };

      expect(response).toEqual({
        configured: false,
      });
    });
  });

  describe('GET /billing/prices', () => {
    it('returns plans with monthly-only price maps when configured', () => {
      const configured = true;
      // getProviderPriceIds() returns starter/pro only.
      const priceIds: { starter?: string; pro?: string } = {
        starter: 'price_starter_monthly',
        pro: 'price_pro_monthly',
      };

      const priceMap: Record<string, { monthly?: string }> = {};

      if (configured) {
        if (priceIds.starter) {
          priceMap.starter = { monthly: priceIds.starter };
        }
        if (priceIds.pro) {
          priceMap.pro = { monthly: priceIds.pro };
        }
      }

      const response = {
        configured,
        plans: plans.map((plan) => ({
          ...plan,
          // Both keys are emitted (stripePriceIds kept for backward compatibility).
          stripePriceIds: priceMap[plan.id] ?? null,
          priceIds: priceMap[plan.id] ?? null,
        })),
      };

      expect(response.configured).toBe(true);
      expect(response.plans[1].stripePriceIds).toEqual({ monthly: 'price_starter_monthly' });
      expect(response.plans[1].priceIds).toEqual({ monthly: 'price_starter_monthly' });
      expect(response.plans[2].stripePriceIds).toEqual({ monthly: 'price_pro_monthly' });
      // No yearly entry is emitted — yearly pricing was deferred from the product.
      expect(response.plans[1].stripePriceIds).not.toHaveProperty('yearly');
      expect(response.plans[2].stripePriceIds).not.toHaveProperty('yearly');
    });

    it('returns null price maps when not configured', () => {
      const configured = false;

      const response = {
        configured,
        plans: plans.map((plan) => ({
          ...plan,
          stripePriceIds: null,
          priceIds: null,
        })),
      };

      expect(response.configured).toBe(false);
      expect(response.plans[0].stripePriceIds).toBeNull();
      expect(response.plans[1].stripePriceIds).toBeNull();
      expect(response.plans[1].priceIds).toBeNull();
    });
  });

  describe('GET /billing/subscription', () => {
    it('returns 401 when user is not authenticated', () => {
      const user = null;

      const statusCode = user ? 200 : 401;
      const response = user ? {} : { error: 'Unauthorized' };

      expect(statusCode).toBe(401);
      expect(response).toEqual({ error: 'Unauthorized' });
    });

    it('returns 503 when billing is not configured', () => {
      const _user: MockUser = { id: 'user_123', email: 'user@example.com' };
      const isBillingConfigured = false;

      const statusCode = isBillingConfigured ? 200 : 503;
      const response = isBillingConfigured ? {} : { error: 'Billing is not configured' };

      expect(statusCode).toBe(503);
      expect(response).toEqual({ error: 'Billing is not configured' });
    });

    it('returns subscription: null when no customer found', () => {
      const customer = null;

      const response = customer
        ? {}
        : {
            subscription: null,
            status: 'none',
          };

      expect(response).toEqual({
        subscription: null,
        status: 'none',
      });
    });

    it('returns subscription: null when no active subscription found', () => {
      const _customer: MockCustomer = {
        id: 'cust_123',
        stripe_customer_id: 'cus_123',
        user_id: 'user_123',
        email: 'user@example.com',
      };
      const subscription = null;

      const response = subscription
        ? {}
        : {
            subscription: null,
            status: 'none',
          };

      expect(response).toEqual({
        subscription: null,
        status: 'none',
      });
    });

    it('returns full subscription details with resolved planId', () => {
      const subscription: MockSubscription = {
        id: 'sub_123',
        customer_id: 'cust_123',
        stripe_price_id: 'price_starter_monthly',
        status: 'active',
        current_period_end: '2024-12-31T23:59:59Z',
        cancel_at_period_end: false,
      };

      const price: MockProviderPrice = {
        id: 'price_starter_monthly',
        unit_amount: 1900,
        currency: 'usd',
        recurring: { interval: 'month' },
        product: { id: 'prod_123', name: 'Startup Plan' },
      };

      const resolvedPlanId = planIdFromPriceId(subscription.stripe_price_id, {
        starter: 'price_starter_monthly',
        pro: 'price_pro_monthly',
      });

      const response = {
        subscription: {
          id: subscription.id,
          status: subscription.status,
          priceId: subscription.stripe_price_id,
          planId: resolvedPlanId,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          product: price.product,
          price: {
            id: price.id,
            unitAmount: price.unit_amount,
            currency: price.currency,
            interval: price.recurring?.interval,
          },
        },
        status: subscription.status,
      };

      expect(response.subscription.planId).toBe('starter');
      expect(response.subscription.price.unitAmount).toBe(1900);
    });
  });

  describe('POST /billing/checkout', () => {
    it('returns 401 when user is not authenticated', () => {
      const user = null;

      const statusCode = user ? 200 : 401;
      const response = user ? {} : { error: 'Unauthorized' };

      expect(statusCode).toBe(401);
      expect(response).toEqual({ error: 'Unauthorized' });
    });

    it('returns 503 when billing is not configured', () => {
      const _user: MockUser = { id: 'user_123', email: 'user@example.com' };
      const isBillingConfigured = false;

      const statusCode = isBillingConfigured ? 200 : 503;
      const response = isBillingConfigured ? {} : { error: 'Billing is not configured' };

      expect(statusCode).toBe(503);
      expect(response).toEqual({ error: 'Billing is not configured' });
    });

    it('returns 400 for invalid request body', () => {
      const rawBody = { type: 'user' }; // Missing priceId
      const result = checkoutSchema.safeParse(rawBody);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(', ');
        expect(errors).toMatch(/required|expected/i);
      }
    });

    it('returns 400 when organization billing missing organizationId', () => {
      const body = {
        priceId: 'price_123',
        type: 'organization' as const,
        // Missing organizationId
      };

      const statusCode = body.type === 'organization' && !body.organizationId ? 400 : 200;
      const response =
        body.type === 'organization' && !body.organizationId
          ? { error: 'Organization ID is required for organization billing' }
          : {};

      expect(statusCode).toBe(400);
      expect(response).toEqual({ error: 'Organization ID is required for organization billing' });
    });

    it('returns 403 when user is not OWNER or ADMIN of organization', () => {
      const _body = {
        priceId: 'price_123',
        type: 'organization' as const,
        organizationId: 'org_123',
      };
      const membership: MockMembership | null = { role: 'MEMBER' };

      const isAuthorized =
        membership && (membership.role === 'OWNER' || membership.role === 'ADMIN');

      const statusCode = isAuthorized ? 200 : 403;
      const response = isAuthorized
        ? {}
        : { error: 'You must be an admin to manage organization billing' };

      expect(statusCode).toBe(403);
      expect(response).toEqual({ error: 'You must be an admin to manage organization billing' });
    });

    it('returns sessionId and url on success', () => {
      const mockSession: MockSession = {
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/pay/cs_test_123',
      };

      const response = {
        sessionId: mockSession.id,
        url: mockSession.url,
      };

      expect(response).toEqual({
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/pay/cs_test_123',
      });
    });

    it('resolves a paid plan from the configured price IDs (no trial logic)', () => {
      const priceId = 'price_starter_monthly';
      const resolvedPlanId = planIdFromPriceId(priceId, { starter: 'price_starter_monthly' });
      const planConfig = plans.find((p) => p.id === resolvedPlanId);

      expect(resolvedPlanId).toBe('starter');
      expect(planConfig).toBeDefined();
      // Plans carry no trial concept — trials were deferred from the product.
      // Only id/name are present; no trial field exists on the plan shape.
      expect(Object.keys(planConfig as Plan)).toEqual(['id', 'name']);
    });

    it('resolves unknown price IDs to the free plan', () => {
      const priceId = 'price_unknown';
      const resolvedPlanId = planIdFromPriceId(priceId, {});
      const planConfig = plans.find((p) => p.id === resolvedPlanId);

      expect(resolvedPlanId).toBe('free');
      expect(planConfig).toBeDefined();
    });
  });

  describe('POST /billing/portal', () => {
    it('returns 401 when user is not authenticated', () => {
      const user = null;

      const statusCode = user ? 200 : 401;
      const response = user ? {} : { error: 'Unauthorized' };

      expect(statusCode).toBe(401);
      expect(response).toEqual({ error: 'Unauthorized' });
    });

    it('returns 503 when billing is not configured', () => {
      const _user: MockUser = { id: 'user_123', email: 'user@example.com' };
      const isBillingConfigured = false;

      const statusCode = isBillingConfigured ? 200 : 503;
      const response = isBillingConfigured ? {} : { error: 'Billing is not configured' };

      expect(statusCode).toBe(503);
      expect(response).toEqual({ error: 'Billing is not configured' });
    });

    it('returns 400 for invalid request body', () => {
      const rawBody = { type: 'invalid' };
      const result = portalSchema.safeParse(rawBody);

      expect(result.success).toBe(false);
    });

    it('returns 404 when customer not found', () => {
      const customer = null;

      const statusCode = customer ? 200 : 404;
      const response = customer
        ? {}
        : { error: 'No billing account found. Please subscribe first.' };

      expect(statusCode).toBe(404);
      expect(response).toEqual({ error: 'No billing account found. Please subscribe first.' });
    });

    it('returns 403 when user is not OWNER or ADMIN for org billing', () => {
      const _body = {
        type: 'organization' as const,
        organizationId: 'org_123',
      };
      const membership: MockMembership | null = { role: 'MEMBER' };

      const isAuthorized =
        membership && (membership.role === 'OWNER' || membership.role === 'ADMIN');

      const statusCode = isAuthorized ? 200 : 403;
      const response = isAuthorized
        ? {}
        : { error: 'You must be an admin to manage organization billing' };

      expect(statusCode).toBe(403);
      expect(response).toEqual({ error: 'You must be an admin to manage organization billing' });
    });

    it('returns portal url on success', () => {
      const mockPortalSession: MockSession = {
        id: 'bps_123',
        url: 'https://billing.stripe.com/session/bps_123',
      };

      const response = {
        url: mockPortalSession.url,
      };

      expect(response).toEqual({
        url: 'https://billing.stripe.com/session/bps_123',
      });
    });
  });
});

// ============================================================================
// DRIFT GUARDS — pin the real carbon/ source these mirrors model.
//
// These read the current template files directly so the mirror can't silently
// drift away from the source again. No TypeScript is imported from carbon/src.
// ============================================================================

describe('drift guards (carbon/ source)', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

  it('getProviderPriceIds returns only starter/pro (no yearly variants)', () => {
    const src = read('carbon/src/server/billing/index.ts');
    expect(src).toMatch(
      /export function getProviderPriceIds\(\): \{ starter\?: string; pro\?: string \}/,
    );
    expect(src).not.toMatch(/yearly/i);
  });

  it('the /prices endpoint emits monthly-only price maps', () => {
    const src = read('carbon/src/server/routes/v1/billing.ts');
    expect(src).toMatch(/Record<string, \{ monthly\?: string \}>/);
    expect(src).not.toMatch(/yearly/i);
  });

  it('getOrCreateCustomer uses the provider abstraction and returns providerCustomerId', () => {
    const src = read('carbon/src/server/routes/v1/billing.ts');
    // Its behavior is tested against the real module in the template.
    expect(read('carbon/tests/integration/server/routes/billing-customer.test.ts')).toMatch(
      /getOrCreateCustomer/,
    );
    expect(src).toMatch(/provider\.createCustomer\(/);
    expect(src).toMatch(/provider\.deleteCustomer\(/);
    expect(src).toMatch(/providerCustomerId/);
    // The old direct-Stripe customer helpers must be gone.
    expect(src).not.toMatch(/stripe\.customers\.create\(/);
    expect(src).not.toMatch(/stripe\.customers\.del\(/);
  });

  it('pricing config has no trial fields and planIdFromPriceId maps only starter/pro/free', () => {
    const src = read('carbon/src/shared/pricing.ts');
    expect(src).not.toMatch(/trial/i);
    expect(src).toMatch(/export function planIdFromPriceId\(/);
    expect(src).toMatch(/if \(priceId === priceIds\.starter\) return 'starter';/);
    expect(src).toMatch(/if \(priceId === priceIds\.pro\) return 'pro';/);
  });
});
