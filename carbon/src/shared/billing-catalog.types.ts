/**
 * Type definitions for the billing-catalog snapshot. Kept separate from the
 * generated data file (`billing-catalog.ts`) so `vibecarbon configure` can
 * regenerate the data without touching these stable types.
 *
 * The catalog is a price-sorted list of the products the operator activated in
 * their provider (via `vibecarbon configure` → Payments). Each activated product
 * becomes a tier shown on the public pricing surface. The template's generic
 * free/starter/pro demo (in `pricing.ts`) is separate and used when the catalog
 * is empty.
 */

export interface CatalogTier {
  /** Provider price ID (e.g. Stripe `price_...`). */
  priceId: string;
  /** Product name — the tier's display name. */
  name: string;
  description: string | null;
  /** Feature bullets, from the product's provider "marketing features". */
  features: string[];
  /** Amount in the currency's smallest unit (e.g. cents). 0 = free. */
  amount: number;
  /** ISO 4217 currency code, lowercase (e.g. `usd`). */
  currency: string;
  interval: 'month' | 'year' | 'one_time';
  type: 'recurring' | 'one_time';
}

export interface BillingCatalog {
  provider: 'stripe' | 'paddle' | 'polar' | null;
  /** ISO 8601 timestamp of the last `vibecarbon configure` snapshot. */
  generatedAt: string | null;
  /** Activated tiers, sorted by `amount` ascending. */
  tiers: CatalogTier[];
}
