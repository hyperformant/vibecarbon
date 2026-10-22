/**
 * Default server sizes: for each role a deploy places, the cheapest server
 * that is orderable in the target location right now and fits the measured
 * load.
 *
 * Each provider declares the x86 types it will use per role
 * (`ROLE_CANDIDATES`, declared order = offline order, most reliably stocked
 * first), caches live prices from the catalog fetch it already makes
 * (`priceFor(type, location)`), and states its billed IPv4 per server
 * (`IPV4_MONTHLY`). This module is the one picker over those: it never calls a
 * provider API itself.
 */

import { filterAmd64Types } from './server-types.js';

/**
 * Minimum RAM per role, in GB: measured peak x 2, rounded up to the next RAM
 * tier providers sell, and compose never under COMPOSE_MIN_RAM_GB (4).
 *
 * Measured peaks (tests/results/e2e.db, metric_type = 'resource', lean stack,
 * Hetzner, observability add-on on, all recorded 2026-10-20, re-queried
 * 2026-10-22):
 *   - compose 1,101 MB; compose-ha 1,245 / 1,239 MB per node -> 4 (the compose floor)
 *   - k8s master 1,488 MB; k8s-ha primary master 1,559 MB    -> 2 x 1.56 = 3.12 -> 4
 *   - k8s db 636 MB; k8s-ha primary db 659 MB                -> 2 x 0.66 = 1.32 -> 2
 *   - k8s worker 1,050 MB                                    -> 2 x 1.05 = 2.10 -> 4
 *
 * Sources and the per-provider cost calculation:
 * docs/superpowers/plans/2026-10-20-cost-grid-sources.md (ruling P1 of
 * docs/superpowers/plans/2026-10-20-price-optimized-defaults.md). One table
 * for every provider, never hand-tuned per provider. A busier app outgrows
 * these; `vibecarbon scale -type` is the way up.
 */
export const ROLE_MIN_RAM_GB = Object.freeze({ compose: 4, master: 4, db: 2, worker: 4 });

/**
 * Pick the cheapest candidate for one role in one location.
 *
 * Keeps the candidates that are orderable, have at least `minRamGb` of RAM in
 * `catalog`, and are amd64 (`filterAmd64Types` on the catalog entry, and not
 * `isArm`). Sorts the survivors by `priceFor(type, location)`, ascending;
 * equal prices keep declared order, and unknown prices go after known ones,
 * in declared order. Offline, the caller passes the offline catalog, an
 * offline orderable set and a `priceFor` that returns null, so declared order
 * decides.
 *
 * @param {object} args
 * @param {string[]} args.candidates - declared order
 * @param {Record<string, {ram: number, architecture?: string}>} args.catalog
 * @param {Set<string>} args.orderable - types orderable in `location` now
 * @param {string} args.location
 * @param {(type: string, location: string) => number|null} args.priceFor
 * @param {(type: string) => boolean} args.isArm
 * @param {number} args.minRamGb
 * @returns {string|null} null when nothing survives
 */
export function pickRoleType({
  candidates,
  catalog,
  orderable,
  location,
  priceFor,
  isArm,
  minRamGb,
}) {
  const fitting = candidates
    .filter((t) => orderable.has(t) && catalog[t] && catalog[t].ram >= minRamGb && !isArm(t))
    .map((t) => ({ name: t, architecture: catalog[t].architecture }));
  const ranked = filterAmd64Types(fitting).map(({ name }, order) => ({
    name,
    order,
    price: priceFor(name, location) ?? null,
  }));
  ranked.sort((a, b) => {
    if (a.price !== null && b.price !== null && a.price !== b.price) return a.price - b.price;
    if ((a.price === null) !== (b.price === null)) return a.price === null ? 1 : -1;
    return a.order - b.order;
  });
  return ranked[0]?.name ?? null;
}

/**
 * The catalog and orderable set the picker reads for one location: the live
 * catalog when `fetchServerTypes` has loaded one, else the provider's offline
 * offer for that region (`getServerTypesForRegion`, which applies the
 * provider's offline region rule).
 */
function catalogFor(Provider, location) {
  if (Provider._locationTypes) {
    return {
      catalog: Provider.SERVER_TYPES,
      orderable: Provider._locationTypes[location] ?? new Set(),
      priceFor: (type, loc) => Provider.priceFor?.(type, loc) ?? null,
    };
  }
  const offered = Provider.getServerTypesForRegion(location);
  return {
    catalog: Object.fromEntries(offered.map((t) => [t.name, t])),
    orderable: new Set(offered.map((t) => t.name)),
    priceFor: () => null,
  };
}

/**
 * The cheapest type for each role in `location`, and what the set costs per
 * month: each pick's price plus `Provider.IPV4_MONTHLY` per server (one server
 * per role), rounded to cents at the end. `monthly` is null when any price,
 * or the IPv4 price, is unknown.
 *
 * @param {object} Provider - a provider class
 * @param {string} location
 * @param {string[]} roles - e.g. ['compose'] or ['master', 'db', 'worker']
 * @returns {{types: Record<string, string>, monthly: number|null}|null}
 *   null when any role has no orderable candidate
 */
export function cheapestRoleSet(Provider, location, roles) {
  const { catalog, orderable, priceFor } = catalogFor(Provider, location);
  const isArm = (type) => Provider.isArmServerType(type);
  const types = {};
  let monthly = typeof Provider.IPV4_MONTHLY === 'number' ? 0 : null;
  for (const role of roles) {
    const type = pickRoleType({
      candidates: Provider.ROLE_CANDIDATES?.[role] ?? [],
      catalog,
      orderable,
      location,
      priceFor,
      isArm,
      minRamGb: ROLE_MIN_RAM_GB[role],
    });
    if (!type) return null;
    types[role] = type;
    const price = priceFor(type, location);
    monthly = monthly === null || price === null ? null : monthly + price + Provider.IPV4_MONTHLY;
  }
  return { types, monthly: monthly === null ? null : Math.round(monthly * 100) / 100 };
}

/**
 * A provider's `getRegionDefaults(region)`: the cheapest fitting type per
 * role, each picked on its own (`cheapestRoleSet` with one role). A role
 * with nothing orderable is null; the caller refuses by name. A provider
 * without k8s candidates (compose-only) answers `composeType` for all four,
 * for interface parity.
 *
 * @param {object} Provider - a provider class
 * @param {string} region
 * @returns {{composeType: string|null, masterType: string|null, dbType: string|null, workerType: string|null}}
 */
export function regionRoleDefaults(Provider, region) {
  const pick = (role) => cheapestRoleSet(Provider, region, [role])?.types[role] ?? null;
  const composeType = pick('compose');
  if (!Provider.ROLE_CANDIDATES?.master) {
    return { composeType, masterType: composeType, dbType: composeType, workerType: composeType };
  }
  return {
    composeType,
    masterType: pick('master'),
    dbType: pick('db'),
    workerType: pick('worker'),
  };
}

/**
 * The region default of the same RAM tier as `type`, for a standby region
 * that does not sell `type`: the db pick (the 2 GB tier) for a type at or
 * under the db floor, else the compose pick (4 GB). Never shrinks a 4 GB
 * node to 2 GB. Falls back to `type` itself when the region has no such
 * default (the caller's create then names the refusal).
 *
 * @param {object} Provider - a provider class
 * @param {string} type
 * @param {string} region
 * @returns {string}
 */
export function sameTierRegionDefault(Provider, type, region) {
  const defaults = Provider.getRegionDefaults(region);
  const ram = Provider.SERVER_TYPES[type]?.ram;
  const pick =
    typeof ram === 'number' && ram <= ROLE_MIN_RAM_GB.db ? defaults.dbType : defaults.composeType;
  return pick ?? type;
}

/**
 * `cheapestRoleSet` for each location, cheapest first. Ties, and locations
 * with an unknown monthly (which go last), keep the order of `locations`.
 * Locations where any role is unorderable are left out.
 *
 * @param {object} Provider - a provider class
 * @param {string[]} locations
 * @param {string[]} roles
 * @returns {Array<{location: string, monthly: number|null, types: Record<string, string>}>}
 */
export function rankLocationsByPrice(Provider, locations, roles) {
  const ranked = [];
  for (const location of locations) {
    const set = cheapestRoleSet(Provider, location, roles);
    if (set) ranked.push({ location, monthly: set.monthly, types: set.types });
  }
  // Array.prototype.sort is stable, so equal keys keep the given order.
  return ranked.sort((a, b) => {
    if (a.monthly === null || b.monthly === null) {
      return (a.monthly === null) - (b.monthly === null);
    }
    return a.monthly - b.monthly;
  });
}
