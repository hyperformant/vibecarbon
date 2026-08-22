/**
 * Post-destroy orphan sweep for DigitalOcean scenarios (d1/d2/d3).
 *
 * Counterpart to `sweepOrphanedHetznerResources` in scenarios/_run-lifecycle.ts.
 * Until 2026-08-07 the lifecycle called the Hetzner sweep UNCONDITIONALLY, so
 * a DO run enumerated the wrong cloud and printed "No orphans found — destroy
 * worked cleanly" over any amount of leaked DO residue; the only backstop was
 * checkDigitalOceanProjectClean failing the NEXT DO run's preflight.
 *
 * Deletion goes through the provider instance API wherever it exists
 * (listServersDetailed / deleteServer(waitUntilGone) / listVolumesDetailed /
 * deleteVolume / deleteFirewallByName / deleteSSHKeyByName /
 * listLoadBalancers / deleteLoadBalancer); enumeration of firewalls, ssh
 * keys, and VPCs — which the provider only exposes as exact-name lookups —
 * walks the DO API directly with the same links.pages.next idiom as
 * preflight.ts. All operations are best-effort: failures warn and flip
 * `enumFailed`, they never propagate (teardown must complete).
 *
 * CSI-volume safety (learned the hard way on Hetzner, 2026-07-18, when an
 * unscoped pvc-* sweep from a concurrent run deleted a LIVE rig's data
 * volumes): a pvc-* volume is only deleted when its decoded tags carry
 * project=<projectName>. An untagged unattached pvc-* volume is REPORTED,
 * never deleted — better a loud leak than a cross-run data loss.
 */
import type { SweepBreakdown } from '../metrics/db.js';

/**
 * Buckets that must NEVER be swept, no matter what prefix matches them.
 * vc-local-e2e (sfo3) is the deliberate DigitalOcean subscription anchor —
 * deleting the account's last Space cancels the Spaces subscription and the
 * next e2e run pays the re-subscribe latency (or fails outright). This used
 * to survive only by accident of prefix scoping; it is now a hard guard.
 */
export const PROTECTED_SPACES_BUCKETS: ReadonlySet<string> = new Set(['vc-local-e2e']);

interface DoSweepProvider {
  listServersDetailed(): Promise<{
    items: Array<{ id: number | string; name: string }>;
    complete: boolean;
  }>;
  deleteServer(id: number | string, opts: { waitUntilGone: boolean }): Promise<unknown>;
  listVolumesDetailed(): Promise<{
    items: Array<{ id: number | string; name: string }>;
    complete: boolean;
  }>;
  volumeAttachedServerIds(volume: object): Array<unknown>;
  volumeLabels(volume: object): Record<string, string>;
  deleteVolume(id: number | string): Promise<unknown>;
  deleteFirewallByName(name: string): Promise<{ deleted: boolean }>;
  deleteSSHKeyByName(name: string): Promise<boolean>;
  listLoadBalancers(): Promise<Array<{ id: string; name: string }>>;
  deleteLoadBalancer(id: string): Promise<unknown>;
}

interface DoSweepSpaces {
  regions(): string[];
  /** Bucket names visible from this region's endpoint; null = unreadable. */
  listBuckets(region: string): Promise<string[] | null>;
  emptyAndDeleteBucket(region: string, name: string): Promise<{ objectsRemoved: number }>;
}

export interface DoSweepDeps {
  provider?: DoSweepProvider;
  spaces?: DoSweepSpaces;
  fetchImpl?: typeof fetch;
  /** DIGITALOCEAN_API_TOKEN — required when `provider`/`fetchImpl` are not injected. */
  token?: string;
  /** DIGITALOCEAN_ACCESS_KEY/SECRET — required when `spaces` is not injected. */
  spacesKey?: string;
  spacesSecret?: string;
}

const API_BASE = 'https://api.digitalocean.com/v2';

async function defaultProvider(token: string): Promise<DoSweepProvider> {
  const { DigitalOceanProvider } = (await import('../../../src/lib/providers/digitalocean.js')) as {
    DigitalOceanProvider: new (token: string) => DoSweepProvider;
  };
  return new DigitalOceanProvider(token);
}

async function defaultSpaces(key: string, secret: string): Promise<DoSweepSpaces> {
  const { DigitalOceanSpacesProvider } = (await import(
    '../../../src/lib/providers/digitalocean-spaces.js'
    // biome-ignore lint/suspicious/noExplicitAny: JS module interop
  )) as any;
  const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
  return {
    regions: () => Object.keys(DigitalOceanSpacesProvider.REGIONS),
    async listBuckets(region: string) {
      try {
        const s3 = new S3Client({
          endpoint: DigitalOceanSpacesProvider.ENDPOINTS[region],
          region,
          credentials: { accessKeyId: key, secretAccessKey: secret },
          forcePathStyle: false,
        });
        const resp = await s3.send(new ListBucketsCommand({}));
        return (resp.Buckets ?? []).map((b) => b.Name).filter((n): n is string => !!n);
      } catch {
        return null;
      }
    },
    async emptyAndDeleteBucket(region: string, name: string) {
      const provider = new DigitalOceanSpacesProvider(key, secret, region);
      return provider.emptyAndDeleteBucket(name);
    },
  };
}

export async function sweepOrphanedDigitalOceanResources(
  tag: string,
  projectName: string,
  deps: DoSweepDeps,
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  if (!projectName || projectName.length < 4) {
    // An empty/short prefix would match resources that are not ours; the
    // shortest legitimate e2e project name is `testapp-…` / `citest-…`.
    throw new Error(
      `[sweep] refusing to sweep DigitalOcean with project name ${JSON.stringify(projectName)}`,
    );
  }
  console.log(`${tag} Sweeping orphaned DigitalOcean resources for ${projectName}...`);

  const counts: SweepBreakdown = {
    servers: 0,
    volumes: 0,
    placementGroups: 0, // DigitalOcean has no placement groups
    firewalls: 0,
    floatingIps: 0,
    networks: 0, // VPCs
    s3Buckets: 0,
    sshKeys: 0,
    loadBalancers: 0,
  };
  let enumFailed = false;
  const markIncomplete = (what: string) => {
    enumFailed = true;
    console.warn(
      `${tag} [sweep] ${what} enumeration incomplete — residue past the last readable page cannot be ruled out`,
    );
  };

  const token = deps.token ?? process.env.DIGITALOCEAN_API_TOKEN;
  let provider = deps.provider;
  if (!provider) {
    if (!token) {
      markIncomplete('DigitalOcean (no API token)');
      return { counts, enumFailed };
    }
    provider = await defaultProvider(token);
  }
  const fetchImpl =
    deps.fetchImpl ??
    (((url: RequestInfo | URL, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      })) as typeof fetch);

  // 1. Droplets. deleteServer(waitUntilGone) polls until 404 so the
  // dependent sweeps below never race DO's async teardown (the DO analogue
  // of the Hetzner sweep's 1b settle-wait).
  try {
    const { items, complete } = await provider.listServersDetailed();
    if (!complete) markIncomplete('droplet list');
    for (const droplet of items) {
      if (!droplet.name.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned droplet ${droplet.id} (${droplet.name})`);
      try {
        await provider.deleteServer(droplet.id, { waitUntilGone: true });
        counts.servers++;
      } catch (err) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] Droplet ${droplet.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('droplet list');
    console.warn(`${tag} [sweep] Droplet cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2. Volumes. Project-named volumes delete on prefix; pvc-* CSI volumes
  // delete ONLY with a matching project tag (see header — cross-run safety).
  try {
    const { items, complete } = await provider.listVolumesDetailed();
    if (!complete) markIncomplete('volume list');
    for (const volume of items) {
      if (provider.volumeAttachedServerIds(volume).length > 0) continue;
      const ownedByName = volume.name.startsWith(projectName);
      const isPvc = volume.name.startsWith('pvc-');
      const ownedByTag = isPvc && provider.volumeLabels(volume).project === projectName;
      if (!ownedByName && !ownedByTag) {
        if (isPvc) {
          console.warn(
            `${tag} [sweep] Unattached CSI volume ${volume.name} carries no project=${projectName} tag — ` +
              'NOT deleting (could belong to a concurrent run); review manually if it persists.',
          );
        }
        continue;
      }
      console.log(`${tag} [sweep] Deleting orphaned volume ${volume.id} (${volume.name})`);
      try {
        await provider.deleteVolume(volume.id);
        counts.volumes++;
      } catch (err) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] Volume ${volume.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('volume list');
    console.warn(`${tag} [sweep] Volume cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 3. Firewalls / SSH keys / VPCs. The provider exposes only exact-name
  // lookups for these, so enumeration walks the API directly (preflight's
  // links.pages.next idiom); deletion still routes through the provider's
  // name-based methods where they exist.
  const walkPages = async <T>(
    path: string,
    key: string,
  ): Promise<{ items: T[]; complete: boolean }> => {
    const items: T[] = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      let data: Record<string, unknown>;
      try {
        const res = await fetchImpl(`${API_BASE}${path}?per_page=50&page=${page}`);
        if (!res.ok) return { items, complete: false };
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        return { items, complete: false };
      }
      if (Array.isArray(data[key])) items.push(...(data[key] as T[]));
      if (!(data.links as { pages?: { next?: string } } | undefined)?.pages?.next) {
        return { items, complete: true };
      }
      page++;
    }
    return { items, complete: true };
  };

  try {
    const { items, complete } = await walkPages<{ id: string; name: string }>(
      '/firewalls',
      'firewalls',
    );
    if (!complete) markIncomplete('firewall list');
    for (const fw of items) {
      if (!fw.name.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned firewall ${fw.name}`);
      const { deleted } = await provider.deleteFirewallByName(fw.name);
      if (deleted) counts.firewalls++;
      else {
        enumFailed = true;
        console.warn(`${tag} [sweep] Firewall ${fw.name} delete failed`);
      }
    }
  } catch (e) {
    markIncomplete('firewall list');
    console.warn(`${tag} [sweep] Firewall cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const { items, complete } = await walkPages<{ id: number; name: string }>(
      '/account/keys',
      'ssh_keys',
    );
    if (!complete) markIncomplete('ssh-key list');
    for (const sshKey of items) {
      if (!sshKey.name.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned ssh key ${sshKey.name}`);
      if (await provider.deleteSSHKeyByName(sshKey.name)) counts.sshKeys++;
      else {
        enumFailed = true;
        console.warn(`${tag} [sweep] SSH key ${sshKey.name} delete failed`);
      }
    }
  } catch (e) {
    markIncomplete('ssh-key list');
    console.warn(`${tag} [sweep] SSH-key cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const lbs = await provider.listLoadBalancers();
    for (const lb of lbs) {
      if (!lb.name.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned load balancer ${lb.id} (${lb.name})`);
      try {
        await provider.deleteLoadBalancer(lb.id);
        counts.loadBalancers = (counts.loadBalancers ?? 0) + 1;
      } catch (err) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] Load balancer ${lb.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    console.warn(
      `${tag} [sweep] Load-balancer cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  try {
    const { items, complete } = await walkPages<{ id: string; name: string }>('/vpcs', 'vpcs');
    if (!complete) markIncomplete('vpc list');
    for (const vpc of items) {
      if (!vpc.name.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned VPC ${vpc.id} (${vpc.name})`);
      try {
        const res = await fetchImpl(`${API_BASE}/vpcs/${vpc.id}`, { method: 'DELETE' });
        if (res.ok || res.status === 404) counts.networks++;
        else {
          enumFailed = true;
          console.warn(`${tag} [sweep] VPC ${vpc.id} delete returned ${res.status}`);
        }
      } catch (err) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] VPC ${vpc.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('vpc list');
    console.warn(`${tag} [sweep] VPC cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // Reserved IPs. digitalocean-k8s.js's `ingress` ReservedIp mints one and it bills WHILE UNASSIGNED — deleting
  // the droplet it was attached to does NOT release it, so a failed destroy
  // strands a billing IP.
  //
  // This counter used to be a hardcoded `floatingIps: 0` with the comment
  // a claim that this tier mints none. True of the
  // compose tier; false the moment the k8s tier landed. The ledger then read
  // zero meaning "never looked", not "found none" — a false-clean verdict on
  // the one resource class that bills while idle.
  //
  // We do NOT auto-delete here. DigitalOcean reserved IPs carry no name or tag
  // (unlike Vultr's, which the program labels), so an UNASSIGNED one cannot be
  // attributed to this namespace from the API alone — and deleting an
  // unattributable IP could destroy someone's production address. Instead an
  // unassigned IP is reported and the sweep is marked INCOMPLETE, which fails
  // the CI step so a human decides. An unverifiable sweep must not pose as a
  // clean one; that contract is why this file exits non-zero on enumeration
  // gaps everywhere else.
  try {
    // Paginated walk, not a single fat page: a truncated listing reads as
    // "nothing found", which is precisely the false-clean this pass exists to
    // remove (see list-endpoint-pagination-sweep.test.ts).
    type ReservedIpPage = {
      reserved_ips?: Array<{ ip?: string; droplet?: unknown | null }>;
      links?: { pages?: { next?: string } };
    };
    const reserved: Array<{ ip?: string; droplet?: unknown | null }> = [];
    let url: string | null = `${API_BASE}/reserved_ips?per_page=200`;
    let pageOk = true;
    for (let guard = 0; guard < 20 && url; guard++) {
      const res = await fetchImpl(url);
      if (!res.ok) {
        pageOk = false;
        break;
      }
      const body = (await res.json()) as ReservedIpPage;
      url = body.links?.pages?.next ?? null;
      reserved.push(...(body.reserved_ips ?? []));
    }
    if (!pageOk) {
      markIncomplete('reserved-ip list');
    } else {
      const unassigned = reserved.filter((r) => !r.droplet);
      for (const r of unassigned) {
        console.warn(
          `${tag} [sweep] UNASSIGNED reserved IP ${r.ip} is billing and cannot be ` +
            'attributed from the API (DO reserved IPs carry no name/tag). Not deleted — ' +
            'check it belongs to this e2e account and release it manually.',
        );
      }
      if (unassigned.length > 0) markIncomplete('unassigned reserved IPs present');
    }
  } catch (e) {
    markIncomplete('reserved-ip list');
    console.warn(`${tag} [sweep] Reserved IP check failed: ${e instanceof Error ? e.message : e}`);
  }

  // 4. Spaces buckets. DO's ListBuckets is account-wide from any regional
  // endpoint, so the same bucket can appear in several regions' listings —
  // dedupe by name and let emptyAndDeleteBucket resolve the right region.
  let spaces = deps.spaces;
  if (!spaces) {
    const key = deps.spacesKey ?? process.env.DIGITALOCEAN_ACCESS_KEY;
    const secret = deps.spacesSecret ?? process.env.DIGITALOCEAN_SECRET_KEY;
    if (!key || !secret) {
      markIncomplete('Spaces (no credentials)');
      spaces = undefined;
    } else {
      spaces = await defaultSpaces(key, secret);
    }
  }
  if (spaces) {
    const handled = new Set<string>();
    for (const region of spaces.regions()) {
      let buckets: string[] | null;
      try {
        buckets = await spaces.listBuckets(region);
      } catch {
        buckets = null;
      }
      if (buckets === null) {
        markIncomplete(`Spaces region ${region}`);
        continue;
      }
      for (const name of buckets) {
        if (handled.has(name)) continue;
        if (PROTECTED_SPACES_BUCKETS.has(name)) {
          // The account's deliberate subscription anchor (see the constant's
          // doc) — never swept, even if a project prefix ever matches it.
          handled.add(name);
          continue;
        }
        if (!name.startsWith(projectName)) continue;
        handled.add(name);
        console.log(`${tag} [sweep] Deleting Spaces bucket ${name} (${region})`);
        try {
          const { objectsRemoved } = await spaces.emptyAndDeleteBucket(region, name);
          console.log(`${tag} [sweep]   deleted ${name} (${objectsRemoved} obj)`);
          counts.s3Buckets++;
        } catch (err) {
          enumFailed = true;
          console.warn(
            `${tag} [sweep]   FAILED ${name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  // Regression banner — same grep-stable `[sweep] REGRESSION` marker as the
  // Hetzner sweep, and the clean line names the cloud it actually verified.
  const totalOrphans =
    counts.servers +
    counts.volumes +
    counts.firewalls +
    (counts.loadBalancers ?? 0) +
    counts.networks +
    counts.s3Buckets +
    counts.sshKeys;
  if (totalOrphans > 0) {
    const breakdown = [
      `droplets=${counts.servers}`,
      `volumes=${counts.volumes}`,
      `firewalls=${counts.firewalls}`,
      `load-balancers=${counts.loadBalancers ?? 0}`,
      `vpcs=${counts.networks}`,
      `spaces-buckets=${counts.s3Buckets}`,
      `ssh-keys=${counts.sshKeys}`,
    ].join(', ');
    console.warn(
      `${tag} [sweep] REGRESSION: destroy left ${totalOrphans} DigitalOcean orphan resource(s) (${breakdown}). vibecarbon destroy did not free these — fix the corresponding destroy code path.`,
    );
  } else if (enumFailed) {
    console.warn(
      `${tag} [sweep] REGRESSION: could not enumerate one or more DigitalOcean resource types — orphan check is incomplete, treat as a destroy regression.`,
    );
  } else {
    console.log(`${tag} [sweep] No DigitalOcean orphans found — destroy worked cleanly.`);
  }

  return { counts, enumFailed };
}
