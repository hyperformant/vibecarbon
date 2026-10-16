import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Context, Next } from 'hono';
import type { PlanId } from '../../shared/pricing';
import { planIdFromPriceId } from '../../shared/pricing';
import { getProviderPriceIds, isBillingConfigured } from '../billing';
import { adminDb } from '../db/client';
import { customers, memberships, subscriptions } from '../db/schema';
import type { HonoVariables } from '../types';

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
  const [personal] = await adminDb
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.userId, userId), isNull(customers.organizationId)))
    .limit(1);
  if (personal?.id) customerIds.push(personal.id);

  // Org customers for every organization the user is a member of.
  const userMemberships = await adminDb
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  const orgIds = userMemberships
    .map((m) => m.organizationId)
    .filter((id): id is string => Boolean(id));

  if (orgIds.length > 0) {
    const orgCustomers = await adminDb
      .select({ id: customers.id })
      .from(customers)
      .where(inArray(customers.organizationId, orgIds));
    for (const c of orgCustomers) {
      if (c.id) customerIds.push(c.id);
    }
  }

  if (customerIds.length === 0) return 'free';

  const activeSubscriptions = await adminDb
    .select({ stripePriceId: subscriptions.stripePriceId })
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.customerId, customerIds),
        inArray(subscriptions.status, ['active', 'trialing'])
      )
    );

  let highest: PlanId = 'free';
  for (const sub of activeSubscriptions) {
    const plan = planIdFromPriceId(sub.stripePriceId, priceIds);
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
