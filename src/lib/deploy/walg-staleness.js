/**
 * Bounded retry for Hetzner Object Storage read-after-write staleness on the
 * wal-g paths.
 *
 * THE CLASS
 * ---------
 * Hetzner Object Storage load-balances across frontends that do not share a
 * consistent view instantly. A read issued moments after a create/write can
 * land on a frontend that has not caught up and answers 404 — for the BUCKET
 * (`NoSuchBucket`) or for an object that demonstrably exists (`NoSuchKey` /
 * a bare `NotFound`). The matrix run of 2026-07-31 produced four spellings of
 * this one class, all against `nbg1-prod1-ceph5`:
 *
 *   1. `pulumi up` 404ing its own stack file        → src/lib/iac/index.js (PR #220)
 *   2. the DIY backend 404ing the lock blob it wrote → src/lib/iac/index.js (PR #220)
 *   3. the in-cluster registry 500ing on a fresh repo
 *   4. `wal-g backup-fetch` 404ing the bucket a `backup-push` had JUST
 *      written, from a DIFFERENT host — this module.
 *
 * Spelling 4, verbatim, from a compose scale (env e1, ~21:49Z): the old
 * server's base-backup push succeeded, and seconds later the new server's
 * restore died with
 *
 *   INFO: Selecting the latest backup...
 *   ERROR: Failed to select backup: list folder in storage "default": failed to
 *   list s3 folder: 'backups/<project>/walg/basebackups_005/': NoSuchBucket:
 *     status code: 404, request id: tx…-nbg1-prod1-ceph5
 *
 * The e2e runner already classifies this as `[infra: S3 transient]`, but the
 * PRODUCT had no recovery: a customer's scale dies mid-migration, after the
 * new server is provisioned and before the old one is destroyed.
 *
 * WHY RETRYING IS SAFE HERE
 * -------------------------
 * Both wrapped operations are idempotent by construction:
 *   - `backup-fetch` runs inside a restore script that CLEARS $PGDATA before
 *     fetching, against a stopped database. Re-running it re-clears and
 *     re-fetches — the same sequence attempt 1 performed. And the staleness
 *     bites on the initial LIST ("Selecting the latest backup"), before a
 *     single byte has been fetched.
 *   - `backup-push` writes a NEW base backup whose sentinel is written last,
 *     so a failed push leaves nothing selectable; the `delete retain` in the
 *     same script prunes to the retention count either way.
 *
 * WHAT MUST STAY FATAL
 * --------------------
 * A missing bucket is a REAL ANSWER for a mistyped S3_BACKUP_BUCKET / wrong
 * endpoint, exactly as it is on pulumi's destroy path (which deliberately does
 * NOT opt `NoSuchBucket` into its retry — see `withStateBackendRetry`'s
 * `extraPattern` note in src/lib/iac/index.js). The budget is what reconciles
 * the two: ~30s of backoff, then the ORIGINAL error propagates untouched. A
 * broken configuration still fails the command; it just fails 30s later.
 * Everything that does not match the signature fails on the first attempt.
 */

import { progressLog } from '../cli/progress.js';
import { runWithRetry } from '../retry.js';

/**
 * The staleness signature, matched against a failed command's message, stdout
 * AND stderr (see `isWalgStaleStorageError` for why all three).
 *
 * Deliberately narrow — three spellings of "object storage says 404":
 *
 *  - `NoSuchBucket`: the bucket itself 404s. This is the observed incident.
 *  - `NoSuchKey`: an object 404s. On a fetch this is a just-written base
 *    backup part or sentinel; on the push path it is `delete retain` listing
 *    back what the push just wrote. (Unlike the pulumi lock-blob case, there
 *    is no path prefix worth pinning on: every key wal-g reads here belongs to
 *    the backup it is actively fetching or pruning.)
 *  - `status code: 404`: the aws-sdk rendering that accompanies both, plus its
 *    bare `NotFound` shape, which carries no code word of its own.
 *  - `object '…' not found in storage`: wal-g's OWN storage-abstraction
 *    rendering of the same 404, which carries none of the aws-sdk code words.
 *    Observed 2026-08-06 (compose scale, env e1, ~23:21Z): the fetch's LIST
 *    saw the just-pushed backup's sentinel, then the GET for its
 *    `files_metadata.json` landed on a frontend that had not caught up —
 *    `Failed to fetch backup: failed to fetch files metadata: object
 *    'base_…/files_metadata.json' not found in storage`. The intent above
 *    always covered this case; the wording escaped the pattern, so the
 *    ladder never fired and the scale died on attempt 1.
 *
 * What is deliberately EXCLUDED: `403`/`InvalidAccessKeyId` (credentials are
 * wrong on attempt 5 too), and wal-g's empty-prefix wording (`no backups
 * found` — the LIST reached the bucket in order to discover it was empty;
 * see WALG_EMPTY_STORAGE_RE in walg-audit.js).
 */
export const WALG_STALE_STORAGE_PATTERN =
  /NoSuchBucket|NoSuchKey|status code:\s*404|object '[^']*' not found in storage/i;

/**
 * 5 attempts, 2/4/8/16s — the same ladder `withStateBackendRetry` uses for the
 * pulumi half of this class (exponential from 2s, capped at 30s), so the two
 * recoveries for one storage backend cannot drift apart. ~30s total, which is
 * comfortably longer than every observed propagation delay and short enough to
 * stay invisible next to a restore's multi-minute budget.
 */
export const WALG_STALE_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

/**
 * Does this failure look like a stale storage frontend?
 *
 * The signature is hunted across message + stdout + stderr because where wal-g's
 * output lands depends on the transport: `docker compose run` (no `-T`) can
 * merge the container's stderr into stdout, in which case `runCommandAsync`'s
 * rejection message — built from stderr alone — carries none of it.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isWalgStaleStorageError(err) {
  if (!err) return false;
  const parts = [err.message, err.stdout, err.stderr]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => (typeof v === 'string' ? v : String(v)));
  const haystack = parts.length > 0 ? parts.join('\n') : String(err);
  return WALG_STALE_STORAGE_PATTERN.test(haystack);
}

/**
 * Run a wal-g exec under the bounded staleness retry.
 *
 * @template T
 * @param {() => Promise<T>} fn  The exec to run (and possibly re-run).
 * @param {string} desc  What is being retried, for the log line
 *   (e.g. `backup-fetch (restore)`).
 * @param {object} [options]
 * @param {number[]} [options.delaysMs]  Override the delay ladder. Production
 *   callers omit it; tests pass zeros. Attempts = delaysMs.length + 1.
 * @returns {Promise<T>}
 */
export function withWalgStaleStorageRetry(fn, desc, options = {}) {
  const delaysMs = options.delaysMs ?? WALG_STALE_RETRY_DELAYS_MS;
  const attempts = delaysMs.length + 1;
  return runWithRetry(fn, {
    delaysMs,
    isTransient: isWalgStaleStorageError,
    onRetry: (_err, attempt) => {
      // Routed through progressLog so a retry updates an active spinner's line
      // instead of corrupting it (same reason the pulumi retry does).
      progressLog(
        `[walg] ${desc} hit a stale storage frontend (attempt ${attempt}/${attempts}), ` +
          `retrying in ${delaysMs[attempt - 1] / 1000}s`,
      );
    },
  });
}
