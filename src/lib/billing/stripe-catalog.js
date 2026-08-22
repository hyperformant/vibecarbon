/**
 * Stripe catalog fetch — pulls the customer's live products + prices so
 * `vibecarbon configure` (Billing → Stripe) can let them pick which products to
 * activate and snapshot the display fields into the project.
 *
 * Contains NO secrets in its output — product names, amounts, and price IDs are
 * all public. The secret key only ever travels in the Authorization header of
 * the live API call; it is never persisted by this module.
 */

import { fetchWithRetry } from '../fetch-retry.js';

/**
 * @typedef {Object} NormalizedPrice
 * @property {string} priceId             Stripe price id (`price_...`).
 * @property {string} name                Expanded product name (falls back to nickname/id).
 * @property {string | null} description  Expanded product description.
 * @property {string[]} features          Product marketing features (names).
 * @property {number} amount              Smallest currency unit (cents).
 * @property {string} currency            Lowercase ISO 4217 (e.g. `usd`).
 * @property {'month' | 'year' | 'one_time'} interval
 * @property {'recurring' | 'one_time'} type
 */

/**
 * Format a smallest-unit amount + currency for human-readable select labels,
 * e.g. (1900, 'usd') -> "$19.00". Falls back to a generic "<major> <CODE>"
 * form for currencies Intl doesn't render with a symbol.
 *
 * @param {number} amount   Smallest currency unit (cents).
 * @param {string} currency Lowercase ISO 4217 code.
 * @returns {string}
 */
export function formatAmount(amount, currency) {
  const code = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).format(amount / 100);
  } catch {
    // Unknown / unsupported currency code — render the major-unit number plainly.
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
}

/**
 * Normalize a raw Stripe price object (with `product` expanded) into the shape
 * our billing catalog stores. Returns null for prices we can't represent
 * (metered / null `unit_amount`) so the caller can skip them.
 *
 * @param {any} price
 * @returns {NormalizedPrice | null}
 */
function normalizePrice(price) {
  if (!price || typeof price !== 'object') return null;
  // Metered prices have a null unit_amount — we can't display a fixed amount,
  // so skip them rather than emit a bogus 0.
  if (price.unit_amount === null || price.unit_amount === undefined) return null;

  const product = price.product && typeof price.product === 'object' ? price.product : null;
  const name = product?.name || price.nickname || price.id;
  const description = product?.description ?? null;
  // Stripe product marketing_features is an array of { name }; flatten to the
  // feature strings, dropping any with an empty/missing name.
  const features = Array.isArray(product?.marketing_features)
    ? product.marketing_features.map((f) => f?.name).filter(Boolean)
    : [];

  const recurring = price.recurring && typeof price.recurring === 'object' ? price.recurring : null;
  // Our catalog type only allows month/year/one_time. Use the Stripe interval
  // when it's month or year; for any other recurring interval (week/day) fall
  // back to a safe 'month' default; non-recurring prices are one_time.
  let interval;
  if (recurring) {
    interval =
      recurring.interval === 'month' || recurring.interval === 'year'
        ? recurring.interval
        : 'month';
  } else {
    interval = 'one_time';
  }

  return {
    priceId: price.id,
    name,
    description,
    features,
    amount: price.unit_amount,
    currency: price.currency,
    interval,
    type: recurring ? 'recurring' : 'one_time',
  };
}

/**
 * Fetch the customer's active Stripe prices (with products expanded),
 * normalize them, and return them sorted by amount ascending.
 *
 * Single page (limit=100) — fine for MVP. If Stripe reports `has_more`, we log
 * a note but don't paginate; a customer with >100 active prices is well past
 * the activate-products use case this serves.
 *
 * @param {string} secretKey Stripe secret key (`sk_test_...` / `sk_live_...`).
 * @returns {Promise<NormalizedPrice[]>} Sorted by amount ascending.
 * @throws {Error} on non-OK response (e.g. 401 invalid key) so the caller can
 *   warn and skip catalog writing.
 */
export async function listStripePrices(secretKey) {
  // Stripe wants form-encoded query params; `expand[]=data.product` must be
  // sent literally (URLSearchParams would percent-encode the brackets, which
  // Stripe rejects), so build the query string by hand.
  const url = 'https://api.stripe.com/v1/prices?active=true&limit=100&expand[]=data.product';

  const response = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
    label: 'stripe prices',
  });

  if (!response.ok) {
    // Surface Stripe's own error message when present — its body is
    // { error: { message, type, ... } } for auth/validation failures.
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error?.message) detail = body.error.message;
    } catch {
      // Non-JSON body (rare) — keep the status-code detail.
    }
    throw new Error(`Stripe price fetch failed: ${detail}`);
  }

  const body = await response.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  const prices = [];
  for (const price of rows) {
    const normalized = normalizePrice(price);
    if (normalized) prices.push(normalized);
  }

  if (body?.has_more) {
    console.error(
      '[stripe] more than 100 active prices exist; only the first page was loaded. Activation uses this page.',
    );
  }

  // Sort by amount ascending so the activate multiselect and the snapshot both
  // present cheapest-first (free tiers, then paid).
  prices.sort((a, b) => a.amount - b.amount);

  return prices;
}
