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
 * The size floor a pick must meet for `role`: at least the vCPUs and RAM of
 * `type` (when known), and never under the role's RAM floor.
 *
 * @returns {{vcpu: number, ram: number}}
 */
function tierOf(Provider, type, role) {
  const spec = type ? Provider.SERVER_TYPES?.[type] : undefined;
  return {
    vcpu: typeof spec?.vcpu === 'number' ? spec.vcpu : 0,
    ram: Math.max(ROLE_MIN_RAM_GB[role] ?? 0, typeof spec?.ram === 'number' ? spec.ram : 0),
  };
}

/** Does `type` meet `floor`? */
function meetsTier(Provider, type, floor) {
  const spec = Provider.SERVER_TYPES?.[type];
  return (spec?.vcpu ?? 0) >= floor.vcpu && (spec?.ram ?? 0) >= floor.ram;
}

/**
 * The cheapest `role` candidate of CPU class `cpuClass` in `location` that
 * meets `floor` (pickRoleType over the candidates of that class), limited to
 * `onlyIn` when given (types orderable in the other location too).
 */
function pickInClass(Provider, location, role, cpuClass, floor, onlyIn) {
  const { catalog, orderable, priceFor } = catalogFor(Provider, location);
  return pickRoleType({
    candidates: (Provider.ROLE_CANDIDATES?.[role] ?? []).filter(
      (t) =>
        Provider.cpuClassOf(t) === cpuClass &&
        (!onlyIn || onlyIn.has(t)) &&
        (catalog[t]?.vcpu ?? 0) >= floor.vcpu,
    ),
    catalog,
    orderable,
    location,
    priceFor,
    isArm: (type) => Provider.isArmServerType(type),
    minRamGb: floor.ram,
  });
}

/**
 * The best-ranked class (CPU_CLASSES order, `first` ahead of the rest) that
 * has a `role` candidate in `location` meeting `floor`, and that candidate.
 */
function bestClassPick(Provider, location, role, floor, first) {
  const order = Provider.CPU_CLASSES.includes(first)
    ? [first, ...Provider.CPU_CLASSES.filter((c) => c !== first)]
    : Provider.CPU_CLASSES;
  for (const cpuClass of order) {
    const type = pickInClass(Provider, location, role, cpuClass, floor);
    if (type) return type;
  }
  return null;
}

/**
 * Do the two sides match for every role? A role matches when both sides run
 * the same type, or two types of the same declared CPU class. A type with no
 * class matches only itself.
 *
 * @param {object} Provider - a provider class
 * @param {Record<string, string|null|undefined>} primary - types by role
 * @param {Record<string, string|null|undefined>} standby - types by role
 * @returns {boolean}
 */
export function haSidesMatch(Provider, primary, standby) {
  return Object.keys(standby).every((role) => {
    const p = primary[role];
    const s = standby[role];
    if (!p || !s || p === s) return true;
    const pc = Provider.cpuClassOf(p);
    return pc !== null && pc === Provider.cpuClassOf(s);
  });
}

/**
 * The default types for both sides of an HA deploy: one CPU class for both,
 * the best one (`Provider.CPU_CLASSES` order) in which every role has a type
 * in both locations at least as big (vCPUs and RAM) as the primary
 * location's single-region default for it, so the rule never moves a deploy
 * below the size it would otherwise get. Within that class each role takes
 * the cheapest such type sold in both locations; when none is, the primary
 * takes its location's and the standby `haStandbyType` of it, which the
 * deploy resolves the same way, so the wizard and the deploy agree.
 *
 * When no class offers that in both locations, each side falls back on its
 * own: the primary keeps its single-region default, the standby takes
 * `haStandbyType` of it (the primary's class where sold, else the closest
 * class it sells). `shared` is false then, and the deploy warns.
 *
 * A provider with one class, or no live catalog, keeps today's picks: the
 * primary's single-region default per role and its standby resolution
 * (`shared` true, `cpuClass` null).
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
  const defaults = Object.fromEntries(
    roles.map((role) => [
      role,
      cheapestRoleSet(Provider, primaryRegion, [role])?.types[role] ?? null,
    ]),
  );
  const perSide = (pick) => {
    const primary = {};
    const standby = {};
    for (const role of roles) {
      primary[role] = pick(role);
      standby[role] = primary[role]
        ? haStandbyType(Provider, primary[role], standbyRegion, role)
        : null;
    }
    return { primary, standby };
  };
  if (!classRuleApplies(Provider)) {
    return { ...perSide((role) => defaults[role]), cpuClass: null, shared: true };
  }

  const standbyOrderable = Provider._locationTypes[standbyRegion] ?? new Set();
  for (const cpuClass of Provider.CPU_CLASSES) {
    const primary = {};
    const standby = {};
    let placed = true;
    for (const role of roles) {
      const floor = tierOf(Provider, defaults[role], role);
      // The same type on both sides when one is sold in both locations.
      const type =
        pickInClass(Provider, primaryRegion, role, cpuClass, floor, standbyOrderable) ??
        pickInClass(Provider, primaryRegion, role, cpuClass, floor);
      const stand = type ? haStandbyType(Provider, type, standbyRegion, role) : null;
      if (
        !stand ||
        Provider.cpuClassOf(stand) !== cpuClass ||
        !meetsTier(Provider, stand, tierOf(Provider, type, role))
      ) {
        placed = false;
        break;
      }
      primary[role] = type;
      standby[role] = stand;
    }
    if (placed) return { primary, standby, cpuClass, shared: true };
  }
  return { ...perSide((role) => defaults[role]), cpuClass: null, shared: false };
}

/**
 * The standby's type for `role` in `standbyRegion` when the primary's type is
 * already fixed (on record, given with `-server-type`, or picked by
 * `haRoleSets`): the primary's type where the standby location sells it,
 * else the role's cheapest candidate there with at least its vCPUs and RAM,
 * in the primary's CPU class when one is sold, else in the best class that
 * is. So a premium primary is never paired with a slower class while a
 * premium one is orderable (an sfo3 -amd primary's tor1 standby is -intel,
 * not regular). When no candidate has the vCPUs, the RAM alone decides, as
 * the price-only stand-in always has, so a standby is placed wherever it was
 * placed before.
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
  const floor = tierOf(Provider, primaryType, pickRole);
  const own = Provider.cpuClassOf(primaryType);
  return (
    bestClassPick(Provider, standbyRegion, pickRole, floor, own) ??
    bestClassPick(Provider, standbyRegion, pickRole, { vcpu: 0, ram: floor.ram }, own)
  );
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
 * The best class (CPU_CLASSES order) in which both locations sell, for every
 * role, a type at least as big as that role's `floors` type, searched over
 * the whole catalog (not only the role candidates), or null. What a scale to
 * one class could reach.
 */
function commonClassAt(Provider, regionA, regionB, floors) {
  const soldA = Provider._locationTypes[regionA] ?? new Set();
  const soldB = Provider._locationTypes[regionB] ?? new Set();
  const types = Object.keys(Provider.SERVER_TYPES ?? {}).filter(
    (t) => soldA.has(t) && soldB.has(t) && !Provider.isArmServerType(t),
  );
  return (
    Provider.CPU_CLASSES.find((cpuClass) =>
      Object.entries(floors).every(([role, type]) => {
        const floor = tierOf(Provider, type, role);
        return types.some(
          (t) => Provider.cpuClassOf(t) === cpuClass && meetsTier(Provider, t, floor),
        );
      }),
    ) ?? null
  );
}

/**
 * The line an HA deploy prints about its sides' CPU classes, in the second
 * person. When every role matches (`haSidesMatch`) on one declared class:
 * which class both run and why. When some role differs: a warning naming,
 * per role, the class (or type) on each side; for a provider whose classes
 * are ranked by speed (`CPU_CLASS_ORDER`), that a failover may run slower
 * when the standby's class ranks below the primary's; and what can put both
 * sides on one class (`vibecarbon scale <environment>`, once the deploy is
 * done), or that no class is sold in both locations at these sizes. null for
 * a provider with one class, with no live catalog, or for sides that match
 * on more than one class or on types with no class. The line starts in lower
 * case, to follow a `Standby server types adjusted ...; ` lead-in;
 * `haClassMessage` composes the two.
 *
 * @param {object} Provider - a provider class
 * @param {object} args
 * @param {string} args.primaryRegion
 * @param {string} args.standbyRegion
 * @param {Record<string, string|null|undefined>} args.primary - types by role
 * @param {Record<string, string|null|undefined>} args.standby - types by role
 * @param {string} args.environment - for the command in the hint
 * @returns {{level: 'info'|'warn', line: string}|null}
 */
export function haClassNote(
  Provider,
  { primaryRegion, standbyRegion, primary, standby, environment },
) {
  if (!classRuleApplies(Provider)) return null;
  const roles = Object.keys(standby).filter((r) => standby[r] && primary[r]);
  const floors = Object.fromEntries(roles.map((r) => [r, primary[r]]));
  const common = commonClassAt(Provider, primaryRegion, standbyRegion, floors);
  const bySpeed = Provider.CPU_CLASS_ORDER === 'speed';

  if (haSidesMatch(Provider, primary, standby)) {
    const classes = new Set(roles.map((r) => Provider.cpuClassOf(primary[r])));
    const [only] = classes;
    if (classes.size !== 1 || !only) return null;
    const best = bySpeed ? 'the best' : 'the lowest-priced';
    const why =
      common === only
        ? `${best} CPU class ${primaryRegion} and ${standbyRegion} both sell`
        : 'one CPU class on both sides';
    return {
      level: 'info',
      line:
        `your primary (${primaryRegion}) and standby (${standbyRegion}) both run ` +
        `${haClassLabel(Provider, only)} servers, ${why}, so a failover lands on servers as ` +
        "fast as your primary's",
    };
  }

  const rank = (t) => {
    const i = Provider.CPU_CLASSES.indexOf(Provider.cpuClassOf(t));
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const name = (t) => {
    const cls = Provider.cpuClassOf(t);
    return cls ? haClassLabel(Provider, cls) : t;
  };
  const differing = roles.filter(
    (r) => !haSidesMatch(Provider, { [r]: primary[r] }, { [r]: standby[r] }),
  );
  const detail = differing
    .map((r) => {
      const fewer =
        (Provider.SERVER_TYPES?.[standby[r]]?.vcpu ?? 0) <
        (Provider.SERVER_TYPES?.[primary[r]]?.vcpu ?? 0)
          ? `, ${standby[r]} with ${Provider.SERVER_TYPES[standby[r]].vcpu} vCPU to your primary's ${Provider.SERVER_TYPES[primary[r]].vcpu}`
          : '';
      return `${r}: ${name(standby[r])} in ${standbyRegion}, ${name(primary[r])} in ${primaryRegion}${fewer}`;
    })
    .join('; ');
  const slower =
    bySpeed && differing.some((r) => rank(standby[r]) > rank(primary[r]))
      ? ', so a failover may run slower than your primary'
      : '';
  const remedy = common
    ? `Both locations sell ${haClassLabel(Provider, common)} servers this size or larger: once this ` +
      `deploy finishes, run vibecarbon scale ${environment} and pick ` +
      (roles.length > 1
        ? `${haClassLabel(Provider, common)} sizes for each role`
        : `a ${haClassLabel(Provider, common)} size`) +
      ' to put both sides on one class'
    : `No CPU class is sold in both ${primaryRegion} and ${standbyRegion} at these sizes, ` +
      `so your standby stays on a different class from your primary's`;
  return {
    level: 'warn',
    line: `your standby runs a different CPU class from your primary (${detail})${slower}. ${remedy}`,
  };
}

/**
 * The one message an HA effect prints about a standby it is sizing (not one
 * whose types are on record): when the standby's types differ from the
 * primary's, `Standby server types adjusted for <region>: <role>=<type>, ...`
 * followed by the class note (which class both sides share and why, or a
 * warning that they differ); otherwise the class note alone. null when there
 * is nothing to say.
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
 * @param {string[]} roles - ['compose'], or ['master', 'db', 'worker'] for
 *   k8s-ha: the pilot-light standby places a master and a db, and the worker
 *   is weighed in the class match only (rankStandbyLocations)
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
  return (
    rankStandbyLocations(Provider, partners, roles, primaryTypes, primaryRegion)[0]?.location ??
    conventional
  );
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
 * its size, in the primary's CPU class where sold). A role with no primary
 * type given is one the deploy wizard re-picks for the pair: with
 * `primaryRegion`, the standby side of `haRoleSets(Provider, primaryRegion,
 * location, roles)`; without, the role's plain pick at the location.
 * Locations where any role the standby places resolves to nothing are left
 * out, so a primary bigger than every candidate only ranks locations that
 * stock its type.
 *
 * Locations where both sides would match (`haSidesMatch`: one CPU class per
 * role) rank first, then by the standby's monthly price, so a default
 * standby never takes a mixed pair while a matching one is orderable.
 *
 * A k8s-ha set (`roles` with a worker) also weighs the worker: the
 * pilot-light standby does not run one (`haStandbyRoles`), so it is neither
 * priced nor required, but failover brings it up from the record, so a
 * location where it would differ in class from the primary's, or has none,
 * does not count as matching.
 *
 * @param {object} Provider - a provider class
 * @param {string[]} locations
 * @param {string[]} roles - ['compose'], or ['master', 'db', 'worker'] for
 *   k8s-ha (['master', 'db'] ranks without the worker)
 * @param {Record<string, string|undefined>} [primaryTypes] - by role
 * @param {string} [primaryRegion] - for the roles with no primary type
 * @returns {Array<{location: string, monthly: number|null, types: Record<string, string>,
 *   shared: boolean}>}
 */
export function rankStandbyLocations(Provider, locations, roles, primaryTypes = {}, primaryRegion) {
  return rankSets(locations, (location) => {
    const { priceFor } = catalogFor(Provider, location);
    const open = roles.filter((role) => !primaryTypes[role]);
    const pair =
      open.length > 0 && primaryRegion ? haRoleSets(Provider, primaryRegion, location, open) : null;
    const placed = haStandbyRoles(roles);
    const types = {};
    const recorded = {};
    const primaries = {};
    let unplaced = false;
    const ipv4 = ipv4MonthlyAt(Provider, location);
    let monthly = ipv4 === null ? null : 0;
    for (const role of roles) {
      let type;
      if (primaryTypes[role]) {
        primaries[role] = primaryTypes[role];
        type = haStandbyType(Provider, primaryTypes[role], location, role);
      } else if (pair) {
        primaries[role] = pair.primary[role];
        type = pair.standby[role];
      } else {
        type = cheapestRoleSet(Provider, location, [role])?.types[role] ?? null;
      }
      if (!placed.includes(role)) {
        // Recorded for failover only: weighed in the match, never priced.
        if (type) recorded[role] = type;
        else unplaced = true;
        continue;
      }
      if (!type) return null;
      types[role] = type;
      const price = priceFor(type, location);
      monthly = monthly === null || price === null ? null : monthly + price + ipv4;
    }
    return {
      types,
      monthly: monthly === null ? null : Math.round(monthly * 100) / 100,
      shared: !unplaced && haSidesMatch(Provider, primaries, { ...types, ...recorded }),
    };
  });
}

/**
 * The roles an HA standby places for a deploy of `roles`: the k8s-ha
 * pilot-light standby has a master and a db, no worker.
 *
 * @param {string[]} roles
 * @returns {string[]}
 */
export function haStandbyRoles(roles) {
  return roles.includes('worker') ? roles.filter((r) => r !== 'worker') : roles;
}

/**
 * What a new HA deploy with its primary in `primaryRegion` creates by
 * default: the standby location the wizard pre-selects
 * (`Provider.getDefaultStandbyRegion`, with every role open to the class
 * rule), both sides' types (`haRoleSets`) and what the servers cost per month
 * (each primary role and each standby role, plus billed IPv4 per server).
 * null when either side has a role with nothing orderable.
 *
 * @param {object} Provider - a provider class
 * @param {string} primaryRegion
 * @param {string[]} roles - ['compose'] or ['master', 'db', 'worker']
 * @returns {{standbyRegion: string, primary: Record<string, string>,
 *   standby: Record<string, string>, monthly: number|null}|null}
 */
export function haDefaultPair(Provider, primaryRegion, roles) {
  const standbyRoles = haStandbyRoles(roles);
  // Ranked with every role (the k8s-ha worker included, for the match).
  const standbyRegion = Provider.getDefaultStandbyRegion(primaryRegion, roles, {});
  if (!standbyRegion || standbyRegion === primaryRegion) return null;
  const sets = haRoleSets(Provider, primaryRegion, standbyRegion, roles);
  const standby = Object.fromEntries(standbyRoles.map((r) => [r, sets.standby[r]]));
  if (roles.some((r) => !sets.primary[r]) || standbyRoles.some((r) => !standby[r])) return null;
  let monthly = 0;
  for (const [location, types] of [
    [primaryRegion, sets.primary],
    [standbyRegion, standby],
  ]) {
    const ipv4 = ipv4MonthlyAt(Provider, location);
    for (const type of Object.values(types)) {
      const price = Provider.priceFor?.(type, location) ?? null;
      if (monthly === null || price === null || ipv4 === null) monthly = null;
      else monthly += price + ipv4;
    }
  }
  return {
    standbyRegion,
    primary: sets.primary,
    standby,
    monthly: monthly === null ? null : Math.round(monthly * 100) / 100,
  };
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
 * (so it always agrees with the prices the region prompt shows), or for an
 * HA deploy (`options.ha`) by what its default pair costs (`haDefaultPair`).
 * Ties keep the default region; another continent is never picked. The
 * default region stands when no live catalog is loaded or nothing on its
 * continent can place every role (the deploy then refuses at type
 * resolution, naming why).
 *
 * @param {object} Provider - a provider class
 * @param {string[]} roles - e.g. ['compose'] or ['master', 'db', 'worker']
 * @param {{ha?: boolean}} [options]
 * @returns {string}
 */
export function cheapestDefaultRegion(Provider, roles, { ha = false } = {}) {
  const fallback = Provider.DEFAULT_REGION;
  if (!Provider._locationTypes) return fallback;
  const continentOf = Provider.REGION_CONTINENT ?? {};
  const continent = continentOf[fallback];
  if (!continent) return fallback;
  const sameContinent = [
    fallback,
    ...Object.keys(Provider.REGIONS).filter((r) => r !== fallback && continentOf[r] === continent),
  ];
  const ranked = ha
    ? rankSets(sameContinent, (location) => {
        const pair = haDefaultPair(Provider, location, roles);
        return pair && { monthly: pair.monthly, types: pair.primary };
      })
    : rankLocationsByPrice(Provider, sameContinent, roles);
  return ranked[0]?.location ?? fallback;
}

/**
 * Rank `setAt(location)` results cheapest first; see rankLocationsByPrice.
 * A set that carries `shared` (rankStandbyLocations) ranks matching pairs
 * ahead of mixed ones before price.
 */
function rankSets(locations, setAt) {
  const ranked = [];
  for (const location of locations) {
    const set = setAt(location);
    if (set) {
      ranked.push({
        location,
        monthly: set.monthly,
        types: set.types,
        ...(set.shared === undefined ? {} : { shared: set.shared }),
      });
    }
  }
  // Array.prototype.sort is stable, so equal keys keep the given order.
  return ranked.sort((a, b) => {
    if (a.shared !== undefined && a.shared !== b.shared) return a.shared ? -1 : 1;
    if (a.monthly === null || b.monthly === null) {
      return (a.monthly === null) - (b.monthly === null);
    }
    return a.monthly - b.monthly;
  });
}
