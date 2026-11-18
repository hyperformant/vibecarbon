/**
 * Post-destroy orphan sweep for the Scaleway scenario (s1).
 *
 * Counterpart to `sweepOrphanedVultrResources` (sweep-vultr.ts) — see that
 * module's header, and sweep-digitalocean.ts's, for the 2026-08-07
 * wrong-cloud-sweep RCA this family exists to prevent. Same structure:
 * deletion through the provider instance API wherever it exists;
 * enumeration of security groups and IAM ssh keys — which the provider
 * only exposes as exact-name lookups — walks the Scaleway API directly.
 * All operations are best-effort: failures warn and flip `enumFailed`,
 * never propagate (teardown must complete).
 *
 * What differs from the Vultr sibling:
 *
 *   1. ZONE-SCOPED API. Every Instance-API listing is per zone; the
 *      provider's *Detailed listings already merge the REGIONS zones with
 *      an all-zones completeness signal, and the direct walks here loop
 *      the same zone set. Pagination is page/per_page (a short page ends
 *      the walk) — no cursor.
 *   2. THE BILLING-LEAK CLASSES ARE STRUCTURAL, NOT HYPOTHETICAL
 *      (audit design flag 5): `terminate` only DETACHES sbs_volume — and
 *      our instance types are SBS-only — so a failed destroy strands a
 *      billed volume EVERY time; flexible IPv4s survive server deletion at
 *      €0.005/hr. Both classes get first-class arms here (volumes via the
 *      provider's merged Instance+Block listing; flexible IPs via
 *      listFlexibleIPsDetailed), each with its own completeness signal.
 *   3. BUCKET ENUMERATION spans BOTH Object Storage regions (fr-par,
 *      nl-ams — the regions backing our zones). Scaleway ListBuckets is
 *      scoped to the key's preferred Project; whether it is ALSO
 *      region-scoped is unverified (audit), so the sweep walks every
 *      region rather than assuming one listing covers all. The SAME IAM
 *      pair as compute signs S3 — no separate storage credentials.
 *   4. SSH keys are PROJECT-scoped IAM resources (global API). The walk
 *      scopes to SCALEWAY_DEFAULT_PROJECT_ID when set — under the
 *      dedicated-Project doctrine that Project's keys are exactly this
 *      deployment's namespace.
 *
 * The per-AZ auto-created default security group must NEVER be deleted:
 * ownership is prefix-on-`name`, and the default group's name is
 * Scaleway's own ("Default security group"), so it can never match — plus
 * an explicit project_default guard belt-and-braces.
 *
 * CSI-volume safety (Hetzner RCA 2026-07-18): a pvc-* volume is only
 * deleted when its decoded tags carry project=<projectName>. An untagged
 * unattached pvc-* volume is REPORTED, never deleted.
 */
import type { SweepBreakdown } from '../metrics/db.js';
import { walkProviderPages } from './provider-pages.js';
import { bucketSource, createSweep, reportSweep, sweepBuckets } from './sweep-core.js';

/**
 * Buckets that must never be swept regardless of prefix. Deliberately
 * EMPTY on Scaleway (pinned by sweep-scaleway.test.ts): like Linode/Vultr
 * — and unlike DigitalOcean's Spaces-subscription anchor — deleting the
 * last bucket cancels nothing (Scaleway Object Storage is pure usage
 * billing with no subscription). The set exists for structural parity so
 * the next provider's sweep copies the guard, not its absence.
 */
export const PROTECTED_OBJECT_STORAGE_BUCKETS: ReadonlySet<string> = new Set();

interface ScalewaySweepProvider {
  listServersDetailed(): Promise<{
    items: Array<{ id: string; name: string; zone?: string }>;
    complete: boolean;
  }>;
  deleteServer(id: string, opts: { waitUntilGone: boolean }): Promise<unknown>;
  listVolumesDetailed(): Promise<{
    items: Array<{ id: string; name: string; zone?: string }>;
    complete: boolean;
  }>;
  volumeAttachedServerIds(volume: object): Array<unknown>;
  volumeLabels(volume: object): Record<string, string>;
  deleteVolume(id: string): Promise<unknown>;
  deleteFirewallByName(name: string): Promise<{ deleted: boolean }>;
  deleteSSHKeyByName(name: string): Promise<boolean>;
  /** Flexible IPs (zone-stamped items; tags carry ownership). */
  listFlexibleIPsDetailed(): Promise<{
    items: Array<{
      id: string;
      zone?: string;
      tags?: string[];
      server?: { id: string } | null;
      address?: string;
    }>;
    complete: boolean;
  }>;
  releaseFlexibleIP(id: string, zone?: string): Promise<boolean>;
  deleteLoadBalancer(id: string): Promise<unknown>;
  serverLabels(server: object): Record<string, string>;
}

interface ScalewaySweepObjectStorage {
  /** Bucket names visible in ONE region; null = unreadable. */
  listBuckets(): Promise<string[] | null>;
  emptyAndDeleteBucket(name: string): Promise<{ objectsRemoved: number }>;
  /**
   * The region holding the bucket (a HeadBucket in every region the keys
   * reach), or null when none does; throws when a region cannot tell.
   */
  locateBucket(name: string): Promise<string | null>;
}

export interface ScalewaySweepDeps {
  provider?: ScalewaySweepProvider;
  /** One injected store per Object Storage region (tests). */
  objectStorageByRegion?: Record<string, ScalewaySweepObjectStorage>;
  fetchImpl?: typeof fetch;
  /** SCALEWAY_SECRET_KEY — required when `provider`/`fetchImpl` are not injected. */
  token?: string;
  /** SCALEWAY_ACCESS_KEY — the S3 pair's access half (same IAM key as compute). */
  storageKey?: string;
  /** Dedicated-Project id (SCALEWAY_DEFAULT_PROJECT_ID) — scopes the ssh-key walk. */
  projectId?: string;
}

const API_BASE = 'https://api.scaleway.com';
// Lockstep with ScalewayProvider.REGIONS (zones) and
// ScalewayObjectStorageProvider.REGIONS (their stripped regions) — pinned
// by sweep-scaleway.test.ts against the live classes.
export const SWEEP_ZONES = ['fr-par-1', 'fr-par-2', 'nl-ams-1', 'nl-ams-2'] as const;
export const SWEEP_S3_REGIONS = ['fr-par', 'nl-ams'] as const;

async function defaultProvider(token: string): Promise<ScalewaySweepProvider> {
  const { ScalewayProvider } = (await import('../../../src/lib/providers/scaleway.js')) as {
    ScalewayProvider: new (token: string) => ScalewaySweepProvider;
  };
  return new ScalewayProvider(token);
}

async function defaultObjectStorage(
  key: string,
  secret: string,
  region: string,
): Promise<ScalewaySweepObjectStorage> {
  const { ScalewayObjectStorageProvider } = (await import(
    '../../../src/lib/providers/scaleway-objectstorage.js'
    // biome-ignore lint/suspicious/noExplicitAny: JS module interop
  )) as any;
  // Constructing the provider pins the endpoint to ENDPOINTS[region] and
  // keeps the NATIVE signing region (no S3_SIGNING_REGION on Scaleway —
  // it is not the Ceph LocationConstraint class), plus s3-base's
  // retry/timeout envelope.
  const provider = new ScalewayObjectStorageProvider(key, secret, region);
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
      // Scaleway keys reach both regions (keyRegions 'all'): fr-par and nl-ams.
      return provider.locateBucket(name);
    },
  };
}

export async function sweepOrphanedScalewayResources(
  tag: string,
  projectName: string,
  deps: ScalewaySweepDeps,
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  // The guard, the opening line, the counts and the incomplete flag
  // (sweep-core.ts). Placement groups are never provisioned by our Scaleway paths; `firewalls` counts security groups, `floatingIps` flexible IPs (real here: €0.005/hr survivors) and `networks` Private Networks.
  const sweep = createSweep(tag, 'Scaleway', projectName, { loadBalancers: 0 });
  const { counts, markIncomplete } = sweep;

  const token = deps.token ?? process.env.SCALEWAY_SECRET_KEY;
  const projectId = deps.projectId ?? process.env.SCALEWAY_DEFAULT_PROJECT_ID;
  let provider = deps.provider;
  if (!provider) {
    if (!token) {
      markIncomplete('Scaleway (no SCALEWAY_SECRET_KEY)');
      return sweep.result();
    }
    provider = await defaultProvider(token);
  }
  const fetchImpl =
    deps.fetchImpl ??
    (((url: RequestInfo | URL, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: { 'X-Auth-Token': token ?? '', ...(init?.headers ?? {}) },
      })) as typeof fetch);

  // Zone-scoped page walk for the resource families the provider only
  // exposes as exact-name lookups (security groups) or that live outside
  // the Instance API (IAM ssh keys use their own path — see below).
  const walkZonePages = <T>(zone: string, path: string, key: string) =>
    walkProviderPages<T>('scaleway', `${API_BASE}/instance/v1/zones/${zone}${path}`, {
      key,
      perPage: 100,
      fetchImpl,
    });

  // The same walk for the APIs outside the Instance API (Load Balancer,
  // VPC), which page with `page_size` and take a full path. A short page
  // ends it; a page that fails, or 20 full pages, is an incomplete listing.
  const walkPageSize = <T>(path: string, key: string) =>
    walkProviderPages<T>('scaleway-page-size', `${API_BASE}${path}`, {
      key,
      perPage: 100,
      fetchImpl,
    });

  // 1. Instances. deleteServer is the full billing-leak-safe chain
  // (terminate → wait gone → delete detached SBS volumes → release IPs),
  // so the arms below only see what a FAILED destroy left behind.
  try {
    const { items, complete } = await provider.listServersDetailed();
    if (!complete) markIncomplete('instance list');
    for (const server of items) {
      if (!server.name.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned instance ${server.id} (${server.name})`);
      try {
        await provider.deleteServer(server.id, { waitUntilGone: true });
        counts.servers++;
      } catch (err) {
        sweep.fail();
        console.warn(
          `${tag} [sweep] Instance ${server.id} delete failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } catch (e) {
    markIncomplete('instance list');
    console.warn(`${tag} [sweep] Instance cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2. Volumes — the merged Instance+Block listing (every SBS root volume
  // lives in /block/v1; reading only the Instance API would report clean
  // over a dead-certain leak). Project-named volumes delete on prefix;
  // pvc-* CSI volumes delete ONLY with a matching project tag (header).
  try {
    const { items, complete } = await provider.listVolumesDetailed();
    if (!complete) markIncomplete('volume list');
    for (const volume of items) {
      if (provider.volumeAttachedServerIds(volume).length > 0) continue;
      const volName = volume.name ?? '';
      const ownedByName = volName.startsWith(projectName);
      const isPvc = volName.startsWith('pvc');
      const ownedByTag = isPvc && provider.volumeLabels(volume).project === projectName;
      if (!ownedByName && !ownedByTag) {
        if (isPvc) {
          console.warn(
            `${tag} [sweep] Unattached CSI volume ${volName} carries no project=${projectName} tag — ` +
              'NOT deleting (could belong to a concurrent run); review manually if it persists.',
          );
        }
        continue;
      }
      console.log(`${tag} [sweep] Deleting orphaned volume ${volume.id} (${volName})`);
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

  // 3. Security groups — per-zone enumeration (zone-scoped resources);
  // deletion routes through the provider's name-based method. The per-AZ
  // auto-created default group can never be prefix-matched (Scaleway names
  // it itself) and is explicitly guarded regardless.
  for (const zone of SWEEP_ZONES) {
    try {
      const { items, complete } = await walkZonePages<{
        id: string;
        name?: string;
        project_default?: boolean;
      }>(zone, '/security_groups', 'security_groups');
      if (!complete) markIncomplete(`security-group list (${zone})`);
      for (const sg of items) {
        if (sg.project_default) continue; // never touch the default group
        if (!sg.name?.startsWith(projectName)) continue;
        console.log(`${tag} [sweep] Deleting orphaned security group ${sg.name} (${zone})`);
        const { deleted } = await provider.deleteFirewallByName(sg.name);
        if (deleted) counts.firewalls++;
        else {
          sweep.fail();
          console.warn(`${tag} [sweep] Security group ${sg.name} delete failed`);
        }
      }
    } catch (e) {
      markIncomplete(`security-group list (${zone})`);
      console.warn(
        `${tag} [sweep] Security-group cleanup failed (${zone}): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // 4. IAM ssh keys — Project-scoped, global API (page/page_size walk).
  try {
    const { items: keys, complete } = await walkProviderPages<{ id: string; name?: string }>(
      'scaleway-page-size',
      `${API_BASE}/iam/v1alpha1/ssh-keys${projectId ? `?project_id=${projectId}` : ''}`,
      // A fetch error goes to the catch below, which names it.
      { key: 'ssh_keys', perPage: 100, fetchImpl, onThrow: 'throw' },
    );
    if (!complete) markIncomplete('ssh-key list');
    for (const sshKey of keys) {
      if (!sshKey.name?.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned ssh key ${sshKey.name}`);
      if (await provider.deleteSSHKeyByName(sshKey.name)) counts.sshKeys++;
      else {
        sweep.fail();
        console.warn(`${tag} [sweep] SSH key ${sshKey.name} delete failed`);
      }
    }
  } catch (e) {
    markIncomplete('ssh-key list');
    console.warn(`${tag} [sweep] SSH-key cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 5. Flexible IPs — the €0.005/hr survivors (audit design flag 5).
  // Ownership is by project tag (the compose program tags the Ip resource;
  // IPs have no name field). Only UNATTACHED IPs are released — an
  // attached one belongs to a server the instance arm handles.
  try {
    const { items, complete } = await provider.listFlexibleIPsDetailed();
    if (!complete) markIncomplete('flexible-IP list');
    const { decodeLabels } = (await import('../../../src/lib/providers/scaleway.js')) as {
      decodeLabels: (tags?: string[] | null) => Record<string, string>;
    };
    for (const ip of items) {
      if (ip.server?.id) continue;
      if (decodeLabels(ip.tags).project !== projectName) continue;
      console.log(
        `${tag} [sweep] Releasing orphaned flexible IP ${ip.id}${ip.address ? ` (${ip.address})` : ''}`,
      );
      if (await provider.releaseFlexibleIP(ip.id, ip.zone)) counts.floatingIps++;
      else {
        sweep.fail();
        console.warn(`${tag} [sweep] Flexible IP ${ip.id} release failed`);
      }
    }
  } catch (e) {
    markIncomplete('flexible-IP list');
    console.warn(
      `${tag} [sweep] Flexible-IP cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  // 6. Load balancers + Private Networks — never provisioned by the
  // compose tier, enumerated so a future tier's leak can't hide behind a
  // stub (same reasoning as the sibling sweeps).
  // Listed by this sweep's own walk, not provider.listLoadBalancers(): that
  // method answers [] when the API call fails (its contract for destroy), so
  // an unreadable listing read as "no load balancers" and the class went
  // unchecked under a clean banner.
  // Load balancers are zone-scoped, like the provider's own walk.
  for (const zone of SWEEP_ZONES) {
    try {
      const { items: lbs, complete } = await walkPageSize<{ id: string; name?: string }>(
        `/lb/v1/zones/${zone}/lbs`,
        'lbs',
      );
      if (!complete) markIncomplete(`load-balancer list (${zone})`);
      for (const lb of lbs) {
        if (!lb.name?.startsWith(projectName)) continue;
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
      markIncomplete(`load-balancer list (${zone})`);
      console.warn(
        `${tag} [sweep] Load-balancer cleanup failed (${zone}): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Listed by this sweep's own walk, not provider.listNetworks(), for the
  // same reason as the load balancers above: that method answers [] (or a
  // partial list) when the API call fails.
  // Private Networks are region-scoped, like the provider's own walk.
  for (const region of SWEEP_S3_REGIONS) {
    try {
      const { items: networks, complete } = await walkPageSize<{ id: string; name?: string }>(
        `/vpc/v2/regions/${region}/private-networks`,
        'private_networks',
      );
      if (!complete) markIncomplete(`private-network list (${region})`);
      for (const net of networks) {
        const netName = net.name ?? '';
        if (!netName.startsWith(projectName)) continue;
        console.log(`${tag} [sweep] Orphaned Private Network ${net.id} (${netName}) — deleting`);
        try {
          // Private Networks are region-scoped; try both regions — a 404 in
          // the wrong one is benign.
          let deleted = false;
          for (const r of SWEEP_S3_REGIONS) {
            const res = await fetchImpl(
              `${API_BASE}/vpc/v2/regions/${r}/private-networks/${net.id}`,
              {
                method: 'DELETE',
              },
            );
            if (res.ok) {
              deleted = true;
              break;
            }
          }
          if (deleted) counts.networks++;
          else {
            sweep.fail();
            console.warn(`${tag} [sweep] Private Network ${net.id} delete failed`);
          }
        } catch (err) {
          sweep.fail();
          console.warn(
            `${tag} [sweep] Private Network ${net.id} delete failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (e) {
      markIncomplete(`private-network list (${region})`);
      console.warn(
        `${tag} [sweep] Private-Network cleanup failed (${region}): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // 7. Object Storage buckets — the SAME IAM pair as compute signs S3;
  // walk BOTH regions (per-region scoping unverified — header note 3).
  const storageKey = deps.storageKey ?? process.env.SCALEWAY_ACCESS_KEY;
  const storageSecret = token; // the secret key IS the S3 secret half
  let storesByRegion = deps.objectStorageByRegion;
  if (!storesByRegion) {
    if (!storageKey || !storageSecret) {
      markIncomplete('Object Storage (no SCALEWAY_ACCESS_KEY/SCALEWAY_SECRET_KEY)');
    } else {
      storesByRegion = {};
      for (const region of SWEEP_S3_REGIONS) {
        try {
          storesByRegion[region] = await defaultObjectStorage(storageKey, storageSecret, region);
        } catch (err) {
          markIncomplete(
            `Object Storage (region '${region}' unusable: ${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
    }
  }
  await sweepBuckets(
    sweep,
    'Object Storage bucket',
    Object.entries(storesByRegion ?? {}).map(([region, store]) =>
      bucketSource(store, region, () => markIncomplete(`Object Storage bucket list (${region})`)),
    ),
    { protectedNames: PROTECTED_OBJECT_STORAGE_BUCKETS },
  );

  // The closing banner (sweep-core.ts). The rows are this cloud's classes
  // in breakdown order; a class left out here is left out of the total.
  reportSweep(sweep, [
    ['instances', 'servers'],
    ['volumes', 'volumes'],
    ['security-groups', 'firewalls'],
    ['flexible-ips', 'floatingIps'],
    ['load-balancers', 'loadBalancers'],
    ['private-networks', 'networks'],
    ['buckets', 's3Buckets'],
    ['ssh-keys', 'sshKeys'],
  ]);

  return sweep.result();
}
