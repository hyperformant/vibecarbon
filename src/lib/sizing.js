/**
 * Default server sizes: for each role a deploy places, the cheapest server
 * that is orderable in the target location right now and fits the measured
 * load.
 *
 * Each provider declares the x86 types it will use per role
 * (`ROLE_CANDIDATES`, declared order = offline order, most reliably stocked
 * first), caches live prices from the catalog fetch it already makes
 * (`priceFor(type, location)`), and states its billed IPv4 per server
 * (`IPV4_MONTHLY`, or the live `_ipv4Monthly` where its API states it). This
 * module is the one picker over those: it never calls a provider API itself.
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
 * month: each pick's price plus the billed IPv4 per server (`ipv4MonthlyAt`,
 * one server per role), rounded to cents at the end. `monthly` is null when any price,
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
  const ipv4 = ipv4MonthlyAt(Provider, location);
  let monthly = ipv4 === null ? null : 0;
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
    monthly = monthly === null || price === null ? null : monthly + price + ipv4;
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
 * Does the HA common-class rule apply? Only for a provider that declares
 * more than one CPU class, and only over a live catalog: offline there is no
 * per-location stock to intersect, so the single-region picks stand.
 */
function classRuleApplies(Provider) {
  return (Provider.CPU_CLASSES?.length ?? 0) > 1 && Boolean(Provider._locationTypes);
}

/**
 * The cheapest `role` candidate of CPU class `cpuClass` in `location`, with at
 * least `minRamGb` (pickRoleType over the candidates of that class), limited
 * to `onlyIn` when given (types orderable in the other location too).
 */
function pickInClass(Provider, location, role, cpuClass, minRamGb, onlyIn) {
  const { catalog, orderable, priceFor } = catalogFor(Provider, location);
  return pickRoleType({
    candidates: (Provider.ROLE_CANDIDATES?.[role] ?? []).filter(
      (t) => Provider.cpuClassOf(t) === cpuClass && (!onlyIn || onlyIn.has(t)),
    ),
    catalog,
    orderable,
    location,
    priceFor,
    isArm: (type) => Provider.isArmServerType(type),
    minRamGb,
  });
}

/**
 * The best-ranked class (CPU_CLASSES order, `first` ahead of the rest) that
 * has a fitting `role` candidate in `location`, and that candidate.
 */
function bestClassPick(Provider, location, role, minRamGb, first) {
  const order = Provider.CPU_CLASSES.includes(first)
    ? [first, ...Provider.CPU_CLASSES.filter((c) => c !== first)]
    : Provider.CPU_CLASSES;
  for (const cpuClass of order) {
    const type = pickInClass(Provider, location, role, cpuClass, minRamGb);
    if (type) return type;
  }
  return null;
}

/**
 * The default types for both sides of an HA deploy: one CPU class for both,
 * the best one (`Provider.CPU_CLASSES` order) that has a fitting candidate
 * for every role in both locations, at the RAM tier the single-region
 * defaults pick (ROLE_MIN_RAM_GB). Within that class each role takes the
 * cheapest type sold in both locations, so the two sides normally run the
 * very same type.
 *
 * When no class is common to both locations for every role, each side falls
 * back on its own: the primary takes its location's best class, and the
 * standby `haStandbyType` of it (the same class where sold, else its own best
 * class). `shared` is false then, and the caller warns.
 *
 * A provider with one class, or no live catalog, keeps today's picks: the
 * primary's single-region default per role and its standby resolution.
 *
 * Example (2026-10-22 stock): sfo3 sells -amd and -intel, tor1 -intel and
 * regular, so an sfo3 + tor1 pair runs -intel on both sides.
 *
 * @param {object} Provider - a provider class
 * @param {string} primaryRegion
 * @param {string} standbyRegion
 * @param {string[]} roles - e.g. ['compose'] or ['master', 'db', 'worker']
 * @returns {{primary: Record<string, string|null>, standby: Record<string, string|null>,
 *   cpuClass: string|null, shared: boolean}} a null type means nothing fits
 *   that role there (the caller refuses by name, as for the single-region picks)
 */
export function haRoleSets(Provider, primaryRegion, standbyRegion, roles) {
  const fallback = () => {
    const primary = {};
    const standby = {};
    for (const role of roles) {
      primary[role] = classRuleApplies(Provider)
        ? bestClassPick(Provider, primaryRegion, role, ROLE_MIN_RAM_GB[role])
        : (cheapestRoleSet(Provider, primaryRegion, [role])?.types[role] ?? null);
      standby[role] = primary[role]
        ? haStandbyType(Provider, primary[role], standbyRegion, role)
        : null;
    }
    const classes = new Set(
      [...Object.values(primary), ...Object.values(standby)].map(
        (t) => t && Provider.cpuClassOf(t),
      ),
    );
    const [only] = classes;
    const shared = classes.size === 1;
    return { primary, standby, cpuClass: shared ? (only ?? null) : null, shared };
  };
  if (!classRuleApplies(Provider)) return fallback();

  const standbyOrderable = Provider._locationTypes[standbyRegion] ?? new Set();
  for (const cpuClass of Provider.CPU_CLASSES) {
    const primary = {};
    const standby = {};
    let placed = true;
    for (const role of roles) {
      const min = ROLE_MIN_RAM_GB[role];
      // The same type on both sides when one is sold in both locations.
      const both = pickInClass(Provider, primaryRegion, role, cpuClass, min, standbyOrderable);
      primary[role] = both ?? pickInClass(Provider, primaryRegion, role, cpuClass, min);
      standby[role] = both ?? pickInClass(Provider, standbyRegion, role, cpuClass, min);
      if (!primary[role] || !standby[role]) {
        placed = false;
        break;
      }
    }
    if (placed) return { primary, standby, cpuClass, shared: true };
  }
  return { ...fallback(), shared: false, cpuClass: null };
}

/**
 * The standby's type for `role` in `standbyRegion` when the primary's type is
 * already fixed (on record, given with `-server-type`, or picked by
 * `haRoleSets`): the primary's type where the standby location sells it,
 * else the role's cheapest candidate there of at least its RAM, in the
 * primary's CPU class when one is sold, else in the best class that is. So a
 * premium primary is never paired with a slower class while a premium one is
 * orderable (an sfo3 -amd primary's tor1 standby is -intel, not regular).
 *
 * A provider with one class, no live catalog, or an ARM type keeps
 * `Provider.resolveServerTypeForRegion` (its price-only stand-in, and the
 * ARM->x86 rescue).
 *
 * @param {object} Provider - a provider class
 * @param {string} primaryType
 * @param {string} standbyRegion
 * @param {string} [role] - compose, master, db or worker
 * @returns {string|null} null when nothing fits, for the caller to refuse
 */
export function haStandbyType(Provider, primaryType, standbyRegion, role) {
  if (!classRuleApplies(Provider) || Provider.isArmServerType(primaryType)) {
    return Provider.resolveServerTypeForRegion(primaryType, standbyRegion, role);
  }
  if (Provider._locationTypes[standbyRegion]?.has(primaryType)) return primaryType;
  const ram = Provider.SERVER_TYPES[primaryType]?.ram;
  let pickRole = role ?? (typeof ram === 'number' && ram <= ROLE_MIN_RAM_GB.db ? 'db' : 'compose');
  if (!Provider.ROLE_CANDIDATES?.[pickRole]) pickRole = 'compose';
  const minRam = Math.max(ROLE_MIN_RAM_GB[pickRole], typeof ram === 'number' ? ram : 0);
  return bestClassPick(Provider, standbyRegion, pickRole, minRam, Provider.cpuClassOf(primaryType));
}

/**
 * A CPU class as the CLI names it (`Provider.CPU_CLASS_LABELS`, else its id).
 * @param {object} Provider - a provider class
 * @param {string} cpuClass
 * @returns {string}
 */
export function haClassLabel(Provider, cpuClass) {
  return Provider.CPU_CLASS_LABELS?.[cpuClass] ?? cpuClass;
}

/**
 * The line an HA deploy prints about its sides' CPU classes: which class
 * both run and why, or, when they differ, a warning naming each side's class,
 * what that costs (a failover onto slower servers) and the way out. null for
 * a provider with one class, or with no live catalog. The line starts in
 * lower case, to follow a `Standby server types adjusted ...; ` lead-in;
 * `haClassMessage` composes the two.
 *
 * @param {object} Provider - a provider class
 * @param {object} args
 * @param {string} args.primaryRegion
 * @param {string} args.standbyRegion
 * @param {Record<string, string|null|undefined>} args.primary - types by role
 * @param {Record<string, string|null|undefined>} args.standby - types by role
 * @returns {{level: 'info'|'warn', line: string}|null}
 */
export function haClassNote(Provider, { primaryRegion, standbyRegion, primary, standby }) {
  if (!classRuleApplies(Provider)) return null;
  const classesOf = (types) =>
    [
      ...new Set(
        Object.values(types)
          .filter(Boolean)
          .map((t) => Provider.cpuClassOf(t)),
      ),
    ].filter(Boolean);
  const ofPrimary = classesOf(primary);
  const ofStandby = classesOf(standby);
  const list = (types) =>
    Object.entries(types)
      .filter(([, t]) => t)
      .map(([role, t]) => `${role}=${t}`)
      .join(', ');
  const roles = Object.keys(standby).filter((r) => standby[r]);
  const best = haRoleSets(Provider, primaryRegion, standbyRegion, roles);
  if (ofPrimary.length === 1 && ofStandby.length === 1 && ofPrimary[0] === ofStandby[0]) {
    const label = haClassLabel(Provider, ofPrimary[0]);
    const why =
      best.shared && best.cpuClass === ofPrimary[0]
        ? `the best CPU class ${primaryRegion} and ${standbyRegion} both sell`
        : 'one CPU class on both sides';
    return {
      level: 'info',
      line:
        `primary (${primaryRegion}) and standby (${standbyRegion}) both run ${label} servers, ` +
        `${why}, so a failover lands on servers as fast as the primary's`,
    };
  }
  const names = (classes) => classes.map((c) => haClassLabel(Provider, c)).join(' and ');
  const remedy = best.shared
    ? `Both locations sell ${haClassLabel(Provider, best.cpuClass)} servers: ` +
      `deploy -server-type ${Object.values(best.primary)[0]} puts both sides on that class`
    : `No CPU class is sold in both ${primaryRegion} and ${standbyRegion} at these sizes; ` +
      'pick a standby location that sells the primary class with -standby-region';
  return {
    level: 'warn',
    line:
      `the standby in ${standbyRegion} runs ${names(ofStandby)} servers (${list(standby)}) ` +
      `and the primary in ${primaryRegion} runs ${names(ofPrimary)}, so a failover may run ` +
      `slower than the primary. ${remedy}`,
  };
}

/**
 * The one message an HA effect prints about its standby's sizes: when the
 * standby's types differ from the primary's, `Standby server types adjusted
 * for <region>: <role>=<type>, ...` followed by the class note (which class
 * both sides share and why, or a warning that they differ); otherwise the
 * class note alone. null when there is nothing to say.
 *
 * @param {object} Provider - a provider class
 * @param {Parameters<typeof haClassNote>[1]} sides
 * @returns {{level: 'info'|'warn', line: string}|null}
 */
export function haClassMessage(Provider, sides) {
  const note = haClassNote(Provider, sides);
  const adjusted = Object.keys(sides.standby).some(
    (role) => sides.standby[role] && sides.standby[role] !== sides.primary[role],
  );
  if (adjusted) {
    const types = Object.entries(sides.standby)
      .filter(([, t]) => t)
      .map(([role, t]) => `${role}=${t}`)
      .join(', ');
    const lead = `Standby server types adjusted for ${sides.standbyRegion}: ${types}`;
    return note
      ? { level: note.level, line: `${lead}; ${note.line}` }
      : { level: 'info', line: lead };
  }
  if (!note) return null;
  return { level: note.level, line: `${note.line[0].toUpperCase()}${note.line.slice(1)}` };
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
 * place at the location, `haStandbyType(Provider, primaryType, location,
 * role)` (the primary's type where stocked, else the role's pick of at least
 * its RAM, in the primary's CPU class where sold), or the role's plain pick
 * when no primary type is given.
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
    const ipv4 = ipv4MonthlyAt(Provider, location);
    let monthly = ipv4 === null ? null : 0;
    for (const role of roles) {
      const primary = primaryTypes[role];
      const type = primary
        ? haStandbyType(Provider, primary, location, role)
        : (cheapestRoleSet(Provider, location, [role])?.types[role] ?? null);
      if (!type) return null;
      types[role] = type;
      const price = priceFor(type, location);
      monthly = monthly === null || price === null ? null : monthly + price + ipv4;
    }
    return { types, monthly: monthly === null ? null : Math.round(monthly * 100) / 100 };
  });
}

/**
 * A monthly price as the CLI prints it: the provider's currency symbol (the
 * live `Provider._currency`, else `Provider.CURRENCY`) and the amount to the cent, e.g. `$7.09` or
 * `€18.39`.
 *
 * @param {object} Provider - a provider class
 * @param {number} monthly
 * @returns {string}
 */
export function formatMonthly(Provider, monthly) {
  return `${Provider._currency ?? Provider.CURRENCY}${monthly.toFixed(2)}`;
}

/**
 * The billed IPv4 per server per month in `location`, the one read every
 * priced or ranked set adds: the live price for the location
 * (`Provider._ipv4Monthly`, read with the catalog where the provider's API
 * states it), else the first live one, else the static `IPV4_MONTHLY`. null
 * when none is known, which makes a set's monthly unknown.
 *
 * @param {object} Provider - a provider class
 * @param {string} location
 * @returns {number|null}
 */
export function ipv4MonthlyAt(Provider, location) {
  const live = Provider._ipv4Monthly;
  if (live) {
    if (typeof live[location] === 'number') return live[location];
    const first = Object.values(live).find((n) => typeof n === 'number');
    if (first !== undefined) return first;
  }
  return typeof Provider.IPV4_MONTHLY === 'number' ? Provider.IPV4_MONTHLY : null;
}

/**
 * The region a new project pre-selects: the cheapest location for `roles` on
 * the continent of `Provider.DEFAULT_REGION`, ranked by `rankLocationsByPrice`
 * (so it always agrees with the prices the region prompt shows). Ties keep
 * the default region; another continent is never picked. The default region
 * stands when no live catalog is loaded or nothing on its continent can place
 * every role (the deploy then refuses at type resolution, naming why).
 *
 * @param {object} Provider - a provider class
 * @param {string[]} roles - e.g. ['compose'] or ['master', 'db', 'worker']
 * @returns {string}
 */
export function cheapestDefaultRegion(Provider, roles) {
  const fallback = Provider.DEFAULT_REGION;
  if (!Provider._locationTypes) return fallback;
  const continentOf = Provider.REGION_CONTINENT ?? {};
  const continent = continentOf[fallback];
  if (!continent) return fallback;
  const sameContinent = [
    fallback,
    ...Object.keys(Provider.REGIONS).filter((r) => r !== fallback && continentOf[r] === continent),
  ];
  return rankLocationsByPrice(Provider, sameContinent, roles)[0]?.location ?? fallback;
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
