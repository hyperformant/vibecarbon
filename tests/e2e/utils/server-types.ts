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

export type ServerTypeProvider = 'hetzner' | 'digitalocean' | 'linode' | 'vultr' | 'scaleway';

export interface FetchServerTypesOptions {
  /** Cloud provider to query. Defaults to 'hetzner' — every existing caller is unaffected. */
  provider?: ServerTypeProvider;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Scenario tag prefix for warn logging (e.g. `[k8s]`). */
  tag?: string;
}

const HETZNER_SERVERS_URL = 'https://api.hetzner.cloud/v1/servers?per_page=50';
const DIGITALOCEAN_DROPLETS_URL = 'https://api.digitalocean.com/v2/droplets?per_page=50';
const LINODE_INSTANCES_URL = 'https://api.linode.com/v4/linode/instances?page_size=100';
const VULTR_INSTANCES_URL = 'https://api.vultr.com/v2/instances?per_page=100';

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

interface HetznerServersResponse {
  servers?: Array<{
    public_net?: { ipv4?: { ip?: string } };
    server_type?: { name?: string };
  }>;
  meta?: { pagination?: { next_page?: number | null } };
}

interface DigitalOceanDropletsResponse {
  droplets?: Array<{
    networks?: { v4?: Array<{ type?: string; ip_address?: string }> };
    size_slug?: string;
  }>;
  links?: { pages?: { next?: string } };
}

/**
 * Paginated Hetzner fetch, walking `GET /v1/servers` behind
 * `meta.pagination.next_page` (the same walk shape as
 * src/lib/providers/hetzner-pagination.js — the Cloud API caps per_page at
 * 50 and hides the rest). Returns `null` (not a throw) on a non-ok response
 * on ANY page — that's a definitive "no" the caller should NOT retry, and a
 * partial snapshot must never feed verify-scale a misleadingly-partial
 * "types changed" assertion (same contract as `fetchDigitalOceanTypes`).
 * A thrown error (network failure, timeout, bad JSON) IS retry-worthy and
 * propagates to the caller.
 *
 * Multiple parallel e2e scenarios share the same token, so a label-selector
 * query would pull every project's servers — fine because we then index by
 * IP, which is unique cluster-wide.
 */
async function fetchHetznerTypes(
  ips: string[],
  token: string,
  fetchFn: typeof fetch,
  tag: string,
): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  let page = 1;
  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const response = await fetchFn(`${HETZNER_SERVERS_URL}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(
        `${tag} [verify-scale] Hetzner API returned ${response.status} when fetching server types`,
      );
      return null;
    }
    const data = (await response.json()) as HetznerServersResponse;
    for (const srv of data.servers ?? []) {
      const ip = srv.public_net?.ipv4?.ip;
      const type = srv.server_type?.name;
      if (ip && type && ips.includes(ip)) {
        out[ip] = type;
      }
    }
    const next = data.meta?.pagination?.next_page;
    if (!next) break;
    page = next;
  }
  return out;
}

/**
 * Paginated DigitalOcean fetch, walking `GET /v2/droplets` (same
 * `per_page=50` + guarded `links.pages.next` walk as Task 5b's
 * listServers/findServersByName in `src/lib/providers/digitalocean.js`).
 * `size_slug` is DO's analog of Hetzner's `server_type.name`; a droplet's
 * public IPv4 lives in `networks.v4[]` keyed by `type: 'public'` (same
 * shape `DigitalOceanProvider.getPublicIP` reads).
 *
 * Same non-ok → `null` (no retry) / throw → retry-worthy contract as
 * `fetchHetznerTypes`. A non-ok response on any page (not just the first)
 * degrades the whole snapshot to `null` — verify-scale's fallback path
 * exists precisely so a partial/failed snapshot never produces a
 * misleadingly-partial "types changed" assertion.
 */
async function fetchDigitalOceanTypes(
  ips: string[],
  token: string,
  fetchFn: typeof fetch,
  tag: string,
): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  let page = 1;
  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const response = await fetchFn(`${DIGITALOCEAN_DROPLETS_URL}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(
        `${tag} [verify-scale] DigitalOcean API returned ${response.status} when fetching server types`,
      );
      return null;
    }
    const data = (await response.json()) as DigitalOceanDropletsResponse;
    for (const droplet of data.droplets ?? []) {
      const ip = droplet.networks?.v4?.find((n) => n.type === 'public')?.ip_address;
      const type = droplet.size_slug;
      if (ip && type && ips.includes(ip)) {
        out[ip] = type;
      }
    }
    if (!data.links?.pages?.next) break;
    page++;
  }
  return out;
}

interface LinodeInstancesResponse {
  data?: Array<{
    ipv4?: string[];
    type?: string;
  }>;
  page?: number;
  pages?: number;
}

/**
 * Paginated Linode fetch, walking `GET /v4/linode/instances` behind the
 * `{data, page, pages}` envelope (same walk shape as
 * `LinodeProvider.listServersDetailed`). `type` is Linode's analog of
 * Hetzner's `server_type.name`; an instance's public IPv4 is `ipv4[0]`
 * (the shape `LinodeProvider.getPublicIP` reads). Same non-ok → `null`
 * (no retry) / throw → retry-worthy contract as its two siblings.
 */
async function fetchLinodeTypes(
  ips: string[],
  token: string,
  fetchFn: typeof fetch,
  tag: string,
): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  let page = 1;
  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const response = await fetchFn(`${LINODE_INSTANCES_URL}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(
        `${tag} [verify-scale] Linode API returned ${response.status} when fetching server types`,
      );
      return null;
    }
    const data = (await response.json()) as LinodeInstancesResponse;
    for (const instance of data.data ?? []) {
      const ip = instance.ipv4?.[0];
      const type = instance.type;
      if (ip && type && ips.includes(ip)) {
        out[ip] = type;
      }
    }
    if (!data.pages || page >= data.pages) break;
    page++;
  }
  return out;
}

interface VultrInstancesResponse {
  instances?: Array<{
    main_ip?: string;
    plan?: string;
  }>;
  meta?: { links?: { next?: string } };
}

/**
 * Paginated Vultr fetch, walking `GET /v2/instances` behind Vultr's CURSOR
 * envelope (`meta.links.next` fed back as `&cursor=` — there is no
 * page/pages counter; same idiom as sweep-vultr.ts). `plan` is Vultr's
 * analog of Hetzner's `server_type.name`; an instance's public IPv4 is
 * `main_ip`. Same non-ok → `null` (no retry) / throw → retry-worthy
 * contract as its three siblings.
 */
async function fetchVultrTypes(
  ips: string[],
  token: string,
  fetchFn: typeof fetch,
  tag: string,
): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  let cursor = '';
  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const url = cursor
      ? `${VULTR_INSTANCES_URL}&cursor=${encodeURIComponent(cursor)}`
      : VULTR_INSTANCES_URL;
    const response = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(
        `${tag} [verify-scale] Vultr API returned ${response.status} when fetching server types`,
      );
      return null;
    }
    const data = (await response.json()) as VultrInstancesResponse;
    for (const instance of data.instances ?? []) {
      const ip = instance.main_ip;
      const type = instance.plan;
      if (ip && type && ips.includes(ip)) {
        out[ip] = type;
      }
    }
    const next = data.meta?.links?.next;
    if (!next) break;
    cursor = next;
  }
  return out;
}

interface ScalewayServersResponse {
  servers?: Array<{
    commercial_type?: string;
    public_ips?: Array<{ family?: string; address?: string }>;
    public_ip?: { address?: string };
  }>;
}

// Zones — lockstep with ScalewayProvider.REGIONS (the Instance API is
// zone-scoped; a listing exists per zone, not per account).
const SCALEWAY_ZONES = ['fr-par-1', 'fr-par-2', 'nl-ams-1', 'nl-ams-2'];

/**
 * Paginated Scaleway fetch — one `GET /instance/v1/zones/{zone}/servers`
 * page walk PER ZONE (Scaleway's API is zone-scoped; page/per_page with a
 * short page ending the walk — no cursor). `commercial_type` is Scaleway's
 * analog of Hetzner's `server_type.name`; the public IPv4 is the first
 * `family: 'inet'` entry of `public_ips[]` (legacy `public_ip.address`
 * fallback — the shape `ScalewayProvider.getPublicIP` reads). Auth is
 * `X-Auth-Token` (the secret key), not Bearer. Same non-ok → `null`
 * (no retry) / throw → retry-worthy contract as its siblings — a non-ok in
 * ANY zone degrades the whole snapshot.
 */
async function fetchScalewayTypes(
  ips: string[],
  token: string,
  fetchFn: typeof fetch,
  tag: string,
): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  for (const zone of SCALEWAY_ZONES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await fetchFn(
        `https://api.scaleway.com/instance/v1/zones/${zone}/servers?per_page=100&page=${page}`,
        {
          headers: { 'X-Auth-Token': token },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        console.warn(
          `${tag} [verify-scale] Scaleway API returned ${response.status} when fetching server types (${zone})`,
        );
        return null;
      }
      const data = (await response.json()) as ScalewayServersResponse;
      const servers = data.servers ?? [];
      for (const srv of servers) {
        const ip =
          srv.public_ips?.find((p) => p.family === 'inet' && p.address)?.address ??
          srv.public_ip?.address;
        const type = srv.commercial_type;
        if (ip && type && ips.includes(ip)) {
          out[ip] = type;
        }
      }
      if (servers.length < 100) break;
    }
  }
  return out;
}

// Throw-on-unknown fetcher registry — the previous shape was a binary
// `provider === 'digitalocean' ? … : fetchHetznerTypes` ternary (same
// silent-Hetzner-fallback class as runner.ts's capacity/token ternary,
// swept together 2026-08-08): an unknown provider id would hit the Hetzner
// API with the wrong token, get a non-ok, and silently degrade
// verify-scale to its weaker stdout-grep fallback.
const TYPE_FETCHERS: Record<
  ServerTypeProvider,
  (
    ips: string[],
    token: string,
    fetchFn: typeof fetch,
    tag: string,
  ) => Promise<Record<string, string> | null>
> = {
  hetzner: fetchHetznerTypes,
  digitalocean: fetchDigitalOceanTypes,
  linode: fetchLinodeTypes,
  vultr: fetchVultrTypes,
  scaleway: fetchScalewayTypes,
};

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
  const fetchOnePass = TYPE_FETCHERS[provider];
  if (!fetchOnePass) {
    throw new Error(
      `server-types: no type fetcher registered for provider '${String(provider)}' — add a TYPE_FETCHERS row.`,
    );
  }

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await fetchOnePass(ips, token, fetchFn, tag);
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
