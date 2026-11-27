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
 * deleteVolume / deleteFirewallByName / deleteSSHKeyById /
 * deleteLoadBalancer); enumeration of firewalls, ssh keys, load balancers
 * and VPCs — which the provider exposes as exact-name lookups or as
 * listings that answer [] on a failed call —
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
import { walkProviderPages } from './provider-pages.js';
import {
  createSweep,
  reportSweep,
  sweepBuckets,
  sweepClass,
  sweepOwnsServer,
  sweepOwnsVolume,
} from './sweep-core.js';
import { runTagOwner, sweepRunTags } from './sweep-run-tags.js';

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
  deleteSSHKeyById(id: number): Promise<'deleted' | 'absent' | 'stuck'>;
  deleteLoadBalancer(id: string): Promise<unknown>;
}

interface DoSweepSpaces {
  regions(): string[];
  /** Bucket names visible from this region's endpoint; null = unreadable. */
  listBuckets(region: string): Promise<string[] | null>;
  emptyAndDeleteBucket(region: string, name: string): Promise<{ objectsRemoved: number }>;
  /**
   * The region holding the bucket (a HeadBucket in every region the keys
   * reach), or null when none does; throws when a region cannot tell.
   */
  locateBucket(region: string, name: string): Promise<string | null>;
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
    async locateBucket(region: string, name: string) {
      return new DigitalOceanSpacesProvider(key, secret, region).locateBucket(name);
    },
  };
}

export async function sweepOrphanedDigitalOceanResources(
  tag: string,
  projectName: string,
  deps: DoSweepDeps,
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  // The guard, the opening line, the counts and the incomplete flag
  // (sweep-core.ts). DigitalOcean has no placement groups; `networks` counts VPCs.
  const sweep = createSweep(tag, 'DigitalOcean', projectName, { loadBalancers: 0, storageKeys: 0 });
  const { markIncomplete } = sweep;

  const token = deps.token ?? process.env.DIGITALOCEAN_API_TOKEN;
  const provider = deps.provider ?? (token ? await defaultProvider(token) : null);
  if (!provider) {
    markIncomplete('DigitalOcean (no API token)');
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

  // 1. Droplets. deleteServer(waitUntilGone) polls until 404 so the
  // dependent sweeps below never race DO's async teardown (the DO analogue
  // of the Hetzner sweep's 1b settle-wait).
  await sweepClass(sweep, {
    listing: 'droplet list',
    cleanupFailed: 'Droplet cleanup failed',
    count: 'servers',
    list: () => provider.listServersDetailed(),
    owned: (droplet) => sweepOwnsServer(droplet, projectName),
    announce: (droplet) => `Deleting orphaned droplet ${droplet.id} (${droplet.name})`,
    remove: async (droplet) => {
      await provider.deleteServer(droplet.id, { waitUntilGone: true });
      return true;
    },
    thrown: (droplet) => `Droplet ${droplet.id} delete failed`,
  });

  // 2. Volumes. Project-named volumes delete on prefix; pvc-* CSI volumes
  // delete ONLY with a matching project tag (see header — cross-run safety).
  await sweepClass(sweep, {
    listing: 'volume list',
    cleanupFailed: 'Volume cleanup failed',
    count: 'volumes',
    list: () => provider.listVolumesDetailed(),
    owned: (volume) =>
      sweepOwnsVolume(
        sweep,
        {
          name: volume.name,
          attached: provider.volumeAttachedServerIds(volume).length > 0,
          projectTag: () => provider.volumeLabels(volume).project,
        },
        { pvcPrefix: 'pvc-' },
      ),
    announce: (volume) => `Deleting orphaned volume ${volume.id} (${volume.name})`,
    remove: async (volume) => {
      await provider.deleteVolume(volume.id);
      return true;
    },
    thrown: (volume) => `Volume ${volume.id} delete failed`,
  });

  // 3. Firewalls / SSH keys / VPCs. The provider exposes only exact-name
  // lookups for these, so enumeration walks the API directly (preflight's
  // links.pages.next idiom); deletion still routes through the provider's
  // name-based methods where they exist.
  const walkPages = <T>(path: string, key: string) =>
    walkProviderPages<T>('digitalocean', `${API_BASE}${path}`, { key, perPage: 50, fetchImpl });

  await sweepClass(sweep, {
    listing: 'firewall list',
    cleanupFailed: 'Firewall cleanup failed',
    count: 'firewalls',
    list: () => walkPages<{ id: string; name: string }>('/firewalls', 'firewalls'),
    owned: (fw) => fw.name.startsWith(projectName),
    announce: (fw) => `Deleting orphaned firewall ${fw.name}`,
    remove: async (fw) =>
      (await provider.deleteFirewallByName(fw.name)).deleted || `Firewall ${fw.name} delete failed`,
  });

  await sweepClass(sweep, {
    listing: 'ssh-key list',
    cleanupFailed: 'SSH-key cleanup failed',
    count: 'sshKeys',
    list: () => walkPages<{ id: number; name: string }>('/account/keys', 'ssh_keys'),
    owned: (sshKey) => sshKey.name.startsWith(projectName),
    announce: (sshKey) => `Deleting orphaned ssh key ${sshKey.name}`,
    remove: async (sshKey) => {
      const outcome = await provider.deleteSSHKeyById(sshKey.id);
      if (outcome === 'deleted') return true;
      if (outcome !== 'absent') return `SSH key ${sshKey.name} delete failed`;
      // DigitalOcean lists a deleted key for up to 22 s: destroy's delete
      // landed and this list was stale, so nothing was left behind.
      console.log(`${tag} [sweep] ssh key ${sshKey.name} was already gone (stale list)`);
      return null;
    },
  });

  // Listed by this sweep's own walk, not provider.listLoadBalancers(): that
  // method answers [] when the API call fails (its contract for destroy), so
  // an unreadable listing read as "no load balancers" and the class went
  // unchecked under a clean banner.
  await sweepClass(sweep, {
    listing: 'load-balancer list',
    cleanupFailed: 'Load-balancer cleanup failed',
    count: 'loadBalancers',
    list: () => walkPages<{ id: string; name: string }>('/load_balancers', 'load_balancers'),
    owned: (lb) => lb.name.startsWith(projectName),
    announce: (lb) => `Deleting orphaned load balancer ${lb.id} (${lb.name})`,
    remove: async (lb) => {
      // deleteLoadBalancer answers true for a 2xx or a 404; false is a refusal.
      if ((await provider.deleteLoadBalancer(lb.id)) === false) {
        throw new Error('the API refused the delete');
      }
      return true;
    },
    thrown: (lb) => `Load balancer ${lb.id} delete failed`,
  });

  await sweepClass(sweep, {
    listing: 'vpc list',
    cleanupFailed: 'VPC cleanup failed',
    count: 'networks',
    list: () => walkPages<{ id: string; name: string }>('/vpcs', 'vpcs'),
    owned: (vpc) => vpc.name.startsWith(projectName),
    announce: (vpc) => `Deleting orphaned VPC ${vpc.id} (${vpc.name})`,
    remove: async (vpc) => {
      const res = await fetchImpl(`${API_BASE}/vpcs/${vpc.id}`, { method: 'DELETE' });
      return res.ok || res.status === 404 || `VPC ${vpc.id} delete returned ${res.status}`;
    },
    thrown: (vpc) => `VPC ${vpc.id} delete failed`,
  });

  // 3c. App storage keys (security plan R9). Every deploy mints the env app a
  // key labelled `vc-app-<env bucket>`, and env buckets start with the project
  // name, so a key whose label starts with `vc-app-<project>` is this run's.
  // Destroy revokes them; one left here is a destroy leak, or a deploy that
  // crashed between the mint and the record (no destroy can see that one).
  let labelPrefix = '';
  await sweepClass(sweep, {
    listing: 'app storage key list',
    cleanupFailed: 'App storage key cleanup failed',
    count: 'storageKeys',
    list: async () => {
      const { appKeyLabel } = (await import('../../../src/lib/providers/app-key-api.js')) as {
        appKeyLabel: (bucket: string, max: number) => string;
      };
      labelPrefix = appKeyLabel(projectName, 63);
      return walkPages<{ access_key: string; name: string }>('/spaces/keys', 'keys');
    },
    owned: (key) => String(key.name ?? '').startsWith(labelPrefix),
    announce: (key) => `Revoking orphaned app storage key (${key.name})`,
    remove: async (key) => {
      const res = await fetchImpl(`${API_BASE}/spaces/keys/${encodeURIComponent(key.access_key)}`, {
        method: 'DELETE',
      });
      return (
        res.ok || res.status === 404 || `app storage key ${key.name} revoke returned ${res.status}`
      );
    },
    thrown: (key) => `app storage key ${key.name} revoke failed`,
  });

  // Reserved IPs. No vibecarbon program mints one on DigitalOcean today: k8s
  // clusters made since 2026-11 point their domain at the master's own
  // address. Clusters made before had an `ingress` ReservedIp, released by
  // their next deploy or by destroy's backstop; one whose release failed is
  // still out there. A reserved IP bills WHILE UNASSIGNED, and deleting the
  // droplet it was attached to does NOT release it, so a failed destroy or
  // release strands a billing IP. This pass is what still looks for them.
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
    type ReservedIp = { ip?: string; droplet?: unknown | null };
    const { items: reserved, complete } = await walkProviderPages<ReservedIp>(
      'digitalocean',
      `${API_BASE}/reserved_ips`,
      // A fetch error goes to the catch below, which names it.
      { key: 'reserved_ips', perPage: 200, fetchImpl, onThrow: 'throw' },
    );
    if (!complete) {
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

  // 4. Spaces buckets. Each regional endpoint lists only its own region's
  // buckets (probed 2026-11-15: nyc3 and sfo3 list disjoint sets) and
  // answers NoSuchBucket for another region's, so a bucket is deleted
  // through the region that listed it. The dedupe by name stays as a guard.
  let spaces = deps.spaces;
  if (!spaces) {
    const key = deps.spacesKey ?? process.env.DIGITALOCEAN_ACCESS_KEY;
    const secret = deps.spacesSecret ?? process.env.DIGITALOCEAN_SECRET_KEY;
    if (!key || !secret) {
      markIncomplete('Spaces (no credentials)');
      spaces = undefined;
    } else {
      // Inside a try, like the Vultr and Scaleway sweeps: this function
      // promises never to throw, and a store that cannot be built (a module
      // that fails to load) leaves the buckets unchecked.
      try {
        spaces = await defaultSpaces(key, secret);
      } catch (err) {
        markIncomplete(
          `Spaces (store unusable: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }
  if (spaces) {
    const store = spaces;
    await sweepBuckets(
      sweep,
      'Spaces bucket',
      store.regions().map((region) => ({
        async listBuckets() {
          const names = await store.listBuckets(region);
          return names === null ? null : names.map((name) => ({ name, where: region }));
        },
        async emptyAndDeleteBucket(bucket) {
          return store.emptyAndDeleteBucket(region, bucket.name);
        },
        async locateBucket(bucket) {
          return store.locateBucket(region, bucket.name);
        },
        unreadable: () => markIncomplete(`Spaces region ${region}`),
      })),
      // vc-local-e2e is the account's deliberate subscription anchor (see the
      // constant's doc): never swept, even if a project prefix ever matches it.
      { protectedNames: PROTECTED_SPACES_BUCKETS, dedupe: true },
    );
  }

  // 5. Empty run tags (sweep-run-tags.ts), last, so the droplets and volumes
  // that carried them are gone. Only `project:` is the run's here: the k8s
  // `cluster:` tag is a Pulumi resource (digitalocean.Tag) that destroy
  // removes, and a live deploy's can be empty before its droplets exist.
  const { encodeLabel } = (await import('../../../src/lib/providers/digitalocean.js')) as {
    encodeLabel: (key: string, value: string) => string;
  };
  await sweepRunTags(tag, runTagOwner(projectName, ['project'], encodeLabel), {
    async list() {
      const { items, complete } = await walkPages<{ name: string }>('/tags', 'tags');
      return { names: items.map((t) => t.name), complete };
    },
    async resourceCount(name) {
      const res = await fetchImpl(`${API_BASE}/tags/${encodeURIComponent(name)}`);
      if (res.status === 404) return 0;
      if (!res.ok) return null;
      const body = (await res.json()) as { tag?: { resources?: { count?: unknown } } };
      const count = body.tag?.resources?.count;
      return typeof count === 'number' ? count : null;
    },
    async remove(name) {
      const res = await fetchImpl(`${API_BASE}/tags/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      return res.ok || res.status === 404;
    },
  });

  // The closing banner (sweep-core.ts). The rows are this cloud's classes
  // in breakdown order; a class left out here is left out of the total.
  reportSweep(sweep, [
    ['droplets', 'servers'],
    ['volumes', 'volumes'],
    ['firewalls', 'firewalls'],
    ['load-balancers', 'loadBalancers'],
    ['vpcs', 'networks'],
    ['spaces-buckets', 's3Buckets'],
    ['ssh-keys', 'sshKeys'],
    ['app-storage-keys', 'storageKeys'],
  ]);

  return sweep.result();
}
