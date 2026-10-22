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
 * @param {Record<string, number>} [minRamGb] - a higher floor for some roles
 *   (a standby never smaller than its primary); ROLE_MIN_RAM_GB otherwise
 * @returns {{types: Record<string, string>, monthly: number|null}|null}
 *   null when any role has no orderable candidate
 */
export function cheapestRoleSet(Provider, location, roles, minRamGb = {}) {
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
      minRamGb: minRamGb[role] ?? ROLE_MIN_RAM_GB[role],
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
 * What a standby places in `region` for `role` when `region` does not sell
 * `type`, the primary's type: the role's cheapest orderable candidate there
 * with at least the RAM of `type` (and never under the role's floor), so a
 * standby is never smaller than the node it stands in for. With no `role`,
 * the RAM tier names it: the db role for a type at or under the db floor,
 * else compose. A provider without candidates for the role (compose-only)
 * picks from its compose candidates.
 *
 * Null when nothing fits: the caller refuses by name (the deploy wizard,
 * ruling B6), never an unstocked type the create would fail on.
 *
 * @param {object} Provider - a provider class
 * @param {string} type
 * @param {string} region
 * @param {string} [role] - compose, master, db or worker
 * @returns {string|null}
 */
export function standbyStandIn(Provider, type, region, role) {
  const ram = Provider.SERVER_TYPES[type]?.ram;
  let pickRole = role ?? (typeof ram === 'number' && ram <= ROLE_MIN_RAM_GB.db ? 'db' : 'compose');
  if (!Provider.ROLE_CANDIDATES?.[pickRole]) pickRole = 'compose';
  const minRam = Math.max(ROLE_MIN_RAM_GB[pickRole], typeof ram === 'number' ? ram : 0);
  return (
    cheapestRoleSet(Provider, region, [pickRole], { [pickRole]: minRam })?.types[pickRole] ?? null
  );
}

/**
 * A provider's `getDefaultStandbyRegion(primaryRegion, roles, primaryTypes)`:
 * the cheapest same-continent partner of `primaryRegion` (never the primary
 * itself) where every role in `roles` can be placed, priced as
 * `rankStandbyLocations` does. With the primary's types, a partner must fit
 * them without shrinking (a cpx32 primary pairs where cpx32 is stocked).
 * Ties keep `conventional` (the provider's static pair) first, then
 * `REGION_CONTINENT` order. `conventional` stands when no catalog is loaded
 * or no partner qualifies; the deploy wizard then refuses at type resolution.
 *
 * @param {object} Provider - a provider class
 * @param {string} primaryRegion
 * @param {string[]} roles - ['compose'], or ['master', 'db'] for a k8s-ha
 *   pilot-light standby (it has no worker)
 * @param {string} conventional - the static pair for `primaryRegion`
 * @param {Record<string, string|undefined>} [primaryTypes] - by role
 * @returns {string}
 */
export function cheapestStandbyRegion(
  Provider,
  primaryRegion,
  roles,
  conventional,
  primaryTypes = {},
) {
  if (!Provider._locationTypes) return conventional;
  const continentOf = Provider.REGION_CONTINENT ?? {};
  const continent = continentOf[primaryRegion];
  const partners = [...new Set([conventional, ...Object.keys(continentOf)])].filter(
    (r) => r !== primaryRegion && continent && continentOf[r] === continent,
  );
  return rankStandbyLocations(Provider, partners, roles, primaryTypes)[0]?.location ?? conventional;
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
  return rankSets(locations, (location) => cheapestRoleSet(Provider, location, roles));
}

/**
 * `rankLocationsByPrice` for a standby: each role is what the standby would
 * place at the location, `Provider.resolveServerTypeForRegion(primaryType,
 * location, role)` (the primary's type where stocked, else the role's pick of
 * at least its RAM), or the role's plain pick when no primary type is given.
 * Locations where any role resolves to nothing are left out, so a primary
 * bigger than every candidate only ranks locations that stock its type.
 *
 * @param {object} Provider - a provider class
 * @param {string[]} locations
 * @param {string[]} roles
 * @param {Record<string, string|undefined>} [primaryTypes] - by role
 * @returns {Array<{location: string, monthly: number|null, types: Record<string, string>}>}
 */
export function rankStandbyLocations(Provider, locations, roles, primaryTypes = {}) {
  return rankSets(locations, (location) => {
    const { priceFor } = catalogFor(Provider, location);
    const types = {};
    let monthly = typeof Provider.IPV4_MONTHLY === 'number' ? 0 : null;
    for (const role of roles) {
      const primary = primaryTypes[role];
      const type = primary
        ? Provider.resolveServerTypeForRegion(primary, location, role)
        : (cheapestRoleSet(Provider, location, [role])?.types[role] ?? null);
      if (!type) return null;
      types[role] = type;
      const price = priceFor(type, location);
      monthly = monthly === null || price === null ? null : monthly + price + Provider.IPV4_MONTHLY;
    }
    return { types, monthly: monthly === null ? null : Math.round(monthly * 100) / 100 };
  });
}

/** Rank `setAt(location)` results cheapest first; see rankLocationsByPrice. */
function rankSets(locations, setAt) {
  const ranked = [];
  for (const location of locations) {
    const set = setAt(location);
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
