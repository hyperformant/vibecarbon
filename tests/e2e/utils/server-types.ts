/**
 * Provider-aware server-type snapshot capture for verify-scale.
 *
 * Query the cloud provider for the current server-type/size of every IP in
 * `ips`. Returns `{ ip: typeName }`. Best-effort: an unreachable API or IPs
 * that don't match any project server fall back to an empty record so the
 * verify-scale assertion (`tests/e2e/scenarios/_run-lifecycle.ts`) can
 * degrade gracefully to the stdout-grep path rather than hard-failing.
 *
 * Extracted from a `_run-lifecycle.ts`-local closure (M3 Task 9e) so it's
 * independently unit-testable with a mocked `fetch` — same rationale as
 * Task 8's `extractRegistryMirrorAddress` (see `ssh.ts`). The Hetzner path
 * kept the pre-extraction closure's retry/backoff constants; since the
 * 2026-07-30 truncated-listing sweep it also walks pagination like its
 * DigitalOcean sibling. The old single `per_page=100` GET exceeded the
 * documented max of 50 (Hetzner Cloud OpenAPI spec: "The default value is
 * 25, the maximum value is 50 except otherwise specified"), so it was out
 * of contract and served at most one bounded page — fine at today's batch
 * sizes, but exactly the "fits today" assumption that leaked six orphaned
 * volumes elsewhere.
 */

import { type PageDialect, walkProviderPages } from './provider-pages.js';

export type ServerTypeProvider = 'hetzner' | 'digitalocean' | 'linode' | 'vultr' | 'scaleway';

export interface FetchServerTypesOptions {
  /** Cloud provider to query. Defaults to 'hetzner' — every existing caller is unaffected. */
  provider?: ServerTypeProvider;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Scenario tag prefix for warn logging (e.g. `[k8s]`). */
  tag?: string;
}

// 6 attempts × 15s timeout + exponential backoff 1+2+4+8+16=31s → worst-case
// ~121s, well under verify-scale's 600s step budget. Bumped from 3 attempts
// after iter-serial2 k8s verify-scale tripped on a >50s Hetzner Cloud API
// outage (`fetch failed` on every attempt). Retry on transient `fetch
// failed` (Node-side undici blip we've seen hit S3, Hetzner Cloud, and
// Cloudflare across this session). Without this, a single transient is
// enough to push verify-scale into the empty-snapshots fallback path that
// then has to grep stdout — and compose scale.js's "Scale complete!"
// tokens didn't match the old grep regex, so an upstream transient
// cascaded into a confusing verify-scale "no-op" failure observed
// 2026-04-28. Shared verbatim by both providers (M3 Task 9e).
const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 15_000;

// Pagination guard, shared by both providers — same ≤20-page walk Task 5b
// established in src/lib/providers/digitalocean.js (listServers,
// findServersByName). The account behind the shared token can hold more
// servers/droplets than one page (parallel local + CI matrices share it),
// and a truncated listing here doesn't fail — it silently pushes
// verify-scale onto its weaker stdout-grep fallback.
const MAX_PAGES = 20;

interface HetznerServer {
  public_net?: { ipv4?: { ip?: string } };
  server_type?: { name?: string };
}

interface DigitalOceanDroplet {
  networks?: { v4?: Array<{ type?: string; ip_address?: string }> };
  size_slug?: string;
}

interface LinodeInstance {
  ipv4?: string[];
  type?: string;
}

interface VultrInstance {
  main_ip?: string;
  plan?: string;
}

interface ScalewayServer {
  commercial_type?: string;
  public_ips?: Array<{ family?: string; address?: string }>;
  public_ip?: { address?: string };
}

// Zones — lockstep with ScalewayProvider.REGIONS (the Instance API is
// zone-scoped; a listing exists per zone, not per account).
const SCALEWAY_ZONES = ['fr-par-1', 'fr-par-2', 'nl-ams-1', 'nl-ams-2'];

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** One server listing: where it is, how it pages, and which zone it is (Scaleway). */
interface TypeListing {
  dialect: PageDialect;
  url: string;
  key?: string;
  perPage: number;
  /** Named in the warning when this listing answers non-ok. */
  where?: string;
}

/**
 * How each provider's server listing is read: its listings, its auth header,
 * and where a row keeps the public IPv4 and the type name. Everything else
 * (the page walk, the non-ok and throw contract) is fetchTypesOnce below.
 *
 * The account behind the shared token can hold more servers than one page
 * (parallel local + CI matrices share it), and a truncated listing here
 * doesn't fail: it silently pushes verify-scale onto its weaker stdout-grep
 * fallback. So every listing is walked (tests/e2e/utils/provider-pages.ts).
 *
 * Multiple parallel e2e scenarios share the same token, so each listing
 * pulls every project's servers; fine, because rows are then indexed by IP,
 * which is unique cluster-wide.
 */
const TYPE_FETCHERS: Record<
  ServerTypeProvider,
  {
    /** The provider's name in the non-ok warning. */
    name: string;
    headers: (token: string) => Record<string, string>;
    listings: TypeListing[];
    // biome-ignore lint/suspicious/noExplicitAny: rows are provider JSON, one shape per provider
    row: (row: any) => { ip?: string; type?: string };
  }
> = {
  // `server_type.name`. per_page=50 is the Cloud API's documented maximum.
  hetzner: {
    name: 'Hetzner',
    headers: bearer,
    listings: [
      {
        dialect: 'hetzner',
        url: 'https://api.hetzner.cloud/v1/servers',
        key: 'servers',
        perPage: 50,
      },
    ],
    row: (srv: HetznerServer) => ({ ip: srv.public_net?.ipv4?.ip, type: srv.server_type?.name }),
  },
  // `size_slug` is DO's analog of Hetzner's `server_type.name`; a droplet's
  // public IPv4 lives in `networks.v4[]` keyed by `type: 'public'` (the
  // shape `DigitalOceanProvider.getPublicIP` reads).
  digitalocean: {
    name: 'DigitalOcean',
    headers: bearer,
    listings: [
      {
        dialect: 'digitalocean',
        url: 'https://api.digitalocean.com/v2/droplets',
        key: 'droplets',
        perPage: 50,
      },
    ],
    row: (droplet: DigitalOceanDroplet) => ({
      ip: droplet.networks?.v4?.find((n) => n.type === 'public')?.ip_address,
      type: droplet.size_slug,
    }),
  },
  // `type`; an instance's public IPv4 is `ipv4[0]` (the shape
  // `LinodeProvider.getPublicIP` reads).
  linode: {
    name: 'Linode',
    headers: bearer,
    listings: [
      { dialect: 'linode', url: 'https://api.linode.com/v4/linode/instances', perPage: 100 },
    ],
    row: (instance: LinodeInstance) => ({ ip: instance.ipv4?.[0], type: instance.type }),
  },
  // `plan`; an instance's public IPv4 is `main_ip`.
  vultr: {
    name: 'Vultr',
    headers: bearer,
    listings: [
      {
        dialect: 'vultr',
        url: 'https://api.vultr.com/v2/instances',
        key: 'instances',
        perPage: 100,
      },
    ],
    row: (instance: VultrInstance) => ({ ip: instance.main_ip, type: instance.plan }),
  },
  // One listing PER ZONE. `commercial_type`; the public IPv4 is the first
  // `family: 'inet'` entry of `public_ips[]` (legacy `public_ip.address`
  // fallback — the shape `ScalewayProvider.getPublicIP` reads). Auth is
  // `X-Auth-Token` (the secret key), not Bearer. A non-ok in ANY zone
  // degrades the whole snapshot.
  scaleway: {
    name: 'Scaleway',
    headers: (token) => ({ 'X-Auth-Token': token }),
    listings: SCALEWAY_ZONES.map((zone) => ({
      dialect: 'scaleway' as const,
      url: `https://api.scaleway.com/instance/v1/zones/${zone}/servers`,
      key: 'servers',
      perPage: 100,
      where: zone,
    })),
    row: (srv: ScalewayServer) => ({
      ip:
        srv.public_ips?.find((p) => p.family === 'inet' && p.address)?.address ??
        srv.public_ip?.address,
      type: srv.commercial_type,
    }),
  },
};

/**
 * One pass over a provider's listings. Returns `null` (not a throw) on a
 * non-ok response on ANY page: that's a definitive "no" the caller should
 * NOT retry, and a partial snapshot must never feed verify-scale a
 * misleadingly-partial "types changed" assertion. A thrown error (network
 * failure, timeout, bad JSON) IS retry-worthy and propagates to the caller.
 *
 * A listing that runs past the page guard keeps the rows it read, as the
 * per-provider loops this replaced did.
 */
async function fetchTypesOnce(
  provider: ServerTypeProvider,
  ips: string[],
  token: string,
  fetchFn: typeof fetch,
  tag: string,
): Promise<Record<string, string> | null> {
  const source = TYPE_FETCHERS[provider];
  const out: Record<string, string> = {};
  for (const listing of source.listings) {
    const walk = await walkProviderPages(listing.dialect, listing.url, {
      key: listing.key,
      perPage: listing.perPage,
      maxPages: MAX_PAGES,
      fetchImpl: fetchFn,
      headers: source.headers(token),
      timeoutMs: TIMEOUT_MS,
      onThrow: 'throw',
    });
    if (walk.status !== undefined) {
      console.warn(
        `${tag} [verify-scale] ${source.name} API returned ${walk.status} when fetching server types${listing.where ? ` (${listing.where})` : ''}`,
      );
      return null;
    }
    for (const item of walk.items) {
      const { ip, type } = source.row(item);
      if (ip && type && ips.includes(ip)) out[ip] = type;
    }
  }
  return out;
}

/**
 * Query `provider` for the server-type/size of every IP in `ips`. See the
 * module doc for the degrade-to-`{}` contract.
 */
export async function fetchServerTypes(
  ips: string[],
  token: string,
  options: FetchServerTypesOptions = {},
): Promise<Record<string, string>> {
  if (ips.length === 0 || !token) return {};

  const provider = options.provider ?? 'hetzner';
  const fetchFn = options.fetchFn ?? fetch;
  const tag = options.tag ?? '';
  if (!TYPE_FETCHERS[provider]) {
    throw new Error(
      `server-types: no type fetcher registered for provider '${String(provider)}' — add a TYPE_FETCHERS row.`,
    );
  }

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fetchTypesOnce(provider, ips, token, fetchFn, tag);
      if (result === null) return {};
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped). Linear was too
        // tight — a 30+s Hetzner API blip exhausted retries before recovery.
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 16_000);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  console.warn(
    `${tag} [verify-scale] fetchServerTypes failed after ${MAX_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
  return {};
}
