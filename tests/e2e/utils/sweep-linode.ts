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
import { walkProviderPages } from './provider-pages.js';
import { createSweep, reportSweep, sweepBuckets } from './sweep-core.js';
import { runTagOwner, sweepRunTags } from './sweep-run-tags.js';

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
  /** The decoded value a raw name is stored as: squeezed past 50 characters. */
  labelValue(key: string, value: string): string;
  deleteVolume(id: number | string): Promise<unknown>;
  deleteFirewallByName(name: string): Promise<{ deleted: boolean }>;
  deleteSSHKeyByName(name: string): Promise<boolean>;
  deleteLoadBalancer(id: number | string): Promise<unknown>;
}

interface LinodeSweepObjectStorage {
  /**
   * Every bucket on the account with its assigned cluster slug; null =
   * unreadable. Backed by the Linode MANAGEMENT API (GET
   * /object-storage/buckets), NOT S3 ListBuckets: only the management
   * listing reports each bucket's cluster, which per-cluster S3 listings
   * can't give in one call.
   */
  listAllBuckets(): Promise<Array<{ name: string; cluster: string }> | null>;
  emptyAndDeleteBucket(cluster: string, name: string): Promise<{ objectsRemoved: number }>;
  /**
   * The region holding the bucket (a HeadBucket in every region the keys
   * reach), or null when none does; throws when a region cannot tell.
   */
  locateBucket(cluster: string, name: string): Promise<string | null>;
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
      // Management-API listing (see the interface doc for why not S3
      // ListBuckets). Hostname shape:
      // `<bucket>.<cluster>.linodeobjects.com` — the cluster slug is
      // recovered by stripping the bucket's own name and the domain.
      const walk = await walkProviderPages<{ label?: string; hostname?: string }>(
        'linode',
        'https://api.linode.com/v4/object-storage/buckets',
        { perPage: 100, fetchImpl, headers: { Authorization: `Bearer ${token}` } },
      );
      // A failed page, a throw or 20 pages with more pending: unreadable.
      if (!walk.complete) return null;
      const buckets: Array<{ name: string; cluster: string }> = [];
      for (const b of walk.items) {
        if (!b.label || !b.hostname) continue;
        const cluster = b.hostname.replace(`${b.label}.`, '').replace('.linodeobjects.com', '');
        buckets.push({ name: b.label, cluster });
      }
      return buckets;
    },
    async emptyAndDeleteBucket(cluster: string, name: string) {
      const provider = new LinodeObjectStorageProvider(key, secret, cluster);
      return provider.emptyAndDeleteBucket(name);
    },
    async locateBucket(cluster: string, name: string) {
      // Linode keys work on their own cluster only (keyRegions 'own').
      return new LinodeObjectStorageProvider(key, secret, cluster).locateBucket(name);
    },
  };
}

export async function sweepOrphanedLinodeResources(
  tag: string,
  projectName: string,
  deps: LinodeSweepDeps,
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  // The guard, the opening line, the counts and the incomplete flag
  // (sweep-core.ts). Linode placement groups are never provisioned by our paths; `networks` counts VPCs and `loadBalancers` NodeBalancers.
  const sweep = createSweep(tag, 'Linode', projectName, { loadBalancers: 0, storageKeys: 0 });
  const { counts, markIncomplete } = sweep;

  const token = deps.token ?? process.env.LINODE_API_TOKEN;
  let provider = deps.provider;
  if (!provider) {
    if (!token) {
      markIncomplete('Linode (no API token)');
      return sweep.result();
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
        sweep.fail();
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
  // Linode squeezes a tag past 50 characters, so the decoded tag is compared
  // to labelValue, not the raw project name.
  const ownProject = provider.labelValue('project', projectName);
  try {
    const { items, complete } = await provider.listVolumesDetailed();
    if (!complete) markIncomplete('volume list');
    for (const volume of items) {
      if (provider.volumeAttachedServerIds(volume).length > 0) continue;
      const ownedByName = volume.label.startsWith(projectName);
      const isPvc = volume.label.startsWith('pvc');
      const ownedByTag = isPvc && provider.volumeLabels(volume).project === ownProject;
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
        sweep.fail();
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
  const walkPages = <T>(path: string) =>
    walkProviderPages<T>('linode', `${API_BASE}${path}`, { perPage: 100, fetchImpl });

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
      const ownedByTag = decodeLabels(fw.tags).project === ownProject;
      if (!ownedByLabel && !ownedByTag) continue;
      console.log(`${tag} [sweep] Deleting orphaned firewall ${fw.label}`);
      const { deleted } = await provider.deleteFirewallByName(fw.label);
      if (deleted) counts.firewalls++;
      else {
        sweep.fail();
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
        sweep.fail();
        console.warn(`${tag} [sweep] SSH key ${sshKey.label} delete failed`);
      }
    }
  } catch (e) {
    markIncomplete('ssh-key list');
    console.warn(`${tag} [sweep] SSH-key cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // Reserved IPs. linode-k8s.js mints one per cluster via `linode.ReservedIp`.
  // Linode bills a reserved IP by the hour whether it is assigned or not
  // (Linode API changelog, 1 July 2026), and deleting the instance does not
  // release it, so a failed destroy strands a billing IP.
  //
  // This counter used to be a hardcoded `floatingIps: 0` with the comment
  // a claim that this tier mints none. True of the
  // compose tier; false the moment the k8s tier landed. The ledger then read
  // zero meaning "never looked", not "found none".
  //
  // We do NOT auto-delete. The k8s program tags its reserved IP
  // (linode-k8s.js `tags: encodeLabels(labels)`), but this sweep does not
  // read those tags yet, and the compose tier mints none, so an UNASSIGNED
  // one is not attributed to this namespace here, and deleting an
  // unattributed address could destroy someone's production IP. Report it
  // and mark the sweep INCOMPLETE so the CI step fails and a human decides —
  // an unverifiable sweep must not pose as a clean one.
  try {
    // Paginated walk, not a single fat page: a truncated listing reads as
    // "nothing found", which is precisely the false-clean this pass exists to
    // remove (see list-endpoint-pagination-sweep.test.ts).
    type Ip = { address?: string; reserved?: boolean; linode_id?: number | null };
    const { items: ips, complete } = await walkProviderPages<Ip>(
      'linode',
      `${API_BASE}/networking/ips`,
      // A fetch error goes to the catch below, which names it.
      { perPage: 100, fetchImpl, onThrow: 'throw' },
    );
    if (!complete) {
      markIncomplete('reserved-ip list');
    } else {
      const stranded = ips.filter((i) => i.reserved && !i.linode_id);
      for (const i of stranded) {
        console.warn(
          `${tag} [sweep] UNASSIGNED reserved IP ${i.address} is billing and cannot be ` +
            'attributed from the API (this sweep does not read the k8s tags). Not deleted: ' +
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
  //
  // Listed by this sweep's own walk, not provider.listLoadBalancers(): that
  // method answers [] when the API call fails (its contract for destroy), so
  // an unreadable listing read as "no load balancers" and the class went
  // unchecked under a clean banner.
  try {
    const { items: lbs, complete } = await walkPages<{ id: number | string; label: string }>(
      '/nodebalancers',
    );
    if (!complete) markIncomplete('NodeBalancer list');
    for (const lb of lbs) {
      if (!lb.label.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned NodeBalancer ${lb.id} (${lb.label})`);
      try {
        // deleteLoadBalancer answers true for a 2xx or a 404; false is a refusal.
        if ((await provider.deleteLoadBalancer(lb.id)) === false) {
          throw new Error('the API refused the delete');
        }
        counts.loadBalancers = (counts.loadBalancers ?? 0) + 1;
      } catch (err) {
        sweep.fail();
        console.warn(
          `${tag} [sweep] NodeBalancer ${lb.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('NodeBalancer list');
    console.warn(
      `${tag} [sweep] NodeBalancer cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  // Listed by this sweep's own walk, not provider.listNetworks(), for the
  // same reason as the load balancers above: that method answers [] (or a
  // partial list) when the API call fails.
  try {
    const { items: vpcs, complete } = await walkPages<{ id: number | string; label: string }>(
      '/vpcs',
    );
    if (!complete) markIncomplete('vpc list');
    for (const vpc of vpcs) {
      if (!vpc.label.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned VPC ${vpc.id} (${vpc.label})`);
      try {
        const res = await fetchImpl(`${API_BASE}/vpcs/${vpc.id}`, { method: 'DELETE' });
        if (res.ok || res.status === 404) counts.networks++;
        else {
          sweep.fail();
          console.warn(`${tag} [sweep] VPC ${vpc.id} delete returned ${res.status}`);
        }
      } catch (err) {
        sweep.fail();
        console.warn(
          `${tag} [sweep] VPC ${vpc.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('vpc list');
    console.warn(`${tag} [sweep] VPC cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 3c. App storage keys (security plan R9). Every deploy mints the env app a
  // key labelled `vc-app-<env bucket>`, and env buckets start with the project
  // name, so a key whose label starts with `vc-app-<project>` is this run's.
  // Destroy revokes them; one left here is a destroy leak, or a deploy that
  // crashed between the mint and the record (no destroy can see that one).
  try {
    const { appKeyLabel } = (await import('../../../src/lib/providers/app-key-api.js')) as {
      appKeyLabel: (bucket: string, max: number) => string;
    };
    const labelPrefix = appKeyLabel(projectName, 50);
    const { items, complete } = await walkPages<{ id: number; label: string }>(
      '/object-storage/keys',
    );
    if (!complete) markIncomplete('app storage key list');
    for (const key of items) {
      if (!String(key.label ?? '').startsWith(labelPrefix)) continue;
      console.log(`${tag} [sweep] Revoking orphaned app storage key (${key.label})`);
      try {
        const res = await fetchImpl(`${API_BASE}/object-storage/keys/${key.id}`, {
          method: 'DELETE',
        });
        if (res.ok || res.status === 404) counts.storageKeys = (counts.storageKeys ?? 0) + 1;
        else {
          sweep.fail();
          console.warn(`${tag} [sweep] app storage key ${key.label} revoke returned ${res.status}`);
        }
      } catch (err) {
        sweep.fail();
        console.warn(
          `${tag} [sweep] app storage key ${key.label} revoke failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('app storage key list');
    console.warn(
      `${tag} [sweep] App storage key cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
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
      // Inside a try, like the Vultr and Scaleway sweeps: this function
      // promises never to throw, and a store that cannot be built (a module
      // that fails to load) leaves the buckets unchecked.
      try {
        objectStorage = await defaultObjectStorage(key, secret, token, fetchImpl);
      } catch (err) {
        markIncomplete(
          `Object Storage (store unusable: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }
  if (objectStorage) {
    const store = objectStorage;
    await sweepBuckets(
      sweep,
      'Object Storage bucket',
      [
        {
          // One account-wide listing; each row carries the cluster the
          // bucket is emptied, deleted and located through.
          async listBuckets() {
            const buckets = await store.listAllBuckets();
            return buckets === null
              ? null
              : buckets.map(({ name, cluster }) => ({ name, where: cluster }));
          },
          async emptyAndDeleteBucket(bucket) {
            return store.emptyAndDeleteBucket(bucket.where, bucket.name);
          },
          async locateBucket(bucket) {
            return store.locateBucket(bucket.where, bucket.name);
          },
          unreadable: () => markIncomplete('Object Storage bucket list'),
        },
      ],
      { protectedNames: PROTECTED_OBJECT_STORAGE_BUCKETS },
    );
  }

  // 6. Empty run tags (sweep-run-tags.ts), last, so the instances and volumes
  // that carried them are gone. Linode tags are made only by tagging a
  // resource, so `cluster:<run>-<env>` is the run's too. Linode squeezes a tag
  // over 50 characters (linode.js TAG_MAX), which k8s-ha's cluster tags are.
  const { encodeLabel } = (await import('../../../src/lib/providers/linode.js')) as {
    encodeLabel: (key: string, value: string) => string;
  };
  await sweepRunTags(
    tag,
    runTagOwner(projectName, ['project', 'cluster'], encodeLabel, { squeezeMax: 50 }),
    {
      async list() {
        const { items, complete } = await walkPages<{ label: string }>('/tags');
        return { names: items.map((t) => t.label), complete };
      },
      async resourceCount(name) {
        // GET /tags/{label} lists the tagged objects; `results` is their count.
        const res = await fetchImpl(`${API_BASE}/tags/${encodeURIComponent(name)}?page_size=25`);
        if (res.status === 404) return 0;
        if (!res.ok) return null;
        const body = (await res.json()) as { results?: unknown };
        return typeof body.results === 'number' ? body.results : null;
      },
      async remove(name) {
        const res = await fetchImpl(`${API_BASE}/tags/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        });
        return res.ok || res.status === 404;
      },
    },
  );

  // The closing banner (sweep-core.ts). The rows are this cloud's classes
  // in breakdown order; a class left out here is left out of the total.
  reportSweep(sweep, [
    ['instances', 'servers'],
    ['volumes', 'volumes'],
    ['firewalls', 'firewalls'],
    ['nodebalancers', 'loadBalancers'],
    ['vpcs', 'networks'],
    ['buckets', 's3Buckets'],
    ['ssh-keys', 'sshKeys'],
    ['app-storage-keys', 'storageKeys'],
  ]);

  return sweep.result();
}
