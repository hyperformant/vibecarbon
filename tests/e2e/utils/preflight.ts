import { scratchNamePrefix } from './namespace.js';

export type PreflightStatus = 'ok' | 'slow' | 'failed';

export interface PreflightCheck {
  service: string;
  status: PreflightStatus;
  latencyMs: number;
  detail?: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  /** True when every check is 'ok'. */
  allHealthy: boolean;
  /** True when at least one check is 'failed' (down/unauthorized). */
  hasFailure: boolean;
}

// Generous timeouts: a Node process's first fetch to each host pays a cold
// TLS handshake (we observed docker-hub take 5s+ on first try while curl
// from the same shell takes 80ms). 10s catches real outages but tolerates
// cold-start; the per-check retry below tolerates a single transient blip.
const TIMEOUT_MS = 10_000;
const SLOW_THRESHOLD_MS = 4_000;

/**
 * Run all preflight checks in parallel and return their results.
 */
export async function runPreflight(args: {
  hetznerToken?: string;
  cloudflareToken?: string;
  /**
   * When false, the Cloudflare check reports ok/skipped instead of failing
   * on a missing token — a run whose scenarios are all on Hetzner DNS
   * (E2E_DNS_PROVIDER=hetzner, e.g. the CI US-perf workflow) has no
   * Cloudflare dependency to ping. Defaults to true.
   */
  needsCloudflare?: boolean;
  /**
   * When false, every Hetzner-specific check (API health, project-clean,
   * and the Hetzner-Object-Storage S3 check) reports ok/skipped instead of
   * requiring a token — a DO-only run (e.g. `--provider digitalocean`) has no Hetzner
   * dependency to ping. Defaults to true so every existing caller (which
   * never passes this) keeps today's behavior byte-for-byte.
   */
  needsHetzner?: boolean;
  digitaloceanToken?: string;
  /**
   * When true, runs the DigitalOcean checks (account/token health,
   * project-clean, Spaces reachability). Defaults to false — the release
   * matrix has no DigitalOcean dependency, so existing callers that omit
   * this see no new checks at all.
   */
  needsDigitalOcean?: boolean;
  linodeToken?: string;
  /**
   * When true, runs the Linode checks (profile/token health, project-clean,
   * Object Storage reachability). Defaults to false — same opt-in contract
   * as needsDigitalOcean above.
   */
  needsLinode?: boolean;
  vultrToken?: string;
  /**
   * When true, runs the Vultr checks (account/token health, project-clean,
   * Object Storage reachability). Defaults to false — same opt-in contract
   * as needsDigitalOcean above.
   */
  needsVultr?: boolean;
  /** SCALEWAY_SECRET_KEY (the token is the secret key on Scaleway). */
  scalewayToken?: string;
  /**
   * When true, runs the Scaleway checks (token health, project-clean,
   * Object Storage reachability). Defaults to false — same opt-in contract
   * as needsDigitalOcean above.
   */
  needsScaleway?: boolean;
  /**
   * One entry per DISTINCT dnsProvider in the selection. Each is checked
   * for token presence, zone-listing success, and visibility of the zone
   * the scenarios will actually write into — the DNS-axis twin of the
   * per-compute-provider trio above. Omitted/empty runs no DNS checks, so
   * existing callers see no new behavior.
   */
  dnsChecks?: ReadonlyArray<{ dnsProvider: string; token?: string; baseDomain: string }>;
}): Promise<PreflightResult> {
  const needsHetzner = args.needsHetzner !== false;
  const skippedHetzner = (service: string): Promise<PreflightCheck> =>
    Promise.resolve({
      service,
      status: 'ok',
      latencyMs: 0,
      detail: 'skipped — no scenario in this run uses Hetzner',
    });
  const checks = await Promise.all([
    needsHetzner ? checkHetzner(args.hetznerToken) : skippedHetzner('hetzner'),
    args.needsCloudflare === false
      ? Promise.resolve<PreflightCheck>({
          service: 'cloudflare',
          status: 'ok',
          latencyMs: 0,
          detail: 'skipped — no scenario uses Cloudflare DNS',
        })
      : checkCloudflare(args.cloudflareToken),
    needsHetzner ? checkS3() : skippedHetzner('s3'),
    checkDockerHub(),
    needsHetzner ? checkHetznerProjectClean(args.hetznerToken) : skippedHetzner('hetzner-clean'),
    ...(args.needsDigitalOcean
      ? [
          checkDigitalOcean(args.digitaloceanToken),
          checkDigitalOceanProjectClean(args.digitaloceanToken),
          checkDigitalOceanSpaces(),
        ]
      : []),
    ...(args.needsLinode
      ? [
          checkLinode(args.linodeToken),
          checkLinodeProjectClean(args.linodeToken),
          checkLinodeObjectStorage(),
        ]
      : []),
    ...(args.needsVultr
      ? [
          checkVultr(args.vultrToken),
          checkVultrProjectClean(args.vultrToken),
          checkVultrObjectStorage(),
        ]
      : []),
    ...(args.needsScaleway
      ? [
          checkScaleway(args.scalewayToken),
          checkScalewayProjectClean(args.scalewayToken),
          checkScalewayObjectStorage(),
        ]
      : []),
    ...(args.dnsChecks ?? []).map((d) => checkDnsZone(d)),
  ]);
  const allHealthy = checks.every((c) => c.status === 'ok');
  const hasFailure = checks.some((c) => c.status === 'failed');
  return { checks, allHealthy, hasFailure };
}

/** Pretty-print results to console. Returns true iff matrix should proceed. */
export function logPreflight(result: PreflightResult): boolean {
  console.log('Preflight:');
  for (const c of result.checks) {
    const symbol = c.status === 'ok' ? '✓' : c.status === 'slow' ? '⚠' : '✗';
    const detail = c.detail ? ` — ${c.detail}` : '';
    // 18 fits the longest service name ('digitalocean-spaces', 'dns-digitalocean').
    console.log(`  ${symbol} ${c.service.padEnd(18)} ${c.latencyMs}ms${detail}`);
  }
  if (result.hasFailure) {
    console.log('  FAIL: at least one infra dependency is down. Aborting matrix.');
    console.log('  (Override with E2E_PREFLIGHT=skip if you know what you are doing.)');
    return false;
  }
  if (!result.allHealthy) {
    console.log('  WARN: some checks were slow. Proceeding — matrix may be flakier than usual.');
  }
  return true;
}

/** Hetzner Cloud API — list servers (authoritative health for the API). */
async function checkHetzner(token?: string): Promise<PreflightCheck> {
  if (!token) return { service: 'hetzner', status: 'failed', latencyMs: 0, detail: 'no token' };
  return timed('hetzner', () =>
    fetch('https://api.hetzner.cloud/v1/servers?per_page=1', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}

/** Cloudflare API — /user/tokens/verify is the canonical health-of-token check. */
async function checkCloudflare(token?: string): Promise<PreflightCheck> {
  if (!token) return { service: 'cloudflare', status: 'failed', latencyMs: 0, detail: 'no token' };
  return timed('cloudflare', () =>
    fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}

/** Hetzner Object Storage — list buckets in nbg1 region (deploy default). */
async function checkS3(): Promise<PreflightCheck> {
  // Env-only (the credentials.json profiles fallback this used to have was
  // retired — A5). runner.ts's loadE2EEnvFile() pre-populates process.env
  // from tests/.env.e2e before this runs (A6), so a value here can come
  // from the shell, CI, or the operator's local token file.
  const creds =
    process.env.HETZNER_ACCESS_KEY && process.env.HETZNER_SECRET_KEY
      ? { accessKey: process.env.HETZNER_ACCESS_KEY, secretKey: process.env.HETZNER_SECRET_KEY }
      : undefined;
  if (!creds?.accessKey || !creds?.secretKey) {
    return { service: 's3', status: 'failed', latencyMs: 0, detail: 'no credentials' };
  }
  // Use a HEAD against the region endpoint — listing buckets is fine but
  // requires SigV4. HEAD on the host returns 200/403 either way and is
  // sufficient to prove the endpoint is up + reachable in the region.
  return timed('s3', () =>
    fetch('https://nbg1.your-objectstorage.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}

/**
 * Docker Hub — fetch the registry token endpoint. Returns 401 (expected,
 * no auth payload) but proves the endpoint is up. Non-200 still counts as
 * 'ok' as long as the connection succeeded.
 */
async function checkDockerHub(): Promise<PreflightCheck> {
  return timed('docker-hub', () =>
    fetch('https://auth.docker.io/token?service=registry.docker.io', {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}

/**
 * DigitalOcean Cloud API — `/v2/account` is the canonical token-health
 * check (mirrors `checkHetzner`'s `/v1/servers` probe). Unlike Docker Hub's
 * "401 is expected and fine" contract, a 401 here means
 * DIGITALOCEAN_API_TOKEN is genuinely bad — `failOn401` makes `timed`
 * classify that as 'failed' instead of the generic "any non-5xx is ok".
 */
async function checkDigitalOcean(token?: string): Promise<PreflightCheck> {
  if (!token)
    return { service: 'digitalocean', status: 'failed', latencyMs: 0, detail: 'no token' };
  return timed(
    'digitalocean',
    () =>
      fetch('https://api.digitalocean.com/v2/account', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    { failOn401: true },
  );
}

/**
 * DigitalOcean Spaces (S3-compatible object storage) — HEAD the default
 * region's endpoint (nyc3, DigitalOceanProvider.DEFAULT_REGION). Mirrors
 * `checkS3`'s env-only credential lookup exactly.
 */
async function checkDigitalOceanSpaces(): Promise<PreflightCheck> {
  const creds =
    process.env.DIGITALOCEAN_ACCESS_KEY && process.env.DIGITALOCEAN_SECRET_KEY
      ? {
          accessKey: process.env.DIGITALOCEAN_ACCESS_KEY,
          secretKey: process.env.DIGITALOCEAN_SECRET_KEY,
        }
      : undefined;
  if (!creds?.accessKey || !creds?.secretKey) {
    return {
      service: 'digitalocean-spaces',
      status: 'failed',
      latencyMs: 0,
      detail: 'no credentials',
    };
  }
  return timed('digitalocean-spaces', () =>
    fetch('https://nyc3.digitaloceanspaces.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}

/**
 * DigitalOcean project quota state — count residual `testapp-*` resources
 * (droplets/firewalls/ssh-keys/volumes) so a leaked prior d1/d2 run aborts
 * the matrix before provisioning rather than tripping a mid-run `422` or
 * silently reusing stale infra. Mirrors `checkHetznerProjectClean`'s
 * contract exactly (same prefix, same 5s-per-endpoint budget, same
 * non-fatal partial-failure handling) against DO's droplet/firewall/
 * account-keys/volumes endpoints.
 */
async function checkDigitalOceanProjectClean(token?: string): Promise<PreflightCheck> {
  if (!token) {
    return { service: 'digitalocean-clean', status: 'failed', latencyMs: 0, detail: 'no token' };
  }
  const t0 = Date.now();
  const prefix = scratchNamePrefix();
  const endpoints: Array<{ url: string; key: string; label: string }> = [
    { url: 'droplets?per_page=50', key: 'droplets', label: 'droplet' },
    { url: 'firewalls?per_page=50', key: 'firewalls', label: 'firewall' },
    { url: 'account/keys?per_page=50', key: 'ssh_keys', label: 'ssh_key' },
    { url: 'volumes?per_page=50', key: 'volumes', label: 'volume' },
  ];
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  await Promise.all(
    endpoints.map(async ({ url, key, label }) => {
      try {
        const res = await fetch(`https://api.digitalocean.com/v2/${url}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          errors.push(`${label}: HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as Record<string, Array<{ name?: string }>>;
        const items = body[key] ?? [];
        const matching = items.filter((i) => i.name?.startsWith(prefix));
        if (matching.length > 0) counts[label] = matching.length;
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`);
      }
    }),
  );
  const latencyMs = Date.now() - t0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const breakdown = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return {
      service: 'digitalocean-clean',
      status: 'failed',
      latencyMs,
      detail: `${total} ${prefix}* resource(s) leaked from prior run (${breakdown}) — run sweep before matrix`,
    };
  }
  if (errors.length > 0) {
    return {
      service: 'digitalocean-clean',
      status: 'slow',
      latencyMs,
      detail: `partial: ${errors.slice(0, 2).join('; ')}`,
    };
  }
  return { service: 'digitalocean-clean', status: 'ok', latencyMs };
}

/**
 * Linode API — `/v4/profile` is the canonical token-health check (mirrors
 * `checkDigitalOcean`'s `/v2/account` probe; same `failOn401` opt-in — a
 * 401 here means LINODE_API_TOKEN is genuinely bad).
 */
async function checkLinode(token?: string): Promise<PreflightCheck> {
  if (!token) return { service: 'linode', status: 'failed', latencyMs: 0, detail: 'no token' };
  return timed(
    'linode',
    () =>
      fetch('https://api.linode.com/v4/profile', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    { failOn401: true },
  );
}

/**
 * Linode Object Storage — HEAD the default region's endpoint (us-iad-1,
 * the endpoint LinodeObjectStorageProvider.resolveS3Region maps
 * LinodeProvider.DEFAULT_REGION to). Mirrors `checkS3`'s env-only
 * credential lookup exactly.
 */
async function checkLinodeObjectStorage(): Promise<PreflightCheck> {
  const creds =
    process.env.LINODE_ACCESS_KEY && process.env.LINODE_SECRET_KEY
      ? {
          accessKey: process.env.LINODE_ACCESS_KEY,
          secretKey: process.env.LINODE_SECRET_KEY,
        }
      : undefined;
  if (!creds?.accessKey || !creds?.secretKey) {
    return {
      service: 'linode-storage',
      status: 'failed',
      latencyMs: 0,
      detail: 'no credentials',
    };
  }
  return timed('linode-storage', () =>
    fetch('https://us-iad-1.linodeobjects.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}

/**
 * Linode project quota state — count residual `testapp-*` resources
 * (instances/firewalls/volumes; Linode's label field is `label`, not
 * `name`, and its list envelope is `{data}` for every endpoint). Mirrors
 * `checkDigitalOceanProjectClean`'s contract exactly. Profile SSH keys are
 * deliberately not counted: unlike DO's account keys they never gate a
 * quota, and the sweep reaps them by label anyway.
 */
async function checkLinodeProjectClean(token?: string): Promise<PreflightCheck> {
  if (!token) {
    return { service: 'linode-clean', status: 'failed', latencyMs: 0, detail: 'no token' };
  }
  const t0 = Date.now();
  const prefix = scratchNamePrefix();
  const endpoints: Array<{ url: string; label: string }> = [
    { url: 'linode/instances?page_size=100', label: 'instance' },
    { url: 'networking/firewalls?page_size=100', label: 'firewall' },
    { url: 'volumes?page_size=100', label: 'volume' },
  ];
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  await Promise.all(
    endpoints.map(async ({ url, label }) => {
      try {
        const res = await fetch(`https://api.linode.com/v4/${url}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          errors.push(`${label}: HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as { data?: Array<{ label?: string }> };
        const items = body.data ?? [];
        const matching = items.filter((i) => i.label?.startsWith(prefix));
        if (matching.length > 0) counts[label] = matching.length;
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`);
      }
    }),
  );
  const latencyMs = Date.now() - t0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const breakdown = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return {
      service: 'linode-clean',
      status: 'failed',
      latencyMs,
      detail: `${total} ${prefix}* resource(s) leaked from prior run (${breakdown}) — run sweep before matrix`,
    };
  }
  if (errors.length > 0) {
    return {
      service: 'linode-clean',
      status: 'slow',
      latencyMs,
      detail: `partial: ${errors.slice(0, 2).join('; ')}`,
    };
  }
  return { service: 'linode-clean', status: 'ok', latencyMs };
}

/**
 * Vultr API — `/v2/account` is the canonical token-health check (mirrors
 * `checkLinode`'s `/v4/profile` probe; same `failOn401` opt-in — a 401 here
 * means VULTR_API_TOKEN is genuinely bad).
 */
async function checkVultr(token?: string): Promise<PreflightCheck> {
  if (!token) return { service: 'vultr', status: 'failed', latencyMs: 0, detail: 'no token' };
  return timed(
    'vultr',
    () =>
      fetch('https://api.vultr.com/v2/account', {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    { failOn401: true },
  );
}

/**
 * Vultr Object Storage — HEAD the subscription's own cluster endpoint.
 * Mirrors `checkS3`'s env-only credential lookup exactly, but the CLUSTER
 * comes from `VULTR_STORAGE_REGION` rather than a provider default:
 * Vultr mints object-storage keys per SUBSCRIPTION (one subscription = one
 * cluster), so probing any other cluster would prove nothing about the keys
 * this run will actually use. `ewr1` is the fallback only so a
 * misconfigured run still pings something real and fails informatively.
 */
async function checkVultrObjectStorage(): Promise<PreflightCheck> {
  const creds =
    process.env.VULTR_ACCESS_KEY && process.env.VULTR_SECRET_KEY
      ? {
          accessKey: process.env.VULTR_ACCESS_KEY,
          secretKey: process.env.VULTR_SECRET_KEY,
        }
      : undefined;
  if (!creds?.accessKey || !creds?.secretKey) {
    return {
      service: 'vultr-storage',
      status: 'failed',
      latencyMs: 0,
      detail: 'no credentials',
    };
  }
  const cluster = process.env.VULTR_STORAGE_REGION || 'ewr1';
  return timed('vultr-storage', () =>
    fetch(`https://${cluster}.vultrobjects.com/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}

/**
 * Vultr project quota state — count residual `testapp-*` resources
 * (instances/firewall groups/ssh keys). Mirrors
 * `checkLinodeProjectClean`'s contract exactly (same prefix, same
 * 5s-per-endpoint budget, same non-fatal partial-failure handling), but
 * every endpoint names its identity field differently: instances carry
 * `label`, firewall GROUPS carry `description` (not `label`), ssh keys
 * carry `name`. Reading the wrong one would silently count zero forever.
 */
async function checkVultrProjectClean(token?: string): Promise<PreflightCheck> {
  if (!token) {
    return { service: 'vultr-clean', status: 'failed', latencyMs: 0, detail: 'no token' };
  }
  const t0 = Date.now();
  const prefix = scratchNamePrefix();
  const endpoints: Array<{ url: string; key: string; field: string; label: string }> = [
    { url: 'instances?per_page=100', key: 'instances', field: 'label', label: 'instance' },
    {
      url: 'firewalls?per_page=100',
      key: 'firewall_groups',
      field: 'description',
      label: 'firewall',
    },
    { url: 'ssh-keys?per_page=100', key: 'ssh_keys', field: 'name', label: 'ssh_key' },
  ];
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  await Promise.all(
    endpoints.map(async ({ url, key, field, label }) => {
      try {
        const res = await fetch(`https://api.vultr.com/v2/${url}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          errors.push(`${label}: HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as Record<string, Array<Record<string, string>>>;
        const items = body[key] ?? [];
        const matching = items.filter((i) => i[field]?.startsWith(prefix));
        if (matching.length > 0) counts[label] = matching.length;
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`);
      }
    }),
  );
  const latencyMs = Date.now() - t0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const breakdown = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return {
      service: 'vultr-clean',
      status: 'failed',
      latencyMs,
      detail: `${total} ${prefix}* resource(s) leaked from prior run (${breakdown}) — run sweep before matrix`,
    };
  }
  if (errors.length > 0) {
    return {
      service: 'vultr-clean',
      status: 'slow',
      latencyMs,
      detail: `partial: ${errors.slice(0, 2).join('; ')}`,
    };
  }
  return { service: 'vultr-clean', status: 'ok', latencyMs };
}

/**
 * Scaleway API — a one-row instance listing in the default zone is the
 * canonical token-health check (Scaleway auth is `X-Auth-Token: <secret
 * key>`, not Bearer; there is no unauthenticated /account analog). Same
 * `failOn401` opt-in — a 401 here means SCALEWAY_SECRET_KEY is genuinely bad.
 */
async function checkScaleway(token?: string): Promise<PreflightCheck> {
  if (!token) return { service: 'scaleway', status: 'failed', latencyMs: 0, detail: 'no token' };
  return timed(
    'scaleway',
    () =>
      fetch('https://api.scaleway.com/instance/v1/zones/fr-par-1/servers?per_page=1', {
        headers: { 'X-Auth-Token': token },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    { failOn401: true },
  );
}

/**
 * Scaleway Object Storage — HEAD the default region's endpoint (fr-par,
 * the region zoneToS3Region derives from ScalewayProvider.DEFAULT_REGION).
 * Mirrors `checkS3`'s env-only credential lookup — but the pair here IS
 * the compute pair (SCALEWAY_ACCESS_KEY + SCALEWAY_SECRET_KEY; one IAM key signs
 * both, no separate storage credential exists on Scaleway).
 */
async function checkScalewayObjectStorage(): Promise<PreflightCheck> {
  const creds =
    process.env.SCALEWAY_ACCESS_KEY && process.env.SCALEWAY_SECRET_KEY
      ? { accessKey: process.env.SCALEWAY_ACCESS_KEY, secretKey: process.env.SCALEWAY_SECRET_KEY }
      : undefined;
  if (!creds?.accessKey || !creds?.secretKey) {
    return {
      service: 'scaleway-storage',
      status: 'failed',
      latencyMs: 0,
      detail: 'no credentials',
    };
  }
  return timed('scaleway-storage', () =>
    fetch('https://s3.fr-par.scw.cloud/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
}

/**
 * Scaleway project quota state — count residual `testapp-*` resources
 * (instances/security groups/SBS volumes/flexible IPs). Mirrors
 * `checkVultrProjectClean`'s contract (same prefix, same 5s-per-endpoint
 * budget, same non-fatal partial-failure handling) with two Scaleway
 * twists: every endpoint is ZONE-scoped, so each resource family is
 * checked across the audited zone set; and SBS volumes live in the Block
 * Storage API, not the Instance API — and flexible IPs have no name, so
 * the IP arm scopes by the `project:<name>` ownership TAG the compose
 * program stamps (an unattached tagged IP bills €0.005/hr and is residue
 * by definition; untagged unattached IPs are ignored — they may belong to
 * a concurrent run in another namespace).
 */
async function checkScalewayProjectClean(token?: string): Promise<PreflightCheck> {
  if (!token) {
    return { service: 'scaleway-clean', status: 'failed', latencyMs: 0, detail: 'no token' };
  }
  const t0 = Date.now();
  const prefix = scratchNamePrefix();
  const zones = ['fr-par-1', 'fr-par-2', 'nl-ams-1', 'nl-ams-2'];
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  const bump = (label: string, n: number) => {
    if (n > 0) counts[label] = (counts[label] ?? 0) + n;
  };
  await Promise.all(
    zones.flatMap((zone) => [
      (async () => {
        try {
          const res = await fetch(
            `https://api.scaleway.com/instance/v1/zones/${zone}/servers?per_page=100`,
            { headers: { 'X-Auth-Token': token }, signal: AbortSignal.timeout(5_000) },
          );
          if (!res.ok) {
            errors.push(`server(${zone}): HTTP ${res.status}`);
            return;
          }
          const body = (await res.json()) as { servers?: Array<{ name?: string }> };
          bump('server', (body.servers ?? []).filter((s) => s.name?.startsWith(prefix)).length);
        } catch (err) {
          errors.push(
            `server(${zone}): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`,
          );
        }
      })(),
      (async () => {
        try {
          const res = await fetch(
            `https://api.scaleway.com/instance/v1/zones/${zone}/security_groups?per_page=100`,
            { headers: { 'X-Auth-Token': token }, signal: AbortSignal.timeout(5_000) },
          );
          if (!res.ok) {
            errors.push(`security_group(${zone}): HTTP ${res.status}`);
            return;
          }
          const body = (await res.json()) as { security_groups?: Array<{ name?: string }> };
          bump(
            'security_group',
            (body.security_groups ?? []).filter((g) => g.name?.startsWith(prefix)).length,
          );
        } catch (err) {
          errors.push(
            `security_group(${zone}): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`,
          );
        }
      })(),
      (async () => {
        try {
          // Block Storage API — where every SBS root volume lives
          // (terminate only DETACHES sbs_volume, the audited leak class).
          const res = await fetch(
            `https://api.scaleway.com/block/v1/zones/${zone}/volumes?page_size=100`,
            { headers: { 'X-Auth-Token': token }, signal: AbortSignal.timeout(5_000) },
          );
          if (!res.ok) {
            errors.push(`volume(${zone}): HTTP ${res.status}`);
            return;
          }
          const body = (await res.json()) as { volumes?: Array<{ name?: string }> };
          bump('volume', (body.volumes ?? []).filter((v) => v.name?.startsWith(prefix)).length);
        } catch (err) {
          errors.push(
            `volume(${zone}): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`,
          );
        }
      })(),
      (async () => {
        try {
          const res = await fetch(
            `https://api.scaleway.com/instance/v1/zones/${zone}/ips?per_page=100`,
            { headers: { 'X-Auth-Token': token }, signal: AbortSignal.timeout(5_000) },
          );
          if (!res.ok) {
            errors.push(`flexible_ip(${zone}): HTTP ${res.status}`);
            return;
          }
          const body = (await res.json()) as {
            ips?: Array<{ server?: { id?: string } | null; tags?: string[] }>;
          };
          // IPs have no name — ownership is the `project:<name>` tag the
          // compose program stamps. Namespace-scoped like every other arm:
          // only UNATTACHED IPs tagged with this namespace's prefix count
          // (a concurrent laptop run's rigs must never abort a CI matrix).
          bump(
            'flexible_ip',
            (body.ips ?? []).filter(
              (ip) => !ip.server && (ip.tags ?? []).some((t) => t.startsWith(`project:${prefix}`)),
            ).length,
          );
        } catch (err) {
          errors.push(
            `flexible_ip(${zone}): ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`,
          );
        }
      })(),
    ]),
  );
  const latencyMs = Date.now() - t0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const breakdown = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return {
      service: 'scaleway-clean',
      status: 'failed',
      latencyMs,
      detail: `${total} residual resource(s) from prior run (${breakdown}) — run sweep before matrix`,
    };
  }
  if (errors.length > 0) {
    return {
      service: 'scaleway-clean',
      status: 'slow',
      latencyMs,
      detail: `partial: ${errors.slice(0, 2).join('; ')}`,
    };
  }
  return { service: 'scaleway-clean', status: 'ok', latencyMs };
}

/**
 * Does `zoneName` contain `baseDomain`?
 *
 * Deliberately NOT a bare `baseDomain.endsWith(zoneName)`: that reports a
 * match for baseDomain `evilappcarbon.dev` against zone `appcarbon.dev`,
 * which is a different registrable domain the token has no rights over.
 * Matching requires either equality or a label boundary. Trailing dots and
 * case are normalized away — DNS APIs are inconsistent about both, and a
 * false "zone not visible" abort right before a matrix run is expensive.
 *
 * Exported for tests; the check below is the only production caller.
 */
export function zoneCovers(baseDomain: string, zoneName: string): boolean {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');
  const base = normalize(baseDomain);
  const zone = normalize(zoneName);
  if (!base || !zone) return false;
  return base === zone || base.endsWith(`.${zone}`);
}

/**
 * Per-DNS-provider check: the backend's token lists zones, and the zone the
 * scenarios will write into is one of them.
 *
 * The zone-visibility half is the point. A token that authenticates fine but
 * can't see `do.appcarbon.dev` produces a deploy that provisions a server,
 * waits out DNS propagation, and only fails at ACME — tens of minutes in,
 * with an error about certificates rather than about permissions. Listing
 * zones costs one API call at preflight and names the real problem.
 *
 * Goes through the DNS_PROVIDERS registry rather than importing a backend
 * module directly, so a provider added to the registry is checked here with
 * no edit to this file.
 */
/** Injectable resolver seam so the probe is testable without network. */
export interface SoaProbeDeps {
  /** Delegated nameserver hostnames for a zone, via the ambient resolver. */
  resolveNs: (zone: string) => Promise<string[]>;
  /** Resolve a nameserver hostname to an address. */
  resolveAddr: (host: string) => Promise<string[]>;
  /** Ask ONE specific nameserver for the zone's SOA. Rejects with `.code`. */
  soaFrom: (serverIp: string, zone: string) => Promise<unknown>;
}

/**
 * Ask a zone's OWN delegated nameservers whether they actually serve it.
 *
 * `checkDnsZone` proves a zone is visible in the provider's API — not that
 * the provider's nameservers answer for it. Linode only serves DNS for
 * accounts holding at least one active Linode, so a zone reads `"status":
 * "active"` over the API while every ns1-5.linode.com returns REFUSED. That
 * state passes an API-only check and then fails ~20 minutes later at ACME,
 * which is precisely the failure shape this check exists to prevent.
 *
 * `status: "active"` is a user-settable render flag, not a published-to-
 * nameservers signal, and no API field exposes the account-level gate — so
 * the wire is the only source of truth.
 *
 * Returns `served: true` on any authoritative answer. Inconclusive states
 * (no NS, unresolvable NS, timeouts) return `served: true` with a detail:
 * this check must never turn a network blip into a false abort of a healthy
 * matrix. Only an explicit REFUSED/SERVFAIL — the provider answering "I do
 * not serve this" — is treated as a failure.
 */
export async function probeZoneAuthoritative(
  zone: string,
  deps: SoaProbeDeps,
): Promise<{ served: boolean; detail: string }> {
  let nameservers: string[];
  try {
    nameservers = (await deps.resolveNs(zone)) ?? [];
  } catch (err) {
    return { served: true, detail: `NS lookup inconclusive (${errCode(err)})` };
  }
  if (nameservers.length === 0) {
    return { served: true, detail: 'no NS records — delegation not visible yet' };
  }

  // One nameserver is enough: REFUSED is an account-level gate, not a
  // per-server fault, so polling all five would only multiply latency.
  const host = nameservers[0];
  let addrs: string[];
  try {
    addrs = (await deps.resolveAddr(host)) ?? [];
  } catch (err) {
    return { served: true, detail: `NS ${host} unresolvable (${errCode(err)})` };
  }
  if (addrs.length === 0) {
    return { served: true, detail: `NS ${host} has no address` };
  }

  try {
    await deps.soaFrom(addrs[0], zone);
    return { served: true, detail: `authoritative at ${host}` };
  } catch (err) {
    const code = errCode(err);
    if (code === 'REFUSED' || code === 'SERVFAIL') {
      return { served: false, detail: `${host} returned ${code} for ${zone}` };
    }
    return { served: true, detail: `SOA probe inconclusive (${code})` };
  }
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.message.split('\n')[0].slice(0, 40) : String(err);
}

/** Real resolver wiring for {@link probeZoneAuthoritative}. */
async function nodeSoaProbeDeps(): Promise<SoaProbeDeps> {
  const { promises: dnsp, Resolver } = await import('node:dns');
  return {
    resolveNs: (zone) => dnsp.resolveNs(zone),
    resolveAddr: (host) => dnsp.resolve4(host),
    soaFrom: (serverIp, zone) => {
      // Bounded: a hung authoritative server must not stall preflight.
      const r = new Resolver({ timeout: 3_000, tries: 1 });
      r.setServers([serverIp]);
      return new Promise((resolve, reject) => {
        r.resolveSoa(zone, (err, addresses) => (err ? reject(err) : resolve(addresses)));
      });
    },
  };
}

async function checkDnsZone(target: {
  dnsProvider: string;
  token?: string;
  baseDomain: string;
}): Promise<PreflightCheck> {
  const service = `dns-${target.dnsProvider}`;
  if (!target.token) {
    return { service, status: 'failed', latencyMs: 0, detail: 'no token' };
  }
  // Can't reuse `timed` — it wraps a single fetch and classifies on HTTP
  // status, whereas this drives a provider module and then asserts something
  // semantic about the response body. The retry-once-after-1s contract is
  // copied deliberately (see `timed` for the blip-window reasoning).
  let lastErr: unknown;
  let lastLatency = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const { getDnsProvider } = (await import('../../../src/lib/dns-provider.js')) as {
        getDnsProvider: (id: string) => Promise<{
          getZones: (token: string) => Promise<Array<{ name?: string }>>;
        }>;
      };
      const backend = await getDnsProvider(target.dnsProvider);
      const zones = (await backend.getZones(target.token)) ?? [];
      const latencyMs = Date.now() - t0;
      const names = zones.map((z) => z?.name).filter((n): n is string => Boolean(n));
      const match = names.find((n) => zoneCovers(target.baseDomain, n));
      if (!match) {
        return {
          service,
          status: 'failed',
          latencyMs,
          // Name what WAS visible — "zone not visible" alone can't
          // distinguish a wrong account from an undelegated zone.
          detail:
            `no zone covering ${target.baseDomain} (${names.length} visible: ` +
            `${names.slice(0, 3).join(', ') || 'none'}${names.length > 3 ? ', …' : ''})`,
        };
      }
      // The zone is visible to the token. That is NOT the same as the
      // provider's nameservers serving it — see probeZoneAuthoritative.
      //
      // Deliberately reported, never fatal. Linode serves DNS only for
      // accounts holding an active Linode, and preflight runs BEFORE the
      // deploy creates one — so REFUSED here is the normal starting state for
      // a healthy linode run, and failing on it would abort every one of
      // them. The real exposure is the race on the other side (zone published
      // to ns1-5 before ACME validates), which belongs in a poll-until-served
      // gate at cert-issuance time, not in a pre-run abort.
      const served = await probeZoneAuthoritative(match, await nodeSoaProbeDeps());
      const servedNote = served.served ? '' : ` — NOT YET SERVED: ${served.detail}`;
      if (latencyMs > SLOW_THRESHOLD_MS) {
        return {
          service,
          status: 'slow',
          latencyMs,
          detail: `> ${SLOW_THRESHOLD_MS}ms (${match})${servedNote}`,
        };
      }
      return { service, status: 'ok', latencyMs, detail: `zone ${match}${servedNote}` };
    } catch (err) {
      lastErr = err;
      lastLatency = Date.now() - t0;
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1_000));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return {
    service,
    status: 'failed',
    latencyMs: lastLatency,
    detail: msg.split('\n')[0].slice(0, 80),
  };
}

/**
 * Hetzner project quota state — count residual `testapp-*` resources and
 * fail-fast if any are present. The 2026-04-27 morning matrix-bumped run
 * lost 3 of 4 scenarios to `server limit reached` because 6 servers had
 * silently leaked from the previous matrix's k8s-ha (PR 1BR root-caused
 * the leak). Without this check, the matrix burned ~30 min before any
 * scenario discovered the cap. This check runs the same Hetzner API calls
 * the post-matrix sweep uses, with a 5-second budget; if it finds residue
 * we abort the matrix immediately and the operator runs a manual sweep.
 *
 * Skipped if no token is available (handled upstream by checkHetzner).
 */
async function checkHetznerProjectClean(token?: string): Promise<PreflightCheck> {
  if (!token) {
    return { service: 'hetzner-clean', status: 'failed', latencyMs: 0, detail: 'no token' };
  }
  const t0 = Date.now();
  // Scope to the active namespace's prefix (E2E_NAMESPACE) — a CI run must
  // only abort on CI residue, never on a concurrent laptop run's rigs.
  const prefix = scratchNamePrefix();
  // Each endpoint's count of `${prefix}*` matches contributes to the total.
  // A hard 5s timeout per endpoint keeps the whole check under ~10s in the
  // worst case. Per-endpoint failures are non-fatal — a single 5xx shouldn't
  // block the matrix, but we surface them in the detail.
  const endpoints: Array<{ url: string; key: string; label: string }> = [
    { url: 'servers?per_page=50', key: 'servers', label: 'server' },
    { url: 'placement_groups?per_page=50', key: 'placement_groups', label: 'placement_group' },
    { url: 'firewalls?per_page=50', key: 'firewalls', label: 'firewall' },
    { url: 'floating_ips?per_page=50', key: 'floating_ips', label: 'floating_ip' },
    { url: 'networks?per_page=50', key: 'networks', label: 'network' },
    { url: 'ssh_keys?per_page=50', key: 'ssh_keys', label: 'ssh_key' },
    { url: 'volumes?per_page=50', key: 'volumes', label: 'volume' },
  ];
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  await Promise.all(
    endpoints.map(async ({ url, key, label }) => {
      try {
        const res = await fetch(`https://api.hetzner.cloud/v1/${url}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          errors.push(`${label}: HTTP ${res.status}`);
          return;
        }
        const body = (await res.json()) as Record<string, Array<{ name?: string }>>;
        const items = body[key] ?? [];
        const matching = items.filter((i) => i.name?.startsWith(prefix));
        if (matching.length > 0) counts[label] = matching.length;
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown'}`);
      }
    }),
  );
  const latencyMs = Date.now() - t0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const breakdown = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return {
      service: 'hetzner-clean',
      status: 'failed',
      latencyMs,
      detail: `${total} ${prefix}* resource(s) leaked from prior run (${breakdown}) — run sweep before matrix`,
    };
  }
  if (errors.length > 0) {
    // Couldn't enumerate at least one resource type — surface as 'slow' so
    // the matrix proceeds with a warning rather than aborting on a Hetzner
    // 5xx blip. (A real outage will be caught by the checkHetzner above.)
    return {
      service: 'hetzner-clean',
      status: 'slow',
      latencyMs,
      detail: `partial: ${errors.slice(0, 2).join('; ')}`,
    };
  }
  return { service: 'hetzner-clean', status: 'ok', latencyMs };
}

/**
 * Run a fetch and turn the result into a PreflightCheck. Any 2xx/3xx/4xx
 * counts as 'ok' (the endpoint is up), 5xx counts as 'failed', a network
 * error / abort counts as 'failed'. Latency > SLOW_THRESHOLD_MS gets 'slow'.
 */
async function timed(
  service: string,
  fetchFn: () => Promise<Response>,
  options: {
    /**
     * Classify a 401 response as 'failed' instead of the generic "any
     * non-5xx is ok" rule. Off by default — Docker Hub's token endpoint
     * (and Hetzner's/Cloudflare's checks) treat a 401 as "endpoint is up",
     * which is what every existing caller wants. Only DigitalOcean's
     * account check (a real auth probe, not an intentionally-unauthed
     * endpoint) opts in.
     */
    failOn401?: boolean;
  } = {},
): Promise<PreflightCheck> {
  // Retry once on transient failure — cold TLS handshake at process startup
  // can spuriously time out a single check. A real outage will fail twice;
  // a blip won't. Sequential, not parallel: if it really IS a blip the
  // second attempt has a warm DNS cache and TCP path.
  //
  // Wait 1s between attempts: sub-second network hiccups (IPv6 path flap,
  // DNS retransmit, brief route loss) would otherwise kill both attempts
  // inside the same blip window. Empirically a 547ms hetzner failure +
  // 253ms s3 failure pair landed inside one ~500ms blip while cloudflare
  // simultaneously stayed reachable — proves the failure window can be
  // narrower than two back-to-back fetches.
  let lastErr: unknown;
  let lastLatency = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetchFn();
      const latencyMs = Date.now() - t0;
      if (options.failOn401 && res.status === 401) {
        return {
          service,
          status: 'failed',
          latencyMs,
          detail: 'unauthorized (401) — check the API token',
        };
      }
      if (res.status >= 500) {
        return { service, status: 'failed', latencyMs, detail: `HTTP ${res.status}` };
      }
      if (latencyMs > SLOW_THRESHOLD_MS) {
        return { service, status: 'slow', latencyMs, detail: `> ${SLOW_THRESHOLD_MS}ms` };
      }
      return { service, status: 'ok', latencyMs };
    } catch (err) {
      lastErr = err;
      lastLatency = Date.now() - t0;
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1_000));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return {
    service,
    status: 'failed',
    latencyMs: lastLatency,
    detail: msg.split('\n')[0].slice(0, 80),
  };
}
