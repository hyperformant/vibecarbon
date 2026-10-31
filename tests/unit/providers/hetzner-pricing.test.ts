/**
 * Hetzner prices are in the account's billing currency: `/v1/server_types`
 * states none, `/v1/pricing` states it (`pricing.currency`) along with the
 * billed primary IPv4 per location (`pricing.primary_ips`, type ipv4).
 * `fetchServerTypes` reads `/v1/pricing` alongside the catalog walk, and
 * `parsePricing` turns it into `_currency` (a symbol) and `_ipv4Monthly`
 * (net per location). A failed pricing call never fails the catalog: the
 * static `CURRENCY` and `IPV4_MONTHLY` stand.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { cheapestRoleSet, formatMonthly, ipv4MonthlyAt } from '../../../src/lib/sizing.js';
import { readCatalogFixture, withHetznerPricing } from '../helpers/catalog-fixtures.js';

// biome-ignore lint/suspicious/noExplicitAny: statics the live fetch replaces
const H = HetznerProvider as any;
const KEYS = ['SERVER_TYPES', '_locationTypes', '_prices', '_currency', '_ipv4Monthly'];
const saved = KEYS.map((k) => [k, Object.hasOwn(H, k), H[k]] as const);

afterEach(() => {
  for (const [k, owned, v] of saved) {
    if (owned) H[k] = v;
    else delete H[k];
  }
  vi.unstubAllGlobals();
});

const EUR = readCatalogFixture('hetzner-pricing-eur');

describe('HetznerProvider.parsePricing', () => {
  it('reads the currency symbol and the IPv4 net per location', () => {
    expect(HetznerProvider.parsePricing(EUR)).toEqual({
      currency: '€',
      ipv4Monthly: { fsn1: 0.5, nbg1: 0.5, hel1: 0.5, ash: 0.55, hil: 0.55 },
    });
  });

  it('USD is $; any other code is the code and a space', () => {
    expect(HetznerProvider.parsePricing({ pricing: { currency: 'USD' } }).currency).toBe('$');
    expect(HetznerProvider.parsePricing({ pricing: { currency: 'CHF' } }).currency).toBe('CHF ');
  });

  it('only the ipv4 entry counts, and an unparseable price is skipped', () => {
    const out = HetznerProvider.parsePricing({
      pricing: {
        currency: 'EUR',
        primary_ips: [
          { type: 'ipv6', prices: [{ location: 'fsn1', price_monthly: { net: '9' } }] },
          {
            type: 'ipv4',
            prices: [
              { location: 'fsn1', price_monthly: { net: 'n/a' } },
              { location: 'nbg1', price_monthly: { net: '0.5' } },
            ],
          },
        ],
      },
    });
    expect(out.ipv4Monthly).toEqual({ nbg1: 0.5 });
  });

  it('a payload without pricing gives nothing, so the statics stand', () => {
    for (const payload of [null, undefined, {}, { pricing: {} }, 'oops']) {
      expect(HetznerProvider.parsePricing(payload)).toEqual({ currency: null, ipv4Monthly: null });
    }
  });
});

describe('HetznerProvider.fetchServerTypes reads /v1/pricing', () => {
  const flux = readCatalogFixture('flux-hetzner-cx23-hel1');
  const catalogFetch = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ server_types: flux.server_types, meta: { pagination: {} } }),
    }));

  it('a EUR account gets EUR labels and the EUR IPv4 addend', async () => {
    H._locationTypes = null;
    const stub = vi.fn(withHetznerPricing(catalogFetch(), EUR));
    vi.stubGlobal('fetch', stub);
    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);
    const pricingCall = stub.mock.calls.find(([url]) => String(url).endsWith('/v1/pricing'));
    expect(pricingCall?.[0]).toBe('https://api.hetzner.cloud/v1/pricing');
    expect(pricingCall?.[1]).toMatchObject({ headers: { Authorization: 'Bearer tok' } });
    expect(H._currency).toBe('€');
    expect(ipv4MonthlyAt(HetznerProvider, 'hel1')).toBe(0.5);
    const hel1 = cheapestRoleSet(HetznerProvider, 'hel1', ['compose']);
    expect(hel1?.monthly).toBe(6.99); // cx23 6.49 + 0.50
    expect(formatMonthly(HetznerProvider, hel1?.monthly as number)).toBe('€6.99');
  });

  it('a failed pricing call keeps $ and 0.6, and the catalog still loads', async () => {
    H._locationTypes = null;
    vi.stubGlobal('fetch', withHetznerPricing(catalogFetch()));
    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);
    expect(H._currency).toBeNull();
    expect(ipv4MonthlyAt(HetznerProvider, 'hel1')).toBe(0.6);
    expect(cheapestRoleSet(HetznerProvider, 'hel1', ['compose'])?.monthly).toBe(7.09);
    expect(formatMonthly(HetznerProvider, 7.09)).toBe('$7.09');
  });

  it('a pricing call that throws keeps the statics too', async () => {
    H._locationTypes = null;
    const catalog = catalogFetch();
    vi.stubGlobal('fetch', async (url: unknown, init: unknown) => {
      if (String(url).endsWith('/v1/pricing')) throw new Error('boom');
      return catalog(url, init);
    });
    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(true);
    expect(H._currency).toBeNull();
    expect(H._ipv4Monthly).toBeNull();
  });

  it('a failed catalog walk records no pricing', async () => {
    H._locationTypes = null;
    H._currency = null;
    vi.stubGlobal(
      'fetch',
      withHetznerPricing(
        vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
        EUR,
      ),
    );
    expect(await HetznerProvider.fetchServerTypes('tok')).toBe(false);
    expect(H._currency).toBeNull();
  });
});
