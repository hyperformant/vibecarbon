import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HetznerProvider } from '../../../src/lib/providers/hetzner.js';
import { LinodeProvider } from '../../../src/lib/providers/linode.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';

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
 * The parse below mirrors each provider's `fetchServerTypes` filters, so a
 * seeded class answers `getServerTypesForRegion` / `getRegionDefaults` the way
 * the live path would. `_prices` follows the shape Task 2 of the
 * price-optimized defaults plan gives `fetchServerTypes`: per location for
 * Hetzner, Linode and Scaleway, flat for DigitalOcean and Vultr.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/catalogs');

// biome-ignore lint/suspicious/noExplicitAny: fixtures are untyped API JSON
type Json = any;
type Prices = Record<string, number | null | Record<string, number | null>>;
interface Seed {
  SERVER_TYPES: Record<string, Json>;
  _locationTypes: Record<string, Set<string>>;
  _prices: Prices;
  _typeArch?: Record<string, string>;
}

/** Read a fixture by name, e.g. `2026-10-22/hetzner` or `flux-hetzner-cx23-hel1`. */
export function readCatalogFixture(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

function addTo(locationTypes: Record<string, Set<string>>, location: string, type: string) {
  if (!locationTypes[location]) locationTypes[location] = new Set();
  locationTypes[location].add(type);
}

const PARSERS: Record<string, (fixture: Json) => Seed> = {
  hetzner(fixture) {
    const seed: Seed = { SERVER_TYPES: {}, _locationTypes: {}, _prices: {} };
    for (const t of fixture.server_types) {
      if (t.deprecation) continue;
      if (t.architecture === 'arm' || HetznerProvider.isArmServerType(t.name)) continue;
      for (const loc of t.locations) {
        if (HetznerProvider.isLocationOrderable(loc)) addTo(seed._locationTypes, loc.name, t.name);
      }
      seed.SERVER_TYPES[t.name] = {
        vcpu: t.cores,
        ram: t.memory,
        disk: t.disk,
        cpuType: t.cpu_type,
        architecture: t.architecture,
      };
      seed._prices[t.name] = Object.fromEntries(
        t.prices.map((p: Json) => [p.location, Number(p.price_monthly.net)]),
      );
    }
    return seed;
  },

  digitalocean(fixture) {
    const seed: Seed = { SERVER_TYPES: {}, _locationTypes: {}, _prices: {} };
    for (const s of fixture.sizes) {
      if (s.available === false) continue;
      seed.SERVER_TYPES[s.slug] = {
        vcpu: s.vcpus,
        ram: s.memory / 1024,
        disk: s.disk,
        regions: s.regions,
      };
      for (const region of s.regions) addTo(seed._locationTypes, region, s.slug);
      seed._prices[s.slug] = s.price_monthly ?? null;
    }
    return seed;
  },

  vultr(fixture) {
    const seed: Seed = { SERVER_TYPES: {}, _locationTypes: {}, _prices: {} };
    for (const plan of fixture.plans) {
      seed.SERVER_TYPES[plan.id] = { vcpu: plan.vcpu_count, ram: plan.ram / 1024, disk: plan.disk };
      for (const region of plan.locations) addTo(seed._locationTypes, region, plan.id);
      seed._prices[plan.id] = plan.monthly_cost ?? null;
    }
    return seed;
  },

  linode(fixture) {
    const seed: Seed = { SERVER_TYPES: {}, _locationTypes: {}, _prices: {} };
    for (const t of fixture.data) {
      if (t.class === 'gpu' || t.class === 'accelerated') continue;
      seed.SERVER_TYPES[t.id] = { vcpu: t.vcpus, ram: t.memory / 1024, disk: t.disk / 1024 };
      const overrides = Object.fromEntries(t.region_prices.map((r: Json) => [r.id, r.monthly]));
      seed._prices[t.id] = Object.fromEntries(
        Object.keys(LinodeProvider.REGIONS).map((region) => [
          region,
          overrides[region] ?? t.price.monthly ?? null,
        ]),
      );
    }
    const all = new Set(Object.keys(seed.SERVER_TYPES));
    for (const region of Object.keys(LinodeProvider.REGIONS)) seed._locationTypes[region] = all;
    return seed;
  },

  scaleway(fixture) {
    const seed: Seed = { SERVER_TYPES: {}, _locationTypes: {}, _prices: {}, _typeArch: {} };
    for (const [zone, { servers, availability }] of Object.entries<Json>(fixture.zones)) {
      for (const [name, spec] of Object.entries<Json>(servers)) {
        if (spec.arch) seed._typeArch[name.toUpperCase()] = spec.arch;
        if (spec.arch !== 'x86_64' || spec.end_of_service) continue;
        seed.SERVER_TYPES[name] = {
          vcpu: spec.ncpus,
          ram: spec.ram / 2 ** 30,
          disk:
            Math.round((spec.volumes_constraint?.max_size ?? 0) / 1e9) ||
            ScalewayProvider.COMPOSE_ROOT_VOLUME_GB,
        };
        // `shortage` cannot be placed; `scarce` still can (plan P6).
        if (availability[name] !== 'shortage') addTo(seed._locationTypes, zone, name);
        seed._prices[name] = {
          ...(seed._prices[name] as Record<string, number | null>),
          [zone]: spec.monthly_price ?? null,
        };
      }
    }
    return seed;
  },
};

const SEEDED_KEYS = ['SERVER_TYPES', '_locationTypes', '_prices', '_typeArch'] as const;

/**
 * Seed `Provider` with a catalog fixture: sets `SERVER_TYPES`,
 * `_locationTypes` and `_prices` (and Scaleway's `_typeArch`). Returns a
 * restore function for `afterEach`, which puts back exactly what was there
 * (deleting a key the class did not own before).
 *
 * `options.drop` removes types from given locations' orderable sets, for a
 * stock-out case: `{ drop: { nbg1: ['cpx22'] } }`.
 */
export function seedCatalog(
  // biome-ignore lint/suspicious/noExplicitAny: any provider class, or a stub shaped like one
  Provider: any,
  fixtureName: string,
  options: { drop?: Record<string, string[]> } = {},
): () => void {
  const fixture = readCatalogFixture(fixtureName);
  const parse = PARSERS[fixture.provider];
  if (!parse) throw new Error(`catalog fixture ${fixtureName} names no known provider`);
  const seed = parse(fixture);

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
