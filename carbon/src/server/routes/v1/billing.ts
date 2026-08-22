import type { SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';
import { planIdFromPriceId, plans } from '../../../shared/pricing';
import { getBillingProvider, getProviderPriceIds, isBillingConfigured } from '../../billing';
import { env } from '../../lib/env';
import { sanitizeError } from '../../lib/errors';
import { createRateLimiter } from '../../lib/rate-limiter';
import { supabaseAdmin } from '../../lib/supabase';
import { requireAal2 } from '../../middleware/requireAal2';
import { requireOrgRole } from '../../middleware/requireOrgRole';
import type { HonoVariables } from '../../types';

// Organization billing actions require an owner/admin of the target org.
const ORG_BILLING_ROLES = ['OWNER', 'ADMIN'];

// Helper to access tables not yet in generated types
// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const billingRoutes = new Hono<{ Variables: HonoVariables }>();

// Strict limiters on the provider-cost routes — each creates a Stripe/Paddle/
// Polar checkout/setup/portal object, so the app-wide 100/min/IP still allows
// 100 provider objects/min. Registered BEFORE the route handlers (Hono applies
// middleware in registration order). Authed + org-role gated already, so a
// modest 20/15min is ample for legitimate use. (The public license-checkout
// gets its own tighter 5/15min limiter further down.)
for (const p of ['/checkout', '/setup', '/portal']) {
  billingRoutes.use(p, createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 }));
}

// ============================================================================
// VALIDATION SCHEMAS
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
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validate that a redirect URL is same-origin to prevent open redirects.
 * Returns the URL if valid, or null if it's external.
 */
function validateRedirectUrl(url: string, baseUrl: string): string | null {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    if (parsed.origin === base.origin) return url;
    return null;
  } catch {
    return null;
  }
}

/**
 * Get or create a billing customer for a user or organization.
 *
 * Uses the active billing provider to create the customer in the external
 * system, then stores the provider's customer ID in the `stripe_customer_id`
 * column (which holds any provider's customer ID despite its name).
 */
async function getOrCreateCustomer(
  type: 'user' | 'organization',
  userId: string,
  email: string,
  organizationId?: string
): Promise<{ customerId: string; providerCustomerId: string }> {
  const provider = getBillingProvider();

  // Build query based on type
  const query = adminDb.from('customers').select('id, stripe_customer_id');

  if (type === 'user') {
    query.eq('user_id', userId).is('organization_id', null);
  } else {
    if (!organizationId) {
      throw new Error('Organization ID is required for organization billing');
    }
    query.eq('organization_id', organizationId).is('user_id', null);
  }

  const { data: existingCustomer, error: fetchError } = await query.maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to fetch customer: ${fetchError.message}`);
  }

  // Return existing customer if found
  if (existingCustomer) {
    return {
      customerId: existingCustomer.id,
      providerCustomerId: existingCustomer.stripe_customer_id,
    };
  }

  // Get organization name if applicable
  let customerName = email;
  if (type === 'organization' && organizationId) {
    const { data: org } = await adminDb
      .from('organizations')
      .select('name')
      .eq('id', organizationId)
      .single();
    if (org) {
      customerName = org.name;
    }
  }

  // Create customer in the billing provider
  const providerCustomerId = await provider.createCustomer({
    email,
    name: customerName,
    metadata: {
      type,
      user_id: userId,
      organization_id: organizationId || '',
    },
  });

  // Create database record
  // NOTE: stripe_customer_id column stores the provider's customer ID regardless
  // of which provider is active. The column name is kept for backward compatibility.
  // Single explicit shape (not a discriminated union of two object literals):
  // PostgREST's insert overload rejects the union because the org branch's
  // `user_id?: undefined` is incompatible with the user branch's `user_id: string`.
  // `organizationId` is guaranteed defined in the org path by the guard above.
  const insertData: {
    user_id?: string;
    organization_id?: string;
    stripe_customer_id: string;
    email: string;
  } =
    type === 'user'
      ? { user_id: userId, stripe_customer_id: providerCustomerId, email }
      : { organization_id: organizationId, stripe_customer_id: providerCustomerId, email };

  const { data: newCustomer, error: insertError } = await adminDb
    .from('customers')
    .insert(insertData)
    .select('id, stripe_customer_id')
    .single();

  if (insertError) {
    // Clean up provider customer if DB insert fails
    try {
      await provider.deleteCustomer(providerCustomerId);
    } catch {
      // Best-effort cleanup; the orphaned customer can be cleaned up manually
    }
    throw new Error(`Failed to create customer record: ${insertError.message}`);
  }

  return {
    customerId: newCustomer.id,
    providerCustomerId: newCustomer.stripe_customer_id,
  };
}

// ============================================================================
// STRIPE PRICE CACHE (kept for backward compatibility with Stripe subscriptions)
// ============================================================================

const priceCache = new Map<string, { data: unknown; expiresAt: number }>();
const PRICE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour (prices rarely change)

async function getCachedPrice(priceId: string): Promise<unknown> {
  const cached = priceCache.get(priceId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  // Price caching via direct Stripe API is only available for the Stripe provider.
  // For other providers, the subscription endpoint uses getSubscription() instead.
  const provider = getBillingProvider();
  if (provider.type !== 'stripe') {
    return null;
  }

  // Dynamic import to avoid loading stripe module when not needed
  const { getStripe } = await import('../../lib/stripe');
  const stripe = getStripe();
  const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
  priceCache.set(priceId, { data: price, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
  return price;
}

// ============================================================================
// BILLING STATUS
// ============================================================================

/**
 * Check if billing is configured
 */
billingRoutes.get('/status', (c) => {
  return c.json({
    configured: isBillingConfigured(),
    provider: env.BILLING_PROVIDER,
  });
});

// ============================================================================
// PRICES ENDPOINT
// ============================================================================

/**
 * Get available plans and their price IDs for the active provider
 */
billingRoutes.get('/prices', (c) => {
  const configured = isBillingConfigured();
  const priceIds = getProviderPriceIds();
  const priceMap: Record<string, { monthly?: string }> = {};

  if (configured) {
    if (priceIds.starter) {
      priceMap.starter = { monthly: priceIds.starter };
    }
    if (priceIds.pro) {
      priceMap.pro = { monthly: priceIds.pro };
    }
  }

  return c.json({
    configured,
    provider: env.BILLING_PROVIDER,
    plans: plans.map((plan) => ({
      ...plan,
      // Keep stripePriceIds key for backward compatibility with existing clients
      stripePriceIds: priceMap[plan.id] ?? null,
      priceIds: priceMap[plan.id] ?? null,
    })),
  });
});

// ============================================================================
// SUBSCRIPTION ENDPOINTS
// ============================================================================

/**
 * Get current subscription for user or organization.
 *
 * SECURITY: requireOrgRole enforces org membership before this handler runs, so
 * a caller cannot read another organization's subscription by supplying an
 * arbitrary organizationId (the previous IDOR).
 */
billingRoutes.get('/subscription', requireOrgRole(ORG_BILLING_ROLES), async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isBillingConfigured()) {
    return c.json({ error: 'Billing is not configured' }, 503);
  }

  const type = c.req.query('type') || 'user';
  const organizationId = c.req.query('organizationId');

  try {
    // Build customer query
    let customerQuery = adminDb.from('customers').select('id, stripe_customer_id');

    if (type === 'user') {
      customerQuery = customerQuery.eq('user_id', user.id).is('organization_id', null);
    } else {
      if (!organizationId) {
        return c.json({ error: 'Organization ID is required' }, 400);
      }
      customerQuery = customerQuery.eq('organization_id', organizationId).is('user_id', null);
    }

    const { data: customer } = await customerQuery.maybeSingle();

    if (!customer) {
      return c.json({
        subscription: null,
        status: 'none',
      });
    }

    // Get subscription from database
    const { data: subscription } = await adminDb
      .from('subscriptions')
      .select('*')
      .eq('customer_id', customer.id)
      .eq('status', 'active')
      .maybeSingle();

    if (!subscription) {
      return c.json({
        subscription: null,
        status: 'none',
      });
    }

    const providerPriceIds = getProviderPriceIds();

    // Try to get price details from provider or use cached Stripe price
    const provider = getBillingProvider();
    let priceInfo: { unitAmount: number; currency: string; interval: string } | null = null;
    let productInfo: { id: string; name: string } | null = null;

    if (provider.type === 'stripe') {
      // Use the existing Stripe price cache for backward compatibility
      const price = (await getCachedPrice(subscription.stripe_price_id)) as {
        id: string;
        unit_amount: number | null;
        currency: string;
        recurring: { interval: string } | null;
        product: unknown;
      } | null;

      if (price) {
        priceInfo = {
          unitAmount: price.unit_amount ?? 0,
          currency: price.currency,
          interval: price.recurring?.interval ?? 'month',
        };
        const product = price.product as { id: string; name: string } | undefined;
        productInfo = product ? { id: product.id, name: product.name } : null;
      }
    } else {
      // For Paddle/Polar, fetch subscription details from the provider API
      try {
        const subInfo = await provider.getSubscription({
          customerId: customer.stripe_customer_id,
          subscriptionId: subscription.stripe_subscription_id,
        });
        if (subInfo) {
          priceInfo = subInfo.price;
          productInfo = subInfo.product;
        }
      } catch {
        // Fall back to database data if provider API is unreachable
      }
    }

    const resolvedPlanId = planIdFromPriceId(subscription.stripe_price_id, providerPriceIds);

    return c.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        priceId: subscription.stripe_price_id,
        planId: resolvedPlanId,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        product: productInfo,
        price: priceInfo
          ? {
              id: subscription.stripe_price_id,
              unitAmount: priceInfo.unitAmount,
              currency: priceInfo.currency,
              interval: priceInfo.interval,
            }
          : null,
      },
      status: subscription.status,
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to fetch subscription') }, 500);
  }
});

// ============================================================================
// CHECKOUT
// ============================================================================

/**
 * Create a checkout session via the active billing provider
 */
billingRoutes.post('/checkout', requireAal2, requireOrgRole(ORG_BILLING_ROLES), async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isBillingConfigured()) {
    return c.json({ error: 'Billing is not configured' }, 503);
  }

  // Parse and validate request body. Organization access is enforced by the
  // requireOrgRole middleware above (which reads the same cached body).
  let body: z.infer<typeof checkoutSchema>;
  try {
    const rawBody = await c.req.json();
    const result = checkoutSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    const provider = getBillingProvider();

    // Get or create customer (user.email guaranteed for authenticated users)
    const { providerCustomerId } = await getOrCreateCustomer(
      body.type,
      user.id,
      user.email ?? '',
      body.organizationId
    );

    // Default URLs - validate user-supplied URLs are same-origin to prevent open redirects
    const baseUrl = env.NODE_ENV === 'production' ? process.env.SITE_URL : 'http://localhost:5173';
    const defaultSuccessUrl = `${baseUrl}/settings/billing?success=true`;
    const defaultCancelUrl = `${baseUrl}/settings/billing?canceled=true`;
    const successUrl =
      (body.successUrl && baseUrl ? validateRedirectUrl(body.successUrl, baseUrl) : null) ||
      defaultSuccessUrl;
    const cancelUrl =
      (body.cancelUrl && baseUrl ? validateRedirectUrl(body.cancelUrl, baseUrl) : null) ||
      defaultCancelUrl;

    // Create checkout session via the provider
    const result = await provider.createCheckout({
      customerId: providerCustomerId,
      priceId: body.priceId,
      successUrl,
      cancelUrl,
      metadata: {
        type: body.type,
        user_id: user.id,
        organization_id: body.organizationId || '',
      },
    });

    return c.json({
      sessionId: result.sessionId,
      url: result.url,
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to create checkout session') }, 500);
  }
});

// ============================================================================
// SETUP (add payment method without subscribing — Stripe-only feature)
// ============================================================================

const setupSchema = z.object({
  type: z.enum(['user', 'organization']),
  organizationId: z.string().uuid().optional(),
});

/**
 * Create a Stripe Checkout session in setup mode to collect a payment method.
 *
 * NOTE: This endpoint is Stripe-specific. Paddle and Polar handle payment
 * method collection differently (during checkout or via their portal).
 * For non-Stripe providers, this endpoint returns 501.
 */
billingRoutes.post('/setup', requireAal2, requireOrgRole(ORG_BILLING_ROLES), async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isBillingConfigured()) {
    return c.json({ error: 'Billing is not configured' }, 503);
  }

  // Setup mode is only supported by Stripe
  const provider = getBillingProvider();
  if (provider.type !== 'stripe') {
    return c.json(
      { error: 'Setup mode is only supported with Stripe. Use the customer portal instead.' },
      501
    );
  }

  // Organization access is enforced by requireOrgRole above.
  let body: z.infer<typeof setupSchema>;
  try {
    const rawBody = await c.req.json();
    const result = setupSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    // Import Stripe directly for setup mode (Stripe-specific feature)
    const { getStripe } = await import('../../lib/stripe');
    const stripe = getStripe();

    const { providerCustomerId } = await getOrCreateCustomer(
      body.type,
      user.id,
      user.email ?? '',
      body.organizationId
    );

    const baseUrl = env.NODE_ENV === 'production' ? process.env.SITE_URL : 'http://localhost:5173';
    const returnUrl = `${baseUrl}/settings/billing`;

    const session = await stripe.checkout.sessions.create({
      customer: providerCustomerId,
      mode: 'setup',
      payment_method_types: ['card'],
      success_url: `${returnUrl}?setup=success`,
      cancel_url: `${returnUrl}?setup=canceled`,
      metadata: {
        type: body.type,
        user_id: user.id,
        organization_id: body.organizationId || '',
      },
    });

    return c.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to create setup session') }, 500);
  }
});

// ============================================================================
// CUSTOMER PORTAL
// ============================================================================

/**
 * Create a customer portal session via the active billing provider
 */
billingRoutes.post('/portal', requireAal2, requireOrgRole(ORG_BILLING_ROLES), async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isBillingConfigured()) {
    return c.json({ error: 'Billing is not configured' }, 503);
  }

  // Parse and validate request body. Organization access is enforced by the
  // requireOrgRole middleware above.
  let body: z.infer<typeof portalSchema>;
  try {
    const rawBody = await c.req.json();
    const result = portalSchema.safeParse(rawBody);

    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }

    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    // Find existing customer
    const query = adminDb.from('customers').select('stripe_customer_id');

    if (body.type === 'user') {
      query.eq('user_id', user.id).is('organization_id', null);
    } else {
      query.eq('organization_id', body.organizationId).is('user_id', null);
    }

    const { data: customer, error: fetchError } = await query.maybeSingle();

    if (fetchError) {
      return c.json({ error: sanitizeError(fetchError, 'Failed to fetch customer') }, 500);
    }

    if (!customer) {
      return c.json({ error: 'No billing account found. Please subscribe first.' }, 404);
    }

    const provider = getBillingProvider();
    const baseUrl = env.NODE_ENV === 'production' ? process.env.SITE_URL : 'http://localhost:5173';
    const defaultReturnUrl = `${baseUrl}/settings/billing`;
    const returnUrl =
      (body.returnUrl && baseUrl ? validateRedirectUrl(body.returnUrl, baseUrl) : null) ||
      defaultReturnUrl;

    const result = await provider.createPortalSession({
      customerId: customer.stripe_customer_id,
      returnUrl,
    });

    return c.json({
      url: result.url,
    });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to create portal session') }, 500);
  }
});

// ============================================================================
// LICENSE CHECKOUT (public, no auth — one-time license purchases)
// ============================================================================

const licenseCheckoutSchema = z.object({
  tier: z.enum(['fullerene']),
});

// Fullerene is the only self-serve license tier; Agency is a contact-us
// channel with no checkout (see src/lib/licensing/tiers.js in the CLI repo).
const TIER_PRICE_IDS: Record<string, string | undefined> = {
  fullerene: env.FULLERENE_PRICE_ID,
};

// The amounts every static surface advertises (README, docs, PricingSection).
// Checkout REFUSES to sell when the live catalog price disagrees — a stale
// FULLERENE_PRICE_ID pointing at the old $299 price must fail loud, never
// charge a customer more than the page said. USD cents.
const TIER_ADVERTISED_CENTS: Record<string, number> = {
  fullerene: 149_00,
};

// One successful verification per price id per process — checkout must not
// pay a provider round-trip on every request. A FAILED verification is never
// cached: config can be fixed live and the next request re-checks.
const verifiedPriceIds = new Set<string>();

/**
 * Returns null when the checkout may proceed, or an operator-facing reason
 * string when the live price disagrees with the advertised amount.
 * Providers without price retrieval, and transient retrieval errors, log and
 * proceed — availability is not held hostage to a provider API blip; only a
 * POSITIVE amount mismatch blocks the sale.
 */
async function priceIntegrityFailure(
  provider: import('../../billing/provider').BillingProvider,
  tier: string,
  priceId: string
): Promise<string | null> {
  const expected = TIER_ADVERTISED_CENTS[tier];
  if (!expected || verifiedPriceIds.has(priceId)) return null;
  if (!provider.getPriceAmount) {
    console.warn(
      `[billing] ${provider.type} lacks price retrieval, skipping ${tier} price integrity check`
    );
    return null;
  }
  let live: { unitAmountCents: number; currency: string } | null;
  try {
    live = await provider.getPriceAmount(priceId);
  } catch (err) {
    console.warn(
      `[billing] price integrity check for ${tier} (${priceId}) errored, proceeding: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
  if (live === null) return null;
  if (live.unitAmountCents !== expected || live.currency !== 'usd') {
    return (
      `live ${provider.type} price ${priceId} is ${live.unitAmountCents} ${live.currency}, ` +
      `but ${tier} is advertised at ${expected} usd, refusing to sell at an undisclosed amount`
    );
  }
  verifiedPriceIds.add(priceId);
  return null;
}

// SECURITY: this route is public (no auth) and creates a provider checkout
// session on every request, so it's an abuse/cost vector. Apply a strict
// per-IP limiter on top of the app-wide 100/min, matching the contact/
// newsletter public routes.
billingRoutes.use('/license-checkout', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 }));

/**
 * Create a one-time payment checkout session for a license tier.
 * No authentication and no pre-collected email — the provider's checkout page
 * collects the buyer's email itself (Stripe guest payment sessions create a
 * Customer via customer_creation: 'always', so license fulfillment reads the
 * email from the dashboard / customer_details).
 */
billingRoutes.post('/license-checkout', async (c) => {
  if (!isBillingConfigured()) {
    return c.json({ error: 'Billing is not configured' }, 503);
  }

  let body: z.infer<typeof licenseCheckoutSchema>;
  try {
    const rawBody = await c.req.json();
    const result = licenseCheckoutSchema.safeParse(rawBody);
    if (!result.success) {
      const errors = result.error.issues.map((e: { message: string }) => e.message).join(', ');
      return c.json({ error: errors }, 400);
    }
    body = result.data;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const priceId = TIER_PRICE_IDS[body.tier];
  if (!priceId) {
    return c.json({ error: `Price not configured for ${body.tier} tier` }, 503);
  }

  try {
    const provider = getBillingProvider();

    // Catalog-drift guard: never charge an amount the page didn't advertise.
    const integrityFailure = await priceIntegrityFailure(provider, body.tier, priceId);
    if (integrityFailure) {
      console.error(`[billing] LICENSE CHECKOUT BLOCKED: ${integrityFailure}`);
      return c.json({ error: 'License pricing is temporarily unavailable' }, 503);
    }

    const baseUrl = env.NODE_ENV === 'production' ? process.env.SITE_URL : 'http://localhost:5173';
    const successUrl = `${baseUrl}/checkout?success=true&tier=${body.tier}`;
    // Purchases start straight from the pricing card, so a cancelled checkout
    // returns there — /checkout only renders the success state.
    const cancelUrl = `${baseUrl}/#pricing`;

    const result = await provider.createCheckout({
      priceId,
      successUrl,
      cancelUrl,
      metadata: { tier: body.tier, type: 'license' },
      mode: 'payment',
    });

    return c.json({ url: result.url });
  } catch (error) {
    return c.json({ error: sanitizeError(error, 'Failed to create checkout session') }, 500);
  }
});

export { billingRoutes };
