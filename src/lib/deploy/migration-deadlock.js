/**
 * Bounded retry for boot-window deadlocks at migration apply.
 *
 * THE CLASS
 * ---------
 * applyMigrations runs each supabase/migrations/*.sql file through
 * `psql -v ON_ERROR_STOP=1 --single-transaction` while the Supabase services
 * are ALREADY booting — and several of them (storage-api, auth) run their own
 * first-boot DDL against the same relations our migrations touch
 * (storage.objects policies, auth schema). The storage-schema readiness
 * probe (buckets.public queryable) proves the schema EXISTS, not that the
 * service is done taking locks. Observed 2026-08-30 (run 33287840597,
 * hetzner k8s-ha restore's re-deploy):
 *
 *   ERROR:  deadlock detected
 *   DETAIL:  Process 71 waits for AccessExclusiveLock on relation 16524 of
 *   database 5; blocked by process 55. Process 55 waits for ShareLock on
 *   virtual transaction 8/16; blocked by process 71.
 *   command terminated with exit code 3
 *
 * WHY RETRYING IS SAFE HERE
 * -------------------------
 * `--single-transaction` means a deadlocked file rolled back COMPLETELY —
 * re-running that one file is byte-for-byte what attempt 1 did. And a
 * deadlock is transient by definition: Postgres kills one participant so the
 * other can finish; by the retry, the boot DDL that raced us has moved on.
 *
 * WHAT MUST STAY FATAL
 * --------------------
 * Everything else. A syntax error, a missing column, an RLS violation fail
 * identically on attempt 3 — they fail on attempt 1, unretried, exactly as
 * loud as before (see the 2026-08-25 migration-drift RCA for why a silent
 * migration failure is the worst outcome).
 *
 * Two transports share this policy (census: the source pins in
 * tests/unit/deploy/migration-deadlock.test.ts):
 *  - k8s/k8s-ha: applyMigrations (k3s.js) wraps its per-file exec in
 *    withMigrationDeadlockRetry.
 *  - compose/compose-ha: the remote migration loop is built by
 *    composeMigrationsRetryShell(), which derives its attempt bound from the
 *    SAME ladder so the two cannot drift.
 */

import { progressLog } from '../cli/progress.js';
import { runWithRetry } from '../retry.js';

/**
 * Postgres's one spelling of the condition (SQLSTATE 40P01 renders as
 * "deadlock detected" in psql output). Deliberately narrow: lock TIMEOUTS
 * (55P03/40001 wordings) are a different class with different causes.
 */
export const MIGRATION_DEADLOCK_PATTERN = /deadlock detected/i;

/** 3 attempts, 5s apart — the boot DDL that races us finishes in seconds. */
export const MIGRATION_DEADLOCK_DELAYS_MS = [5000, 5000];

/**
 * Does this failure look like a migration deadlock?
 *
 * Hunted across message + stdout + stderr because where psql's output lands
 * depends on the transport (kubectl exec merges differently than ssh'd
 * `docker compose exec`), mirroring isWalgStaleStorageError.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMigrationDeadlockError(err) {
  if (!err) return false;
  const parts = [err.message, err.stdout, err.stderr]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => (typeof v === 'string' ? v : String(v)));
  const haystack = parts.length > 0 ? parts.join('\n') : String(err);
  return MIGRATION_DEADLOCK_PATTERN.test(haystack);
}

/**
 * Run one migration file's exec under the bounded deadlock retry.
 *
 * @template T
 * @param {() => Promise<T>} fn  The per-file exec to run (and possibly re-run).
 * @param {string} file  The migration file name, for the log line.
 * @param {object} [options]
 * @param {number[]} [options.delaysMs]  Override the delay ladder. Production
 *   callers omit it; tests pass zeros. Attempts = delaysMs.length + 1.
 * @returns {Promise<T>}
 */
export function withMigrationDeadlockRetry(fn, file, options = {}) {
  const delaysMs = options.delaysMs ?? MIGRATION_DEADLOCK_DELAYS_MS;
  const attempts = delaysMs.length + 1;
  return runWithRetry(fn, {
    delaysMs,
    isTransient: isMigrationDeadlockError,
    onRetry: (_err, attempt) => {
      progressLog(
        `[migrate] ${file} hit a deadlock (attempt ${attempt}/${attempts}), ` +
          `retrying in ${delaysMs[attempt - 1] / 1000}s`,
      );
    },
  });
}

/**
 * The compose migration loop, with the same per-file deadlock retry.
 *
 * Replaces the previous inline one-shot loop in compose/index.js. Contract
 * preserved: files apply in lex order; each file is atomic
 * (ON_ERROR_STOP=1 --single-transaction); the FIRST unapplied file fails the
 * deploy loudly (no `|| true`, exit 1 propagates through sshRunAsync).
 * Retry added: a file whose combined output matches the deadlock spelling is
 * re-piped after a pause — safe because its transaction rolled back. Any
 * other failure breaks out of the attempt loop immediately.
 *
 * @returns {string} shell script for `sshRunAsync(ip, key, "cd <dir> && " + …)`
 */
export function composeMigrationsRetryShell() {
  const attempts = MIGRATION_DEADLOCK_DELAYS_MS.length + 1;
  const delayS = Math.round(MIGRATION_DEADLOCK_DELAYS_MS[0] / 1000);
  return (
    `for f in $(ls supabase/migrations/ 2>/dev/null | sort); do ` +
    `applied=0; ` +
    `for attempt in $(seq 1 ${attempts}); do ` +
    `echo "[migrate] applying $f"; ` +
    `out=$(cat "supabase/migrations/$f" | docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction 2>&1) && { applied=1; printf '%s\\n' "$out"; break; }; ` +
    `printf '%s\\n' "$out" >&2; ` +
    `printf '%s' "$out" | grep -qi "deadlock detected" || break; ` +
    `[ "$attempt" -lt ${attempts} ] && { echo "[migrate] $f hit a deadlock (attempt $attempt/${attempts}), retrying in ${delayS}s"; sleep ${delayS}; }; ` +
    `done; ` +
    `[ "$applied" = 1 ] || { echo "[migrate] FAILED applying $f" >&2; exit 1; }; ` +
    `done`
  );
}
