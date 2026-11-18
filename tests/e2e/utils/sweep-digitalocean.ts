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
import { createSweep, reportSweep, sweepBuckets } from './sweep-core.js';
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
  const { counts, markIncomplete } = sweep;

  const token = deps.token ?? process.env.DIGITALOCEAN_API_TOKEN;
  let provider = deps.provider;
  if (!provider) {
    if (!token) {
      markIncomplete('DigitalOcean (no API token)');
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
        sweep.fail();
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

  // 3. Firewalls / SSH keys / VPCs. The provider exposes only exact-name
  // lookups for these, so enumeration walks the API directly (preflight's
  // links.pages.next idiom); deletion still routes through the provider's
  // name-based methods where they exist.
  const walkPages = <T>(path: string, key: string) =>
    walkProviderPages<T>('digitalocean', `${API_BASE}${path}`, { key, perPage: 50, fetchImpl });

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
        sweep.fail();
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
      const outcome = await provider.deleteSSHKeyById(sshKey.id);
      if (outcome === 'deleted') counts.sshKeys++;
      else if (outcome === 'absent') {
        // DigitalOcean lists a deleted key for up to 22 s: destroy's delete
        // landed and this list was stale, so nothing was left behind.
        console.log(`${tag} [sweep] ssh key ${sshKey.name} was already gone (stale list)`);
      } else {
        sweep.fail();
        console.warn(`${tag} [sweep] SSH key ${sshKey.name} delete failed`);
      }
    }
  } catch (e) {
    markIncomplete('ssh-key list');
    console.warn(`${tag} [sweep] SSH-key cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // Listed by this sweep's own walk, not provider.listLoadBalancers(): that
  // method answers [] when the API call fails (its contract for destroy), so
  // an unreadable listing read as "no load balancers" and the class went
  // unchecked under a clean banner.
  try {
    const { items: lbs, complete } = await walkPages<{ id: string; name: string }>(
      '/load_balancers',
      'load_balancers',
    );
    if (!complete) markIncomplete('load-balancer list');
    for (const lb of lbs) {
      if (!lb.name.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned load balancer ${lb.id} (${lb.name})`);
      try {
        // deleteLoadBalancer answers true for a 2xx or a 404; false is a refusal.
        if ((await provider.deleteLoadBalancer(lb.id)) === false) {
          throw new Error('the API refused the delete');
        }
        counts.loadBalancers = (counts.loadBalancers ?? 0) + 1;
      } catch (err) {
        sweep.fail();
        console.warn(
          `${tag} [sweep] Load balancer ${lb.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('load-balancer list');
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
    const labelPrefix = appKeyLabel(projectName, 63);
    const { items, complete } = await walkPages<{ access_key: string; name: string }>(
      '/spaces/keys',
      'keys',
    );
    if (!complete) markIncomplete('app storage key list');
    for (const key of items) {
      if (!String(key.name ?? '').startsWith(labelPrefix)) continue;
      console.log(`${tag} [sweep] Revoking orphaned app storage key (${key.name})`);
      try {
        const res = await fetchImpl(
          `${API_BASE}/spaces/keys/${encodeURIComponent(key.access_key)}`,
          { method: 'DELETE' },
        );
        if (res.ok || res.status === 404) counts.storageKeys = (counts.storageKeys ?? 0) + 1;
        else {
          sweep.fail();
          console.warn(`${tag} [sweep] app storage key ${key.name} revoke returned ${res.status}`);
        }
      } catch (err) {
        sweep.fail();
        console.warn(
          `${tag} [sweep] app storage key ${key.name} revoke failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('app storage key list');
    console.warn(
      `${tag} [sweep] App storage key cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

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
