#!/usr/bin/env node
/**
 * Stale object-storage bucket reaper — all four providers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every e2e scenario creates two buckets (app storage + Pulumi state) and
 * deletes them in its final `vibecarbon destroy`. A run that never reaches
 * that destroy — SIGKILL, a cancelled CI job, a laptop that slept — leaves
 * both behind, and nothing else ever looks at them again. `scripts/sweep-hetzner.js`
 * reaps buckets, but only on Hetzner, and only as part of the in-matrix
 * scratch sweep.
 *
 * The 2026-08-10 all-provider orphan audit found 21 orphaned `testapp-*`
 * buckets on Hetzner nbg1 dating back to Jul 30, plus 3 on DigitalOcean nyc3.
 * Nothing was wrong with any single destroy; the gap is that runs which never
 * destroy have no reaper at all.
 *
 * RELATIONSHIP TO sweep-hetzner.js
 * --------------------------------
 * Deliberately separate, not folded in. sweep-hetzner runs BETWEEN e2e
 * scenarios and must delete a just-finished rig's residue immediately — an age
 * gate there would defeat it. This reaper runs out-of-band (by hand, or on a
 * schedule) across every provider and only touches buckets old enough that no
 * live run can own them.
 *
 * SAFETY POSTURE (in the order it applies)
 * ----------------------------------------
 *   1. The DO subscription ANCHOR is excluded by name, on every provider and
 *      in every region, before anything else is considered. See
 *      DO_SUBSCRIPTION_ANCHOR.
 *   2. Only `testapp-*` (or the E2E_NAMESPACE prefix) scratch names are in
 *      scope, so a real deployment's buckets are structurally unreachable —
 *      the same rule sweep-hetzner.js applies to cloud resources.
 *   3. An age gate, defaulting to 24h, and it takes EVERY available age signal
 *      (the provider's creation date AND the epoch embedded in the e2e name).
 *      A disagreement resolves toward keeping.
 *   4. Dry-run by default. Deleting takes `--delete`.
 *
 * The selection logic is pure and unit-tested in
 * tests/unit/e2e/sweep-buckets.test.ts; this file's I/O half just drives it.
 *
 * Usage:
 *   node scripts/sweep-buckets.js                      # dry run, all providers, 24h
 *   node scripts/sweep-buckets.js --delete
 *   node scripts/sweep-buckets.js --provider=linode --older-than=72 --delete
 *
 * Credentials are the operator object-storage keys each provider class already
 * declares (`<PROVIDER>_ACCESS_KEY` / `<PROVIDER>_SECRET_KEY`) — set them in
 * tests/.env.e2e or export them. A provider with no keys is skipped, loudly.
 */

import { getObjectStorageProvider, getProviderClass, PROVIDERS } from '../src/lib/providers/index.js';
import { E2E_SCRATCH_PREFIX } from './sweep-hetzner.js';

/**
 * The DigitalOcean Spaces subscription anchor.
 *
 * DO bills Spaces as a per-account SUBSCRIPTION, not per bucket: this one
 * bucket in sfo3 is kept alive on purpose so the subscription stays active and
 * e2e runs can create Spaces at all. Deleting it cancels the subscription, and
 * re-creating a bucket does not undo that — it is the single most expensive
 * mistake a sweep could make, which is why it is excluded structurally rather
 * than left to the prefix filter to handle incidentally.
 */
export const DO_SUBSCRIPTION_ANCHOR = 'vc-local-e2e';

/** Buckets no sweep may ever delete, on any provider, in any region. */
export const PROTECTED_BUCKET_NAMES = [DO_SUBSCRIPTION_ANCHOR];

const PROTECTED_SET = new Set(PROTECTED_BUCKET_NAMES.map((n) => n.toLowerCase()));

/** Providers this reaper walks, in the order it walks them. */
export const SWEEP_PROVIDERS = ['hetzner', 'digitalocean', 'linode', 'vultr', 'scaleway'];

const HOUR_MS = 3600_000;
const DEFAULT_MAX_AGE_MS = 24 * HOUR_MS;

/**
 * Is this bucket on the never-delete list?
 *
 * Matched on NAME ALONE, case-insensitively, and deliberately not qualified by
 * provider or region: the guard must hold even if the caller has the row's
 * provenance wrong.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isProtectedBucket(name) {
  return typeof name === 'string' && PROTECTED_SET.has(name.toLowerCase());
}

/**
 * The run epoch embedded in an e2e bucket name.
 *
 * e2e project names are `<prefix><mode>-<Date.now()>-<rand>` (tests/e2e/runner.ts),
 * and every bucket derives from the project name — the app bucket appends
 * `-storage`, the state bucket appends further (`-pulumi-state-<gen>`), so both
 * halves of a run's pair carry the same epoch and age together.
 *
 * This is a SECOND age signal, independent of the provider's own creation
 * date, which some S3-compatible listings omit or report oddly.
 *
 * @param {string} name
 * @returns {number|null} epoch milliseconds, or null when the name carries none
 */
export function bucketTimestampMs(name) {
  const match = /(?:^|-)(\d{12,14})(?:-|$)/.exec(String(name ?? ''));
  if (!match) return null;
  const value = Number(match[1]);
  // Anything before 2017 is not one of our run ids — it is a coincidence in
  // somebody's bucket name, and coincidences must not authorize a delete.
  return value >= 1_500_000_000_000 ? value : null;
}

/**
 * Split a provider listing into what may be deleted and what must be kept,
 * with a reason for every kept row (a sweep that cannot say why it skipped
 * something is not auditable).
 *
 * @param {Array<{name: string, creationDate?: Date|string|null, region?: string}>} buckets
 * @param {object} options
 * @param {string} options.prefix - scratch-name prefix that scopes the sweep
 * @param {number} options.maxAgeMs - minimum age before a bucket is in scope
 * @param {number} [options.now]
 * @returns {{stale: object[], kept: object[]}}
 */
export function selectStaleBuckets(buckets, { prefix, maxAgeMs, now = Date.now() }) {
  const stale = [];
  const kept = [];
  const hours = (ms) => `${Math.round((ms / HOUR_MS) * 10) / 10}h`;

  for (const row of buckets ?? []) {
    const name = row?.name;
    if (!name) continue;

    if (isProtectedBucket(name)) {
      kept.push({ ...row, reason: 'protected: deliberate subscription anchor, never sweepable' });
      continue;
    }
    if (!name.startsWith(prefix)) {
      kept.push({ ...row, reason: `outside the "${prefix}*" scratch prefix` });
      continue;
    }

    // Every signal we have, not the most convenient one. A name that says
    // "ancient" over a bucket the provider says it made minutes ago is a live
    // run reusing a retried scenario's project name.
    const ages = [];
    const created = row.creationDate ? new Date(row.creationDate).getTime() : Number.NaN;
    if (Number.isFinite(created)) ages.push(now - created);
    const stamped = bucketTimestampMs(name);
    if (stamped !== null) ages.push(now - stamped);

    if (ages.length === 0) {
      kept.push({ ...row, reason: 'no age signal (no creation date, no run id in the name)' });
      continue;
    }

    const youngest = Math.min(...ages);
    if (youngest < maxAgeMs) {
      kept.push({
        ...row,
        reason: `younger than the ${hours(maxAgeMs)} age gate (${hours(Math.max(youngest, 0))} old)`,
      });
      continue;
    }
    stale.push({ ...row, ageMs: youngest, reason: `${hours(youngest)} old` });
  }

  return { stale, kept };
}

/**
 * Parse the command line. Dry-run is the DEFAULT — a reaper whose destructive
 * mode is the one you get by typing nothing is a reaper that eventually runs
 * by accident.
 *
 * @param {string[]} argv
 * @returns {{dryRun: boolean, maxAgeMs: number, providers: string[], prefix: string}}
 */
export function parseSweepArgs(argv = []) {
  const options = {
    dryRun: true,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    providers: [...SWEEP_PROVIDERS],
    prefix: E2E_SCRATCH_PREFIX,
  };

  for (const arg of argv) {
    if (arg === '--delete') {
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--older-than=')) {
      const raw = arg.slice('--older-than='.length);
      const hours = Number(raw);
      if (raw === '' || !Number.isFinite(hours) || hours < 0) {
        throw new Error(`--older-than expects a non-negative number of hours; got "${raw}"`);
      }
      options.maxAgeMs = hours * HOUR_MS;
    } else if (arg.startsWith('--provider=')) {
      const id = arg.slice('--provider='.length);
      if (!SWEEP_PROVIDERS.includes(id)) {
        throw new Error(`Unknown provider "${id}". Known: ${SWEEP_PROVIDERS.join(', ')}`);
      }
      options.providers = [id];
    } else if (arg.startsWith('--prefix=')) {
      options.prefix = arg.slice('--prefix='.length);
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }

  return options;
}

/**
 * "This key is not valid for this cluster" — expected, not a fault.
 *
 * Linode mints Object Storage keys per CLUSTER and each cluster keeps its own
 * key database, so walking every endpoint (which is how the reaper finds the
 * account's REAL cluster without trusting LINODE_STORAGE_REGION) necessarily
 * gets rejected by all the others. Treating that as an error would bury the
 * one region that matters under eighteen warnings.
 */
function isWrongClusterError(error) {
  return ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'NoSuchKey'].includes(
    error?.name,
  );
}

/** A delete refused because the bucket lives behind a different endpoint. */
function isWrongEndpointError(error) {
  return ['PermanentRedirect', 'NoSuchBucket', 'NotFound'].includes(error?.name);
}

/**
 * Sweep one provider across every region its object-storage class knows.
 *
 * Regions are walked exhaustively rather than resolved from configuration.
 * That is what makes the Linode case work without special-casing: the account
 * is assigned ONE cluster per region and it is not always the documented `-1`
 * (this account's is us-iad-18), `LINODE_STORAGE_REGION` may be unset or
 * stale, and the wrong-cluster rejections above are self-identifying. It also
 * means a bucket left in a region nobody configured any more is still found.
 */
async function sweepProvider(providerId, { prefix, maxAgeMs, dryRun, now }) {
  const summary = { deleted: [], failed: [], planned: [], unreadable: [] };
  const Provider = getProviderClass(providerId);
  const [accessEnv, secretEnv] = Provider.OBJECT_STORAGE_ENV;
  const accessKey = process.env[accessEnv];
  const secretKey = process.env[secretEnv];

  if (!accessKey || !secretKey) {
    console.log(`[buckets] ${providerId}: no ${accessEnv}/${secretEnv} — skipping`);
    return summary;
  }

  const S3Class = await Provider.getObjectStorageProviderClass();
  const regions = Object.keys(S3Class.ENDPOINTS);
  let readable = 0;

  for (const region of regions) {
    const s3 = await getObjectStorageProvider(providerId, accessKey, secretKey, region);

    let buckets;
    try {
      // Fail fast on a rejection that is already final. This walk visits every
      // endpoint the provider has, so on Linode and Vultr most regions answer
      // "not your cluster" — retrying that answer three times with backoff
      // cost 15s per region (live: Vultr's 8 endpoints took two minutes).
      buckets = await s3.listBuckets({ terminal: isWrongClusterError });
    } catch (error) {
      if (!isWrongClusterError(error)) {
        console.warn(`[buckets] ${providerId}/${region}: list failed: ${error.message}`);
        summary.unreadable.push(`${providerId}/${region}`);
      }
      continue;
    }
    readable += 1;

    const { stale } = selectStaleBuckets(buckets, { prefix, maxAgeMs, now });
    if (stale.length === 0) continue;

    console.log(`[buckets] ${providerId}/${region}: ${stale.length} stale bucket(s)`);
    for (const bucket of stale) {
      if (dryRun) {
        console.log(`[buckets]   would delete ${bucket.name} (${bucket.reason})`);
        summary.planned.push(`${providerId}/${region}/${bucket.name}`);
        continue;
      }
      process.stdout.write(`[buckets]   DELETE ${bucket.name} (${bucket.reason}) ... `);
      try {
        const result = await s3.emptyAndDeleteBucket(bucket.name);
        // A deferred empty shell is not a failure: the data is gone and it
        // costs nothing, and the next sweep collects the shell (see s3-base's
        // BucketNotEmpty eventual-consistency note).
        console.log(result.deleted ? 'ok' : 'emptied (shell deferred)');
        summary.deleted.push(`${providerId}/${region}/${bucket.name}`);
      } catch (error) {
        if (isWrongEndpointError(error)) {
          // Some backends list an account's buckets from any regional
          // endpoint but only serve deletes from the bucket's own. The
          // owning region's pass handles it.
          console.log(`skipped (lives in another region)`);
          continue;
        }
        console.log(`FAILED: ${error.message}`);
        summary.failed.push(`${providerId}/${region}/${bucket.name}: ${error.message}`);
      }
    }
  }

  if (readable === 0) {
    console.warn(
      `[buckets] ${providerId}: no region accepted these credentials — nothing could be checked`,
    );
    summary.unreadable.push(`${providerId}/*`);
  }
  return summary;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseSweepArgs(argv);
  const now = Date.now();
  console.log(
    `[buckets] ${new Date(now).toISOString()} — ${options.dryRun ? 'DRY RUN' : 'DELETING'} ` +
      `"${options.prefix}*" buckets older than ${options.maxAgeMs / HOUR_MS}h ` +
      `on ${options.providers.join(', ')}`,
  );

  const totals = { deleted: [], failed: [], planned: [], unreadable: [] };
  for (const providerId of options.providers) {
    const summary = await sweepProvider(providerId, { ...options, now });
    for (const key of Object.keys(totals)) totals[key].push(...summary[key]);
  }

  if (options.dryRun) {
    console.log(
      totals.planned.length > 0
        ? `[buckets] DRY RUN — ${totals.planned.length} bucket(s) would be deleted. Re-run with --delete.`
        : '[buckets] DRY RUN — nothing stale enough to delete.',
    );
  } else {
    console.log(`[buckets] deleted ${totals.deleted.length} bucket(s)`);
  }

  if (totals.failed.length > 0) {
    console.error(`[buckets] ${totals.failed.length} delete(s) FAILED:`);
    for (const line of totals.failed) console.error(`  - ${line}`);
    process.exit(1);
  }
  // An unreadable region cannot support a clean verdict — the same rule the
  // cloud-resource sweep applies to a truncated listing. Wrong-cluster
  // rejections are not counted here; they are an answer, not a silence.
  if (totals.unreadable.length > 0) {
    console.error(
      `[buckets] could not read ${totals.unreadable.length} location(s): ${totals.unreadable.join(', ')}`,
    );
    process.exit(1);
  }
}

// Importable for unit tests without running the sweep.
if (process.argv[1]?.endsWith('sweep-buckets.js')) {
  main().catch((err) => {
    console.error('[buckets] error:', err.message);
    process.exit(2);
  });
}

// Referenced so the provider registry stays an explicit dependency of the
// SWEEP_PROVIDERS list: a provider added to PROVIDERS without a row here
// would otherwise never be swept.
export const KNOWN_PROVIDER_IDS = Object.keys(PROVIDERS);
