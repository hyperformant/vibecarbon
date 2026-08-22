/**
 * Pricing configuration - single source of truth for plan tiers.
 *
 * NOTE: This is the subscription pricing for apps BUILT WITH Vibecarbon (Stripe subscriptions).
 * For Vibecarbon CLI licensing tiers (Graphite/Fullerene/Agency), see src/lib/licensing/tiers.js.
 *
 * Stripe price IDs are loaded from environment variables so they differ
 * between development (test mode) and production (live mode).
 *
 * Client-side: import { plans } from '@/shared/pricing' (uses display info only)
 * Server-side: import { getStripePriceId } from '@/shared/pricing' (resolves env vars)
 */

import { billingCatalog } from './billing-catalog';
import type { CatalogTier } from './billing-catalog.types';

export type { CatalogTier };

export type PlanId = 'free' | 'starter' | 'pro';

export interface PlanFeature {
  text: string;
  included: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  description: string;
  price: {
    monthly: number; // cents
  };
  features: PlanFeature[];
  limits: {
    members: number; // 0 = unlimited
    organizations: number;
    apiRequestsPerMinute: number;
  };
  popular?: boolean;
  // Dynamic fields, populated from the billing-catalog snapshot when the
  // provider has been configured. Undefined falls back to the hardcoded price.
  priceId?: string;
  currency?: string; // ISO 4217, lowercase (e.g. 'usd')
  interval?: 'month' | 'year' | 'one_time';
  type?: 'recurring' | 'one_time';
}

/**
 * Canonical feature list shared across all plans.
 * Each plan specifies which features are included.
 *
 * Placeholder copy for the generated app's own product — deliberately generic
 * application capabilities, not infrastructure claims. Replace with your own.
 */
const allFeatures = [
  'Full app and API access',
  'Email and OAuth sign-in',
  'Community support',
  'Unlimited projects',
  'Advanced analytics',
  'Priority support',
  'Roles and permissions',
  'SSO and audit logs',
  'Dedicated support',
] as const;

function buildFeatures(included: string[]): PlanFeature[] {
  return allFeatures.map((text) => ({
    text,
    included: included.includes(text),
  }));
}

// Display names and prices mirror the homepage pricing section
// (src/client/components/sections/pricing.tsx) so the two surfaces agree. The
// `id`s stay free/starter/pro: they are wired into billing (planIdFromPriceId,
// requirePlan, PlanGate) and into persisted org.plan values, so they are keys,
// not copy. Rename the display names freely; leave the ids alone.
const basePlans: Plan[] = [
  {
    id: 'free',
    name: 'Starter',
    description: 'For side projects and early prototypes.',
    price: { monthly: 0 },
    features: buildFeatures([
      'Full app and API access',
      'Email and OAuth sign-in',
      'Community support',
    ]),
    limits: {
      members: 0, // unlimited
      organizations: 0, // unlimited
      apiRequestsPerMinute: 60,
    },
  },
  {
    id: 'starter',
    name: 'Pro',
    description: 'For products with paying customers.',
    price: { monthly: 2900 },
    features: buildFeatures([
      'Full app and API access',
      'Email and OAuth sign-in',
      'Community support',
      'Unlimited projects',
      'Advanced analytics',
      'Priority support',
    ]),
    limits: {
      members: 0, // unlimited
      organizations: 0, // unlimited
      apiRequestsPerMinute: 200,
    },
    popular: true,
  },
  {
    id: 'pro',
    name: 'Team',
    description: 'For teams shipping together.',
    price: { monthly: 9900 },
    features: buildFeatures([
      'Full app and API access',
      'Email and OAuth sign-in',
      'Community support',
      'Unlimited projects',
      'Advanced analytics',
      'Priority support',
      'Roles and permissions',
      'SSO and audit logs',
      'Dedicated support',
    ]),
    limits: {
      members: 0, // unlimited
      organizations: 0, // unlimited
      apiRequestsPerMinute: 1000,
    },
  },
];

/**
 * The template's generic demo plans (Starter/Pro/Team). Used as the fallback on
 * the pricing surface when no provider catalog has been configured — which is
 * what a freshly generated app renders, since billing-catalog ships `tiers: []`.
 */
export const plans: Plan[] = basePlans;

export function getPlan(planId: PlanId): Plan | undefined {
  return plans.find((p) => p.id === planId);
}

/**
 * The activated provider products (price-sorted), synced by `vibecarbon configure`
 * → Payments. When non-empty, these drive the public pricing surface instead of
 * the generic demo `plans`. Sorted defensively by amount in case the snapshot isn't.
 */
export const catalogTiers: CatalogTier[] = [...billingCatalog.tiers].sort(
  (a, b) => a.amount - b.amount
);

/**
 * Map an activated catalog product to its bespoke design slot by name (the
 * allotrope tiers are stable). Returns '' for an unrecognized product, which
 * falls back to default styling.
 */
export function designSlugFromName(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('graphite')) return 'graphite';
  if (n.includes('fullerene')) return 'fullerene';
  if (n.includes('agency')) return 'agency';
  return '';
}

function priceSuffix(interval: CatalogTier['interval'], type: CatalogTier['type']): string {
  if (type === 'one_time' || interval === 'one_time') return '';
  if (interval === 'year') return '/yr';
  return '/mo';
}

function formatAmount(amount: number, currency: string): string {
  const value = amount / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

/** Currency- and interval-aware price label for an activated catalog tier. */
export function formatTierPrice(tier: CatalogTier): string {
  if (tier.amount === 0) return 'Free';
  return `${formatAmount(tier.amount, tier.currency)}${priceSuffix(tier.interval, tier.type)}`;
}

/** Currency- and interval-aware price label for a demo plan. */
export function formatPlanPrice(plan: Plan): string {
  const cents = plan.price.monthly;
  if (cents === 0) return 'Free';
  return `${formatAmount(cents, plan.currency ?? 'usd')}${priceSuffix(plan.interval ?? 'month', plan.type ?? 'recurring')}`;
}

export function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(0)}/mo`;
}

/**
 * Map a provider price ID back to a plan ID.
 * Works with any billing provider (Stripe, Paddle, Polar).
 * Used by webhook handlers and subscription queries.
 */
export function planIdFromPriceId(
  priceId: string,
  priceIds: { starter?: string; pro?: string }
): PlanId {
  if (priceId === priceIds.starter) return 'starter';
  if (priceId === priceIds.pro) return 'pro';
  return 'free';
}

/**
 * Map Stripe price ID back to a plan ID.
 * @deprecated Use planIdFromPriceId instead. Kept for backward compatibility.
 */
export function planIdFromStripePriceId(
  stripePriceId: string,
  envPriceIds: { starter?: string; pro?: string }
): PlanId {
  return planIdFromPriceId(stripePriceId, envPriceIds);
}
