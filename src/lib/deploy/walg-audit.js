/**
 * Deploy-time wal-g audit — the ground-truth backstop for BACKUPS.
 *
 * Sibling of rls-audit.js, same contract: run a probe against the LIVE system
 * after the stack is up, and FAIL the deploy when the answer is wrong. Where
 * the RLS audit protects the data from being read, this one protects it from
 * being lost.
 *
 * WHY THIS EXISTS
 * ---------------
 * `carbon/db/Dockerfile` proves the wal-g BINARY executes (`wal-g --version`
 * runs in the build, so a wrong-arch or glibc-mismatched download fails there).
 * Deploy then asserts `archive_mode=on`. Neither says anything about whether
 * wal-g can actually TALK TO THE BUCKET from the deployed container. Wrong or
 * expired S3 keys, a bucket that doesn't exist, a mistyped endpoint/region, or
 * blocked egress all produce a database that is healthy, serving traffic, and
 * silently accumulating ZERO recoverable backups. That exact shape has bitten
 * three times (404'd release URL, glibc mismatch, TARGETARCH bug) and every
 * time the symptom was "everything green, backups dead".
 *
 * THE SIGNAL, AND WHY
 * -------------------
 * `wal-g backup-list --json` executed INSIDE the db container is the load-
 * bearing check. It exercises the whole chain the archive path depends on —
 * binary → WALG_* env → credentials → network → bucket/prefix — for the cost of
 * a single S3 LIST, and it does it with the exact environment postgres'
 * `archive_command` sees (same container, same env, same mounted credentials
 * file). Exit 0 means that chain lines up. An EMPTY list is SUCCESS, not
 * failure: a brand-new environment legitimately has no base backups until the
 * first `vibecarbon backup` or the nightly cron runs.
 *
 * `pg_stat_archiver` is read too, but it is deliberately NOT the primary
 * signal, because on this stack it cannot see the failure mode we care about:
 * `wal-archive.sh` retries and then exits 0 on purpose (a non-zero
 * archive_command pins pg_wal and fills the disk — RCA prod-1 2026-05-26), so
 * postgres counts every push as a success and `failed_count` stays 0 even when
 * every WAL segment is being dropped on the floor. What pg_stat_archiver DOES
 * see is the archive_command itself being broken — missing script, bad mount,
 * wrong interpreter — which surfaces as a real non-zero exit. So we use it for
 * exactly that, and only when the MOST RECENT archiver event was a failure
 * (`last_failed_time` newer than `last_archived_time`). Comparing timestamps
 * instead of `failed_count > 0` means a historical failure that has since been
 * fixed cannot false-red a warm redeploy, and it is computed in SQL so no
 * timestamp parsing happens in JS.
 *
 * A fresh cluster that has archived nothing yet has both timestamps NULL and is
 * reported as a PASS with a note — never a failure. Forcing a WAL switch to
 * manufacture a data point was considered and rejected: because the wrapper
 * exits 0 regardless, a forced switch would prove nothing that backup-list
 * hasn't already proven, at the cost of a 16 MiB segment on every deploy.
 *
 * WHEN IT RUNS
 * ------------
 * Wherever wal-g is deployed, on both paths, gated on backups actually being
 * configured. Backups CAN be disabled (a deploy with no S3 bucket renders
 * `WALG_S3_PREFIX` as the empty-bucket form `s3:///backups/...` — see
 * carbon/docker-compose.yml and carbon/k8s/values/supabase.values.yaml), and
 * the probe detects that from INSIDE the container and reports a skip. Testing
 * the env wal-g actually sees is the same technique
 * carbon/backup/compose-backup.sh uses, and it means the gate can never drift
 * from the runtime. A real prefix with NO credentials is the opposite case and
 * FAILS: prefix and credentials come from the same S3 config, so that shape is
 * a missing/misnamed secret, not an opt-out.
 *
 * PRIMARY ONLY. The probe skips a node whose `WALG_ROLE` is `standby`, and that
 * is correct rather than merely convenient: the standby is write-guarded by
 * design (WALG_ROLE=standby short-circuits both wal-archive.sh and the base
 * backup), so every archiver assertion there is vacuous; its wal-g CONFIG is
 * not independent (both nodes render WALG_S3_PREFIX from the same project
 * config and receive the same credential material, so the primary's audit
 * already proves it); and its DR seed/reseed path is pg_basebackup over the
 * WireGuard transport, not wal-g, and is already hard-gated by verify-streaming
 * later in the same plan. Probing a standby db that is still converging would
 * trade a vacuous signal for real deploy flake.
 *
 * `requirePrimary`: WHEN THE SKIP IS ITSELF THE BUG
 * ------------------------------------------------
 * That skip is right at DEPLOY time and exactly wrong at FAILOVER time. After a
 * promotion the node IS the primary, so a `WALG_ROLE=standby` it is still
 * carrying is not a write-guard doing its job — it is stale config silently
 * disabling archiving on the only node that has the data (see
 * src/lib/deploy/walg-role.js). Callers that KNOW the node must be a primary
 * pass `requirePrimary: true`, which turns that skip into a failure and reads
 * `pg_is_in_recovery()` alongside it so the message can say which shape it is:
 * a promoted node that never got its role re-rendered, or a node that is still
 * in recovery and should not have been audited as a primary at all.
 *
 * It is OPT-IN, not the default, and that is deliberate. A k8s-ha standby
 * legitimately sits `WALG_ROLE=standby` and NOT in recovery during bring-up:
 * if the first-boot seed init exits UNSEEDED, its database boots as an
 * independent primary and the serial reseed converts it later — AFTER
 * `deployK3s` has already run this audit against that cluster. Failing on that
 * shape would turn a designed fallback into a red deploy. The rot state and the
 * bring-up state are indistinguishable from inside the container; only the
 * CALLER knows which one it is looking at, so the caller declares it.
 */

import { progressLog } from '../cli/progress.js';
import { runWithRetry } from '../retry.js';
import { parseWalgBackupList } from '../walg-backups.js';

/**
 * SQL read from `pg_stat_archiver`, written for `psql -tAX` (tuples-only,
 * unaligned → one `|`-separated row; NULLs render as empty fields).
 *
 * The trailing boolean is the only derived value and it is computed HERE, in
 * Postgres, on purpose: "is the archiver failing RIGHT NOW" is a timestamp
 * comparison, and doing it in SQL keeps JS from having to parse Postgres'
 * `2026-07-30 12:00:00.123456+00` timestamptz rendering (which is not ISO-8601
 * and is not portably parseable by `new Date`). JS only ever compares it to the
 * literal `t`.
 *
 * Contains NO single quotes — it is embedded inside a `bash -c '...'` word.
 */
export const WALG_ARCHIVER_SQL =
  'SELECT archived_count, failed_count, last_archived_wal, last_failed_wal, ' +
  'last_archived_time, last_failed_time, ' +
  '(last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR ' +
  'last_failed_time > last_archived_time)) FROM pg_stat_archiver';

/**
 * Build the probe body, executed INSIDE the db container by both deploy paths
 * (`docker compose exec -T db bash -c '<this>'` / `kubectl exec ... -- bash -c
 * '<this>'`). It always exits 0 and reports its findings as `KEY=value` lines
 * on stdout, so the pass/fail VERDICT lives in JS (evaluateWalgAudit) instead
 * of in shell — one evaluator, identical message on both paths, unit-testable
 * with the exec seam mocked. A non-zero exit from this command therefore means
 * the container itself was unreachable, which is its own reported failure.
 *
 * INVARIANT: no single quotes anywhere in this string, in EITHER mode. It is
 * passed as one single-quoted word through the compose path's remote shell; a
 * stray `'` would split the command. Pinned by a unit test.
 *
 * GUARD ORDER IS THE WHOLE POINT — it is what separates "configured" from
 * "working":
 *   1. No prefix at all (empty, or the `s3:///…` empty-bucket form both paths
 *      render when no bucket is set) → backups are deliberately OFF → skip.
 *   2. WALG_ROLE=standby → normally write-guarded by design → skip, before the
 *      credential check, so a standby never fails on it either. Under
 *      `requirePrimary` the caller has asserted this node IS the primary, so
 *      the same reading is a FAILURE instead (see the module docblock) and
 *      `pg_is_in_recovery()` is read to say which shape it is.
 *   3. A real prefix but NO credentials → the deploy INTENDED backups and they
 *      cannot possibly work → FAIL. The prefix and the credentials come from
 *      the same S3 config, so this is a missing/misnamed secret, never an
 *      operator opting out. Detection covers both wiring styles: compose
 *      injects AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY as env, k8s mounts an
 *      INI file and points AWS_SHARED_CREDENTIALS_FILE at it.
 *
 * @param {{requirePrimary?: boolean}} [opts]
 * @returns {string}
 */
export function buildWalgAuditProbe({ requirePrimary = false } = {}) {
  const standbyBranch = requirePrimary
    ? [
        // Read recovery state for the MESSAGE only — the verdict is already
        // decided by the role. `f` = promoted node still carrying the standby
        // write-guard (the post-failover rot state); `t` = a node that is still
        // a replica and should never have been audited as a primary; empty =
        // psql could not answer, which changes neither.
        `  REC="$(psql -U supabase_admin -d postgres -tAXc "SELECT pg_is_in_recovery()" 2>/dev/null | tr -d "[:space:]")"`,
        '  echo "WALG_AUDIT=fail:stale-standby-role"; echo "WALG_AUDIT_PREFIX=$PFX"',
        '  echo "WALG_AUDIT_RECOVERY=$REC"; exit 0',
      ]
    : ['  echo "WALG_AUDIT=skip:standby-write-guard"; exit 0'];
  return [
    'set -u',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion inside a shell script string, not a JS template placeholder
    'PFX="${WALG_S3_PREFIX:-}"',
    'case "$PFX" in "" | s3:///*) echo "WALG_AUDIT=skip:no-backup-target"; exit 0 ;; esac',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion inside a shell script string, not a JS template placeholder
    'if [ "${WALG_ROLE:-primary}" = "standby" ]; then',
    ...standbyBranch,
    'fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion inside a shell script string, not a JS template placeholder
    'if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ ! -s "${AWS_SHARED_CREDENTIALS_FILE:-/nonexistent}" ]; then',
    '  echo "WALG_AUDIT=fail:no-credentials"; echo "WALG_AUDIT_PREFIX=$PFX"; exit 0',
    'fi',
    'LIST="$(wal-g backup-list --json 2>&1)"',
    'RC=$?',
    `ARCHIVER="$(psql -U supabase_admin -d postgres -tAX -c "${WALG_ARCHIVER_SQL}" 2>/dev/null)"`,
    'echo "WALG_AUDIT=probed"',
    'echo "WALG_AUDIT_PREFIX=$PFX"',
    'echo "WALG_AUDIT_RC=$RC"',
    'echo "WALG_AUDIT_ARCHIVER=$ARCHIVER"',
    'echo "WALG_AUDIT_LIST_BEGIN"',
    'echo "$LIST"',
    'echo "WALG_AUDIT_LIST_END"',
    'exit 0',
  ].join('\n');
}

/** The deploy-time probe: a genuine standby skips cleanly. */
export const WALG_AUDIT_PROBE = buildWalgAuditProbe();

/**
 * wal-g's own "the prefix is empty" wording. Some wal-g builds exit non-zero
 * when `backup-list` finds nothing; that is the FRESH-ENVIRONMENT case, not a
 * broken one — the LIST call itself demonstrably reached the bucket in order to
 * discover it was empty. Genuinely broken storage never prints this; it prints
 * credential/connection/NoSuchBucket errors instead.
 */
export const WALG_EMPTY_STORAGE_RE = /no backups found|backup list is empty/i;

/** 3 attempts, ~20s worst case — mirrors the SSH transport retry budget. */
export const WALG_AUDIT_RETRY_DELAYS_MS = [5000, 15000];

/**
 * Per-attempt exec ceiling, shared by both deploy paths so neither can drift
 * into being unbounded. The probe is one S3 LIST plus a catalog read — seconds
 * — so this is a hang backstop (a wedged `docker compose exec` / `kubectl
 * exec`, an apiserver that stopped answering), not a working budget. Bounding
 * it is what turns a hang into a retryable failure the audit can report.
 */
export const WALG_AUDIT_PROBE_TIMEOUT_MS = 120_000;

/**
 * Human-readable "check this by hand" command per deploy path. Keyed by the
 * `path` a caller passes; unknown keys fall back to naming both.
 */
const VERIFY_HINTS = {
  compose: 'docker compose exec -T db wal-g backup-list',
  k8s: 'kubectl -n vibecarbon exec supabase-supabase-db-0 -- wal-g backup-list',
};

/** Keep operator-facing error bodies bounded without losing the useful tail. */
function tail(text, max = 400) {
  const s = String(text ?? '').trim();
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/**
 * Parse the probe's `KEY=value` stdout into a structured record. Pure.
 *
 * @param {string} raw Combined stdout of WALG_AUDIT_PROBE.
 * @returns {{outcome: 'skip'|'fail'|'probed'|'unreadable', reason: string, prefix: string,
 *   listStatus: number|null, listOutput: string, archiver: {archivedCount: number|null,
 *   failedCount: number|null, lastArchivedWal: string, lastFailedWal: string,
 *   lastArchivedTime: string, lastFailedTime: string, currentlyFailing: boolean,
 *   readable: boolean}}}
 */
export function parseWalgAuditOutput(raw) {
  const text = String(raw ?? '');
  const lines = text.split('\n').map((l) => l.trimEnd());
  const value = (key) => {
    const hit = lines.find((l) => l.startsWith(`${key}=`));
    return hit === undefined ? null : hit.slice(key.length + 1);
  };

  const marker = value('WALG_AUDIT');
  const archiverFields = (value('WALG_AUDIT_ARCHIVER') ?? '').split('|');
  const archiver = {
    archivedCount: archiverFields[0] ? Number(archiverFields[0]) : null,
    failedCount: archiverFields[1] ? Number(archiverFields[1]) : null,
    lastArchivedWal: archiverFields[2] ?? '',
    lastFailedWal: archiverFields[3] ?? '',
    lastArchivedTime: archiverFields[4] ?? '',
    lastFailedTime: archiverFields[5] ?? '',
    currentlyFailing: (archiverFields[6] ?? '').trim() === 't',
    // A 7-field row means psql answered. Anything else (empty string because
    // psql failed, or a truncated row) means "archiver state unknown", which is
    // never on its own a deploy failure.
    readable: archiverFields.length >= 7,
  };

  const begin = lines.indexOf('WALG_AUDIT_LIST_BEGIN');
  const end = lines.indexOf('WALG_AUDIT_LIST_END');
  const listOutput =
    begin >= 0 && end > begin
      ? lines
          .slice(begin + 1, end)
          .join('\n')
          .trim()
      : '';

  const rcRaw = value('WALG_AUDIT_RC');
  const listStatus = rcRaw !== null && rcRaw.trim() !== '' ? Number(rcRaw.trim()) : null;

  if (marker?.startsWith('skip:')) {
    return {
      outcome: 'skip',
      reason: marker.slice('skip:'.length),
      prefix: '',
      listStatus: null,
      listOutput: '',
      archiver,
    };
  }
  if (marker?.startsWith('fail:')) {
    return {
      outcome: 'fail',
      reason: marker.slice('fail:'.length),
      prefix: value('WALG_AUDIT_PREFIX') ?? '',
      // Only the requirePrimary standby branch emits this: `t` / `f` /
      // '' (psql unreachable). Used for the message, never for the verdict.
      recovery: (value('WALG_AUDIT_RECOVERY') ?? '').trim(),
      listStatus: null,
      listOutput: '',
      archiver,
    };
  }
  if (marker !== 'probed' || listStatus === null || Number.isNaN(listStatus)) {
    return {
      outcome: 'unreadable',
      reason: '',
      prefix: value('WALG_AUDIT_PREFIX') ?? '',
      listStatus,
      listOutput,
      archiver,
    };
  }
  return {
    outcome: 'probed',
    reason: '',
    prefix: value('WALG_AUDIT_PREFIX') ?? '',
    listStatus,
    listOutput,
    archiver,
  };
}

/**
 * Count base backups out of `wal-g backup-list --json` output for the success
 * line. The probe merges stderr into the capture (wal-g logs INFO lines there
 * and we want them in failure messages), so slice out the JSON array before
 * handing it to the shared parser. Returns null when no array is present —
 * reported as "unknown", never as a misleading 0.
 *
 * @param {string} listOutput
 * @returns {number|null}
 */
export function countWalgBackups(listOutput) {
  const text = String(listOutput ?? '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const arr = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(arr);
    if (!Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  return parseWalgBackupList(arr).length;
}

/**
 * Detail text for the probe's pre-flight `fail:` verdicts — the ones decided
 * from the container's own configuration, before wal-g is worth invoking.
 *
 * @param {{reason: string, prefix: string, recovery?: string}} parsed
 * @returns {string}
 */
function preflightFailureDetail(parsed) {
  if (parsed.reason === 'stale-standby-role') {
    // Only reachable under `requirePrimary`, i.e. from a failover that has
    // already promoted this node. Name the mechanism, because the symptom
    // (a healthy, serving database) gives nothing away.
    const shape =
      parsed.recovery === 't'
        ? `and pg_is_in_recovery() says it is STILL A REPLICA; the promotion did not take, so ` +
          `this node is neither archiving nor writable`
        : parsed.recovery === 'f'
          ? `while pg_is_in_recovery() confirms it is NOT in recovery; it really is the primary, ` +
            `running with the standby write-guard still latched`
          : `and pg_is_in_recovery() could not be read, so the promotion state is unconfirmed`;
    return (
      `the db container still has WALG_ROLE=standby ${shape}. WALG_ROLE is the wal-g ` +
      `WRITE-GUARD: while it reads standby, wal-archive.sh drops every WAL segment and the ` +
      `base-backup path no-ops, so this node archives NOTHING into ` +
      `${parsed.prefix || 'the configured prefix'} — the exact post-failover rot this audit ` +
      `exists to catch. Either the role re-render did not run, or it wrote the value without ` +
      `the container being recreated (env is fixed at container-create time)`
    );
  }
  return (
    `backups are CONFIGURED (${parsed.prefix || 'a backup prefix is set'}) but no ` +
    `object-storage credentials reached the db container: no AWS_ACCESS_KEY_ID in ` +
    `its environment and no readable AWS_SHARED_CREDENTIALS_FILE. wal-g cannot ` +
    `authenticate, so nothing will ever be archived`
  );
}

/**
 * Turn probe output into a verdict. PURE — this is the single decision point
 * shared by the compose and k8s call sites.
 *
 * @param {string} raw Combined stdout of WALG_AUDIT_PROBE.
 * @returns {{ok: boolean, skipped: boolean, reason: string, prefix: string,
 *   backupCount: number|null, failures: Array<{code: string, detail: string}>,
 *   notes: string[]}}
 */
export function evaluateWalgAudit(raw) {
  const parsed = parseWalgAuditOutput(raw);
  const base = {
    skipped: false,
    reason: parsed.reason,
    prefix: parsed.prefix,
    backupCount: null,
    failures: [],
    notes: [],
  };

  if (parsed.outcome === 'skip') {
    return { ...base, ok: true, skipped: true };
  }
  if (parsed.outcome === 'fail') {
    // Configured-but-broken, caught before wal-g is even worth invoking.
    return {
      ...base,
      ok: false,
      failures: [{ code: parsed.reason, detail: preflightFailureDetail(parsed) }],
    };
  }
  if (parsed.outcome === 'unreadable') {
    return {
      ...base,
      ok: false,
      failures: [
        {
          code: 'probe-unreadable',
          detail:
            'the audit probe produced no usable result; the db container did not run it to ' +
            `completion. Raw output: ${tail(raw) || '(empty)'}`,
        },
      ],
    };
  }

  const failures = [];
  const notes = [];

  const listReachedStorage =
    parsed.listStatus === 0 || WALG_EMPTY_STORAGE_RE.test(parsed.listOutput);
  if (!listReachedStorage) {
    failures.push({
      code: 'storage-unreachable',
      detail:
        `\`wal-g backup-list\` exited ${parsed.listStatus} against ` +
        `${parsed.prefix || '(no prefix reported)'} — wal-g cannot read the backup ` +
        `storage it is configured to write to. wal-g said: ${tail(parsed.listOutput) || '(no output)'}`,
    });
  }

  if (parsed.archiver.currentlyFailing) {
    failures.push({
      code: 'archive-command-failing',
      detail:
        `pg_stat_archiver reports the most recent archive attempt FAILED ` +
        `(last_failed_wal=${parsed.archiver.lastFailedWal || '?'} at ` +
        `${parsed.archiver.lastFailedTime || '?'}, failed_count=` +
        `${parsed.archiver.failedCount ?? '?'}). postgres could not even run ` +
        `archive_command to completion, so this is the wrapper script itself: check that ` +
        `/etc/postgresql/wal-archive.sh is mounted and readable in the db container`,
    });
  }

  const backupCount = countWalgBackups(parsed.listOutput);
  if (failures.length === 0) {
    if (backupCount === 0) {
      notes.push(
        'no base backups exist yet, expected on a new environment; the first one lands ' +
          'with the nightly backup job or `vibecarbon backup <env>`',
      );
    }
    if (!parsed.archiver.readable) {
      notes.push('pg_stat_archiver was unreadable, archiver state unknown (not fatal)');
    } else if (!parsed.archiver.lastArchivedTime) {
      notes.push(
        'no WAL archived yet, expected on a fresh cluster; storage is reachable so the ' +
          'first segment switch will archive',
      );
    }
  }

  return { ...base, ok: failures.length === 0, backupCount, failures, notes };
}

/**
 * Failure codes whose `detail` already names the cause AND the fix, so appending
 * the generic storage-credential differential would only bury it. `stale-standby-role`
 * is the case: it is not a storage problem at all.
 */
const SELF_EXPLANATORY_CODES = new Set(['stale-standby-role']);

/**
 * Build the operator-facing failure message. Mirrors rlsAuditFailureMessage:
 * name what failed, why it matters, the likely cause, and what to check.
 *
 * @param {{failures: Array<{code: string, detail: string}>, prefix?: string}} result
 * @param {'compose'|'k8s'} [path] Which exec seam to name in the hint.
 * @param {{context?: 'deploy'|'failover'}} [opts] Where this is being raised —
 *   only the framing changes: a deploy REFUSES to finish, a failover has already
 *   promoted and is instead reporting that it completed with dead backups.
 * @returns {string}
 */
export function walgAuditFailureMessage(result, path, { context = 'deploy' } = {}) {
  const failures = result?.failures ?? [];
  const findings = failures.map((f, i) => `(${i + 1}) ${f.detail}`).join(' ');
  const hint = VERIFY_HINTS[path] ?? Object.values(VERIFY_HINTS).join('  |  ');
  const causes =
    failures.length > 0 && failures.every((f) => SELF_EXPLANATORY_CODES.has(f.code))
      ? ''
      : `Likely causes, in order: wrong or expired object-storage credentials ` +
        `(S3_ACCESS_KEY / S3_SECRET_KEY); a bucket that does not exist, or the wrong ` +
        `endpoint/region for it (S3_BACKUP_BUCKET / S3_BUCKET, S3_ENDPOINT, S3_REGION); or ` +
        `blocked egress from the db container to object storage. Reproduce it directly with ` +
        `\`${hint}\`. `;
  const opening =
    context === 'failover'
      ? `BACKUPS: wal-g is NOT working in the promoted database container. It is serving ` +
        `traffic and accumulating ZERO recoverable backups.`
      : `BACKUPS: wal-g is NOT working in the database container. This deployment would come ` +
        `up healthy, serve traffic, and accumulate ZERO recoverable backups.`;
  const closing =
    context === 'failover'
      ? `Failing the failover command so this cannot be read as a clean success.`
      : `Refusing to finish a deploy whose backups do not work.`;
  return `${opening} ${findings} ${causes}${closing}`;
}

/**
 * Failure codes that cannot possibly clear on a retry — a missing env var or
 * unmounted credentials file is the same on attempt 3 as on attempt 1. Burning
 * the 20s budget on them only delays a certain failure.
 *
 * `stale-standby-role` belongs here for the same reason and one more: it is
 * raised mid-failover, where 20s of pointless backoff is 20s of RTO.
 */
const NON_RETRYABLE_CODES = new Set(['no-credentials', 'stale-standby-role']);

/** Success/skip one-liner, so a passing audit is visible rather than silent. */
function successLine(result) {
  if (result.skipped) {
    const why =
      {
        'no-backup-target': 'no backup bucket is configured',
        'standby-write-guard': 'this node is the wal-g standby (write-guarded by design)',
      }[result.reason] ?? result.reason;
    return `[walg-audit] skipped, ${why}.`;
  }
  const count =
    result.backupCount === null ? 'unknown' : `${result.backupCount} base backup(s) visible`;
  const notes = result.notes.length ? ` (${result.notes.join('; ')})` : '';
  return `[walg-audit] wal-g reached ${result.prefix || 'the configured prefix'} — ${count}${notes}.`;
}

/**
 * Run the audit through `probe` and THROW when wal-g isn't working.
 *
 * `probe` is the exec seam: an async function returning the probe's combined
 * stdout. Callers supply the one for their deploy path (docker compose exec /
 * kubectl exec) using the existing helpers, so this module never spawns
 * anything itself and unit tests can drive it with a plain function.
 *
 * Retry budget: 3 attempts with 5s then 15s backoff (~20s worst case),
 * deliberately identical to the SSH transport budget in lib/ssh.js. Both a
 * failed verdict and a failed exec are retried — an S3 5xx or a throttle clears
 * in seconds, while wrong credentials / a missing bucket / blocked egress fail
 * identically on all three attempts. So the budget buys flake-immunity for ~20s
 * of cost on a genuinely broken deploy, which is the right trade for a check
 * whose whole point is refusing to ship. The one exception is a verdict that
 * provably cannot change (NON_RETRYABLE_CODES) — that fails on the first
 * attempt.
 *
 * @param {object} args
 * @param {() => Promise<string>} args.probe
 * @param {'compose'|'k8s'} args.path
 * @param {'deploy'|'failover'} [args.context] Framing for the failure message.
 * @returns {Promise<{ok: boolean, skipped: boolean}>} the passing/skipped verdict
 */
export async function assertWalgBackupsWorking({ probe, path, context = 'deploy' }) {
  let lastResult = null;
  let lastError = null;
  try {
    return await runWithRetry(
      async () => {
        lastError = null;
        const raw = await probe();
        lastResult = evaluateWalgAudit(raw);
        if (!lastResult.ok) {
          const failure = new Error(walgAuditFailureMessage(lastResult, path, { context }));
          failure.walgRetryable = !lastResult.failures.every((f) =>
            NON_RETRYABLE_CODES.has(f.code),
          );
          throw failure;
        }
        progressLog(successLine(lastResult));
        return lastResult;
      },
      {
        delaysMs: WALG_AUDIT_RETRY_DELAYS_MS,
        isTransient: (err) => err?.walgRetryable !== false,
        onRetry: (err, attempt) => {
          lastError = err;
          progressLog(
            `[walg-audit] attempt ${attempt}/${WALG_AUDIT_RETRY_DELAYS_MS.length + 1} failed, ` +
              `retrying in ${WALG_AUDIT_RETRY_DELAYS_MS[attempt - 1] / 1000}s, ` +
              `${String(err?.message ?? err)
                .split('\n')[0]
                .slice(0, 160)}`,
          );
        },
      },
    );
  } catch (err) {
    // A verdict failure already carries the full operator message; an exec
    // failure (container unreachable, kubectl/ssh error) does not, so wrap it
    // in the same shape rather than letting a bare transport error escape.
    if (lastResult && !lastResult.ok) throw err;
    throw new Error(
      walgAuditFailureMessage(
        {
          failures: [
            {
              code: 'probe-exec-failed',
              detail:
                `the backup audit could not be executed inside the db container: ` +
                `${tail(err?.message ?? lastError?.message ?? err)}`,
            },
          ],
        },
        path,
        { context },
      ),
    );
  }
}

/**
 * Single-line shell snippet that runs the probe via `docker compose exec db`.
 * Embedded into the compose migration step's SSH command, exactly as
 * composeRlsAuditShell is. The caller prefixes `cd <remoteDir> && `.
 *
 * The probe is wrapped in ONE single-quoted word, which is why
 * buildWalgAuditProbe must not emit a single quote in either mode.
 *
 * @param {{requirePrimary?: boolean}} [opts]
 * @returns {string}
 */
export function composeWalgAuditShell(opts = {}) {
  return `docker compose exec -T db bash -c '${buildWalgAuditProbe(opts)}'`;
}

/**
 * kubectl argv (without the leading `kubectl`) that runs the probe in the
 * supabase-db pod. Same probe, same evaluator — only the exec seam differs.
 *
 * @param {string} [dbPod]
 * @param {{requirePrimary?: boolean}} [opts]
 * @returns {string[]}
 */
export function k8sWalgAuditArgv(dbPod = 'supabase-supabase-db-0', opts = {}) {
  return ['-n', 'vibecarbon', 'exec', dbPod, '--', 'bash', '-c', buildWalgAuditProbe(opts)];
}
