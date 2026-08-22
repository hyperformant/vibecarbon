/**
 * Tests for src/lib/billing/stripe-catalog.js::listStripePrices.
 *
 * listStripePrices calls the global fetch (via fetchWithRetry) against
 * Stripe's /v1/prices, so we stub globalThis.fetch and assert it normalizes a
 * representative response (recurring monthly, recurring yearly, one-time) and
 * throws on a 401 invalid-key body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAmount, listStripePrices } from '../../../src/lib/billing/stripe-catalog.js';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('listStripePrices', () => {
  it('normalizes prices (incl. marketing_features) and sorts by amount ascending', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        object: 'list',
        has_more: false,
        // Intentionally out of price order — listStripePrices must sort ascending.
        data: [
          {
            id: 'price_onetime',
            currency: 'usd',
            unit_amount: 4900,
            recurring: null,
            product: { name: 'Workbench' },
          },
          {
            id: 'price_monthly',
            currency: 'usd',
            unit_amount: 1900,
            nickname: 'monthly-nick',
            recurring: { interval: 'month' },
            product: {
              name: 'Startup',
              description: 'For small teams',
              marketing_features: [{ name: 'A' }, { name: 'B' }],
            },
          },
          {
            id: 'price_yearly',
            currency: 'eur',
            unit_amount: 19000,
            recurring: { interval: 'year' },
            product: { name: 'Pro', description: null },
          },
        ],
      }),
    );

    const prices = await listStripePrices('sk_test_abc');

    // Calls Stripe's prices endpoint with the literal expand[] param and the
    // secret in the Authorization header.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('https://api.stripe.com/v1/prices');
    expect(String(url)).toContain('expand[]=data.product');
    expect(init.headers.Authorization).toBe('Bearer sk_test_abc');

    // Sorted by amount ascending: 1900, 4900, 19000.
    expect(prices.map((pr) => pr.amount)).toEqual([1900, 4900, 19000]);

    expect(prices).toEqual([
      {
        priceId: 'price_monthly',
        name: 'Startup',
        description: 'For small teams',
        features: ['A', 'B'],
        amount: 1900,
        currency: 'usd',
        interval: 'month',
        type: 'recurring',
      },
      {
        priceId: 'price_onetime',
        name: 'Workbench',
        description: null,
        features: [],
        amount: 4900,
        currency: 'usd',
        interval: 'one_time',
        type: 'one_time',
      },
      {
        priceId: 'price_yearly',
        name: 'Pro',
        description: null,
        features: [],
        amount: 19000,
        currency: 'eur',
        interval: 'year',
        type: 'recurring',
      },
    ]);
  });

  it('falls back to nickname then id when the product has no name', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'price_nick',
            currency: 'usd',
            unit_amount: 500,
            nickname: 'My Nickname',
            recurring: { interval: 'month' },
            product: {},
          },
          {
            id: 'price_bare',
            currency: 'usd',
            unit_amount: 700,
            recurring: { interval: 'month' },
          },
        ],
      }),
    );

    const prices = await listStripePrices('sk_test_abc');
    // Sorted by amount: price_nick (500) before price_bare (700).
    expect(prices[0].name).toBe('My Nickname');
    expect(prices[1].name).toBe('price_bare');
  });

  it('coerces non month/year recurring intervals to month', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'price_weekly',
            currency: 'usd',
            unit_amount: 300,
            recurring: { interval: 'week' },
            product: { name: 'Weekly' },
          },
        ],
      }),
    );

    const prices = await listStripePrices('sk_test_abc');
    expect(prices[0].interval).toBe('month');
    expect(prices[0].type).toBe('recurring');
  });

  it('skips metered prices with a null unit_amount', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'price_metered',
            currency: 'usd',
            unit_amount: null,
            recurring: { interval: 'month', usage_type: 'metered' },
            product: { name: 'Metered' },
          },
          {
            id: 'price_fixed',
            currency: 'usd',
            unit_amount: 1000,
            recurring: { interval: 'month' },
            product: { name: 'Fixed' },
          },
        ],
      }),
    );

    const prices = await listStripePrices('sk_test_abc');
    expect(prices).toHaveLength(1);
    expect(prices[0].priceId).toBe('price_fixed');
  });

  it('throws with the Stripe error message on a 401 body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            type: 'invalid_request_error',
            message: 'Invalid API Key provided: sk_test_***',
          },
        },
        401,
      ),
    );

    await expect(listStripePrices('sk_test_bad')).rejects.toThrow(/Invalid API Key provided/);
  });

  it('returns an empty array when Stripe has no prices', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const prices = await listStripePrices('sk_test_abc');
    expect(prices).toEqual([]);
  });
});

describe('formatAmount', () => {
  it('renders cents as a currency string', () => {
    expect(formatAmount(1900, 'usd')).toBe('$19.00');
  });

  it('falls back to major-unit + code for an invalid currency code', () => {
    // Intl rejects non-3-letter currency codes; the fallback renders the
    // major-unit amount plus the upper-cased code rather than throwing.
    expect(formatAmount(1900, 'bogus')).toBe('19.00 BOGUS');
  });
});
