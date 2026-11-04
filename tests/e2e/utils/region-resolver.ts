/**
 * Capacity resolver for e2e scenarios: picks where each scenario deploys,
 * never what it deploys.
 *
 * The matrix deploys the sizes a customer gets by default. At preflight the
 * resolver reads each provider's live catalog through the provider class
 * (`fetchServerTypes`, the same read the CLI makes) and runs the customer's
 * price picker over it (`cheapestRoleSet`, src/lib/sizing.js). It returns the
 * first preferred region where the picker can place every role the scenario
 * needs (an HA standby goes where the customer's deploy puts it), with
 * `serverType: undefined`: the deploy under test then picks its
 * types itself, cold, exactly as a customer's first deploy does, and records
 * them in `.vibecarbon.json`. The scale step reads that record and looks the
 * target up in the scenario's ladder (`scaleTo`, tests/config.ts) through
 * `deployedScaleTarget`.
 *
 * A region also has to sell the scale target of the type the picker chose
 * there, or the scale step would fail 20 minutes in on a stock-out the
 * preflight could see (the reason this resolver exists: Hetzner capacity
 * shifts through the day).
 *
 * No catalog means no run: a missing token or an API failure fails preflight
 * naming the provider, so the matrix never deploys a type a customer would
 * not get.
 */
import { getProviderClass } from '../../../src/lib/providers/index.js';
import { cheapestRoleSet, haRoleSets } from '../../../src/lib/sizing.js';
import type { DeployMode } from '../scenarios/types.js';

export interface CapacityPreferences {
  /** Locations (Scaleway: zones) in operator-preferred order, best first. */
  regions: readonly string[];
  /**
   * Scale ladder: the type a deploy recorded -> the type the scale step moves
   * it to. An entry is one type, or an ordered list of candidates: the
   * resolver picks the first that every side of the deploy sells and that is
   * bigger than each side's own type (a mixed-type HA pair, such as DO sfo3
   * `-amd` with tor1 plain, needs a target both sell, e.g. the `-intel` one).
   */
  scaleTo: Readonly<Record<string, string | readonly string[]>>;
}

/** The ladder entry as an ordered candidate list. */
export function scaleCandidates(entry: string | readonly string[] | undefined): string[] {
  if (entry === undefined) return [];
  return typeof entry === 'string' ? [entry] : [...entry];
}

export interface ResolvedCapacity {
  region: string;
  /**
   * Always undefined: the deploy picks the default sizes itself. Kept on the
   * result so the census can prove no scenario pins one.
   */
  serverType: undefined;
  /** What the picker chose per role at preflight, for the run log. */
  types: Record<string, string>;
  /** Where the capacity was found, for diagnostics (the region itself). */
  datacenter: string;
  /**
   * The scale step's target: the first ladder candidate sold on every side
   * of the deploy and bigger than each side's own type. The scale step uses
   * this, never `scaleTo[type]` directly.
   */
  scaleTarget: string;
}

/** Provider a scenario provisions against. */
export type CapacityProvider = 'hetzner' | 'digitalocean' | 'linode' | 'vultr' | 'scaleway';

/** The deploy mode whose roles a scenario places. */
export type CapacityMode = DeployMode;

// biome-ignore lint/suspicious/noExplicitAny: a provider class (src/lib/providers/*.js)
type ProviderClass = any;

interface ResolveOptions {
  /** Defaults to 'hetzner'. */
  provider?: CapacityProvider;
  /** Which roles to place. Defaults to 'compose'. */
  mode?: CapacityMode;
  /**
   * Loads the live catalog into the provider class; resolves false when it
   * could not. Defaults to `Provider.fetchServerTypes(token)`. Unit tests seed
   * the class from a fixture and inject `async () => true`.
   */
  loadCatalog?: (Provider: ProviderClass, token: string) => Promise<boolean>;
}

/** The roles the deploy places on the primary side for `mode`. */
function primaryRoles(mode: CapacityMode): string[] {
  return mode.startsWith('k8s') ? ['master', 'db', 'worker'] : ['compose'];
}

/** The roles an HA standby places: k8s-ha's pilot light has no worker. */
function standbyRoles(mode: CapacityMode): string[] {
  return mode === 'k8s-ha' ? ['master', 'db'] : ['compose'];
}

/**
 * The role whose type keys the scale ladder. `scale -type X` resizes every
 * node (k8s: master, db and worker alike), so one target covers the env; the
 * master is the role at the 4 GB floor, so its target fits every role.
 */
function scaleKeyRole(mode: CapacityMode): string {
  return mode.startsWith('k8s') ? 'master' : 'compose';
}

function noScaleTarget(type: string): Error {
  return new Error(`no scale target for ${type} in tests/config.ts scaleTo`);
}

async function loadProvider(
  provider: CapacityProvider,
  token: string,
  loadCatalog: ResolveOptions['loadCatalog'],
): Promise<ProviderClass> {
  const Provider = getProviderClass(provider);
  if (!Provider) {
    throw new Error(`region-resolver: no provider class registered for '${provider}'.`);
  }
  const loaded = loadCatalog
    ? await loadCatalog(Provider, token)
    : await Provider.fetchServerTypes(token);
  if (!loaded) {
    throw new Error(
      `region-resolver: could not read the ${Provider.NAME ?? provider} catalog ` +
        `(missing API token or an API failure). The matrix deploys only the sizes a ` +
        `customer gets by default, so it will not guess a server type.`,
    );
  }
  return Provider;
}

interface ScaleSide {
  /** Human label for refusals, e.g. `primary` or `default standby`. */
  label: string;
  location: string;
  /** The side's own resolved types: the target must be bigger than each. */
  types: Array<{ role: string; type: string }>;
}

/** Why `candidate` cannot be the scale target for `side`, or null when it can. */
function candidateFailure(Provider: ProviderClass, candidate: string, side: ScaleSide) {
  if (!Provider._locationTypes?.[side.location]?.has(candidate)) {
    return `${side.label} location ${side.location} does not sell the scale target ${candidate}`;
  }
  const ramOf = (type: string): number | undefined => Provider.SERVER_TYPES?.[type]?.ram;
  for (const { role, type } of side.types) {
    const targetRam = ramOf(candidate);
    const ownRam = ramOf(type);
    if (targetRam === undefined || ownRam === undefined || targetRam <= ownRam) {
      return (
        `scale target ${candidate} (${targetRam ?? '?'} GB) is not bigger than the ${role} ` +
        `${side.label} type ${type} (${ownRam ?? '?'} GB) in ${side.location}`
      );
    }
  }
  return null;
}

/**
 * The first candidate sold on every side and bigger than each side's types,
 * or the per-candidate failure reasons when none qualifies.
 */
function pickScaleTarget(
  Provider: ProviderClass,
  candidates: string[],
  sides: ScaleSide[],
): { target: string } | { failures: string[] } {
  const failures: string[] = [];
  for (const candidate of candidates) {
    let failure: string | null = null;
    for (const side of sides) {
      failure = candidateFailure(Provider, candidate, side);
      if (failure) break;
    }
    if (!failure) return { target: candidate };
    failures.push(`${candidate}: ${failure}`);
  }
  return { failures };
}

/**
 * The picker's set for `roles` in `region` with the scale target chosen for
 * it, or null when a role has nothing orderable there or no ladder candidate
 * of the key role's type is sold there (and bigger than it).
 */
function placeableSet(
  Provider: ProviderClass,
  prefs: CapacityPreferences,
  region: string,
  roles: string[],
  keyRole: string,
): { types: Record<string, string>; scaleTarget: string } | null {
  const set = cheapestRoleSet(Provider, region, roles);
  if (!set) return null;
  const key = set.types[keyRole];
  const candidates = scaleCandidates(prefs.scaleTo[key]);
  if (candidates.length === 0) throw noScaleTarget(key);
  const side: ScaleSide = {
    label: 'primary',
    location: region,
    types: [{ role: keyRole, type: key }],
  };
  const picked = pickScaleTarget(Provider, candidates, [side]);
  if ('failures' in picked) return null;
  return { types: set.types, scaleTarget: picked.target };
}

function resolved(
  region: string,
  types: Record<string, string>,
  scaleTarget: string,
): ResolvedCapacity {
  return { region, serverType: undefined, types, datacenter: region, scaleTarget };
}

/**
 * The first preferred region (not excluded) where the picker places every
 * role of `options.mode` and the scale target is sold. Throws listing what
 * was tried when none fits; preflight catches that and aborts the matrix
 * before any scenario provisions.
 */
export async function resolveCapacity(
  prefs: CapacityPreferences,
  token: string,
  options: ResolveOptions & { excludeRegions?: readonly string[] } = {},
): Promise<ResolvedCapacity> {
  const provider = options.provider ?? 'hetzner';
  const mode = options.mode ?? 'compose';
  const Provider = await loadProvider(provider, token, options.loadCatalog);
  const excluded = new Set(options.excludeRegions ?? []);
  const roles = primaryRoles(mode);

  for (const region of prefs.regions) {
    if (excluded.has(region)) continue;
    const placed = placeableSet(Provider, prefs, region, roles, scaleKeyRole(mode));
    if (placed) return resolved(region, placed.types, placed.scaleTarget);
  }

  const tried = prefs.regions.filter((r) => !excluded.has(r));
  throw new Error(
    `region-resolver: no ${Provider.NAME ?? provider} region can place the default ` +
      `${mode} sizes and their scale target right now. tried regions=[${tried.join(',')}] ` +
      `roles=[${roles.join(',')}]. Capacity is fluid: try again in a few minutes, or ` +
      `add a region to tests/config.ts capacityPreferences.${provider}.regions.`,
  );
}

/**
 * HA: the primary is the first preferred region the picker can place (as
 * `resolveCapacity`); the standby is where a customer's deploy puts it,
 * `Provider.getDefaultStandbyRegion(primary, roles, primaryTypes)` on the
 * same catalog, whatever the e2e region list says. Both sides' types are
 * what the deploy wizard picks for that pair, `haRoleSets` (one CPU class for
 * both, the best both locations sell, at the default RAM tiers). `scale -type` resizes both sides, so the standby must sell the scale
 * target too, and the target must have more RAM than each standby type; when
 * either fails, preflight fails with a line naming the provider, the location
 * and the types, and no other location is tried.
 */
export async function resolveCapacityPair(
  prefs: CapacityPreferences,
  token: string,
  options: ResolveOptions = {},
): Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }> {
  const provider = options.provider ?? 'hetzner';
  const mode = options.mode ?? 'compose-ha';
  const primary = await resolveCapacity(prefs, token, { ...options, provider, mode });
  const Provider: ProviderClass = getProviderClass(provider);
  const name = Provider.NAME ?? provider;

  const roles = standbyRoles(mode);
  const primaryTypes = Object.fromEntries(roles.map((role) => [role, primary.types[role]]));
  const region: string = Provider.getDefaultStandbyRegion(primary.region, roles, primaryTypes);
  if (!region || region === primary.region) {
    throw new Error(
      `region-resolver: ${name} has no default standby location for a ${mode} primary in ${primary.region}.`,
    );
  }

  // Both sides' types as the deploy wizard re-picks them for this pair: one
  // CPU class for both, the best both locations sell (haRoleSets), at the
  // default RAM tiers. The primary's own pick above chose the location only.
  const pair = haRoleSets(Provider, primary.region, region, primaryRoles(mode));
  const types: Record<string, string> = {};
  for (const role of roles) {
    const type = pair.standby[role];
    if (!type) {
      throw new Error(
        `region-resolver: ${name} default standby location ${region} cannot place the ` +
          `${role} role for a ${primaryTypes[role]} primary, so the ${mode} deploy would refuse.`,
      );
    }
    types[role] = type;
  }
  for (const role of primaryRoles(mode)) {
    const type = pair.primary[role];
    if (type) primary.types[role] = type;
  }

  const keyRole = scaleKeyRole(mode);
  const candidates = scaleCandidates(prefs.scaleTo[primary.types[keyRole]]);
  if (candidates.length === 0) throw noScaleTarget(primary.types[keyRole]);
  const picked = pickScaleTarget(Provider, candidates, [
    {
      label: 'primary',
      location: primary.region,
      types: [{ role: keyRole, type: primary.types[keyRole] }],
    },
    {
      label: 'default standby',
      location: region,
      types: roles.map((role) => ({ role, type: types[role] })),
    },
  ]);
  if ('failures' in picked) {
    throw new Error(
      `region-resolver: ${name} no scale target candidate [${candidates.join(', ')}] can run ` +
        `on both the ${primary.region} primary and the ${region} standby, so the ${mode} ` +
        `scale step would fail. ${picked.failures.join('; ')}.`,
    );
  }

  return {
    primary: { ...primary, scaleTarget: picked.target },
    standby: resolved(region, types, picked.target),
  };
}

/**
 * The scale step's target. The deploy records its type in `.vibecarbon.json`
 * (compose: `serverType`; k8s: `masterServerType`, since `scale -type` resizes
 * every role); that type must have a ladder entry. `resolvedTarget` is the
 * preflight resolver's pick (`ResolvedCapacity.scaleTarget`) and wins when it
 * is one of that entry's candidates; one that is not means the deploy recorded
 * a different type than preflight placed, so it throws rather than scale to a
 * type nobody checked. Without `resolvedTarget` the entry's first candidate is
 * used. Throws when the deploy recorded no type or the ladder has no entry.
 */
export function deployedScaleTarget(
  envConfig: { serverType?: string; masterServerType?: string },
  mode: CapacityMode,
  scaleTo: Readonly<Record<string, string | readonly string[]>>,
  resolvedTarget?: string,
): string {
  const field = mode.startsWith('k8s') ? 'masterServerType' : 'serverType';
  const type = envConfig[field];
  if (!type) {
    throw new Error(
      `the deploy recorded no ${field} in .vibecarbon.json, so the scale target is unknown`,
    );
  }
  const candidates = scaleCandidates(scaleTo[type]);
  if (candidates.length === 0) throw noScaleTarget(type);
  if (resolvedTarget === undefined) return candidates[0];
  if (!candidates.includes(resolvedTarget)) {
    throw new Error(
      `the resolved scale target ${resolvedTarget} is not a ladder candidate for the deployed ` +
        `${type} [${candidates.join(', ')}]: the deploy recorded a different type than preflight placed`,
    );
  }
  return resolvedTarget;
}

/**
 * Apply the `E2E_REGIONS` env override (comma-separated Hetzner location
 * names) to a scenario's capacity preferences. The CI `regions` dispatch
 * input feeds this; its default is EMPTY so the config's EU/cheapest-first
 * list applies everywhere, and a deliberate US perf record run passes
 * `ash,hil` explicitly. Returns the input unchanged when the override is
 * absent or empty.
 */
export function overrideRegions(
  prefs: CapacityPreferences,
  regionsCsv: string | undefined,
): CapacityPreferences {
  if (!regionsCsv) return prefs;
  const regions = regionsCsv
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (regions.length === 0) return prefs;
  return { ...prefs, regions };
}
