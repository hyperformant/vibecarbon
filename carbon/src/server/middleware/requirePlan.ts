import type { SupabaseClient } from '@supabase/supabase-js';
import type { Context, Next } from 'hono';
import type { PlanId } from '../../shared/pricing';
import { planIdFromPriceId } from '../../shared/pricing';
import { getProviderPriceIds, isBillingConfigured } from '../billing';
import { supabaseAdmin } from '../lib/supabase';
import type { HonoVariables } from '../types';

// biome-ignore lint/suspicious/noExplicitAny: Tables not yet in generated Database types
const adminDb = supabaseAdmin as SupabaseClient<any>;

const planHierarchy: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  pro: 2,
};

/**
 * Resolve the highest active plan available to a user, considering BOTH their
 * personal subscription and the subscriptions of any organization they belong
 * to. A user is entitled to a plan if their own customer record OR any org they
 * are a member of has an active/trialing subscription at that tier.
 */
async function resolveHighestPlan(userId: string): Promise<PlanId> {
  const priceIds = getProviderPriceIds();
  const customerIds: string[] = [];

  // Personal customer (organization_id IS NULL).
  const { data: personal } = await adminDb
    .from('customers')
    .select('id')
    .eq('user_id', userId)
    .is('organization_id', null)
    .maybeSingle();
  if (personal?.id) customerIds.push(personal.id);

  // Org customers for every organization the user is a member of.
  const { data: memberships } = await adminDb
    .from('memberships')
    .select('organization_id')
    .eq('user_id', userId);
  const orgIds = (memberships ?? [])
    .map((m: { organization_id: string | null }) => m.organization_id)
    .filter((id: string | null): id is string => Boolean(id));

  if (orgIds.length > 0) {
    const { data: orgCustomers } = await adminDb
      .from('customers')
      .select('id')
      .in('organization_id', orgIds);
    for (const c of orgCustomers ?? []) {
      if (c.id) customerIds.push(c.id);
    }
  }

  if (customerIds.length === 0) return 'free';

  const { data: subscriptions } = await adminDb
    .from('subscriptions')
    .select('stripe_price_id, status')
    .in('customer_id', customerIds)
    .in('status', ['active', 'trialing']);

  let highest: PlanId = 'free';
  for (const sub of subscriptions ?? []) {
    const plan = planIdFromPriceId(sub.stripe_price_id, priceIds);
    if (planHierarchy[plan] > planHierarchy[highest]) {
      highest = plan;
    }
  }
  return highest;
}

/**
 * Hono middleware that gates API routes behind a minimum plan.
 *
 * Usage:
 *   myRoutes.use('/premium-endpoint', requirePlan('pro'));
 *   myRoutes.get('/starter-feature', requirePlan('starter'), handler);
 */
export function requirePlan(minimumPlan: PlanId) {
  return async (c: Context<{ Variables: HonoVariables }>, next: Next) => {
    // If billing isn't configured at all (dev / self-hosted with no provider),
    // allow all requests. Uses isBillingConfigured() — provider-agnostic —
    // rather than the Stripe-only check, so Paddle/Polar deployments gate too.
    if (!isBillingConfigured()) {
      await next();
      return;
    }

    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Free plan requires no subscription check.
    if (minimumPlan === 'free') {
      await next();
      return;
    }

    const currentPlan = await resolveHighestPlan(user.id);

    if (planHierarchy[currentPlan] < planHierarchy[minimumPlan]) {
      return c.json({ error: 'Upgrade required', requiredPlan: minimumPlan, currentPlan }, 403);
    }

    await next();
  };
}
