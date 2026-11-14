/**
 * Read-only residue audit: inventories every e2e provider account and says
 * what looks like test leftovers. The sweeps clean up after dead runs; this is
 * the check that they did, so a gap shows up as a red weekly run, not a bill.
 *
 * Read-only by construction:
 * - every HTTP call goes through `get`, which sends GET and nothing else;
 * - object storage is touched by ListBuckets (one client per region, wrapped by
 *   listBucketsOnly so any other command throws) and by the state store's `where`/`list`;
 *   `remove` is never called.
 *
 * Public output: this repo and its Actions logs are public. The summary names
 * a row only when it is test-shaped (a scratch project's name, a per-run DNS
 * name, a run tag) and is residue. Fixtures, generic tags, in-flight rows and
 * everything else show as counts. DNS is read only for the e2e zones, by exact
 * name; no zone list is ever requested and no name is ever resolved.
 *
 * Incomplete (exit 2): a transport error, 5xx, 429 or 401; a page chain that
 * stops early; a provider whose every kind is refused; a state bucket that
 * cannot be located or listed. A 403 on one kind is "not covered" instead,
 * named in the summary, so a by-design refusal does not raise a weekly alarm.
 */
// biome-ignore-all lint/suspicious/noExplicitAny: provider API payloads and the provider classes are untyped JSON and JS
import { getProviderClass } from '../../../src/lib/providers/index.js';
import { testConfig } from '../../config.js';
import { parseScratchProject } from './local-artifacts.js';
import { type E2eStateStore, e2eStateStore, type S3Config, type S3Like } from './state-store.js';

export interface InventoryRow {
  provider: string;
  kind: string;
  name: string;
  region?: string;
  createdAt?: string;
  count?: number;
}
export type Verdict = 'fixture' | 'residue' | 'expected' | 'in-flight' | 'other';
type Judged = InventoryRow & { verdict: Verdict };

export const RESIDUE_MIN_AGE_MS = 21_600_000;

export const FIXTURES: readonly {
  provider: string;
  kind: string;
  name: string | RegExp;
  why: string;
}[] = [
  ...['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway'].map((provider) => ({
    provider,
    kind: 'bucket',
    name: /^vc-e2e-state-(local|ci)(-[a-z0-9]+)?$/,
    why: 'vc-e2e-state buckets: the long-lived Pulumi state of the local and CI namespaces',
  })),
  {
    provider: 'digitalocean',
    kind: 'bucket',
    name: 'vc-local-e2e',
    why: 'the operator Spaces bucket for local e2e',
  },
  {
    provider: 'vultr',
    kind: 'object-storage',
    name: 'vc-e2e',
    why: 'the object storage subscription the e2e keys belong to',
  },
  {
    provider: 'vultr',
    kind: 'bucket',
    name: 'vc-e2e',
    why: 'the bucket in the e2e object storage subscription',
  },
  {
    provider: 'digitalocean',
    kind: 'network',
    name: /^default-[a-z0-9]+$/,
    why: 'default VPC DigitalOcean makes for each region',
  },
  {
    provider: 'scaleway',
    kind: 'firewall',
    name: 'Default security group',
    why: 'default security group of the Scaleway project',
  },
  {
    provider: '*',
    kind: 'state-object',
    name: '.pulumi/meta.yaml',
    why: 'meta.yaml marks a Pulumi state bucket and is meant to stay',
  },
];

// A scratch project name at the start of a name or after a separator (`project:`,
// `cluster:`, `environment:`, a path slash), so `mytestapp-site` is not ours.
// Shapes seen: `citest-<mode>-<ms>-<id>-master`, `testapp-...-storage`, tags
// `project:<name>`, `cluster:<name>`, and the SCRATCH_PROJECT form.
const TEST_NAME = /(?:^|[:/\s])(?:testapp|citest)-/;
// <envPrefix>-<6 hex run tag>[rN], as a whole DNS label (fresh-dns-names.ts).
// Env prefixes are e/d/l/v/s + digit, or ci + optional letter + digit under the
// ci namespace (remapEnvPrefix), so `x1-abcdef.example.io` is not ours.
const TEST_DNS = /(?:^|\.)(?:[edlvs]|ci[dlvs]?)\d-[0-9a-f]{6}(?:r\d+)?(?:\.|$)/;
const GENERIC_TAG = /^(role|environment|node-pool|managed-by|os-flavor|cluster-autoscaler-node):/;
const STATE_RESIDUE = /^\.pulumi\/(stacks|locks)\/|\.json\.bak$/;

const matches = (p: string | RegExp, s: string) => (typeof p === 'string' ? p === s : p.test(s));

export function classify(row: InventoryRow, now: number): Verdict {
  if (
    FIXTURES.some(
      (f) =>
        (f.provider === '*' || f.provider === row.provider) &&
        f.kind === row.kind &&
        matches(f.name, row.name),
    )
  )
    return 'fixture';

  // One age rule for every test-shaped row: the row's own date when it has
  // one (the provider's clock for this very resource), else the run start time
  // in its name, else no proof it is young, so it counts as old.
  const byAge = (): Verdict => {
    const own = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
    const t = Number.isFinite(own) ? own : parseScratchProject(row.name)?.createdAtMs;
    return t !== undefined && now - t < RESIDUE_MIN_AGE_MS ? 'in-flight' : 'residue';
  };

  if (row.kind === 'state-object') return STATE_RESIDUE.test(row.name) ? byAge() : 'other';
  if (row.kind === 'dns-record') return TEST_DNS.test(row.name) ? byAge() : 'other';
  if (TEST_NAME.test(row.name)) return byAge();
  if (row.kind === 'tag' && GENERIC_TAG.test(row.name)) return 'expected';
  return 'other';
}

export function auditExitCode(rows: Judged[], incomplete: string[]): 0 | 1 | 2 {
  if (rows.some((r) => r.verdict === 'residue')) return 1;
  return incomplete.length > 0 ? 2 : 0;
}

const MAX_LISTED = 200;
export function renderSummary(
  rows: Judged[],
  incomplete: string[],
  notCovered: string[] = [],
): string {
  const out: string[] = ['## E2E residue audit', ''];
  const residue = rows.filter((r) => r.verdict === 'residue');
  out.push(residue.length ? `**${residue.length} residue row(s)**` : 'No residue found.', '');
  if (residue.length) {
    out.push('| provider | kind | name | region | created |', '| --- | --- | --- | --- | --- |');
    for (const r of residue.slice(0, MAX_LISTED)) {
      out.push(
        `| ${r.provider} | ${r.kind} | ${r.name.replaceAll('|', '/')} | ${r.region ?? ''} | ${r.createdAt?.slice(0, 16) ?? 'undated'} |`,
      );
    }
    if (residue.length > MAX_LISTED) out.push('', `...and ${residue.length - MAX_LISTED} more.`);
    out.push('');
  }
  const counts = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const c = counts.get(r.provider) ?? {};
    c[r.verdict] = (c[r.verdict] ?? 0) + 1;
    counts.set(r.provider, c);
  }
  out.push(
    '| provider | fixture | expected | in-flight | other |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const [p, c] of [...counts].sort()) {
    out.push(
      `| ${p} | ${c.fixture ?? 0} | ${c.expected ?? 0} | ${c['in-flight'] ?? 0} | ${c.other ?? 0} |`,
    );
  }
  if (notCovered.length) out.push('', `Not covered (refused with 403): ${notCovered.join(', ')}`);
  if (incomplete.length) {
    out.push('', '**Incomplete inventory** (a clean result cannot be claimed):');
    for (const i of incomplete) out.push(`- ${i}`);
  }
  return `${out.join('\n')}\n`;
}

// ---- reading ----------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public status: number | 'transport',
    msg: string,
  ) {
    super(msg);
  }
}
class PaginationError extends Error {}

/**
 * The only way the audit holds an S3 client: `send` refuses every command but
 * ListBuckets, so even the real SDK client cannot write through it.
 */
export function listBucketsOnly(client: S3Like): S3Like {
  return {
    send: async (command: any) => {
      if (command?.constructor?.name !== 'ListBucketsCommand') {
        throw new Error(
          `read-only audit: refusing ${command?.constructor?.name ?? 'unknown'} command`,
        );
      }
      return client.send(command);
    },
  };
}

export interface AuditDeps {
  /** Builds the S3 client for ListBuckets in one region (test seam). */
  s3?: (cfg: S3Config) => S3Like;
  /** The state store of one namespace; null when its credentials are missing (test seam). */
  makeStore?: (
    provider: string,
    env: Record<string, string | undefined>,
    namespace: 'local' | 'ci',
  ) => Pick<E2eStateStore, 'where' | 'list'> | null;
}
type Env = Record<string, string | undefined>;
export interface InventoryResult {
  rows: InventoryRow[];
  complete: boolean;
  incomplete: string[];
  notCovered: string[];
}

const strip = (u: string) => u.replace(/\?.*/, '');
const short = (e: unknown) =>
  (e instanceof Error
    ? `${e.name}: ${(e as { cause?: { code?: string } }).cause?.code ?? e.message}`
    : String(e)
  ).slice(0, 120);
const MAX_PAGES = 100;

interface Kind {
  label: string;
  run: () => Promise<InventoryRow[]>;
}

/**
 * Kinds one provider reads at once. Scaleway alone has about 60 (zones times
 * resource kinds), and all providers run together, so an unbounded fan-out
 * invites a 429 that turns the week's audit incomplete. A cap, not a retry.
 */
export const KIND_CONCURRENCY = 8;

/** `fn` over `items` with at most `limit` running at once; results in input order. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function inventory(
  provider: string,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  deps: AuditDeps = {},
): Promise<InventoryResult> {
  const incomplete: string[] = [];
  const notCovered: string[] = [];
  const rows: InventoryRow[] = [];

  // The only door to the network for API reads: GET, bounded in time.
  const get = async (url: string, headers: Record<string, string> = {}): Promise<any> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new HttpError('transport', `${strip(url)}: ${short(e)}`);
    }
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${strip(url)}`);
    try {
      return await res.json();
    } catch {
      throw new HttpError('transport', `${strip(url)}: unreadable body`);
    }
  };
  const row = (
    kind: string,
    name: unknown,
    region?: unknown,
    createdAt?: unknown,
  ): InventoryRow => ({
    provider,
    kind,
    name: String(name ?? ''),
    ...(region ? { region: String(region) } : {}),
    ...(createdAt ? { createdAt: String(createdAt) } : {}),
  });

  const token = (name: string) => env[name];
  const need = (...names: string[]) => {
    const missing = names.filter((n) => !env[n]);
    if (missing.length) {
      incomplete.push(`${provider}: no credentials (${missing.join(', ')} not set)`);
      return false;
    }
    return true;
  };

  /** Pages of one list: `next(json, page)` returns the next url, or null at the end. */
  async function chain<T>(
    first: string,
    headers: Record<string, string>,
    take: (j: any) => T[],
    next: (j: any, url: string, n: number, taken: number) => string | null,
  ): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let url: string | null = first;
    for (let n = 1; url; n++) {
      if (seen.has(url) || n > MAX_PAGES)
        throw new PaginationError(`pagination did not end at ${strip(url)}`);
      seen.add(url);
      const j = await get(url, headers);
      const items = take(j);
      out.push(...items);
      url = next(j, url, n, items.length);
    }
    return out;
  }

  const withParam = (u: string, k: string, v: string | number) =>
    `${u}${u.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(String(v))}`;
  const hetznerPaged = (u: string, key: string, h: Record<string, string>) =>
    chain<any>(
      withParam(withParam(u, 'per_page', 50), 'page', 1),
      h,
      (j) => j[key] ?? [],
      (j, url) => {
        const n = j.meta?.pagination?.next_page;
        return n ? url.replace(/([?&])page=\d+/, `$1page=${n}`) : null;
      },
    );
  const doPaged = (u: string, key: string, h: Record<string, string>) =>
    chain<any>(
      withParam(u, 'per_page', 200),
      h,
      (j) => j[key] ?? [],
      (j) => j.links?.pages?.next ?? null,
    );
  const linodePaged = (u: string, h: Record<string, string>) =>
    chain<any>(
      withParam(withParam(u, 'page_size', 500), 'page', 1),
      h,
      (j) => j.data ?? [],
      (j, url, n) => ((j.pages ?? 1) > n ? url.replace(/([?&])page=\d+/, `$1page=${n + 1}`) : null),
    );
  const vultrPaged = (u: string, key: string, h: Record<string, string>) =>
    chain<any>(
      withParam(u, 'per_page', 500),
      h,
      (j) => j[key] ?? [],
      (j, url) => {
        const c = j.meta?.links?.next;
        return c ? `${url.replace(/&cursor=.*/, '')}&cursor=${encodeURIComponent(c)}` : null;
      },
    );
  const SCW_PAGE = 100;
  const scalewayPaged = (u: string, key: string, h: Record<string, string>) => {
    let collected = 0;
    let total: number | undefined;
    return chain<any>(
      withParam(withParam(u, 'per_page', SCW_PAGE), 'page', 1),
      h,
      (j) => j[key] ?? [],
      (j, url, n, taken) => {
        collected += taken;
        if (typeof j.total_count === 'number') total = j.total_count;
        if (typeof total === 'number') {
          if (collected >= total) return null;
          if (taken === 0)
            throw new PaginationError(
              `pagination ended early at ${strip(url)} (${collected} of ${total})`,
            );
        } else if (taken < SCW_PAGE) return null;
        return url.replace(/([?&])page=\d+/, `$1page=${n + 1}`);
      },
    );
  };

  // ListBuckets, one guarded client per endpoint; any other command throws.
  const bucketKinds = (regions: string[], accessEnv: string, secretEnv: string): Kind[] =>
    regions.map((region) => ({
      label: `bucket list ${region}`,
      run: async () => {
        const cls = (await (
          getProviderClass(provider) as any
        ).getObjectStorageProviderClass()) as any;
        const cfg: S3Config = {
          provider,
          accessKey: env[accessEnv] as string,
          secretKey: env[secretEnv] as string,
          region,
          endpoint: cls.ENDPOINTS[region],
        };
        const client = listBucketsOnly(
          deps.s3 ? deps.s3(cfg) : new cls(cfg.accessKey, cfg.secretKey, region).getClient(),
        );
        const { ListBucketsCommand } = await import('@aws-sdk/client-s3');
        let out: any;
        try {
          out = await client.send(new ListBucketsCommand({}));
        } catch (e) {
          const status = (e as any)?.$metadata?.httpStatusCode;
          throw new HttpError(
            typeof status === 'number' ? status : 'transport',
            `${region}: ${short(e)}`,
          );
        }
        return (out.Buckets ?? []).map((b: any) =>
          row('bucket', b.Name, b.BucketRegion ?? region, b.CreationDate?.toISOString?.()),
        );
      },
    }));
  const storageRegions = async (): Promise<string[]> => {
    const cls = (await (getProviderClass(provider) as any).getObjectStorageProviderClass()) as any;
    const pinned = env[(getProviderClass(provider) as any).S3_REGION_ENV ?? '']?.trim();
    if (pinned) return [pinned];
    return cls.keyRegions === 'all' ? Object.keys(cls.ENDPOINTS) : [];
  };

  const zone = (testConfig.e2e.domains as Record<string, string>)[provider];
  const SKIP = new Set(['SOA', 'NS']);
  const rec = (z: string, name: string, type: string, createdAt?: string): InventoryRow[] =>
    SKIP.has(type)
      ? []
      : [row('dns-record', !name || name === '@' ? z : `${name}.${z}`, undefined, createdAt)];
  const zoneAbsent = (z: string): InventoryRow[] => {
    notCovered.push(`${provider} dns zone ${z} (not found)`);
    return [];
  };

  let kinds: Kind[] = [];
  if (provider === 'hetzner' && need('HETZNER_API_TOKEN')) {
    const h = { Authorization: `Bearer ${token('HETZNER_API_TOKEN')}` };
    const base = 'https://api.hetzner.cloud/v1';
    const names: Array<[string, string]> = [
      ['servers', 'server'],
      ['volumes', 'volume'],
      ['firewalls', 'firewall'],
      ['networks', 'network'],
      ['load_balancers', 'load-balancer'],
      ['primary_ips', 'ip'],
      ['floating_ips', 'ip'],
      ['ssh_keys', 'ssh-key'],
      ['placement_groups', 'placement-group'],
      ['certificates', 'certificate'],
    ];
    kinds = names.map(([path, kind]) => ({
      label: path,
      run: async () =>
        (await hetznerPaged(`${base}/${path}`, path, h)).map((r) =>
          row(kind, r.name ?? r.ip, r.location?.name ?? r.network_zone, r.created),
        ),
    }));
    kinds.push({
      label: `dns ${zone}`,
      run: async () => {
        const z = (await get(`${base}/zones?name=${encodeURIComponent(zone)}`, h)).zones?.find(
          (x: any) => x.name === zone,
        );
        if (!z) return zoneAbsent(zone);
        const sets = await hetznerPaged(`${base}/zones/${z.id}/rrsets`, 'rrsets', h);
        return sets.flatMap((s) => rec(zone, s.name, s.type));
      },
    });
    kinds.push(...bucketKinds(await storageRegions(), 'HETZNER_ACCESS_KEY', 'HETZNER_SECRET_KEY'));
  } else if (provider === 'digitalocean' && need('DIGITALOCEAN_API_TOKEN')) {
    const h = { Authorization: `Bearer ${token('DIGITALOCEAN_API_TOKEN')}` };
    const base = 'https://api.digitalocean.com/v2';
    const list: Array<[string, string, string]> = [
      ['droplets', 'droplets', 'server'],
      ['volumes', 'volumes', 'volume'],
      ['firewalls', 'firewalls', 'firewall'],
      ['load_balancers', 'load_balancers', 'load-balancer'],
      ['vpcs', 'vpcs', 'network'],
      ['reserved_ips', 'reserved_ips', 'ip'],
      ['account/keys', 'ssh_keys', 'ssh-key'],
    ];
    kinds = list.map(([path, key, kind]) => ({
      label: path,
      run: async () =>
        (await doPaged(`${base}/${path}`, key, h)).map((r) =>
          row(kind, r.name ?? r.ip, r.region?.slug ?? r.region, r.created_at),
        ),
    }));
    kinds.push({
      label: 'tags',
      run: async () =>
        (await doPaged(`${base}/tags`, 'tags', h)).map((t) => ({
          ...row('tag', t.name),
          count: t.resources?.count ?? 0,
        })),
    });
    kinds.push({
      label: `dns ${zone}`,
      run: async () => {
        try {
          const recs = await doPaged(`${base}/domains/${zone}/records`, 'domain_records', h);
          return recs.flatMap((x) => rec(zone, x.name, x.type));
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) return zoneAbsent(zone);
          throw e;
        }
      },
    });
    kinds.push(
      ...bucketKinds(await storageRegions(), 'DIGITALOCEAN_ACCESS_KEY', 'DIGITALOCEAN_SECRET_KEY'),
    );
  } else if (provider === 'linode' && need('LINODE_API_TOKEN')) {
    const h = { Authorization: `Bearer ${token('LINODE_API_TOKEN')}` };
    const base = 'https://api.linode.com/v4';
    const list: Array<[string, string, string]> = [
      ['linode/instances', 'server', 'label'],
      ['volumes', 'volume', 'label'],
      ['networking/firewalls', 'firewall', 'label'],
      ['nodebalancers', 'load-balancer', 'label'],
      ['vpcs', 'network', 'label'],
      ['profile/sshkeys', 'ssh-key', 'label'],
      ['networking/reserved/ips', 'ip', 'address'],
    ];
    kinds = list.map(([path, kind, f]) => ({
      label: path,
      run: async () =>
        (await linodePaged(`${base}/${path}`, h)).map((r) => row(kind, r[f], r.region, r.created)),
    }));
    kinds.push({
      label: 'object-storage/buckets',
      run: async () =>
        (await linodePaged(`${base}/object-storage/buckets`, h)).map((b) =>
          row('bucket', b.label, b.region ?? b.cluster, b.created),
        ),
    });
    kinds.push({
      label: 'tags',
      run: async () => (await linodePaged(`${base}/tags`, h)).map((t) => row('tag', t.label)),
    });
    kinds.push({
      label: `dns ${zone}`,
      run: async () => {
        const doms = await linodePaged(`${base}/domains`, {
          ...h,
          'X-Filter': JSON.stringify({ domain: zone }),
        });
        const d = doms.find((x) => x.domain === zone);
        if (!d) return zoneAbsent(zone);
        return (await linodePaged(`${base}/domains/${d.id}/records`, h)).flatMap((x) =>
          rec(zone, x.name, x.type),
        );
      },
    });
  } else if (provider === 'vultr' && need('VULTR_API_TOKEN')) {
    const h = { Authorization: `Bearer ${token('VULTR_API_TOKEN')}` };
    const base = 'https://api.vultr.com/v2';
    const list: Array<[string, string, string, string]> = [
      ['instances', 'instances', 'server', 'label'],
      ['blocks', 'blocks', 'volume', 'label'],
      ['firewalls', 'firewall_groups', 'firewall', 'description'],
      ['load-balancers', 'load_balancers', 'load-balancer', 'label'],
      ['vpcs', 'vpcs', 'network', 'description'],
      ['ssh-keys', 'ssh_keys', 'ssh-key', 'name'],
      ['reserved-ips', 'reserved_ips', 'ip', 'label'],
      ['object-storage', 'object_storages', 'object-storage', 'label'],
    ];
    kinds = list.map(([path, key, kind, f]) => ({
      label: path,
      run: async () =>
        (await vultrPaged(`${base}/${path}`, key, h)).map((r) =>
          row(kind, r[f] || r.id, r.region, r.date_created),
        ),
    }));
    kinds.push({
      label: `dns ${zone}`,
      run: async () => {
        try {
          const recs = await vultrPaged(`${base}/domains/${zone}/records`, 'records', h);
          return recs.flatMap((x) => rec(zone, x.name, x.type));
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) return zoneAbsent(zone);
          throw e;
        }
      },
    });
    kinds.push(...bucketKinds(await storageRegions(), 'VULTR_ACCESS_KEY', 'VULTR_SECRET_KEY'));
  } else if (
    provider === 'scaleway' &&
    need('SCALEWAY_SECRET_KEY', 'SCALEWAY_DEFAULT_PROJECT_ID')
  ) {
    const h = { 'X-Auth-Token': token('SCALEWAY_SECRET_KEY') as string };
    const pid = encodeURIComponent(token('SCALEWAY_DEFAULT_PROJECT_ID') as string);
    const api = 'https://api.scaleway.com';
    const regions = ['fr-par', 'nl-ams', 'pl-waw'];
    const zones = regions.flatMap((r) => [1, 2, 3].map((n) => `${r}-${n}`));
    const zoned: Array<[string, string, string, string, string]> = [
      ['instance/v1', 'servers', 'servers', 'server', `project=${pid}`],
      ['instance/v1', 'volumes', 'volumes', 'volume', `project=${pid}`],
      ['instance/v1', 'ips', 'ips', 'ip', `project=${pid}`],
      ['instance/v1', 'security_groups', 'security_groups', 'firewall', `project=${pid}`],
      ['block/v1', 'volumes', 'volumes', 'volume', `project_id=${pid}`],
      ['lb/v1', 'lbs', 'lbs', 'load-balancer', `project_id=${pid}`],
    ];
    for (const z of zones) {
      for (const [svc, path, key, kind, filter] of zoned) {
        // fr-par-3 has no Load Balancer service: it answers 501 (seen 2026-11-13).
        if (svc === 'lb/v1' && z === 'fr-par-3') continue;
        kinds.push({
          label: `${svc.split('/')[0]} ${path} ${z}`,
          run: async () =>
            (await scalewayPaged(`${api}/${svc}/zones/${z}/${path}?${filter}`, key, h)).map((r) =>
              row(kind, r.name ?? r.address, z, r.creation_date ?? r.created_at),
            ),
        });
      }
    }
    for (const r of regions) {
      kinds.push({
        label: `private-networks ${r}`,
        run: async () =>
          (
            await scalewayPaged(
              `${api}/vpc/v2/regions/${r}/private-networks?project_id=${pid}`,
              'private_networks',
              h,
            )
          ).map((n) => row('network', n.name, r, n.created_at)),
      });
    }
    kinds.push({
      label: 'ssh-key',
      run: async () =>
        (await scalewayPaged(`${api}/iam/v1alpha1/ssh-keys?project_id=${pid}`, 'ssh_keys', h)).map(
          (k) => row('ssh-key', k.name, undefined, k.created_at),
        ),
    });
    kinds.push({
      label: `dns ${zone}`,
      run: async () => {
        const zs = await scalewayPaged(
          `${api}/domain/v2beta1/dns-zones?domain=${encodeURIComponent(zone)}&project_id=${pid}`,
          'dns_zones',
          h,
        );
        if (!zs.some((x) => x.domain === zone && !x.subdomain)) return zoneAbsent(zone);
        const recs = await scalewayPaged(
          `${api}/domain/v2beta1/dns-zones/${zone}/records`,
          'records',
          h,
        );
        return recs.flatMap((x) => rec(zone, x.name, x.type));
      },
    });
    kinds.push(
      ...bucketKinds(await storageRegions(), 'SCALEWAY_ACCESS_KEY', 'SCALEWAY_SECRET_KEY'),
    );
  } else if (provider === 'cloudflare' && need('CLOUDFLARE_API_TOKEN')) {
    const h = { Authorization: `Bearer ${token('CLOUDFLARE_API_TOKEN')}` };
    const base = 'https://api.cloudflare.com/client/v4';
    kinds.push({
      label: `dns ${zone}`,
      run: async () => {
        const z = (await get(`${base}/zones?name=${encodeURIComponent(zone)}`, h)).result?.find(
          (x: any) => x.name === zone,
        );
        if (!z) return zoneAbsent(zone);
        const recs = await chain<any>(
          `${base}/zones/${z.id}/dns_records?per_page=500&page=1`,
          h,
          (j) => j.result ?? [],
          (j, url, n) =>
            (j.result_info?.total_pages ?? 1) > n
              ? url.replace(/([?&])page=\d+/, `$1page=${n + 1}`)
              : null,
        );
        return recs.flatMap((x) => {
          // Cloudflare names are already full names.
          return SKIP.has(x.type) ? [] : [row('dns-record', x.name, undefined, x.created_on)];
        });
      },
    });
  } else if (!(provider in testConfig.e2e.providers) && provider !== 'cloudflare') {
    incomplete.push(`${provider}: no inventory for this provider`);
  }

  // No e2e zone configured: say so, and request nothing for DNS.
  if (!zone) {
    incomplete.push(`${provider}: no e2e zone configured`);
    kinds = kinds.filter((k) => !k.label.startsWith('dns '));
  }

  // Run every kind, KIND_CONCURRENCY at a time; a failure is classified, never swallowed.
  let ok = 0;
  const refused: number[] = [];
  const results = await mapBounded(kinds, KIND_CONCURRENCY, async (k) => {
    try {
      return { k, rows: await k.run() };
    } catch (e) {
      return { k, error: e };
    }
  });
  for (const r of results) {
    if (!('error' in r)) {
      ok++;
      rows.push(...(r.rows ?? []));
      continue;
    }
    const e = r.error;
    if (e instanceof HttpError && e.status === 403) {
      notCovered.push(`${provider} ${r.k.label}`);
      refused.push(403);
    } else {
      if (e instanceof HttpError && e.status === 401) refused.push(401);
      incomplete.push(
        `${provider} ${r.k.label}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
      );
    }
  }
  if (kinds.length > 0 && ok === 0 && refused.length === kinds.length) {
    incomplete.push(`${provider}: every kind was refused (401 or 403), nothing was read`);
  }

  // State buckets: both namespaces, keys under .pulumi/. Unlocatable means incomplete.
  if (provider in testConfig.e2e.providers) {
    const makeStore =
      deps.makeStore ?? ((p, e, namespace) => e2eStateStore(p, e, { namespace, s3: deps.s3 }));
    for (const ns of ['local', 'ci'] as const) {
      const label = `${provider} ${ns} state bucket`;
      try {
        const store = makeStore(provider, env, ns);
        if (!store) {
          incomplete.push(`${label}: no storage credentials or bucket name`);
          continue;
        }
        const at = await store.where();
        if (!at) {
          incomplete.push(`${label}: could not be located`);
          continue;
        }
        const { keys, complete } = await store.list('.pulumi/');
        if (!complete) incomplete.push(`${label}: listing was cut short`);
        for (const key of keys) {
          const run = parseScratchProject(key);
          rows.push(
            row('state-object', key, ns, run ? new Date(run.createdAtMs).toISOString() : undefined),
          );
        }
      } catch (e) {
        incomplete.push(`${label}: ${short(e)}`);
      }
    }
  }

  return { rows, complete: incomplete.length === 0, incomplete, notCovered };
}

export type { Judged };
