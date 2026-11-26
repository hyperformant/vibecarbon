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
 *   2. BUCKET ENUMERATION. Plain S3 `ListBuckets` works on Vultr's RGW
 *      (live-probed 2026-08-08). Vultr object-storage keys are minted PER
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
 * unattached pvc-* volume is REPORTED, never deleted. Vultr block storage
 * takes no tags, so every k8s CSI volume (`pvc-<16 hex>`) is reported here;
 * `vibecarbon destroy` deletes them by the ids it captured from the
 * cluster's PersistentVolumes. Compose-tier deploys create no block storage.
 */
import type { SweepBreakdown } from '../metrics/db.js';
import { walkProviderPages } from './provider-pages.js';
import {
  bucketSource,
  createSweep,
  reportSweep,
  sweepBuckets,
  sweepClass,
  sweepOwnsVolume,
} from './sweep-core.js';

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
  deleteLoadBalancer(id: number | string): Promise<unknown>;
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
  /**
   * The region holding the bucket (a HeadBucket in every region the keys
   * reach), or null when none does; throws when a region cannot tell.
   */
  locateBucket(name: string): Promise<string | null>;
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
    async locateBucket(name: string) {
      // Vultr keys work on their own cluster only (keyRegions 'own').
      return provider.locateBucket(name);
    },
  };
}

export async function sweepOrphanedVultrResources(
  tag: string,
  projectName: string,
  deps: VultrSweepDeps,
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  // The guard, the opening line, the counts and the incomplete flag
  // (sweep-core.ts). Vultr has no placement groups; `networks` counts VPCs and `floatingIps` reserved IPs.
  const sweep = createSweep(tag, 'Vultr', projectName, { loadBalancers: 0 });
  const { markIncomplete } = sweep;

  const token = deps.token ?? process.env.VULTR_API_TOKEN;
  const provider = deps.provider ?? (token ? await defaultProvider(token) : null);
  if (!provider) {
    markIncomplete('Vultr (no API token)');
    return sweep.result();
  }
  const fetchImpl =
    deps.fetchImpl ??
    (((url: RequestInfo | URL, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
      })) as typeof fetch);

  // Each pass below is sweepClass's outline (sweep-core.ts): list, keep this
  // run's, delete, count or fail, and mark the sweep incomplete when the
  // listing cannot be read. A pass with `thrown` stops a throwing delete at
  // that resource; one without ends on it, as it always did.

  // 1. Instances. deleteServer(waitUntilGone) polls until 404 so dependent
  // sweeps below never race Vultr's async teardown.
  await sweepClass(sweep, {
    listing: 'instance list',
    cleanupFailed: 'Instance cleanup failed',
    count: 'servers',
    list: () => provider.listServersDetailed(),
    owned: (instance) => instance.label.startsWith(projectName),
    announce: (instance) => `Deleting orphaned instance ${instance.id} (${instance.label})`,
    remove: async (instance) => {
      await provider.deleteServer(instance.id, { waitUntilGone: true });
      return true;
    },
    thrown: (instance) => `Instance ${instance.id} delete failed`,
  });

  // 2. Block storage. Project-labeled volumes delete on prefix; pvc-* CSI
  // volumes delete ONLY with a matching project tag (see header).
  await sweepClass(sweep, {
    listing: 'volume list',
    cleanupFailed: 'Volume cleanup failed',
    count: 'volumes',
    list: () => provider.listVolumesDetailed(),
    owned: (volume) =>
      sweepOwnsVolume(
        sweep,
        {
          name: volume.label,
          attached: provider.volumeAttachedServerIds(volume).length > 0,
          projectTag: () => provider.volumeLabels(volume).project,
        },
        { pvcPrefix: 'pvc' },
      ),
    announce: (volume) => `Deleting orphaned volume ${volume.id} (${volume.label})`,
    remove: async (volume) => {
      await provider.deleteVolume(volume.id);
      return true;
    },
    thrown: (volume) => `Volume ${volume.id} delete failed`,
  });

  // 3. Firewall groups / account SSH keys. The provider exposes only
  // exact-name lookups for these, so enumeration walks the API directly;
  // deletion routes through the provider's name-based methods.
  //
  // Cursor pagination (header note 1): each response carries the next
  // page's opaque cursor at `meta.links.next`, empty string when the walk is
  // done. The ≤20-page guard matches the sibling sweeps.
  const walkPages = <T>(path: string, key: string) =>
    walkProviderPages<T>('vultr', `${API_BASE}${path}`, { key, perPage: 100, fetchImpl });

  await sweepClass(sweep, {
    listing: 'firewall list',
    cleanupFailed: 'Firewall cleanup failed',
    count: 'firewalls',
    list: () => walkPages<{ id: string; description?: string }>('/firewalls', 'firewall_groups'),
    // A Vultr firewall group's identity field is `description`, not
    // `label` — and it carries no tags, so prefix matching is the only
    // ownership signal available (header).
    owned: (fw) => !!fw.description?.startsWith(projectName),
    announce: (fw) => `Deleting orphaned firewall group ${fw.description}`,
    remove: async (fw) =>
      (await provider.deleteFirewallByName(fw.description ?? '')).deleted ||
      `Firewall group ${fw.description} delete failed`,
  });

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
  await sweepClass(sweep, {
    listing: 'reserved-ip list',
    cleanupFailed: 'Reserved IP cleanup failed',
    count: 'floatingIps',
    list: () =>
      walkPages<{ id: string; label?: string; subnet?: string; instance_id?: string }>(
        '/reserved-ips',
        'reserved_ips',
      ),
    owned: (ip) => !!ip.label?.startsWith(projectName),
    announce: (ip) => `Deleting orphaned reserved IP ${ip.label} (${ip.subnet ?? ip.id})`,
    remove: async (ip) => {
      const res = await fetchImpl(`${API_BASE}/reserved-ips/${ip.id}`, { method: 'DELETE' });
      return (
        res.ok || res.status === 404 || `Reserved IP ${ip.label} delete failed (${res.status})`
      );
    },
  });

  await sweepClass(sweep, {
    listing: 'ssh-key list',
    cleanupFailed: 'SSH-key cleanup failed',
    count: 'sshKeys',
    list: () => walkPages<{ id: string; name?: string }>('/ssh-keys', 'ssh_keys'),
    owned: (sshKey) => !!sshKey.name?.startsWith(projectName),
    announce: (sshKey) => `Deleting orphaned ssh key ${sshKey.name}`,
    remove: async (sshKey) =>
      (await provider.deleteSSHKeyByName(sshKey.name ?? '')) ||
      `SSH key ${sshKey.name} delete failed`,
  });

  // 4. Load balancers + VPCs. No tier provisions a load balancer; the k8s
  // tiers make one VPC per stack (`<cluster>-network`), the compose tier
  // none. Both are enumerated so a leak can't hide behind a stub (same
  // reasoning as the Linode sweep's listNetworks doc).
  // Listed by this sweep's own walk, not provider.listLoadBalancers(): that
  // method answers [] when the API call fails (its contract for destroy), so
  // an unreadable listing read as "no load balancers" and the class went
  // unchecked under a clean banner.
  await sweepClass(sweep, {
    listing: 'load-balancer list',
    cleanupFailed: 'Load-balancer cleanup failed',
    count: 'loadBalancers',
    list: () =>
      walkPages<{ id: number | string; label: string }>('/load-balancers', 'load_balancers'),
    owned: (lb) => lb.label.startsWith(projectName),
    announce: (lb) => `Deleting orphaned load balancer ${lb.id} (${lb.label})`,
    remove: async (lb) => {
      // deleteLoadBalancer answers true for a 2xx or a 404; false is a refusal.
      if ((await provider.deleteLoadBalancer(lb.id)) === false) {
        throw new Error('the API refused the delete');
      }
      return true;
    },
    thrown: (lb) => `Load balancer ${lb.id} delete failed`,
  });

  // Listed by this sweep's own walk, not provider.listNetworks(), for the
  // same reason as the load balancers above: that method answers [] (or a
  // partial list) when the API call fails.
  // `description` is Vultr's identity field for a VPC (as it is for a
  // firewall group); `label` is accepted alongside it. Matching only on
  // `label` would make the whole VPC pass a silent no-op.
  const vpcName = (vpc: { label?: string; description?: string }) =>
    vpc.label ?? vpc.description ?? '';
  await sweepClass(sweep, {
    listing: 'vpc list',
    cleanupFailed: 'VPC cleanup failed',
    count: 'networks',
    list: () =>
      walkPages<{ id: number | string; label?: string; description?: string }>('/vpcs', 'vpcs'),
    owned: (vpc) => vpcName(vpc).startsWith(projectName),
    announce: (vpc) => `Deleting orphaned VPC ${vpc.id} (${vpcName(vpc)})`,
    remove: async (vpc) => {
      const res = await fetchImpl(`${API_BASE}/vpcs/${vpc.id}`, { method: 'DELETE' });
      return res.ok || res.status === 404 || `VPC ${vpc.id} delete returned ${res.status}`;
    },
    thrown: (vpc) => `VPC ${vpc.id} delete failed`,
  });

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
    await sweepBuckets(
      sweep,
      'Object Storage bucket',
      [bucketSource(objectStorage, cluster, () => markIncomplete('Object Storage bucket list'))],
      { protectedNames: PROTECTED_OBJECT_STORAGE_BUCKETS },
    );
  }

  // The closing banner (sweep-core.ts). The rows are this cloud's classes
  // in breakdown order; a class left out here is left out of the total.
  reportSweep(sweep, [
    ['instances', 'servers'],
    ['volumes', 'volumes'],
    ['firewalls', 'firewalls'],
    ['reserved-ips', 'floatingIps'],
    ['load-balancers', 'loadBalancers'],
    ['vpcs', 'networks'],
    ['buckets', 's3Buckets'],
    ['ssh-keys', 'sshKeys'],
  ]);

  return sweep.result();
}
