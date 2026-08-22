/**
 * Hetzner capacity resolver for e2e scenarios.
 *
 * The matrix used to hardcode `(region, serverType, scaleToType)` per
 * scenario. Hetzner's per-DC capacity for cx/cpx/cax shifts through the
 * day; one bad slot in `hel1` for cx33 (the scale target) used to fail
 * an entire scenario at the `scale` step even though `nbg1` had headroom
 * the whole time. This resolver queries `/v1/datacenters` once at
 * preflight and picks the first region in the operator's preferred order
 * where BOTH `serverType` and `scaleToType` of some preferred type-pair
 * are currently available.
 *
 * Scenarios declare preferences instead of literals — see
 * `CapacityPreferences` below. The runner calls `resolveCapacity` per
 * scenario and feeds the result into `ScenarioConfig` so downstream
 * lifecycle code (which still reads `serverType` / `region` /
 * `scaleToType` directly) is unaffected.
 *
 * HA scenarios call `resolveCapacityPair` to get two distinct regions
 * both with the same type-pair available — picking different type-pairs
 * for primary vs standby would mean architecture mismatch on cluster
 * join (an x86 master can't run an ARM worker, etc.).
 */

export interface CapacityPreferences {
  /** Hetzner location names in operator-preferred order (best first). */
  regions: readonly string[];
  /**
   * `[deployType, scaleToType]` pairs in preference order. The pair must
   * be the same arch family — they share kubelet images and registries.
   */
  typePairs: readonly (readonly [string, string])[];
}

export interface ResolvedCapacity {
  region: string;
  serverType: string;
  scaleToType: string;
  /** The full datacenter name (e.g. `nbg1-dc3`) for diagnostics. */
  datacenter: string;
}

interface HetznerDatacenter {
  name: string;
  location: { name: string };
  server_types: { available: number[]; supported: number[] };
}

interface HetznerServerType {
  id: number;
  name: string;
}

/** A single DigitalOcean droplet size, as returned by `GET /v2/sizes`. */
interface DigitalOceanSize {
  slug: string;
  regions: string[];
}

const HETZNER_API = 'https://api.hetzner.cloud/v1';
const DIGITALOCEAN_API = 'https://api.digitalocean.com/v2';

/** Provider a scenario provisions against. Defaults to 'hetzner' everywhere upstream. */
export type CapacityProvider = 'hetzner' | 'digitalocean' | 'linode' | 'vultr' | 'scaleway';

let hetznerCache: { datacenters: HetznerDatacenter[]; nameToId: Map<string, number> } | null = null;
let digitaloceanCache: { sizeRegions: Map<string, Set<string>> } | null = null;
let vultrCache: { planLocations: Map<string, Set<string>> } | null = null;
let scalewayCache: Map<string, Set<string>> | null = null;

/** Reset the in-process API cache(s). Tests use this between mocked runs. */
export function clearResolverCache(): void {
  hetznerCache = null;
  digitaloceanCache = null;
  vultrCache = null;
  scalewayCache = null;
}

async function loadHetznerInventory(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ datacenters: HetznerDatacenter[]; nameToId: Map<string, number> }> {
  if (hetznerCache) return hetznerCache;
  const headers = { Authorization: `Bearer ${token}` };
  const [dcRes, stRes] = await Promise.all([
    fetchFn(`${HETZNER_API}/datacenters`, { headers }),
    fetchFn(`${HETZNER_API}/server_types?per_page=100`, { headers }),
  ]);
  if (!dcRes.ok) throw new Error(`region-resolver: GET /datacenters → ${dcRes.status}`);
  if (!stRes.ok) throw new Error(`region-resolver: GET /server_types → ${stRes.status}`);
  const dcData = (await dcRes.json()) as { datacenters: HetznerDatacenter[] };
  const stData = (await stRes.json()) as { server_types: HetznerServerType[] };
  const nameToId = new Map<string, number>(stData.server_types.map((t) => [t.name, t.id]));
  hetznerCache = { datacenters: dcData.datacenters, nameToId };
  return hetznerCache;
}

/**
 * DigitalOcean has no Hetzner-style datacenters/server_types split — a
 * single `GET /v2/sizes` call returns every droplet size with its
 * available regions inline, so region availability is just a slug → region
 * set lookup (no per-datacenter granularity to diagnose against; a DO
 * "region" like `nyc3` IS the deployable unit).
 */
async function loadDigitalOceanInventory(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ sizeRegions: Map<string, Set<string>> }> {
  if (digitaloceanCache) return digitaloceanCache;
  const res = await fetchFn(`${DIGITALOCEAN_API}/sizes?per_page=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`region-resolver: GET /sizes → ${res.status}`);
  const data = (await res.json()) as { sizes: DigitalOceanSize[] };
  const sizeRegions = new Map<string, Set<string>>(
    data.sizes.map((s) => [s.slug, new Set(s.regions)]),
  );
  digitaloceanCache = { sizeRegions };
  return digitaloceanCache;
}

/**
 * Pick a single `(region, serverType, scaleToType)` combo where both
 * types are available in some datacenter for one of the preferred
 * regions. Throws with a diagnostic listing what was tried if nothing
 * fits — preflight catches that and aborts the matrix before any
 * scenario provisions.
 *
 * @param excludeRegions Regions to skip (used by `resolveCapacityPair`
 *                       to force the standby into a different location).
 */
export async function resolveCapacity(
  prefs: CapacityPreferences,
  token: string,
  options: {
    excludeRegions?: readonly string[];
    fetchFn?: typeof fetch;
    /** Which cloud to resolve against. Defaults to 'hetzner' — every existing caller is unaffected. */
    provider?: CapacityProvider;
  } = {},
): Promise<ResolvedCapacity> {
  return capacityResolverFor(options.provider).resolve(prefs, token, options);
}

async function resolveHetznerCapacity(
  prefs: CapacityPreferences,
  token: string,
  options: {
    excludeRegions?: readonly string[];
    fetchFn?: typeof fetch;
  } = {},
): Promise<ResolvedCapacity> {
  const { datacenters, nameToId } = await loadHetznerInventory(token, options.fetchFn ?? fetch);
  const excluded = new Set(options.excludeRegions ?? []);

  for (const region of prefs.regions) {
    if (excluded.has(region)) continue;
    const dcsForRegion = datacenters.filter((dc) => dc.location.name === region);
    if (dcsForRegion.length === 0) continue;
    for (const [deployType, scaleType] of prefs.typePairs) {
      const deployId = nameToId.get(deployType);
      const scaleId = nameToId.get(scaleType);
      if (deployId == null || scaleId == null) continue;
      for (const dc of dcsForRegion) {
        const avail = new Set(dc.server_types.available);
        if (avail.has(deployId) && avail.has(scaleId)) {
          return {
            region,
            serverType: deployType,
            scaleToType: scaleType,
            datacenter: dc.name,
          };
        }
      }
    }
  }

  const tried = prefs.regions.filter((r) => !excluded.has(r));
  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: no Hetzner region has a viable type-pair available right now. ` +
      `tried regions=[${tried.join(',')}] type-pairs=[${pairs}]. ` +
      `Hetzner capacity is fluid — try again in a few minutes, or add additional ` +
      `x86 type-pair fallbacks to the scenario's capacityPreferences (ARM is not ` +
      `an option: vibecarbon is amd64-only).`,
  );
}

/**
 * HA: pick two distinct regions both with the SAME type-pair available.
 * The standby's resolver excludes the primary's region. We pin both
 * sides to the same type-pair (rather than re-resolving independently)
 * so cross-region replication never has to bridge an arch mismatch.
 */
export async function resolveCapacityPair(
  prefs: CapacityPreferences,
  token: string,
  options: { fetchFn?: typeof fetch; provider?: CapacityProvider } = {},
): Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }> {
  return capacityResolverFor(options.provider).resolvePair(prefs, token, options);
}

async function resolveHetznerCapacityPair(
  prefs: CapacityPreferences,
  token: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }> {
  const { datacenters, nameToId } = await loadHetznerInventory(token, options.fetchFn ?? fetch);

  // Walk type-pairs in preference order; for each, find at least two
  // distinct regions where the pair is available. This is stricter than
  // resolving primary then standby separately, which could legally pick
  // mismatched families for the two sides.
  for (const [deployType, scaleType] of prefs.typePairs) {
    const deployId = nameToId.get(deployType);
    const scaleId = nameToId.get(scaleType);
    if (deployId == null || scaleId == null) continue;

    const viableRegions: { region: string; datacenter: string }[] = [];
    for (const region of prefs.regions) {
      const dc = datacenters.find(
        (d) =>
          d.location.name === region &&
          d.server_types.available.includes(deployId) &&
          d.server_types.available.includes(scaleId),
      );
      if (dc) viableRegions.push({ region, datacenter: dc.name });
      if (viableRegions.length >= 2) break;
    }

    if (viableRegions.length >= 2) {
      const [p, s] = viableRegions;
      return {
        primary: {
          region: p.region,
          serverType: deployType,
          scaleToType: scaleType,
          datacenter: p.datacenter,
        },
        standby: {
          region: s.region,
          serverType: deployType,
          scaleToType: scaleType,
          datacenter: s.datacenter,
        },
      };
    }
  }

  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: HA needs two distinct regions sharing one type-pair, none found. ` +
      `tried regions=[${prefs.regions.join(',')}] type-pairs=[${pairs}].`,
  );
}

/**
 * DigitalOcean counterpart to the Hetzner walk above `resolveCapacity`
 * performs — same preference-order semantics, but region availability
 * comes straight off each size's `regions` array (see
 * `loadDigitalOceanInventory`), so there's no per-datacenter inner loop.
 * `datacenter` in the result is just the region slug — DO exposes no
 * finer-grained placement id via `/v2/sizes`.
 */
async function resolveDigitalOceanCapacity(
  prefs: CapacityPreferences,
  token: string,
  options: { excludeRegions?: readonly string[]; fetchFn?: typeof fetch } = {},
): Promise<ResolvedCapacity> {
  const { sizeRegions } = await loadDigitalOceanInventory(token, options.fetchFn ?? fetch);
  const excluded = new Set(options.excludeRegions ?? []);

  for (const region of prefs.regions) {
    if (excluded.has(region)) continue;
    for (const [deployType, scaleType] of prefs.typePairs) {
      const deployRegions = sizeRegions.get(deployType);
      const scaleRegions = sizeRegions.get(scaleType);
      if (!deployRegions || !scaleRegions) continue;
      if (deployRegions.has(region) && scaleRegions.has(region)) {
        return { region, serverType: deployType, scaleToType: scaleType, datacenter: region };
      }
    }
  }

  const tried = prefs.regions.filter((r) => !excluded.has(r));
  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: no DigitalOcean region has a viable type-pair available right now. ` +
      `tried regions=[${tried.join(',')}] type-pairs=[${pairs}].`,
  );
}

/** DigitalOcean counterpart to `resolveCapacityPair` — see its doc. */
async function resolveDigitalOceanCapacityPair(
  prefs: CapacityPreferences,
  token: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }> {
  const { sizeRegions } = await loadDigitalOceanInventory(token, options.fetchFn ?? fetch);

  for (const [deployType, scaleType] of prefs.typePairs) {
    const deployRegions = sizeRegions.get(deployType);
    const scaleRegions = sizeRegions.get(scaleType);
    if (!deployRegions || !scaleRegions) continue;

    const viable = prefs.regions.filter((r) => deployRegions.has(r) && scaleRegions.has(r));
    if (viable.length >= 2) {
      const [p, s] = viable;
      return {
        primary: { region: p, serverType: deployType, scaleToType: scaleType, datacenter: p },
        standby: { region: s, serverType: deployType, scaleToType: scaleType, datacenter: s },
      };
    }
  }

  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: HA needs two distinct DigitalOcean regions sharing one type-pair, none found. ` +
      `tried regions=[${prefs.regions.join(',')}] type-pairs=[${pairs}].`,
  );
}

/**
 * Apply the `E2E_REGIONS` env override (comma-separated Hetzner location
 * names) to a scenario's capacity preferences. Used by CI to pin the matrix
 * to US regions (`ash,hil`) so perf numbers are measured runner→US-DC
 * instead of operator-uplink→EU. Returns the input unchanged when the
 * override is absent or empty — local runs are unaffected.
 */
/**
 * Linode counterpart to the walks above. Linode's type catalog is GLOBAL —
 * `GET /v4/linode/types` carries no region axis and the Standard line is
 * uniformly available (linode-step0-audit.md) — so "capacity resolution"
 * reduces to: verify both pair members exist in the live catalog (a retired
 * slug must fail loudly here, not 20 minutes into a deploy), then take the
 * first non-excluded preferred region. The types endpoint is public but the
 * token is sent for rate-limit accounting parity.
 */
async function loadLinodeTypeIds(token: string, fetchFn: typeof fetch): Promise<Set<string>> {
  const ids = new Set<string>();
  let page = 1;
  for (let guard = 0; guard < 20; guard++) {
    const res = await fetchFn(
      `https://api.linode.com/v4/linode/types?page=${page}&page_size=200`,
      token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    );
    if (!res.ok) {
      throw new Error(`region-resolver: Linode types listing failed (${res.status})`);
    }
    const data = (await res.json()) as {
      data?: Array<{ id: string }>;
      page?: number;
      pages?: number;
    };
    for (const t of data.data ?? []) ids.add(t.id);
    if (!data.pages || page >= data.pages) break;
    page++;
  }
  return ids;
}

async function resolveLinodeCapacity(
  prefs: CapacityPreferences,
  token: string,
  options: { excludeRegions?: readonly string[]; fetchFn?: typeof fetch } = {},
): Promise<ResolvedCapacity> {
  const typeIds = await loadLinodeTypeIds(token, options.fetchFn ?? fetch);
  const excluded = new Set(options.excludeRegions ?? []);

  for (const region of prefs.regions) {
    if (excluded.has(region)) continue;
    for (const [deployType, scaleType] of prefs.typePairs) {
      if (typeIds.has(deployType) && typeIds.has(scaleType)) {
        return { region, serverType: deployType, scaleToType: scaleType, datacenter: region };
      }
    }
  }

  const tried = prefs.regions.filter((r) => !excluded.has(r));
  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: no Linode region has a viable type-pair available right now. ` +
      `tried regions=[${tried.join(',')}] type-pairs=[${pairs}].`,
  );
}

/** Linode counterpart to `resolveCapacityPair` — see its doc. */
async function resolveLinodeCapacityPair(
  prefs: CapacityPreferences,
  token: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }> {
  const typeIds = await loadLinodeTypeIds(token, options.fetchFn ?? fetch);

  for (const [deployType, scaleType] of prefs.typePairs) {
    if (!typeIds.has(deployType) || !typeIds.has(scaleType)) continue;
    if (prefs.regions.length >= 2) {
      const [p, s] = prefs.regions;
      return {
        primary: { region: p, serverType: deployType, scaleToType: scaleType, datacenter: p },
        standby: { region: s, serverType: deployType, scaleToType: scaleType, datacenter: s },
      };
    }
  }

  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: HA needs two distinct Linode regions sharing one type-pair, none found. ` +
      `tried regions=[${prefs.regions.join(',')}] type-pairs=[${pairs}].`,
  );
}

/**
 * Vultr counterpart to the walks above. Vultr's catalog sits between
 * Hetzner's and Linode's: `GET /v2/plans` is a single public listing (no
 * datacenters/server_types split) but each plan carries its own
 * `locations: []` array, so there IS a real per-region availability axis to
 * check — a plan absent from a region is a hard create failure, not a
 * capacity blip. Cursor pagination (`meta.links.next` fed back as
 * `&cursor=`), not a page counter — see sweep-vultr.ts's header. The
 * endpoint is public; the token rides along for rate-limit accounting
 * parity with the Linode loader.
 */
async function loadVultrPlanLocations(
  token: string,
  fetchFn: typeof fetch,
): Promise<Map<string, Set<string>>> {
  if (vultrCache) return vultrCache.planLocations;
  const planLocations = new Map<string, Set<string>>();
  let cursor = '';
  for (let guard = 0; guard < 20; guard++) {
    const url =
      `https://api.vultr.com/v2/plans?per_page=500` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await fetchFn(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    if (!res.ok) {
      throw new Error(`region-resolver: Vultr plans listing failed (${res.status})`);
    }
    const data = (await res.json()) as {
      plans?: Array<{ id: string; locations?: string[] }>;
      meta?: { links?: { next?: string } };
    };
    for (const p of data.plans ?? []) planLocations.set(p.id, new Set(p.locations ?? []));
    const next = data.meta?.links?.next;
    if (!next) break;
    cursor = next;
  }
  vultrCache = { planLocations };
  return planLocations;
}

async function resolveVultrCapacity(
  prefs: CapacityPreferences,
  token: string,
  options: { excludeRegions?: readonly string[]; fetchFn?: typeof fetch } = {},
): Promise<ResolvedCapacity> {
  const planLocations = await loadVultrPlanLocations(token, options.fetchFn ?? fetch);
  const excluded = new Set(options.excludeRegions ?? []);

  for (const region of prefs.regions) {
    if (excluded.has(region)) continue;
    for (const [deployType, scaleType] of prefs.typePairs) {
      const deployRegions = planLocations.get(deployType);
      const scaleRegions = planLocations.get(scaleType);
      // Both members must list the region: scaling into a plan the region
      // doesn't carry fails at the scale step, 20 minutes in.
      if (!deployRegions || !scaleRegions) continue;
      if (deployRegions.has(region) && scaleRegions.has(region)) {
        return { region, serverType: deployType, scaleToType: scaleType, datacenter: region };
      }
    }
  }

  const tried = prefs.regions.filter((r) => !excluded.has(r));
  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: no Vultr region has a viable type-pair available right now. ` +
      `tried regions=[${tried.join(',')}] type-pairs=[${pairs}].`,
  );
}

/** Vultr counterpart to `resolveCapacityPair` — see its doc. */
async function resolveVultrCapacityPair(
  prefs: CapacityPreferences,
  token: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }> {
  const planLocations = await loadVultrPlanLocations(token, options.fetchFn ?? fetch);

  for (const [deployType, scaleType] of prefs.typePairs) {
    const deployRegions = planLocations.get(deployType);
    const scaleRegions = planLocations.get(scaleType);
    if (!deployRegions || !scaleRegions) continue;

    const viable = prefs.regions.filter((r) => deployRegions.has(r) && scaleRegions.has(r));
    if (viable.length >= 2) {
      const [p, s] = viable;
      return {
        primary: { region: p, serverType: deployType, scaleToType: scaleType, datacenter: p },
        standby: { region: s, serverType: deployType, scaleToType: scaleType, datacenter: s },
      };
    }
  }

  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: HA needs two distinct Vultr regions sharing one type-pair, none found. ` +
      `tried regions=[${prefs.regions.join(',')}] type-pairs=[${pairs}].`,
  );
}

/**
 * Scaleway counterpart to the walks above — the only provider whose
 * capacity axis must be resolved JOINTLY per (zone, type): NO instance
 * type exists in all ten Scaleway zones (live per-zone catalog 2026-08-09,
 * step-0 audit "per-zone catalog divergence"), and stock is a real
 * per-type enum. Two PUBLIC endpoints answer both halves per zone:
 *   GET /instance/v1/zones/{zone}/products/servers      (catalog presence)
 *   GET /instance/v1/zones/{zone}/products/servers/availability (stock)
 * A type only counts as available in a zone when it is IN the catalog AND
 * its availability is not 'shortage' ('scarce' still sells — treating it
 * as absent would fail runs Scaleway would happily place, while 'shortage'
 * is the Hetzner resource_unavailable class this resolver exists to dodge
 * at preflight rather than at create time). Both endpoints page at 100.
 */
async function loadScalewayZoneTypes(
  zone: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<Set<string>> {
  scalewayCache ??= new Map();
  const cached = scalewayCache.get(zone);
  if (cached) return cached;

  const headers = token ? { 'X-Auth-Token': token } : undefined;
  const walk = async (path: string): Promise<Record<string, { availability?: string }>> => {
    const out: Record<string, { availability?: string }> = {};
    for (let page = 1; page <= 20; page++) {
      const res = await fetchFn(
        `https://api.scaleway.com/instance/v1/zones/${zone}${path}?per_page=100&page=${page}`,
        headers ? { headers } : {},
      );
      if (!res.ok) {
        throw new Error(`region-resolver: Scaleway ${zone}${path} listing failed (${res.status})`);
      }
      const data = (await res.json()) as { servers?: Record<string, { availability?: string }> };
      const pageServers = data.servers ?? {};
      Object.assign(out, pageServers);
      if (Object.keys(pageServers).length < 100) break;
    }
    return out;
  };

  const [catalog, availability] = await Promise.all([
    walk('/products/servers'),
    walk('/products/servers/availability'),
  ]);
  const available = new Set(
    Object.keys(catalog).filter((t) => availability[t]?.availability !== 'shortage'),
  );
  scalewayCache.set(zone, available);
  return available;
}

async function resolveScalewayCapacity(
  prefs: CapacityPreferences,
  token: string,
  options: { excludeRegions?: readonly string[]; fetchFn?: typeof fetch } = {},
): Promise<ResolvedCapacity> {
  const fetchFn = options.fetchFn ?? fetch;
  const excluded = new Set(options.excludeRegions ?? []);

  for (const zone of prefs.regions) {
    if (excluded.has(zone)) continue;
    const available = await loadScalewayZoneTypes(zone, token, fetchFn);
    for (const [deployType, scaleType] of prefs.typePairs) {
      if (available.has(deployType) && available.has(scaleType)) {
        return { region: zone, serverType: deployType, scaleToType: scaleType, datacenter: zone };
      }
    }
  }

  const tried = prefs.regions.filter((r) => !excluded.has(r));
  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: no Scaleway zone has a viable type-pair in-catalog and in-stock right now. ` +
      `tried zones=[${tried.join(',')}] type-pairs=[${pairs}]. ` +
      `Scaleway's catalog is genuinely per-zone (no type spans all zones) and stock is a ` +
      `per-type enum — try again shortly or widen the zone list.`,
  );
}

/** Scaleway counterpart to `resolveCapacityPair` — see its doc. */
async function resolveScalewayCapacityPair(
  prefs: CapacityPreferences,
  token: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }> {
  const fetchFn = options.fetchFn ?? fetch;

  for (const [deployType, scaleType] of prefs.typePairs) {
    const viable: string[] = [];
    for (const zone of prefs.regions) {
      const available = await loadScalewayZoneTypes(zone, token, fetchFn);
      if (available.has(deployType) && available.has(scaleType)) viable.push(zone);
      if (viable.length >= 2) break;
    }
    if (viable.length >= 2) {
      const [p, s] = viable;
      return {
        primary: { region: p, serverType: deployType, scaleToType: scaleType, datacenter: p },
        standby: { region: s, serverType: deployType, scaleToType: scaleType, datacenter: s },
      };
    }
  }

  const pairs = prefs.typePairs.map(([a, b]) => `${a}+${b}`).join(', ');
  throw new Error(
    `region-resolver: HA needs two distinct Scaleway zones sharing one type-pair, none found. ` +
      `tried zones=[${prefs.regions.join(',')}] type-pairs=[${pairs}].`,
  );
}

/**
 * Provider → capacity-resolver dispatch (2026-08-07 audit: was an if/else
 * whose ELSE branch silently resolved Hetzner capacity for any provider id
 * it didn't recognize — provider N+1 would have "resolved" against the
 * wrong cloud's inventory). Adding a provider means adding a row here;
 * an unknown id throws instead of defaulting.
 */
const CAPACITY_RESOLVERS: Record<
  CapacityProvider,
  {
    resolve: (
      prefs: CapacityPreferences,
      token: string,
      options: { excludeRegions?: readonly string[]; fetchFn?: typeof fetch },
    ) => Promise<ResolvedCapacity>;
    resolvePair: (
      prefs: CapacityPreferences,
      token: string,
      options: { fetchFn?: typeof fetch },
    ) => Promise<{ primary: ResolvedCapacity; standby: ResolvedCapacity }>;
  }
> = {
  hetzner: { resolve: resolveHetznerCapacity, resolvePair: resolveHetznerCapacityPair },
  digitalocean: {
    resolve: resolveDigitalOceanCapacity,
    resolvePair: resolveDigitalOceanCapacityPair,
  },
  linode: { resolve: resolveLinodeCapacity, resolvePair: resolveLinodeCapacityPair },
  vultr: { resolve: resolveVultrCapacity, resolvePair: resolveVultrCapacityPair },
  scaleway: { resolve: resolveScalewayCapacity, resolvePair: resolveScalewayCapacityPair },
};

function capacityResolverFor(provider: CapacityProvider | undefined) {
  const impl = CAPACITY_RESOLVERS[provider ?? 'hetzner'];
  if (!impl) {
    throw new Error(
      `region-resolver: no capacity resolver registered for provider '${String(provider)}' — add a CAPACITY_RESOLVERS row.`,
    );
  }
  return impl;
}

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
