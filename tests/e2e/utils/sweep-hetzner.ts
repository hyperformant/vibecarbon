/**
 * Post-destroy orphan sweep for Hetzner scenarios. Moved here from
 * tests/e2e/scenarios/_run-lifecycle.ts so the one provider dispatch
 * (./sweep-provider.ts) can reach it without loading the whole lifecycle.
 */
import type { SweepBreakdown } from '../metrics/db.js';
import { classifyBucketDeleteError } from './bucket-already-gone.js';

/** One Object Storage location's view (each endpoint lists only its own buckets). */
interface HetznerSweepObjectStorage {
  /** Bucket names this location lists; throws when the listing fails. */
  listBuckets(): Promise<string[]>;
  emptyAndDeleteBucket(name: string): Promise<{ objectsRemoved: number }>;
  /**
   * The region holding the bucket (a HeadBucket in every region the keys
   * reach), or null when none does; throws when a region cannot tell.
   */
  locateBucket(name: string): Promise<string | null>;
}

export interface HetznerSweepDeps {
  /** Cloud API fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** One injected store per Object Storage location (tests). */
  objectStorageByRegion?: Record<string, HetznerSweepObjectStorage>;
}

/** A store per location, built on the product's HetznerS3Provider. */
async function defaultObjectStorageByRegion(
  key: string,
  secret: string,
): Promise<Record<string, HetznerSweepObjectStorage>> {
  // biome-ignore lint/suspicious/noExplicitAny: JS module interop
  const { HetznerS3Provider } = (await import('../../../src/lib/providers/hetzner-s3.js')) as any;
  const stores: Record<string, HetznerSweepObjectStorage> = {};
  for (const region of Object.keys(HetznerS3Provider.ENDPOINTS)) {
    const provider = new HetznerS3Provider(key, secret, region);
    stores[region] = {
      async listBuckets() {
        const buckets = (await provider.listBuckets()) as Array<{ name?: string }>;
        return buckets.map((b) => b.name).filter((n): n is string => !!n);
      },
      async emptyAndDeleteBucket(name: string) {
        return provider.emptyAndDeleteBucket(name);
      },
      async locateBucket(name: string) {
        // Hetzner keys reach every location (keyRegions 'all'): nbg1, fsn1, hel1.
        return provider.locateBucket(name);
      },
    };
  }
  return stores;
}

/**
 * Sweep for orphaned cloud resources that `vibecarbon destroy` may have missed.
 *
 * Catches three categories of leaks:
 * 1. Scale "-new" servers: created during blue-green migration, lost if scale fails
 *    before updating the config.
 * 2. K8s PVC volumes: Hetzner CSI volumes that outlive their cluster.
 * 3. S3 buckets: destroy intentionally skips these (to protect user data), but
 *    e2e test buckets should be cleaned up. Scanned across all three
 *    Hetzner S3 regions (nbg1/fsn1/hel1) — HA scenarios put standby buckets
 *    in a different region than the primary.
 *
 * All operations are best-effort — failures are logged but never propagate.
 *
 * Returns per-category counts so the lifecycle can flag destroy regressions.
 * Sweep is the safety net; non-zero counts mean destroy didn't actually free
 * those resource types and a destroy.js code path needs fixing (e.g. PR 1BD
 * fixed firewall destroy after a sweep regression went uncounted for 5+ runs).
 */
export async function sweepOrphanedHetznerResources(
  tag: string,
  projectName: string,
  hetznerToken: string,
  deps: HetznerSweepDeps = {},
): Promise<{ counts: SweepBreakdown; enumFailed: boolean }> {
  if (!projectName || projectName.length < 4) {
    // An empty or short prefix would match resources that are not ours (the
    // placement-group, firewall, ssh-key, floating-IP, network and bucket
    // passes all match on `startsWith(projectName)`). The other four sweeps
    // have refused this since they were written; the shortest legitimate
    // e2e project name is `testapp-…` / `citest-…`.
    throw new Error(
      `[sweep] refusing to sweep Hetzner with project name ${JSON.stringify(projectName)}`,
    );
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  console.log(`${tag} Sweeping orphaned Hetzner resources for ${projectName}...`);
  const counts: SweepBreakdown = {
    servers: 0,
    volumes: 0,
    placementGroups: 0,
    firewalls: 0,
    floatingIps: 0,
    networks: 0,
    s3Buckets: 0,
    sshKeys: 0,
  };

  // Hetzner's API sporadically returns `fetch failed` under concurrent load from
  // multiple parallel scenarios; retry 3× with 3s backoff before giving up.
  // Defined up-front so the server cleanup below can use it (until 2026-04-27
  // it ran with raw fetch and silently leaked 6 servers when a single fetch
  // blipped — the matrix then hit Hetzner's project quota cap).
  const sweepFetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await fetchImpl(url, init);
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    console.warn(
      `${tag} [sweep] ${url} failed after 3 attempts: ${last instanceof Error ? last.message : last}`,
    );
    return null;
  };

  // Every listing below walks pagination via the shared walker
  // (src/lib/providers/hetzner-pagination.js — the same one the provider's
  // destroy sweeps and scripts/sweep-hetzner.js use). The old single GETs
  // asked for `per_page=100`, which exceeds the documented max of 50
  // (Hetzner Cloud OpenAPI spec, pagination: "The default value is 25, the
  // maximum value is 50 except otherwise specified") — out-of-contract, so
  // at most one bounded page was ever served — and this sweep filters
  // CLIENT-side by name prefix, so residue past the last-served page wasn't
  // "missed for now", it was unmatchable and the sweep confidently counted
  // zero (the exact truncated-listing shape that let six orphaned CSI
  // volumes survive a GREEN run's audit, 2026-07-30; SSH keys have exceeded
  // 50 on this shared account before — see the 2026-04-27 uniqueness_error
  // incident in the ssh-key block).
  // The adapter turns sweepFetch's retries-exhausted `null` into a non-ok
  // page so the walker reports `complete: false` — an unreadable listing
  // must degrade the sweep banner, never pose as a clean empty page.
  const sweepFetchImpl = (async (url: string, init?: RequestInit) =>
    (await sweepFetch(url, init)) ??
    ({ ok: false, status: 0, json: async () => ({}) } as Response)) as typeof fetch;
  const listSweepPages = async <T>(
    path: string,
    key: string,
    query = '',
  ): Promise<{ items: T[]; complete: boolean }> => {
    const { listHetznerPages } = (await import(
      '../../../src/lib/providers/hetzner-pagination.js'
    )) as unknown as {
      listHetznerPages: (args: {
        path: string;
        key: string;
        query?: string;
        token: string;
        fetchImpl?: typeof fetch;
      }) => Promise<{ items: unknown[]; complete: boolean }>;
    };
    const { items, complete } = await listHetznerPages({
      path,
      key,
      query,
      token: hetznerToken,
      fetchImpl: sweepFetchImpl,
    });
    return { items: items as T[], complete };
  };

  // Sticky flag set whenever a sweep step couldn't even enumerate the resource
  // type after retries. Without this, "fetch failed → catch → moved on" silently
  // produces a green sweep banner ("No orphans found") when in reality we just
  // couldn't check. The regression banner reads this flag and surfaces an
  // explicit "could not enumerate" line so subagents don't trust a clean sweep
  // that wasn't actually clean.
  let enumFailed = false;

  // Incomplete walks still delete what they DID enumerate, but must flip the
  // sticky enumFailed flag so the banner says "could not (fully) enumerate"
  // instead of blessing a partial listing as clean.
  const markIncomplete = (what: string) => {
    enumFailed = true;
    console.warn(
      `${tag} [sweep] ${what} enumeration incomplete — residue past the last readable page cannot be ruled out`,
    );
  };

  // DELETE one dependent resource and report what the API said. Until
  // 2026-11-17 the volume, placement-group, firewall, ssh-key, floating-IP
  // and network passes ignored the response and counted the resource as
  // swept, so a refused delete (a 409 "still in use", a 5xx, three failed
  // attempts) read as a cleaned-up orphan while the resource stayed and
  // billed. 'deleted' is the only outcome a pass may count. 'gone' is a 404:
  // destroy's own delete landed and the listing was stale, the goal state.
  // 'failed' marks the sweep incomplete and names the resource.
  const deleteResource = async (
    what: string,
    path: string,
  ): Promise<'deleted' | 'gone' | 'failed'> => {
    const resp = await sweepFetch(`https://api.hetzner.cloud/v1${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hetznerToken}` },
    });
    if (resp?.ok) return 'deleted';
    if (resp?.status === 404) {
      console.log(`${tag} [sweep] ${what} was already gone (stale list)`);
      return 'gone';
    }
    enumFailed = true;
    console.warn(
      `${tag} [sweep] ${what} delete failed: returned ${resp?.status ?? 'no response'}, so it may still exist`,
    );
    return 'failed';
  };

  // 1. Delete any servers whose name contains the project name
  // We collect the IDs we DELETE'd so we can confirm completion before
  // sweeping dependent resources. Hetzner server DELETE is async — the API
  // returns 200 immediately but the underlying action (detach FIPs, leave
  // firewalls, leave networks, leave placement groups) may take 5-30s to
  // complete. If the dependent-resource sweeps run before that completes,
  // they enumerate FIPs/firewalls/networks/PGs that are STILL ATTACHED to
  // a deleting server and skip them (`if (fip.server) continue;` etc.),
  // leaving stale residue. Today's matrix left 12 such resources that I
  // had to clean manually. Waiting for `GET /v1/servers/{id}` to return
  // 404 is the canonical "server is fully gone" signal.
  const deletedServerIds: number[] = [];
  try {
    const { items: orphanServers, complete: srvComplete } = await listSweepPages<{
      id: number;
      name: string;
    }>('/servers', 'servers', `label_selector=project%3D${encodeURIComponent(projectName)}`);
    if (!srvComplete) markIncomplete('server list');
    for (const srv of orphanServers) {
      console.log(`${tag} [sweep] Deleting orphaned server ${srv.id} (${srv.name})`);
      const delResp = await sweepFetch(`https://api.hetzner.cloud/v1/servers/${srv.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${hetznerToken}` },
      });
      // If the DELETE itself failed after retries, mark enumFailed so the
      // sweep banner surfaces the gap. Hetzner returns 200/204 on success.
      if (!delResp || (!delResp.ok && delResp.status !== 404)) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] Server ${srv.id} delete returned ${delResp?.status ?? 'no response'}`,
        );
      } else {
        counts.servers++;
        deletedServerIds.push(srv.id);
      }
    }
  } catch (e) {
    // The pass stopped part-way, so what it did not reach is unchecked.
    markIncomplete('server list');
    console.warn(`${tag} [sweep] Server cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 1b. Wait for server DELETEs to actually complete before sweeping dependents.
  // Per-server budget 90s (well above the typical 5-30s settlement); poll every
  // 3s. We poll all deleted servers in parallel — the bound is the slowest, not
  // the sum. A server still present after 90s is logged as enumFailed (so the
  // banner reflects the gap) but does not block the rest of the sweep.
  if (deletedServerIds.length > 0) {
    console.log(
      `${tag} [sweep] Waiting for ${deletedServerIds.length} server delete(s) to complete...`,
    );
    const SETTLE_BUDGET_MS = 90_000;
    const POLL_INTERVAL_MS = 3_000;
    await Promise.all(
      deletedServerIds.map(async (id) => {
        const start = Date.now();
        while (Date.now() - start < SETTLE_BUDGET_MS) {
          const r = await sweepFetch(`https://api.hetzner.cloud/v1/servers/${id}`, {
            headers: { Authorization: `Bearer ${hetznerToken}` },
          });
          // 404 = gone (the goal). Any 2xx = still present, keep polling.
          // sweepFetch returns null after 3 retries; treat as transient and
          // continue polling — the server may genuinely be mid-delete.
          if (r && r.status === 404) return;
          await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
        }
        // Server didn't disappear within budget. Surface as enumFailed so
        // the sweep banner doesn't falsely report a clean run.
        enumFailed = true;
        console.warn(
          `${tag} [sweep] Server ${id} still present after ${SETTLE_BUDGET_MS / 1000}s — dependent resources may be skipped`,
        );
      }),
    );
  }
  try {
    // Scope the listing to THIS project's volumes (the CSI controller stamps
    // `project=<name>` via HCLOUD_VOLUME_EXTRA_LABELS, set in master-init.sh).
    // pvc-* names carry no owner info, and "unattached" is NOT abandonment:
    // a pilot-light reconverge legitimately detaches the db's volumes while
    // the reseed scales it to zero — an unscoped sweep from a CONCURRENT run
    // (CI matrix vs laptop rig, 2026-07-18) deleted a live rig's data
    // volumes in exactly that window. Unlabeled volumes from pre-label
    // clusters are invisible here; the standalone scripts/sweep-hetzner.js
    // (only ever run with NOTHING live) still collects them.
    const { items: orphanVolumes, complete: volComplete } = await listSweepPages<{
      id: number;
      name: string;
      server: number | null;
    }>('/volumes', 'volumes', `label_selector=${encodeURIComponent(`project=${projectName}`)}`);
    if (!volComplete) markIncomplete('volume list');
    for (const vol of orphanVolumes) {
      // Only delete unattached PVC volumes (K8s leftovers)
      if (vol.server === null && vol.name.startsWith('pvc-')) {
        console.log(`${tag} [sweep] Deleting orphaned volume ${vol.id} (${vol.name})`);
        if (
          (await deleteResource(`Volume ${vol.id} (${vol.name})`, `/volumes/${vol.id}`)) ===
          'deleted'
        ) {
          counts.volumes++;
        }
      }
    }
  } catch (e) {
    // The pass stopped part-way, so what it did not reach is unchecked.
    markIncomplete('volume list');
    console.warn(`${tag} [sweep] Volume cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2a. Delete placement groups whose name matches this test project. Hetzner
  // caps a project at 50 placement groups — runs #1..N accumulate these fast
  // and the 51st run hits `placement_group limit exceeded` on Pulumi up,
  // destroying the VM stack before any workload can be scheduled.
  try {
    // Don't use `?name=<projectName>` — Hetzner's name filter is exact-match,
    // so it never returns the suffixed `<projectName>-<env>-<role>-pg` names
    // we actually create. List every page and prefix-match in code,
    // matching the firewall/FIP sweep pattern below.
    const { items: pgs, complete: pgComplete } = await listSweepPages<{
      id: number;
      name: string;
      servers?: number[];
    }>('/placement_groups', 'placement_groups');
    if (!pgComplete) markIncomplete('placement-group list');
    const deletedSet = new Set(deletedServerIds);
    // Treat references to servers we just DELETE'd as released — Hetzner's
    // attachment fields lag the server's 404 by a few seconds (PR 1BX waits
    // for 404, but FIP/firewall/network/PG reconciliation can take longer
    // and the sweep would otherwise skip these as "still attached" even
    // though the server is gone). Filter the servers array against deleted
    // IDs before checking length.
    const liveRefs = (servers: number[] | undefined) =>
      (servers ?? []).filter((sid) => !deletedSet.has(sid));
    // Also grab any trailing `-primary-` / `-standby-` style prefixes that
    // start with the project name — Hetzner's name filter is prefix-match.
    for (const pg of pgs) {
      if (!pg.name.startsWith(projectName)) continue;
      if (liveRefs(pg.servers).length > 0) continue; // still referenced by a live server
      console.log(`${tag} [sweep] Deleting orphaned placement-group ${pg.id} (${pg.name})`);
      if (
        (await deleteResource(
          `Placement group ${pg.id} (${pg.name})`,
          `/placement_groups/${pg.id}`,
        )) === 'deleted'
      ) {
        counts.placementGroups++;
      }
    }
  } catch (e) {
    // The pass stopped part-way, so what it did not reach is unchecked.
    markIncomplete('placement-group list');
    console.warn(
      `${tag} [sweep] Placement-group cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  // 2b. Delete firewalls whose name matches this test project. Same 50-cap
  // story as placement groups — every e2e run creates a fresh
  // `testapp-<mode>-<ts>-<id>-firewall`, and the 51st run hits
  // `firewall limit exceeded`.
  //
  // Don't use `?name=<projectName>` — Hetzner's name filter is exact-match,
  // so it never returns the suffixed `<projectName>-<env>-firewall` we want.
  // List every page and filter by `startsWith(projectName)`,
  // matching the FIP/network sweep pattern below.
  try {
    const { items: firewalls, complete: fwComplete } = await listSweepPages<{
      id: number;
      name: string;
      applied_to?: { type?: string; server?: { id?: number } }[];
    }>('/firewalls', 'firewalls');
    if (!fwComplete) markIncomplete('firewall list');
    for (const fw of firewalls) {
      if (!fw.name.startsWith(projectName)) continue;
      // Filter applied_to: a server-type entry whose server.id is in our
      // deleted set is effectively gone. Anything else (label_selector,
      // a server we did NOT delete) means the firewall is still in use.
      const liveAttachments = (fw.applied_to ?? []).filter((a) => {
        if (a.type !== 'server') return true; // label_selector etc — keep
        const sid = a.server?.id;
        return sid != null && !deletedServerIds.includes(sid);
      });
      if (liveAttachments.length > 0) continue;
      console.log(`${tag} [sweep] Deleting orphaned firewall ${fw.id} (${fw.name})`);
      if (
        (await deleteResource(`Firewall ${fw.id} (${fw.name})`, `/firewalls/${fw.id}`)) ===
        'deleted'
      ) {
        counts.firewalls++;
      }
    }
  } catch (e) {
    // The pass stopped part-way, so what it did not reach is unchecked.
    markIncomplete('firewall list');
    console.warn(`${tag} [sweep] Firewall cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2b'. Delete SSH keys whose name starts with this project name.
  // Hetzner's `?name=` filter is exact-match — Pulumi names compose keys
  // `<project>-<env>-<region>-key`, k8s-ha keys `<project>-<env>-ha-key`.
  // Listing without a filter and prefix-matching is the simplest cover;
  // Hetzner caps at 50 keys per project before the create-key API errors
  // with `uniqueness_error 409` (observed 2026-04-27 morning matrix —
  // compose's destroy hit pagination, key fell off page 1, restore re-deploy
  // hit "SSH key not unique" because the key was actually still there).
  // Fix in destroy.js (PR 1BO) addresses the destroy path; this sweep is
  // the safety net for failed destroys + cross-test residue.
  try {
    const { items: sshKeys, complete: keyComplete } = await listSweepPages<{
      id: number;
      name: string;
    }>('/ssh_keys', 'ssh_keys');
    if (!keyComplete) markIncomplete('ssh-key list');
    for (const key of sshKeys) {
      if (!key.name?.startsWith(projectName)) continue;
      console.log(`${tag} [sweep] Deleting orphaned SSH key ${key.id} (${key.name})`);
      if (
        (await deleteResource(`SSH key ${key.id} (${key.name})`, `/ssh_keys/${key.id}`)) ===
        'deleted'
      ) {
        counts.sshKeys++;
      }
    }
  } catch (e) {
    // The pass stopped part-way, so what it did not reach is unchecked.
    markIncomplete('ssh-key list');
    console.warn(`${tag} [sweep] SSH key cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 2c. Delete Floating IPs whose name matches this test project. Hetzner
  // caps a project at 10 floating IPs by default — exactly the number a
  // single matrix run consumes (1 k8s + 2 k8s-ha) over 3-4 runs. When
  // Pulumi destroy can't run (failed deploy → no env in .vibecarbon.json
  // → no s3Config in projectConfig → orphan-detection finds nothing,
  // observed 2026-04-26 matrix runs #2 + #3), the FIP outlives the
  // servers and the next deploy fails with `Floating IP limit exceeded`.
  try {
    const { items: floatingIps, complete: fipComplete } = await listSweepPages<{
      id: number;
      name: string;
      server: number | null;
    }>('/floating_ips', 'floating_ips');
    if (!fipComplete) markIncomplete('floating-IP list');
    for (const fip of floatingIps) {
      if (!fip.name?.startsWith(projectName)) continue;
      // fip.server is the attached server's id, or null. Treat references
      // to a server we just DELETE'd as released.
      if (fip.server != null && !deletedServerIds.includes(fip.server)) continue;
      console.log(`${tag} [sweep] Deleting orphaned floating IP ${fip.id} (${fip.name})`);
      if (
        (await deleteResource(`Floating IP ${fip.id} (${fip.name})`, `/floating_ips/${fip.id}`)) ===
        'deleted'
      ) {
        counts.floatingIps++;
      }
    }
  } catch (e) {
    // The pass stopped part-way, so what it did not reach is unchecked.
    markIncomplete('floating-IP list');
    console.warn(
      `${tag} [sweep] Floating IP cleanup failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  // 2d. Delete networks whose name matches this test project. Networks
  // don't have a hard quota that breaks deploys, but accumulating them
  // is messy and they hold subnet/route allocations the next deploy
  // would otherwise reuse. Delete only when no servers are attached.
  try {
    // Same exact-match-name caveat as placement groups: list unfiltered and
    // prefix-match in code so suffixed names like `<projectName>-<env>-network`
    // are actually returned.
    const { items: networks, complete: netComplete } = await listSweepPages<{
      id: number;
      name: string;
      servers?: number[];
    }>('/networks', 'networks');
    if (!netComplete) markIncomplete('network list');
    for (const net of networks) {
      if (!net.name?.startsWith(projectName)) continue;
      // Treat references to servers we just DELETE'd as released.
      const liveServers = (net.servers ?? []).filter((sid) => !deletedServerIds.includes(sid));
      if (liveServers.length > 0) continue;
      console.log(`${tag} [sweep] Deleting orphaned network ${net.id} (${net.name})`);
      if (
        (await deleteResource(`Network ${net.id} (${net.name})`, `/networks/${net.id}`)) ===
        'deleted'
      ) {
        counts.networks++;
      }
    }
  } catch (e) {
    // The pass stopped part-way, so what it did not reach is unchecked.
    markIncomplete('network list');
    console.warn(`${tag} [sweep] Network cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // 3. Delete S3 buckets created by this test project.
  // Each bucket is wrapped in its own try/catch so one failure (e.g.,
  // BucketNotEmpty from versioning or a stuck multipart upload) doesn't
  // strand buckets in the remaining regions. Emptying is delegated to
  // HetznerS3Provider.emptyAndDeleteBucket so we get version + multipart
  // handling for free instead of re-implementing it inline. A bucket it
  // cannot delete fails the sweep (enumFailed), unless the delete said "no
  // such bucket", no location holds it, and a second listing no longer shows
  // it: a stale listing, the goal state.
  // A sweep that could not look fails it too: missing storage keys, or a
  // location whose ListBuckets failed, leave its buckets unchecked.
  try {
    let storesByRegion = deps.objectStorageByRegion;
    if (!storesByRegion) {
      // Env-only (the credentials.json profiles fallback this used to have was
      // retired — A5). runner.ts's loadE2EEnvFile() pre-populates process.env
      // from tests/.env.e2e before this runs (A6).
      const accessKey = process.env.HETZNER_ACCESS_KEY;
      const secretKey = process.env.HETZNER_SECRET_KEY;
      if (accessKey && secretKey) {
        storesByRegion = await defaultObjectStorageByRegion(accessKey, secretKey);
      } else {
        // Names only, never a value.
        const missing = [
          accessKey ? '' : 'HETZNER_ACCESS_KEY',
          secretKey ? '' : 'HETZNER_SECRET_KEY',
        ].filter(Boolean);
        enumFailed = true;
        console.warn(
          `${tag} [sweep] S3 buckets not checked: ${missing.join(' and ')} not set, so leftover buckets cannot be ruled out`,
        );
      }
    }

    // Hetzner Object Storage has three regions. A deploy's buckets live in
    // the storage region resolved from its primary region (whichever EU
    // location the resolver picked); an HA standby goes wherever
    // getDefaultStandbyRegion puts it. Scan all three so no bucket is
    // stranded whichever location a scenario landed in. Each endpoint lists
    // only its own location's buckets (probed 2026-11-15), so a bucket is
    // deleted through the location that listed it.
    for (const [region, store] of Object.entries(storesByRegion ?? {})) {
      let listed: string[];
      try {
        listed = await store.listBuckets();
      } catch (listErr) {
        enumFailed = true;
        console.warn(
          `${tag} [sweep] S3 bucket list failed in ${region}: ${listErr instanceof Error ? listErr.message : String(listErr)}; its leftover buckets cannot be ruled out`,
        );
        continue;
      }
      for (const name of listed.filter((n) => n.startsWith(projectName))) {
        console.log(`${tag} [sweep] Deleting S3 bucket ${name} (${region})`);
        try {
          const { objectsRemoved } = await store.emptyAndDeleteBucket(name);
          console.log(`${tag} [sweep]   deleted ${name} (${objectsRemoved} obj)`);
          counts.s3Buckets++;
        } catch (bucketErr) {
          const verdict = await classifyBucketDeleteError(
            bucketErr,
            name,
            () => store.locateBucket(name),
            () => store.listBuckets(),
          );
          if (verdict.gone) {
            // Stale listing: destroy already removed it, and a second
            // listing no longer shows it. Goal state, not an enumeration
            // failure. See bucket-already-gone.ts. A bucket this location
            // still lists is never called gone: a new Hetzner bucket can
            // answer NoSuchBucket for up to 15 minutes (bucketQuietMs in
            // hetzner-s3.js) while it exists and bills (2026-11-16).
            console.log(`${tag} [sweep]   ${name} already gone (stale listing): ${verdict.why}`);
          } else {
            enumFailed = true;
            console.warn(`${tag} [sweep]   FAILED ${name}: ${verdict.why}`);
          }
        }
      }
    }
  } catch (e) {
    // The stores could not be built (module load), so no bucket was checked.
    enumFailed = true;
    console.warn(`${tag} [sweep] S3 cleanup failed: ${e instanceof Error ? e.message : e}`);
  }

  // Regression banner. Sweep is the safety net behind `vibecarbon destroy`;
  // every non-zero category is destroy silently no-op'ing on that resource
  // type (PR 1BD shipped after this signal stayed buried for 5+ runs).
  // Single warn-level line so subagents grepping `grep -E '\[sweep\] REGRESSION'`
  // or `WHERE orphans_swept > 0` can find the regressions deterministically.
  const totalOrphans =
    counts.servers +
    counts.volumes +
    counts.placementGroups +
    counts.firewalls +
    counts.floatingIps +
    counts.networks +
    counts.s3Buckets +
    counts.sshKeys;
  if (totalOrphans > 0) {
    const breakdown = [
      `servers=${counts.servers}`,
      `volumes=${counts.volumes}`,
      `placement-groups=${counts.placementGroups}`,
      `firewalls=${counts.firewalls}`,
      `fips=${counts.floatingIps}`,
      `networks=${counts.networks}`,
      `s3-buckets=${counts.s3Buckets}`,
      `ssh-keys=${counts.sshKeys}`,
    ].join(', ');
    console.warn(
      `${tag} [sweep] REGRESSION: destroy left ${totalOrphans} orphan resource(s) (${breakdown}). vibecarbon destroy did not free these — fix the corresponding destroy code path.`,
    );
  } else if (enumFailed) {
    // counts==0 but enumeration failed at least once — we did NOT verify.
    // Surfacing this explicitly is the difference between "destroy worked"
    // (a load-bearing claim the matrix relies on) and "we couldn't tell"
    // (the actual state when sweepFetch returns null after retries).
    console.warn(
      `${tag} [sweep] REGRESSION: could not enumerate one or more resource types after retries — orphan check is incomplete, treat as a destroy regression.`,
    );
  } else {
    // Name the cloud that was actually verified — until 2026-08-07 this line
    // printed after DO runs too, blessing a sweep of the WRONG cloud as clean.
    console.log(`${tag} [sweep] No Hetzner orphans found — destroy worked cleanly.`);
  }

  // Aligned with the DO/Linode/Vultr sweeps' return shape so the lifecycle
  // can gate the scenario verdict on sweep cleanliness (2026-08-09: round-A
  // v1 counted PASS while two leaked instances sat behind an enum-incomplete
  // banner nothing consumed).
  return { counts, enumFailed };
}
