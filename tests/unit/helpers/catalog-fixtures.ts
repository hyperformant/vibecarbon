import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProviderClass } from '../../../src/lib/providers/index.js';

/**
 * Dated provider catalogs for unit tests, and a loader that seeds a provider
 * class with one as if `fetchServerTypes` had just read it.
 *
 * The fixtures under tests/unit/fixtures/catalogs/ are the provider API
 * payloads `fetchServerTypes` reads, captured on 2026-10-22 and trimmed to the
 * fields it uses (specs, architecture, per-location availability and the
 * monthly price). They are public catalog data with no account identifiers.
 * `flux-hetzner-cx23-hel1` is synthetic: the 2026-10-22 Hetzner catalog with
 * `cx23` set orderable in hel1 only, the shape Hetzner showed on 2026-10-20.
 *
 * The loader hands the fixture's payload to the provider's own
 * `parseCatalog`, the pure step `fetchServerTypes` runs on what it walked, so
 * a seeded class answers exactly as the live path would and a filter change
 * in the provider reaches these tests with no copy to keep in step.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/catalogs');

// biome-ignore lint/suspicious/noExplicitAny: fixtures are untyped API JSON
type Json = any;

/** Read a fixture by name, e.g. `2026-10-22/hetzner` or `flux-hetzner-cx23-hel1`. */
export function readCatalogFixture(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

/**
 * Where each provider's fixture keeps the payload `parseCatalog` takes: the
 * walked collection (Hetzner `server_types`, DigitalOcean `sizes`, Vultr
 * `plans`, Linode `data`), or Scaleway's per-zone `{servers, availability}`.
 */
const PAYLOAD_KEY: Record<string, string> = {
  hetzner: 'server_types',
  digitalocean: 'sizes',
  vultr: 'plans',
  linode: 'data',
  scaleway: 'zones',
};

const SEEDED_KEYS = [
  'SERVER_TYPES',
  '_locationTypes',
  '_prices',
  '_typeArch',
  '_currency',
  '_ipv4Monthly',
] as const;

/**
 * Seed `Provider` with a catalog fixture: sets `SERVER_TYPES`,
 * `_locationTypes` and `_prices` (and Scaleway's `_typeArch`), and clears
 * the live pricing (`_currency`, `_ipv4Monthly`) so a seed never inherits
 * another test's. Returns a restore function for `afterEach`, which puts
 * back exactly what was there (deleting a key the class did not own before).
 *
 * `options.drop` removes types from given locations' orderable sets, for a
 * stock-out case: `{ drop: { nbg1: ['cpx22'] } }`.
 * `options.prices` overrides monthly prices: `{ cpx22: { nbg1: 60 } }`.
 * `options.pricing` names a Hetzner `/v1/pricing` fixture to read through
 * `parsePricing`, as the live fetch does: `{ pricing: 'hetzner-pricing-eur' }`.
 */
export function seedCatalog(
  // biome-ignore lint/suspicious/noExplicitAny: any provider class, or a stub shaped like one
  Provider: any,
  fixtureName: string,
  options: {
    drop?: Record<string, string[]>;
    prices?: Record<string, Record<string, number>>;
    pricing?: string;
  } = {},
): () => void {
  const fixture = readCatalogFixture(fixtureName);
  const key = PAYLOAD_KEY[fixture.provider];
  if (!key) throw new Error(`catalog fixture ${fixtureName} names no known provider`);
  const ProviderClass = getProviderClass(fixture.provider);
  const seed = {
    ...ProviderClass.parseCatalog(fixture[key]),
    _currency: null,
    _ipv4Monthly: null,
  };
  if (options.pricing) {
    const { currency, ipv4Monthly } = ProviderClass.parsePricing(
      readCatalogFixture(options.pricing),
    );
    seed._currency = currency;
    seed._ipv4Monthly = ipv4Monthly;
  }
  for (const [type, byLocation] of Object.entries(options.prices ?? {})) {
    seed._prices[type] = { ...seed._prices[type], ...byLocation };
  }

  for (const [location, types] of Object.entries(options.drop ?? {})) {
    const kept = new Set(seed._locationTypes[location]);
    for (const t of types) kept.delete(t);
    seed._locationTypes[location] = kept;
  }

  const saved = SEEDED_KEYS.map((key) => [key, Object.hasOwn(Provider, key), Provider[key]]);
  for (const key of SEEDED_KEYS) if (key in seed) Provider[key] = seed[key];

  return () => {
    for (const [key, owned, value] of saved) {
      if (owned) Provider[key as string] = value;
      else delete Provider[key as string];
    }
  };
}

/**
 * A `fetch` stub for `HetznerProvider.fetchServerTypes`, which asks for
 * `/v1/pricing` alongside the `/v1/server_types` walk: pricing requests get
 * `pricing` (a 404 when omitted, so the static currency and IPv4 price
 * stand), and every other request goes to `catalogFetch`, so a test's
 * call-order expectations on it see only the catalog walk.
 */
export function withHetznerPricing(
  // biome-ignore lint/suspicious/noExplicitAny: a vi.fn or any fetch-shaped stub
  catalogFetch: (...args: any[]) => any,
  pricing?: Json,
) {
  return async (url: unknown, init?: unknown) => {
    if (String(url).endsWith('/v1/pricing')) {
      return pricing
        ? { ok: true, status: 200, json: async () => pricing }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    return catalogFetch(url, init);
  };
}
