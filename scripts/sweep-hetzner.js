#!/usr/bin/env node
/**
 * Belt-and-suspenders Hetzner resource sweep.
 *
 * Lists every server / firewall / ssh-key / network / load-balancer /
 * volume labeled `managed-by=vibecarbon` and deletes them. Also sweeps
 * orphaned Hetzner Object Storage buckets named `testapp-*` across all
 * three S3 regions (nbg1/fsn1/hel1) when HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY
 * are set — e2e runs that crash before their in-process sweep fires
 * otherwise leak buckets permanently. Set E2E_NAMESPACE=<ns> to scope
 * the sweep to <ns>test-* resources instead.
 *
 * Safe to run before, between, and after e2e scenarios. Exits 0
 * when nothing remains, 1 on failure to clean a resource.
 *
 * Usage: HETZNER_API_TOKEN=xxx node scripts/sweep-hetzner.js
 */

import { HETZNER_API_BASE, listHetznerPages } from '../src/lib/providers/hetzner-pagination.js';
import { ledgerEntriesFor, pruneVolumeLedger } from '../src/lib/volume-ledger.js';

const token = process.env.HETZNER_API_TOKEN;

const API = HETZNER_API_BASE;
const headers = { Authorization: `Bearer ${token}` };
const sel = 'managed-by=vibecarbon';

// Every listing below goes through the SHARED page-walker (the one
// HetznerProvider's destroy sweeps use). Before that, each listing was a
// single GET: the label-selector scan omitted `per_page` entirely (Cloud API
// default 25) and the name-prefix scan asked for 50 and ignored
// `meta.pagination.next_page`. Since this script filters client-side by
// scratch-name prefix, anything past the first page was not "found later" —
// it was unmatchable, and the sweep printed `recheck clean` over it. An audit
// tool that under-reports is worse than no audit tool, so an incomplete walk
// is now surfaced everywhere it can change a verdict.
async function listPages(type, key, query = '') {
  return listHetznerPages({ path: `/${type}`, key, token, query });
}

// SAFETY: this sweep only ever deletes e2e scratch resources, which are always
// named `testapp-*` (the e2e naming convention, and what preflight's clean-check
// matches). Real deployments (e.g. `vibecarbon-web-prod`) ALSO carry the
// `managed-by=vibecarbon` label, so a label-only sweep would delete a production
// server. Scope every deletion to the `testapp-` prefix so a shared label can
// never take down real infra. The S3 bucket half is already prefix-scoped.
// Namespace scoping: `E2E_NAMESPACE=ci` shifts the scratch prefix to
// `citest-` so a CI-triggered sweep can only ever delete CI-created
// resources — a concurrent laptop run's `testapp-*` rigs are invisible to
// it (and vice versa). Derivation must stay in lockstep with
// tests/e2e/utils/namespace.ts (this is a plain-node script that can't
// import TS; tests/unit/e2e/sweep-scope.test.ts pins the two together).
export function scratchPrefixFor(namespace) {
  return namespace ? `${namespace}test-` : 'testapp-';
}
export const E2E_SCRATCH_PREFIX = scratchPrefixFor((process.env.E2E_NAMESPACE || '').trim());
export function isE2eScratchResource(name, prefix = E2E_SCRATCH_PREFIX) {
  return typeof name === 'string' && name.startsWith(prefix);
}

/**
 * List one resource kind, scoped to e2e scratch names. Exported for unit tests
 * (they stub the global `fetch` the shared walker defaults to).
 *
 * @returns {Promise<{ items: object[], complete: boolean }>} `complete: false`
 *   means at least one of the two scans stopped early, so an empty result
 *   proves nothing.
 */
export async function listScopedResources(type, key) {
  // Primary: label-selector scan. Fast — Hetzner filters server-side. Still
  // name-scoped below so a labeled-but-real deployment is never swept.
  const labeled = await listPages(type, key, `label_selector=${sel}`);
  if (!labeled.complete) {
    console.warn(
      `[sweep] list ${type} (labeled) incomplete${labeled.status ? `: HTTP ${labeled.status}` : ''}`,
    );
  }

  // Fallback: name-prefix scan to catch resources created without the
  // `managed-by=vibecarbon` label. The e2e preflight matches on
  // `testapp-*` name prefix, so a label-only sweep can declare success
  // while preflight still flags residue and aborts the next matrix run.
  const all = await listPages(type, key);
  if (!all.complete) {
    console.warn(
      `[sweep] list ${type} (by name) incomplete${all.status ? `: HTTP ${all.status}` : ''}`,
    );
  }

  const seen = new Set();
  const scoped = [];
  for (const it of [...labeled.items, ...all.items]) {
    // Scope to e2e scratch names — never delete a real deployment that merely
    // shares the `managed-by=vibecarbon` label.
    if (!isE2eScratchResource(it.name) || seen.has(it.id)) continue;
    seen.add(it.id);
    scoped.push(it);
  }
  return { items: scoped, complete: labeled.complete && all.complete };
}

// One DELETE attempt. 404 counts as success (already gone).
async function delOnce(type, id) {
  const res = await fetch(`${API}/${type}/${id}`, { method: 'DELETE', headers });
  return res.ok || res.status === 404;
}

// DELETE with bounded retry. Resources freshly detached from a deleting
// server are action-locked (HTTP 423) for a short window — e.g. a floating
// IP auto-unassigning while its server's deletion is still in flight. The
// old one-shot DELETE printed FAILED, the recheck ignored non-server kinds,
// and the sweep exited 0 with residue (RCA 2026-07-16: two citest-*
// floating IPs survived a cancelled CI run's sweep and aborted the next
// matrix's preflight). `doDelete` is injectable for unit tests only.
export async function delWithRetry(
  type,
  id,
  { attempts = 6, delayMs = 5000, doDelete = delOnce } = {},
) {
  for (let i = 1; i <= attempts; i += 1) {
    if (await doDelete(type, id)) return true;
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function sweepKind(type, key, labelFn) {
  const { items } = await listScopedResources(type, key);
  if (items.length === 0) return 0;
  console.log(`[sweep] ${type} still present: ${items.length}`);
  for (const item of items) {
    const label = labelFn(item);
    process.stdout.write(`[sweep]   DELETE ${type} ${label} ... `);
    const ok = await delWithRetry(type, item.id);
    console.log(ok ? 'ok' : 'FAILED');
  }
  return items.length;
}

// Every cloud-resource kind the sweep owns, in deletion order: servers
// first (they hold references to everything else), dependents after. The
// final recheck re-lists THIS table, so sweep coverage and recheck coverage
// cannot drift apart. Must stay a superset of the kinds preflight's
// hetzner-clean scans (tests/e2e/utils/preflight.ts) — a kind preflight
// flags but the sweep can't clean wedges every subsequent run
// (tests/unit/e2e/sweep-recheck.test.ts pins the two together).
export const CLOUD_KINDS = [
  ['servers', 'servers', (s) => `${s.id} ${s.name} ${s.public_net?.ipv4?.ip || '?'}`],
  ['firewalls', 'firewalls', (f) => `${f.id} ${f.name}`],
  ['ssh_keys', 'ssh_keys', (k) => `${k.id} ${k.name}`],
  ['networks', 'networks', (n) => `${n.id} ${n.name}`],
  ['load_balancers', 'load_balancers', (l) => `${l.id} ${l.name}`],
  ['volumes', 'volumes', (v) => `${v.id} ${v.name}`],
  // Placement groups — preflight scans for these by scratch prefix, so the
  // sweep must too. Without this entry, Pulumi state loss on a failed run
  // leaves the placement group behind, sweep declares clean, and the next
  // run aborts on preflight (RCA from k8s-ha 2026-04-30 iteration).
  ['placement_groups', 'placement_groups', (pg) => `${pg.id} ${pg.name}`],
  // Floating IPs — account-scoped quota of 10 by default, and e2e test
  // runs accumulate orphans fast if pulumi destroy fails partway.
  ['floating_ips', 'floating_ips', (ip) => `${ip.id} ${ip.name} ${ip.ip}`],
];

// --- CSI-orphan volume pass -------------------------------------------------
//
// The Hetzner CSI driver names its volumes `pvc-<uuid>` and applies neither
// vibecarbon's `managed-by` label nor the scratch name prefix, so the
// labeled/prefixed sweep above is structurally blind to them — 21 leaked
// (billing per GB/month) between the k8s e2e runs that created them and
// 2026-07-22, with every sweep in between declaring clean.
//
// Since the csi-driver v2.18.1 bump the driver stamps labels of its OWN
// (`managed-by=csi-driver`, `project=<name>` from HCLOUD_VOLUME_EXTRA_LABELS,
// plus pvc-name/pvc-namespace/pv-name). They are not what this pass keys on —
// a rig's volumes and a real deployment's carry the same `project` value, and
// nothing at all is stamped on volumes created before the bump — but they are
// what `vibecarbon destroy`'s backstop matches on, so the ledger pass below
// now has a much smaller pile to drain.
//
// Safety rule: pvc-* volumes are only deleted when the project has ZERO
// servers — with no servers there is no cluster that could still own or be
// about to attach one. With any server present (a live rig in either
// namespace, or a real deployment), the pass defers entirely and says so;
// sweeps run before/between/after every scenario, so a quiet moment that
// collects the orphans always comes.

export function isCsiVolumeName(name) {
  return typeof name === 'string' && /^pvc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name);
}

// --- Ledger pass: volumes a destroy PROVED were its own ---------------------
//
// The zero-servers gate above is correct but slow to fire: during a
// back-to-back e2e matrix there is always a rig up, so the heuristic pass
// defers every time and orphans accumulate for days (21 of them by
// 2026-07-22). It also cannot help a customer at all, since their project
// normally has servers in it permanently.
//
// `vibecarbon destroy` now captures the provider volume ids behind a cluster's
// PersistentVolumes before teardown (src/lib/csi-volumes.js) and writes any it
// could not confirm deleted to ~/.vibecarbon/leaked-volumes.json
// (src/lib/volume-ledger.js). Those are IDENTITIES, not patterns — no
// heuristic, no gate needed.
//
// Two guards remain, because a ledger is a claim about the past:
//   - the volume must still carry the recorded NAME. Volume ids are not
//     documented as never-reused, and deleting a stranger's disk because an id
//     came back around is exactly the failure this whole area keeps having.
//   - the volume must be UNATTACHED. If something is using it, our belief that
//     the owning cluster is gone is wrong; say so and leave it alone.
// Anything the listing shows as already gone is pruned. An incomplete listing
// defers the whole pass — an absent row proves nothing when the walk stopped
// early.

export function selectLedgerVolumes(entries, volumes) {
  const byId = new Map(volumes.map((v) => [String(v.id), v]));
  const deletable = [];
  const gone = [];
  const skipped = [];
  for (const entry of entries) {
    const live = byId.get(String(entry.id));
    if (!live) {
      gone.push(entry);
      continue;
    }
    if (entry.name && live.name !== entry.name) {
      skipped.push({ entry, live, why: `name is now ${live.name} — id was reused` });
      continue;
    }
    if (live.server != null) {
      skipped.push({ entry, live, why: `attached to server ${live.server}` });
      continue;
    }
    deletable.push({ entry, live });
  }
  return { deletable, gone, skipped };
}

export async function sweepLedgerVolumes({
  entries = undefined,
  listVolumes = undefined,
  doDelete = undefined,
  deleteOptions = {},
  prune = pruneVolumeLedger,
} = {}) {
  const ledger = entries ?? ledgerEntriesFor('hetzner');
  if (ledger.length === 0) return 0;

  const listing = listVolumes
    ? await listVolumes()
    : await listPages('volumes', 'volumes').then((r) => ({ items: r.items, complete: r.complete }));
  if (!listing.complete) {
    console.warn(
      `[sweep] ${ledger.length} ledger volume(s) pending but the volume listing is incomplete — deferring`,
    );
    return 0;
  }

  const { deletable, gone, skipped } = selectLedgerVolumes(ledger, listing.items);
  for (const { entry, why } of skipped) {
    console.warn(`[sweep] ledger volume ${entry.id} (${entry.name}) NOT deleted: ${why}`);
  }

  const resolved = [...gone];
  let touched = 0;
  if (deletable.length > 0) {
    console.log(`[sweep] ledger volumes recorded by a previous destroy: ${deletable.length}`);
  }
  for (const { entry, live } of deletable) {
    process.stdout.write(
      `[sweep]   DELETE volumes ${entry.id} ${entry.name} (${entry.environment ?? '?'}, ${live.location?.name ?? '?'}) ... `,
    );
    const ok = await delWithRetry('volumes', entry.id, {
      ...deleteOptions,
      ...(doDelete ? { doDelete } : {}),
    });
    console.log(ok ? 'ok' : 'FAILED');
    if (ok) {
      resolved.push(entry);
      touched += 1;
    }
  }
  if (resolved.length > 0) prune(resolved.map((e) => ({ provider: 'hetzner', id: e.id })));
  return touched;
}

export function selectCsiOrphanVolumes(volumes, serverCount) {
  const candidates = volumes.filter((v) => v.server === null && isCsiVolumeName(v.name));
  if (serverCount > 0) return { orphans: [], deferred: candidates.length };
  return { orphans: candidates, deferred: 0 };
}

async function listAllVolumes() {
  const { items, complete } = await listPages('volumes', 'volumes');
  if (!complete) {
    console.warn('[sweep] volume listing incomplete — CSI-orphan pass sees a partial account');
  }
  return items;
}

// Fail-safe on ANY doubt: the CSI-orphan pass only deletes when this returns
// 0, so an unreadable or truncated server listing must report "servers exist"
// (Infinity) and defer the pass, never under-count its way into deleting a
// live cluster's volumes.
export async function countAllServers() {
  const { items, complete } = await listPages('servers', 'servers');
  return complete ? items.length : Number.POSITIVE_INFINITY;
}

export async function sweepCsiOrphanVolumes({
  listVolumes = listAllVolumes,
  countServers = countAllServers,
  doDelete = undefined,
} = {}) {
  const [volumes, serverCount] = await Promise.all([listVolumes(), countServers()]);
  const { orphans, deferred } = selectCsiOrphanVolumes(volumes, serverCount);
  if (deferred > 0) {
    console.log(
      `[sweep] ${deferred} unattached pvc-* volume(s) present but ${serverCount} server(s) exist — deferring CSI-orphan pass to a quiet sweep`,
    );
    // Enumerate them. A bare count is what let orphans accumulate unnoticed
    // between sweeps: nobody can act on "some volumes were deferred", and the
    // ledger pass above only knows about volumes a destroy actually captured.
    for (const v of volumes.filter((x) => x.server === null && isCsiVolumeName(x.name))) {
      console.log(
        `[sweep]   deferred volume ${v.id} ${v.name} (${v.size}GB, ${v.location?.name ?? '?'}, created ${v.created ?? '?'})`,
      );
    }
    return 0;
  }
  if (orphans.length === 0) return 0;
  console.log(`[sweep] csi-orphan volumes: ${orphans.length}`);
  let touched = 0;
  for (const v of orphans) {
    process.stdout.write(`[sweep]   DELETE volumes ${v.id} ${v.name} (${v.size}GB) ... `);
    const ok = await delWithRetry('volumes', v.id, doDelete ? { doDelete } : undefined);
    console.log(ok ? 'ok' : 'FAILED');
    if (ok) touched += 1;
  }
  return touched;
}

async function main() {
  if (!token) {
    console.error('HETZNER_API_TOKEN required');
    process.exit(2);
  }
  console.log(`[sweep] ${new Date().toISOString()} — checking vibecarbon-managed resources`);
  let touched = 0;
  for (const [type, key, labelFn] of CLOUD_KINDS) {
    touched += await sweepKind(type, key, labelFn);
    // Give Hetzner a moment to release server-owned resources before we
    // try to delete the firewalls / networks that were attached.
    if (type === 'servers' && touched > 0) await new Promise((r) => setTimeout(r, 5000));
  }

  // Ledger volumes FIRST — these are identities a destroy proved were its own,
  // so they need neither the scratch-name prefix nor the quiet-project gate the
  // heuristic pass below waits for.
  touched += await sweepLedgerVolumes();

  // CSI-orphan volumes — see the pass's comment above. Runs after the kinds
  // loop so any scratch servers deleted THIS sweep already count as gone.
  touched += await sweepCsiOrphanVolumes();

  // Sweep orphaned S3 buckets too. Hetzner Object Storage is a separate
  // service from the Cloud API and isn't reachable with HETZNER_API_TOKEN,
  // so we read S3 creds from HETZNER_ACCESS_KEY/HETZNER_SECRET_KEY when present.
  // Missing/invalid creds are non-fatal — the cloud-resource sweep above is
  // the primary job.
  const s3Touched = await sweepS3Buckets();
  touched += s3Touched;

  if (touched === 0) {
    console.log('[sweep] clean — no vibecarbon-managed resources remaining');
    process.exit(0);
  }

  await new Promise((r) => setTimeout(r, 10000));
  // Recheck EVERY cloud kind, not just servers: a FAILED delete above
  // (e.g. a locked floating IP that outlasted the retries) must fail the
  // sweep loudly — exiting 0 with residue just moves the failure to the
  // next run's preflight abort. S3 buckets are deliberately excluded:
  // preflight does not gate on them, and Hetzner Ceph's BucketNotEmpty
  // eventual consistency makes freshly-emptied shells transiently
  // undeletable — successive sweeps converge on those.
  let leaked = 0;
  let blind = 0;
  for (const [type, key, labelFn] of CLOUD_KINDS) {
    const remaining = await listScopedResources(type, key);
    for (const it of remaining.items) console.error(`  - ${type} ${labelFn(it)}`);
    leaked += remaining.items.length;
    if (!remaining.complete) blind += 1;
  }
  if (leaked > 0) {
    console.error(`[sweep] WARNING: ${leaked} resource(s) still present after delete attempts`);
    process.exit(1);
  }
  // A listing that stopped early cannot support a "clean" verdict — the next
  // run's preflight would be the one to discover the residue, which is exactly
  // the failure this sweep exists to prevent. Say so and exit non-zero.
  if (blind > 0) {
    console.error(
      `[sweep] WARNING: ${blind} resource kind(s) could not be listed completely — cannot certify clean`,
    );
    process.exit(1);
  }
  console.log('[sweep] recheck clean');
}

// Only run when invoked directly (`node scripts/sweep-hetzner.js`), so the
// module can be imported for unit tests without executing the sweep.
if (process.argv[1]?.endsWith('sweep-hetzner.js')) {
  main().catch((err) => {
    console.error('[sweep] error:', err.message);
    process.exit(3);
  });
}

async function sweepS3Buckets() {
  // Env-only: populate HETZNER_ACCESS_KEY and HETZNER_SECRET_KEY via tests/.env.e2e or export directly.
  const accessKey = process.env.HETZNER_ACCESS_KEY;
  const secretKey = process.env.HETZNER_SECRET_KEY;
  if (!accessKey || !secretKey) {
    console.log('[sweep] S3 credentials incomplete (HETZNER_ACCESS_KEY/HETZNER_SECRET_KEY) — skipping bucket sweep');
    return 0;
  }

  // Dynamically import so this script still runs on systems without the SDK
  // (the S3 block is optional — cloud-API sweep is the primary job).
  let sdk;
  try {
    sdk = await import('@aws-sdk/client-s3');
  } catch (err) {
    console.warn(`[sweep] @aws-sdk/client-s3 not installed (${err.message}) — skipping bucket sweep`);
    return 0;
  }
  const {
    S3Client,
    ListBucketsCommand,
    ListObjectsV2Command,
    ListObjectVersionsCommand,
    ListMultipartUploadsCommand,
    AbortMultipartUploadCommand,
    DeleteObjectsCommand,
    DeleteBucketCommand,
  } = sdk;

  const TEST_PREFIX = E2E_SCRATCH_PREFIX;
  const REGIONS = ['nbg1', 'fsn1', 'hel1'];
  let deleted = 0;

  for (const region of REGIONS) {
    const client = new S3Client({
      endpoint: `https://${region}.your-objectstorage.com`,
      region,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true,
    });

    let resp;
    try {
      resp = await client.send(new ListBucketsCommand({}));
    } catch (err) {
      console.warn(`[sweep] s3/${region} list-buckets failed: ${err.message}`);
      continue;
    }

    const matches = (resp.Buckets ?? []).filter((b) => b.Name?.startsWith(TEST_PREFIX));
    if (matches.length === 0) continue;
    console.log(`[sweep] s3/${region} testapp-* buckets: ${matches.length}`);

    for (const bucket of matches) {
      const name = bucket.Name;
      process.stdout.write(`[sweep]   DELETE bucket ${region}/${name} ... `);
      try {
        // Empty current objects
        let cont;
        do {
          const list = await client.send(
            new ListObjectsV2Command({ Bucket: name, ContinuationToken: cont, MaxKeys: 1000 }),
          );
          const objs = (list.Contents ?? []).filter((o) => o.Key).map((o) => ({ Key: o.Key }));
          if (objs.length > 0) {
            await client.send(
              new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: objs, Quiet: true } }),
            );
          }
          cont = list.NextContinuationToken;
        } while (cont);

        // Empty versions + delete markers (versioned buckets)
        try {
          let keyMarker;
          let versionIdMarker;
          do {
            const versions = await client.send(
              new ListObjectVersionsCommand({
                Bucket: name,
                KeyMarker: keyMarker,
                VersionIdMarker: versionIdMarker,
              }),
            );
            const toDelete = [
              ...(versions.Versions ?? []).map((v) => ({ Key: v.Key, VersionId: v.VersionId })),
              ...(versions.DeleteMarkers ?? []).map((d) => ({
                Key: d.Key,
                VersionId: d.VersionId,
              })),
            ];
            if (toDelete.length > 0) {
              await client.send(
                new DeleteObjectsCommand({
                  Bucket: name,
                  Delete: { Objects: toDelete, Quiet: true },
                }),
              );
            }
            keyMarker = versions.IsTruncated ? versions.NextKeyMarker : undefined;
            versionIdMarker = versions.IsTruncated ? versions.NextVersionIdMarker : undefined;
          } while (keyMarker);
        } catch {
          // ListObjectVersions not supported — non-fatal
        }

        // Abort any stuck multipart uploads
        try {
          const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: name }));
          for (const u of uploads.Uploads ?? []) {
            await client.send(
              new AbortMultipartUploadCommand({ Bucket: name, Key: u.Key, UploadId: u.UploadId }),
            );
          }
        } catch {
          // Non-fatal
        }

        await client.send(new DeleteBucketCommand({ Bucket: name }));
        console.log('ok');
        deleted++;
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
      }
    }
  }

  if (deleted > 0) console.log(`[sweep] s3 deleted ${deleted} bucket(s)`);
  return deleted;
}
