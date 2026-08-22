/**
 * Post-destroy orphan sweep for the Vultr scenario (v1).
 *
 * Counterpart to `sweepOrphanedLinodeResources` (sweep-linode.ts) — see
 * that module's header, and sweep-digitalocean.ts's, for the 2026-08-07
 * wrong-cloud-sweep RCA this family exists to prevent. Same structure:
 * deletion through the provider instance API wherever it exists;
 * enumeration of firewall groups and account ssh keys — which the provider
 * only exposes as exact-name lookups — walks the Vultr API directly. All
 * operations are best-effort: failures warn and flip `enumFailed`, never
 * propagate (teardown must complete).
 *
 * Two things differ from the Linode sibling:
 *
 *   1. PAGINATION. Vultr API v2 is CURSOR-based (`meta.links.next`, fed
 *      back as `&cursor=`) with no page/pages counter, so a walk written to
 *      Linode's `{data, page, pages}` idiom would stop after one page and
 *      silently miss every later page's residue.
 *   2. BUCKET ENUMERATION. Plain S3 `ListBuckets` WORKS on Vultr's RGW
 *      (live-probed 2026-08-08 — unlike Linode, where account ListBuckets
 *      fails with SignatureDoesNotMatch and the sweep has to detour through
 *      the management API). Vultr object-storage keys are minted PER
 *      SUBSCRIPTION and one subscription is one cluster, so that listing is
 *      already scoped to exactly the cluster's buckets. The flip side: the
 *      cluster must be known (`VULTR_STORAGE_REGION`); the keys
 *      cannot authenticate against any other one, so a defaulted cluster
 *      would yield an authoritative-looking empty listing for an endpoint
 *      that was never ours. No cluster ⇒ report incomplete, never guess.
 *
 * Firewall ownership is prefix-on-`description` only: a Vultr firewall
 * GROUP has no tags field (`GET /v2/firewalls` returns id/description/
 * date_created/rule counts), so there is no tag fallback of the kind
 * Linode's squeezed-label firewalls need.
 *
 * CSI-volume safety (Hetzner RCA 2026-07-18): a pvc-* volume is only
 * deleted when its decoded tags carry project=<projectName>. An untagged
 * unattached pvc-* volume is REPORTED, never deleted. Compose-tier Vultr
 * deploys create no block storage at all — this rule is future-proofing for
 * the k8s tier, kept now so the family stays uniform.
 */
import type { SweepBreakdown } from '../metrics/db.js';

/**
 * Buckets that must never be swept regardless of prefix. Deliberately EMPTY
 * on Vultr (pinned by sweep-vultr.test.ts): like Linode — and unlike
 * DigitalOcean, where deleting the account's last Space cancels the Spaces
 * subscription, hence the vc-local-e2e anchor — a Vultr Object Storage
 * subscription is cancelled explicitly, never as a side effect of deleting
 * its last bucket. The set exists for structural parity with
 * PROTECTED_SPACES_BUCKETS so the next provider's sweep copies the guard,
 * not its absence.
 */
export const PROTECTED_OBJECT_STORAGE_BUCKETS: ReadonlySet<string> = new Set();

interface VultrSweepProvider {
  listServersDetailed(): Promise<{
    items: Array<{ id: number | string; label: string }>;
    complete: boolean;
  }>;
  deleteServer(id: number | string, opts: { waitUntilGone: boolean }): Promise<unknown>;
  listVolumesDetailed(): Promise<{
    items: Array<{ id: number | string; label: string }>;
    complete: boolean;
  }>;
  volumeAttachedServerIds(volume: object): Array<unknown>;
  volumeLabels(volume: object): Record<string, string>;
  deleteVolume(id: number | string): Promise<unknown>;
  deleteFirewallByName(name: string): Promise<{ deleted: boolean }>;
  deleteSSHKeyByName(name: string): Promise<boolean>;
  listLoadBalancers(): Promise<Array<{ id: number | string; label: string }>>;
  deleteLoadBalancer(id: number | string): Promise<unknown>;
  /**
   * VPCs. `description` is Vultr's identity field for a VPC (as it is for a
   * firewall group) — accepted alongside `label` so this half still sweeps
   * if the provider hands back raw API rows rather than normalized ones.
   * Matching only on `label` would make the whole VPC pass a silent no-op.
   */
  listNetworks(): Promise<Array<{ id: number | string; label?: string; description?: string }>>;
}

interface VultrSweepObjectStorage {
  /**
   * Bucket names visible to the subscription's keys; null = unreadable.
   * Backed by plain S3 ListBuckets against the subscription's own cluster
   * endpoint (see the module header for why that is enough here and was
   * not on Linode).
   */
  listBuckets(): Promise<string[] | null>;
  emptyAndDeleteBucket(name: string): Promise<{ objectsRemoved: number }>;
}

export interface VultrSweepDeps {
  provider?: VultrSweepProvider;
  objectStorage?: VultrSweepObjectStorage;
  fetchImpl?: typeof fetch;
  /** VULTR_API_TOKEN — required when `provider`/`fetchImpl` are not injected. */
  token?: string;
  /** VULTR_ACCESS_KEY/SECRET — required when `objectStorage` is not injected. */
  storageKey?: string;
  storageSecret?: string;
  /**
   * Object-storage CLUSTER slug (e.g. `ewr1`) the subscription's keys belong
   * to — `VULTR_STORAGE_REGION`. Required for the bucket half when
   * `objectStorage` is not injected; there is no safe default (see header).
   */
  storageRegion?: string;
}

const API_BASE = 'https://api.vultr.com/v2';

async function defaultProvider(token: string): Promise<VultrSweepProvider> {
  const { VultrProvider } = (await import('../../../src/lib/providers/vultr.js')) as {
    VultrProvider: new (token: string) => VultrSweepProvider;
  };
  return new VultrProvider(token);
}

async function defaultObjectStorage(
  key: string,
  secret: string,
  cluster: string,
): Promise<VultrSweepObjectStorage> {
  const { VultrObjectStorageProvider } = (await import(
    '../../../src/lib/providers/vultr-objectstorage.js'
    // biome-ignore lint/suspicious/noExplicitAny: JS module interop
  )) as any;
  // Constructing the provider (rather than hand-rolling an S3Client the way
  // the DigitalOcean sweep does) is what pins the endpoint to
  // ENDPOINTS[cluster] and the signing region to S3_SIGNING_REGION —
  // 'us-east-1', because Vultr's RGW rejects the SDK-injected
  // LocationConstraint — and gets s3-base's retry/timeout envelope for free.
  const provider = new VultrObjectStorageProvider(key, secret, cluster);
  return {
    async listBuckets() {
      try {
        const buckets = (await provider.listBuckets()) as Array<{ name?: string }>;
        return buckets.map((b) => b.name).filter((n): n is string => !!n);
      } catch {
        return null;
      }
    },
    async emptyAndDeleteBucket(name: string) {
      return provider.emptyAndDeleteBucket(name);
    },
  };
}

export async function sweepOrphanedVultrResources(
  tag: string,
  projectName: string,
  deps: VultrSweepDeps,
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  if (!projectName || projectName.length < 4) {
    throw new Error(
      `[sweep] refusing to sweep Vultr with project name ${JSON.stringify(projectName)}`,
    );
  }
  console.log(`${tag} Sweeping orphaned Vultr resources for ${projectName}...`);

  const counts: SweepBreakdown = {
    servers: 0,
    volumes: 0,
    placementGroups: 0, // Vultr has no placement groups
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

  const token = deps.token ?? process.env.VULTR_API_TOKEN;
  let provider = deps.provider;
  if (!provider) {
    if (!token) {
      markIncomplete('Vultr (no API token)');
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

  // 1. Instances. deleteServer(waitUntilGone) polls until 404 so dependent
  // sweeps below never race Vultr's async teardown.
  try {
    const { items, complete } = await provider.listServersDetailed();
    if (!complete) markIncomplete('instance list');
    for (const instance of items) {
      if (!instance.label.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned instance ${instance.id} (${instance.label})`);
      try {
        await provider.deleteServer(instance.id, { waitUntilGone: true });
        counts.servers++;
      } catch (err) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] Instance ${instance.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('instance list');
    console.warn(`${tag} [sweep] Instance cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2. Block storage. Project-labeled volumes delete on prefix; pvc-* CSI
  // volumes delete ONLY with a matching project tag (see header).
  try {
    const { items, complete } = await provider.listVolumesDetailed();
    if (!complete) markIncomplete('volume list');
    for (const volume of items) {
      if (provider.volumeAttachedServerIds(volume).length > 0) continue;
      const ownedByName = volume.label.startsWith(projectName);
      const isPvc = volume.label.startsWith('pvc');
      const ownedByTag = isPvc && provider.volumeLabels(volume).project === projectName;
      if (!ownedByName && !ownedByTag) {
        if (isPvc) {
          console.warn(
            `${tag} [sweep] Unattached CSI volume ${volume.label} carries no project=${projectName} tag — ` +
              'NOT deleting (could belong to a concurrent run); review manually if it persists.',
          );
        }
        continue;
      }
      console.log(`${tag} [sweep] Deleting orphaned volume ${volume.id} (${volume.label})`);
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

  // 3. Firewall groups / account SSH keys. The provider exposes only
  // exact-name lookups for these, so enumeration walks the API directly;
  // deletion routes through the provider's name-based methods.
  //
  // Cursor pagination (header note 1): each response carries the next
  // page's opaque cursor at `meta.links.next`, empty string when the walk is
  // done. The ≤20-page guard matches the sibling sweeps.
  const walkPages = async <T>(
    path: string,
    key: string,
  ): Promise<{ items: T[]; complete: boolean }> => {
    const items: T[] = [];
    let cursor = '';
    for (let guard = 0; guard < 20; guard++) {
      let data: Record<string, unknown>;
      try {
        const url =
          `${API_BASE}${path}?per_page=100` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res = await fetchImpl(url);
        if (!res.ok) return { items, complete: false };
        data = (await res.json()) as Record<string, unknown>;
      } catch {
        return { items, complete: false };
      }
      if (Array.isArray(data[key])) items.push(...(data[key] as T[]));
      const next = (data.meta as { links?: { next?: string } } | undefined)?.links?.next;
      if (!next) return { items, complete: true };
      cursor = next;
    }
    return { items, complete: true };
  };

  try {
    const { items, complete } = await walkPages<{ id: string; description?: string }>(
      '/firewalls',
      'firewall_groups',
    );
    if (!complete) markIncomplete('firewall list');
    for (const fw of items) {
      // A Vultr firewall group's identity field is `description`, not
      // `label` — and it carries no tags, so prefix matching is the only
      // ownership signal available (header).
      if (!fw.description?.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned firewall group ${fw.description}`);
      const { deleted } = await provider.deleteFirewallByName(fw.description);
      if (deleted) counts.firewalls++;
      else {
        enumFailed = true;
        console.warn(`${tag} [sweep] Firewall group ${fw.description} delete failed`);
      }
    }
  } catch (e) {
    markIncomplete('firewall list');
    console.warn(`${tag} [sweep] Firewall cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // Reserved IPs. vultr-k8s.js's `ingress` ReservedIp bills WHILE UNASSIGNED,
  // and deleting the instance it was attached to does NOT release it — so a
  // failed destroy strands a billing IP that only this sweep can reap.
  //
  // This pass used to be a hardcoded `floatingIps: 0` with the comment
  // a claim that this tier mints none. That was true of
  // the compose tier and became false the moment the k8s tier landed: the
  // ledger then reported zero meaning "never looked", not "found none".
  //
  // Attribution is the `label` the program sets (`<cluster>-ingress`), same
  // prefix contract as every other pass here. An unlabelled or foreign IP is
  // never touched.
  try {
    const { items, complete } = await walkPages<{
      id: string;
      label?: string;
      subnet?: string;
      instance_id?: string;
    }>('/reserved-ips', 'reserved_ips');
    if (!complete) markIncomplete('reserved-ip list');
    for (const ip of items) {
      if (!ip.label?.startsWith(projectName)) continue;
      console.log(
        `${tag} [sweep] Deleting orphaned reserved IP ${ip.label} (${ip.subnet ?? ip.id})`,
      );
      const res = await fetchImpl(`${API_BASE}/reserved-ips/${ip.id}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) counts.floatingIps++;
      else {
        enumFailed = true;
        console.warn(`${tag} [sweep] Reserved IP ${ip.label} delete failed (${res.status})`);
      }
    }
  } catch (e) {
    markIncomplete('reserved-ip list');
    console.warn(
      `${tag} [sweep] Reserved IP cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  try {
    const { items, complete } = await walkPages<{ id: string; name?: string }>(
      '/ssh-keys',
      'ssh_keys',
    );
    if (!complete) markIncomplete('ssh-key list');
    for (const sshKey of items) {
      if (!sshKey.name?.startsWith(projectName)) continue;
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

  // 4. Load balancers + VPCs — never provisioned by the compose tier, but
  // enumerated so a future tier's leak can't hide behind a stub (same
  // reasoning as the Linode sweep's listNetworks doc).
  try {
    const lbs = await provider.listLoadBalancers();
    for (const lb of lbs) {
      if (!lb.label.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned load balancer ${lb.id} (${lb.label})`);
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
    const vpcs = await provider.listNetworks();
    for (const vpc of vpcs) {
      const vpcName = vpc.label ?? vpc.description ?? '';
      if (!vpcName.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned VPC ${vpc.id} (${vpcName})`);
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
    console.warn(`${tag} [sweep] VPC cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 5. Object Storage buckets — plain S3 ListBuckets against the ONE
  // cluster the subscription's keys belong to (header note 2).
  const cluster = deps.storageRegion || process.env.VULTR_STORAGE_REGION || '';
  let objectStorage = deps.objectStorage;
  if (!objectStorage) {
    const key = deps.storageKey ?? process.env.VULTR_ACCESS_KEY;
    const secret = deps.storageSecret ?? process.env.VULTR_SECRET_KEY;
    if (!key || !secret) {
      markIncomplete('Object Storage (no credentials)');
    } else if (!cluster) {
      markIncomplete(
        'Object Storage (no cluster — set VULTR_STORAGE_REGION; per-subscription keys only authenticate against their own cluster)',
      );
    } else {
      try {
        objectStorage = await defaultObjectStorage(key, secret, cluster);
      } catch (err) {
        markIncomplete(
          `Object Storage (cluster '${cluster}' unusable: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }
  if (objectStorage) {
    let buckets: string[] | null;
    try {
      buckets = await objectStorage.listBuckets();
    } catch {
      buckets = null;
    }
    if (buckets === null) {
      markIncomplete('Object Storage bucket list');
    } else {
      for (const name of buckets) {
        if (PROTECTED_OBJECT_STORAGE_BUCKETS.has(name)) continue;
        if (!name.startsWith(projectName)) continue;
        console.log(
          `${tag} [sweep] Deleting Object Storage bucket ${name}${cluster ? ` (${cluster})` : ''}`,
        );
        try {
          const { objectsRemoved } = await objectStorage.emptyAndDeleteBucket(name);
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
  // sibling sweeps; the clean line names the cloud it actually verified.
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
      `instances=${counts.servers}`,
      `volumes=${counts.volumes}`,
      `firewalls=${counts.firewalls}`,
      `load-balancers=${counts.loadBalancers ?? 0}`,
      `vpcs=${counts.networks}`,
      `buckets=${counts.s3Buckets}`,
      `ssh-keys=${counts.sshKeys}`,
    ].join(', ');
    console.warn(
      `${tag} [sweep] REGRESSION: destroy left ${totalOrphans} Vultr orphan resource(s) (${breakdown}). vibecarbon destroy did not free these — fix the corresponding destroy code path.`,
    );
  } else if (enumFailed) {
    console.warn(
      `${tag} [sweep] REGRESSION: could not enumerate one or more Vultr resource types — orphan check is incomplete, treat as a destroy regression.`,
    );
  } else {
    console.log(`${tag} [sweep] No Vultr orphans found — destroy worked cleanly.`);
  }

  return { counts, enumFailed };
}
