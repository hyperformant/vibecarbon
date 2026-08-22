/**
 * Post-destroy orphan sweep for the Linode scenario (l1).
 *
 * Counterpart to `sweepOrphanedDigitalOceanResources` (sweep-digitalocean.ts)
 * — see that module's header for the 2026-08-07 wrong-cloud-sweep RCA this
 * family exists to prevent. Same structure: deletion through the provider
 * instance API wherever it exists; enumeration of firewalls and profile ssh
 * keys — which the provider only exposes as exact-label lookups — walks the
 * Linode API directly with the `{data, page, pages}` envelope idiom. All
 * operations are best-effort: failures warn and flip `enumFailed`, never
 * propagate (teardown must complete).
 *
 * CSI-volume safety (Hetzner RCA 2026-07-18): a pvc-* volume is only
 * deleted when its decoded tags carry project=<projectName>. An untagged
 * unattached pvc-* volume is REPORTED, never deleted. Compose-tier Linode
 * deploys create no volumes at all — this rule is future-proofing for the
 * k8s tier, kept now so the family stays uniform.
 */
import type { SweepBreakdown } from '../metrics/db.js';

/**
 * Buckets that must never be swept regardless of prefix. Deliberately EMPTY
 * on Linode (pinned by sweep-linode.test.ts): unlike DigitalOcean — where
 * deleting the account's last Space cancels the Spaces subscription, hence
 * the vc-local-e2e anchor — Linode Object Storage is only ever cancelled
 * explicitly, never as a side effect of deleting the last bucket. The set
 * exists for structural parity with PROTECTED_SPACES_BUCKETS so the next
 * provider's sweep copies the guard, not its absence.
 */
export const PROTECTED_OBJECT_STORAGE_BUCKETS: ReadonlySet<string> = new Set();

interface LinodeSweepProvider {
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
  listNetworks(): Promise<Array<{ id: number | string; label: string }>>;
}

interface LinodeSweepObjectStorage {
  /**
   * Every bucket on the account with its assigned cluster slug; null =
   * unreadable. Backed by the Linode MANAGEMENT API (GET
   * /object-storage/buckets), NOT S3 ListBuckets: account-level ListBuckets
   * fails with SignatureDoesNotMatch on Linode's RGW (live-probed
   * 2026-08-08 across every signing-region/path-style combination) while
   * bucket-level S3 ops work fine — and the management listing additionally
   * reports each bucket's cluster, which per-cluster S3 listings couldn't.
   */
  listAllBuckets(): Promise<Array<{ name: string; cluster: string }> | null>;
  emptyAndDeleteBucket(cluster: string, name: string): Promise<{ objectsRemoved: number }>;
}

export interface LinodeSweepDeps {
  provider?: LinodeSweepProvider;
  objectStorage?: LinodeSweepObjectStorage;
  fetchImpl?: typeof fetch;
  /** LINODE_API_TOKEN — required when `provider`/`fetchImpl` are not injected. */
  token?: string;
  /** LINODE_ACCESS_KEY/SECRET — required when `objectStorage` is not injected. */
  storageKey?: string;
  storageSecret?: string;
}

const API_BASE = 'https://api.linode.com/v4';

async function defaultProvider(token: string): Promise<LinodeSweepProvider> {
  const { LinodeProvider } = (await import('../../../src/lib/providers/linode.js')) as {
    LinodeProvider: new (token: string) => LinodeSweepProvider;
  };
  return new LinodeProvider(token);
}

async function defaultObjectStorage(
  key: string,
  secret: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<LinodeSweepObjectStorage> {
  const { LinodeObjectStorageProvider } = (await import(
    '../../../src/lib/providers/linode-objectstorage.js'
    // biome-ignore lint/suspicious/noExplicitAny: JS module interop
  )) as any;
  return {
    async listAllBuckets() {
      // Management-API listing (see the interface doc for why S3
      // ListBuckets cannot be used on Linode). Hostname shape:
      // `<bucket>.<cluster>.linodeobjects.com` — the cluster slug is
      // recovered by stripping the bucket's own name and the domain.
      const buckets: Array<{ name: string; cluster: string }> = [];
      let page = 1;
      for (let guard = 0; guard < 20; guard++) {
        let data: {
          data?: Array<{ label?: string; hostname?: string }>;
          page?: number;
          pages?: number;
        };
        try {
          const res = await fetchImpl(
            `https://api.linode.com/v4/object-storage/buckets?page_size=100&page=${page}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!res.ok) return null;
          data = (await res.json()) as typeof data;
        } catch {
          return null;
        }
        for (const b of data.data ?? []) {
          if (!b.label || !b.hostname) continue;
          const cluster = b.hostname.replace(`${b.label}.`, '').replace('.linodeobjects.com', '');
          buckets.push({ name: b.label, cluster });
        }
        if (!data.pages || page >= data.pages) break;
        page++;
      }
      return buckets;
    },
    async emptyAndDeleteBucket(cluster: string, name: string) {
      const provider = new LinodeObjectStorageProvider(key, secret, cluster);
      return provider.emptyAndDeleteBucket(name);
    },
  };
}

export async function sweepOrphanedLinodeResources(
  tag: string,
  projectName: string,
  deps: LinodeSweepDeps,
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  if (!projectName || projectName.length < 4) {
    throw new Error(
      `[sweep] refusing to sweep Linode with project name ${JSON.stringify(projectName)}`,
    );
  }
  console.log(`${tag} Sweeping orphaned Linode resources for ${projectName}...`);

  const counts: SweepBreakdown = {
    servers: 0,
    volumes: 0,
    placementGroups: 0, // Linode placement groups are never provisioned by our paths
    firewalls: 0,
    floatingIps: 0,
    networks: 0, // VPCs
    s3Buckets: 0,
    sshKeys: 0,
    loadBalancers: 0, // NodeBalancers
  };
  let enumFailed = false;
  const markIncomplete = (what: string) => {
    enumFailed = true;
    console.warn(
      `${tag} [sweep] ${what} enumeration incomplete — residue past the last readable page cannot be ruled out`,
    );
  };

  const token = deps.token ?? process.env.LINODE_API_TOKEN;
  let provider = deps.provider;
  if (!provider) {
    if (!token) {
      markIncomplete('Linode (no API token)');
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
  // sweeps below never race Linode's async teardown.
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

  // 2. Volumes. Project-labeled volumes delete on prefix; pvc-* CSI volumes
  // delete ONLY with a matching project tag (see header — cross-run safety).
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

  // 3. Firewalls / profile SSH keys. The provider exposes only exact-label
  // lookups for these, so enumeration walks the API directly (the
  // `{data, page, pages}` idiom); deletion routes through the provider's
  // label-based methods.
  const walkPages = async <T>(path: string): Promise<{ items: T[]; complete: boolean }> => {
    const items: T[] = [];
    let page = 1;
    for (let guard = 0; guard < 20; guard++) {
      let data: { data?: T[]; page?: number; pages?: number };
      try {
        const res = await fetchImpl(`${API_BASE}${path}?page_size=100&page=${page}`);
        if (!res.ok) return { items, complete: false };
        data = (await res.json()) as { data?: T[]; page?: number; pages?: number };
      } catch {
        return { items, complete: false };
      }
      if (Array.isArray(data.data)) items.push(...data.data);
      if (!data.pages || page >= data.pages) {
        return { items, complete: true };
      }
      page++;
    }
    return { items, complete: true };
  };

  try {
    const { items, complete } = await walkPages<{ id: number; label: string; tags?: string[] }>(
      '/networking/firewalls',
    );
    if (!complete) markIncomplete('firewall list');
    const { decodeLabels } = (await import('../../../src/lib/providers/linode.js')) as {
      decodeLabels: (tags?: string[] | null) => Record<string, string>;
    };
    for (const fw of items) {
      // Firewall labels can be SQUEEZED into Linode's 32-char cap (see
      // squeezeLinodeLabel), so a long project name is no longer a label
      // prefix — ownership falls back to the `project:` tag the compose
      // program stamps on every firewall it creates.
      const ownedByLabel = fw.label.startsWith(projectName);
      const ownedByTag = decodeLabels(fw.tags).project === projectName;
      if (!ownedByLabel && !ownedByTag) continue;
      console.log(`${tag} [sweep] Deleting orphaned firewall ${fw.label}`);
      const { deleted } = await provider.deleteFirewallByName(fw.label);
      if (deleted) counts.firewalls++;
      else {
        enumFailed = true;
        console.warn(`${tag} [sweep] Firewall ${fw.label} delete failed`);
      }
    }
  } catch (e) {
    markIncomplete('firewall list');
    console.warn(`${tag} [sweep] Firewall cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  try {
    const { items, complete } = await walkPages<{ id: number; label: string }>('/profile/sshkeys');
    if (!complete) markIncomplete('ssh-key list');
    for (const sshKey of items) {
      if (!sshKey.label.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned ssh key ${sshKey.label}`);
      if (await provider.deleteSSHKeyByName(sshKey.label)) counts.sshKeys++;
      else {
        enumFailed = true;
        console.warn(`${tag} [sweep] SSH key ${sshKey.label} delete failed`);
      }
    }
  } catch (e) {
    markIncomplete('ssh-key list');
    console.warn(`${tag} [sweep] SSH-key cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // Reserved IPs. linode-k8s.js mints one via `linode.NetworkingIp`
  // (reserved: true) and its own header carries the warning: reserved IPs
  // BILL WHILE UNASSIGNED. Deleting the instance does not release it, so a
  // failed destroy strands a billing IP.
  //
  // This counter used to be a hardcoded `floatingIps: 0` with the comment
  // a claim that this tier mints none. True of the
  // compose tier; false the moment the k8s tier landed. The ledger then read
  // zero meaning "never looked", not "found none".
  //
  // We do NOT auto-delete. Linode reserved IPs carry no label or tag (unlike
  // Vultr's, which the program names), so an UNASSIGNED one cannot be
  // attributed to this namespace from the API alone, and deleting an
  // unattributable address could destroy someone's production IP. Report it
  // and mark the sweep INCOMPLETE so the CI step fails and a human decides —
  // an unverifiable sweep must not pose as a clean one.
  try {
    // Paginated walk, not a single fat page: a truncated listing reads as
    // "nothing found", which is precisely the false-clean this pass exists to
    // remove (see list-endpoint-pagination-sweep.test.ts).
    const ips: Array<{ address?: string; reserved?: boolean; linode_id?: number | null }> = [];
    let pageOk = true;
    for (let page = 1; page <= 20; page++) {
      const res = await fetchImpl(`${API_BASE}/networking/ips?page=${page}&page_size=100`);
      if (!res.ok) {
        pageOk = false;
        break;
      }
      const body = (await res.json()) as {
        data?: Array<{ address?: string; reserved?: boolean; linode_id?: number | null }>;
        pages?: number;
      };
      ips.push(...(body.data ?? []));
      if (!body.pages || page >= body.pages) break;
    }
    if (!pageOk) {
      markIncomplete('reserved-ip list');
    } else {
      const stranded = ips.filter((i) => i.reserved && !i.linode_id);
      for (const i of stranded) {
        console.warn(
          `${tag} [sweep] UNASSIGNED reserved IP ${i.address} is billing and cannot be ` +
            'attributed from the API (Linode reserved IPs carry no label/tag). Not deleted — ' +
            'check it belongs to this e2e account and release it manually.',
        );
      }
      if (stranded.length > 0) markIncomplete('unassigned reserved IPs present');
    }
  } catch (e) {
    markIncomplete('reserved-ip list');
    console.warn(`${tag} [sweep] Reserved IP check failed: ${e instanceof Error ? e.message : e}`);
  }

  // 4. NodeBalancers + VPCs — never provisioned by the compose tier, but
  // enumerated so a future tier's leak can't hide behind a stub (same
  // reasoning as the provider's listNetworks doc).
  try {
    const lbs = await provider.listLoadBalancers();
    for (const lb of lbs) {
      if (!lb.label.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned NodeBalancer ${lb.id} (${lb.label})`);
      try {
        await provider.deleteLoadBalancer(lb.id);
        counts.loadBalancers = (counts.loadBalancers ?? 0) + 1;
      } catch (err) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] NodeBalancer ${lb.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    console.warn(
      `${tag} [sweep] NodeBalancer cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  try {
    const vpcs = await provider.listNetworks();
    for (const vpc of vpcs) {
      if (!vpc.label.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned VPC ${vpc.id} (${vpc.label})`);
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

  // 5. Object Storage buckets — enumerated account-wide via the Linode
  // management API (each row carries its assigned cluster), emptied and
  // deleted via bucket-level S3 ops against that cluster.
  let objectStorage = deps.objectStorage;
  if (!objectStorage) {
    const key = deps.storageKey ?? process.env.LINODE_ACCESS_KEY;
    const secret = deps.storageSecret ?? process.env.LINODE_SECRET_KEY;
    if (!key || !secret || !token) {
      markIncomplete('Object Storage (no credentials)');
      objectStorage = undefined;
    } else {
      objectStorage = await defaultObjectStorage(key, secret, token, fetchImpl);
    }
  }
  if (objectStorage) {
    let buckets: Array<{ name: string; cluster: string }> | null;
    try {
      buckets = await objectStorage.listAllBuckets();
    } catch {
      buckets = null;
    }
    if (buckets === null) {
      markIncomplete('Object Storage bucket list');
    } else {
      for (const { name, cluster } of buckets) {
        if (PROTECTED_OBJECT_STORAGE_BUCKETS.has(name)) continue;
        if (!name.startsWith(projectName)) continue;
        console.log(`${tag} [sweep] Deleting Object Storage bucket ${name} (${cluster})`);
        try {
          const { objectsRemoved } = await objectStorage.emptyAndDeleteBucket(cluster, name);
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
      `nodebalancers=${counts.loadBalancers ?? 0}`,
      `vpcs=${counts.networks}`,
      `buckets=${counts.s3Buckets}`,
      `ssh-keys=${counts.sshKeys}`,
    ].join(', ');
    console.warn(
      `${tag} [sweep] REGRESSION: destroy left ${totalOrphans} Linode orphan resource(s) (${breakdown}). vibecarbon destroy did not free these — fix the corresponding destroy code path.`,
    );
  } else if (enumFailed) {
    console.warn(
      `${tag} [sweep] REGRESSION: could not enumerate one or more Linode resource types — orphan check is incomplete, treat as a destroy regression.`,
    );
  } else {
    console.log(`${tag} [sweep] No Linode orphans found — destroy worked cleanly.`);
  }

  return { counts, enumFailed };
}
