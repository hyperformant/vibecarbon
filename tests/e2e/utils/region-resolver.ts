/**
 * Capacity resolver for e2e scenarios: picks where each scenario deploys,
 * never what it deploys.
 *
 * The matrix deploys the sizes a customer gets by default. At preflight the
 * resolver reads each provider's live catalog through the provider class
 * (`fetchServerTypes`, the same read the CLI makes) and runs the customer's
 * price picker over it (`cheapestRoleSet`, src/lib/sizing.js). It returns the
 * first preferred region where the picker can place every role the scenario
 * needs, with `serverType: undefined`: the deploy under test then picks its
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
import { cheapestRoleSet } from '../../../src/lib/sizing.js';
import type { DeployMode } from '../scenarios/types.js';

export interface CapacityPreferences {
  /** Locations (Scaleway: zones) in operator-preferred order, best first. */
  regions: readonly string[];
  /** Scale ladder: the type a deploy recorded -> the type the scale step moves it to. */
  scaleTo: Readonly<Record<string, string>>;
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

/**
 * The picker's set for `roles` in `region`, or null when a role has nothing
 * orderable there or the scale target of the ladder role is not sold there.
 */
function placeableSet(
  Provider: ProviderClass,
  prefs: CapacityPreferences,
  region: string,
  roles: string[],
  keyRole: string | null,
): Record<string, string> | null {
  const set = cheapestRoleSet(Provider, region, roles);
  if (!set) return null;
  if (keyRole) {
    const key = set.types[keyRole];
    const target = prefs.scaleTo[key];
    if (!target) throw noScaleTarget(key);
    if (!Provider._locationTypes?.[region]?.has(target)) return null;
  }
  return set.types;
}

function resolved(region: string, types: Record<string, string>): ResolvedCapacity {
  return { region, serverType: undefined, types, datacenter: region };
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
    const types = placeableSet(Provider, prefs, region, roles, scaleKeyRole(mode));
    if (types) return resolved(region, types);
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
 * HA: a primary region and a distinct standby region on the same continent
 * (`Provider.REGION_CONTINENT`), each where the picker places its side's
 * roles. The two sides may land on different types, each the cheapest where
 * it sits, as a customer's HA pair does. The scale target is checked where
 * the ladder key lives, on the primary.
 */
export async function resolveCapacityPair(
  prefs: CapacityPreferences,
  token: string,
  options: ResolveOptions = {},
): Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }> {
  const provider = options.provider ?? 'hetzner';
  const mode = options.mode ?? 'compose-ha';
  const Provider = await loadProvider(provider, token, options.loadCatalog);
  const continentOf: Record<string, string> = Provider.REGION_CONTINENT ?? {};

  for (const p of prefs.regions) {
    const primaryTypes = placeableSet(Provider, prefs, p, primaryRoles(mode), scaleKeyRole(mode));
    if (!primaryTypes || !continentOf[p]) continue;
    for (const s of prefs.regions) {
      if (s === p || continentOf[s] !== continentOf[p]) continue;
      const standbyTypes = placeableSet(Provider, prefs, s, standbyRoles(mode), null);
      if (standbyTypes) {
        return { primary: resolved(p, primaryTypes), standby: resolved(s, standbyTypes) };
      }
    }
  }

  throw new Error(
    `region-resolver: HA needs two distinct same-continent ${Provider.NAME ?? provider} ` +
      `regions that can place the default ${mode} sizes, none found. ` +
      `tried regions=[${prefs.regions.join(',')}].`,
  );
}

/**
 * The scale step's target: the ladder entry for the type the deploy recorded
 * in `.vibecarbon.json` (compose: `serverType`; k8s: `masterServerType`,
 * since `scale -type` resizes every role). Throws when the deploy recorded no
 * type, or when the ladder has no entry for it.
 */
export function deployedScaleTarget(
  envConfig: { serverType?: string; masterServerType?: string },
  mode: CapacityMode,
  scaleTo: Readonly<Record<string, string>>,
): string {
  const field = mode.startsWith('k8s') ? 'masterServerType' : 'serverType';
  const type = envConfig[field];
  if (!type) {
    throw new Error(
      `the deploy recorded no ${field} in .vibecarbon.json, so the scale target is unknown`,
    );
  }
  const target = scaleTo[type];
  if (!target) throw noScaleTarget(type);
  return target;
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
