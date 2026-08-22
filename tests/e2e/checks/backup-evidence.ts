/**
 * Backup-evidence check — assert a backup object ACTUALLY LANDS in S3.
 *
 * This is the e2e half of the class-3 "silent success" countermeasure in
 * docs/tests.md ("success must cite evidence"). Everything upstream of it
 * proves *capability*, never *effect*:
 *
 *   - `carbon/db/Dockerfile` proves the wal-g BINARY runs (executed in the
 *     same build layer, pinned by walg-dockerfile-arch.test.ts).
 *   - `src/lib/deploy/walg-audit.js` proves wal-g can REACH the bucket — but
 *     its own docblock is explicit that an EMPTY `backup-list` is a PASS, so
 *     a prefix that never receives a single object still audits green.
 *   - `pg_stat_archiver` is *structurally blind* here: `wal-archive.sh`
 *     deliberately exits 0 on push failure (a non-zero archive_command pins
 *     pg_wal and fills the disk — RCA prod-1 2026-05-26), so Postgres counts
 *     every dropped segment as archived and `failed_count` stays 0.
 *
 * The gap that leaves is the one that matters to a customer: a database that
 * is healthy, serving traffic, green on every check, and accumulating ZERO
 * recoverable backups. Nothing in the repo asserted an object exists.
 *
 * HOW IT ASSERTS EFFECT
 * ---------------------
 * Provoke, then observe from OUTSIDE the box:
 *
 *   1. Inside the db container/pod, force a WAL boundary —
 *      `SELECT txid_current()` (guarantees a WAL record exists, so the switch
 *      cannot degrade into a no-op on an idle cluster) followed by
 *      `SELECT pg_walfile_name(pg_switch_wal())`, which names the segment
 *      Postgres just CLOSED and handed to `archive_command`.
 *   2. From the runner, LIST the backup bucket for that exact segment key.
 *
 * Naming the segment is what makes this a real assertion rather than a
 * freshness heuristic: no clock-skew comparison, no "some object looks
 * recent", no dependence on `LastModified` semantics that differ between
 * Hetzner Object Storage and DO Spaces. Either the segment Postgres just
 * closed is in the bucket, or the archive path is dropping data on the floor.
 *
 * WHY WE FORCE THE SWITCH RATHER THAN WAITING
 * -------------------------------------------
 * `archive_timeout=900` (carbon/docker-compose.yml, k3s.js's ALTER SYSTEM), so
 * an unprovoked check would have to wait up to 15 minutes for evidence, or
 * accept a flaky "maybe a segment filled" race. walg-audit rejected forcing a
 * switch *on the deploy path* because it costs a segment on every deploy and
 * proves nothing `backup-list` hasn't; in a test that runs twice per scenario
 * the trade flips — a bounded ~30s assertion of the one thing nothing else can
 * see is worth two 16 MiB segments.
 *
 * Nothing here is a test-only backdoor: an operator can run the same two
 * statements and the same `ListObjectsV2` against their own bucket. That is
 * the e2e-mirrors-the-customer rule (docs/tests.md), and it makes this check
 * double as the runbook for "are my backups actually working?".
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION
 * ---------------------------------
 * Bucket/region/endpoint come from the project's own `.vibecarbon.json`
 * (`environments.<env>.backupS3`, written by the deploy orchestrator), and the
 * S3 client is the PRODUCT's `getObjectStorageProvider(providerId, ...)` — so
 * Hetzner Object Storage and DO Spaces are covered by the same code path with
 * no endpoint templates duplicated into test code. Credentials are read
 * through `Provider.OBJECT_STORAGE_ENV`, so `d1`/`d2`/`d3` pick up
 * `DIGITALOCEAN_ACCESS_KEY` / `_SECRET_KEY` without a branch here.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getObjectStorageProvider, getProviderClass } from '../../../src/lib/providers/index.js';
import type { VerificationResult } from '../scenarios/types.js';
import { e2eSshOpts } from '../utils/ssh.js';

/**
 * The slice of `S3CompatibleProvider` this check uses. The JS module's inferred
 * type is `object`, so name the one method we call rather than casting to
 * `any` — a rename upstream then breaks the build here instead of at runtime,
 * 40 minutes into an e2e run.
 */
interface PrefixProbeCapableS3 {
  hasObjectsWithPrefix(bucketName: string, prefix: string): Promise<boolean>;
}

/**
 * wal-g v3.0.x layout under the configured `WALG_S3_PREFIX`. `basebackups_005/`
 * is the one subdir spelled anywhere in the repo (quoted verbatim in
 * src/lib/deploy/walg-staleness.js's real-world error); `wal_005/` is wal-g's
 * own convention for the WAL archive and is not otherwise pinned — which is
 * itself a reason to assert it live rather than trust it.
 */
export const WALG_WAL_SUBDIR = 'wal_005/';
export const WALG_BASEBACKUP_SUBDIR = 'basebackups_005/';

/**
 * The canonical, SINGLE prefix both roles share. There is deliberately NO role
 * segment: a `primary/` vs `standby/` split would let a promoted node read an
 * empty prefix and fail restore with "No backups found" (the anti-collision
 * reasoning in carbon/docker-compose.yml, and the rot #218 fixed). We assert
 * that invariant against live S3 below.
 */
export function walgPrefixFor(projectName: string): string {
  return `backups/${projectName}/walg/`;
}

/** Object key (prefix form) of one archived WAL segment. */
export function walSegmentKeyPrefix(projectName: string, segment: string): string {
  return `${walgPrefixFor(projectName)}${WALG_WAL_SUBDIR}${segment}`;
}

/**
 * Role-namespaced prefixes that must NEVER contain objects. If wal-g ever
 * starts writing under one of these, restore/failover silently reads an empty
 * prefix — the failure shape is "backups look fine until you need them".
 */
export const FORBIDDEN_ROLE_PREFIXES = ['primary/', 'standby/'] as const;

/** How long to wait for the archiver to push the closed segment to S3. */
export const WAL_EVIDENCE_BUDGET_MS = 120_000;
/** Poll interval while waiting. Also absorbs Hetzner's read-after-write lag. */
export const WAL_EVIDENCE_INTERVAL_MS = 5_000;

export interface BackupS3Target {
  bucket: string;
  region: string;
  endpoint?: string;
}

/**
 * Read `environments.<env>.backupS3` out of the project's `.vibecarbon.json`.
 * That block is written by the deploy orchestrator and is the same record
 * `destroy`/`backup` read, so the check can never drift onto a different
 * bucket than the product uses. Credentials are deliberately NOT persisted
 * there — they come from the environment (see `resolveObjectStorageCreds`).
 *
 * Pure fs-in/value-out so the resolution matrix is unit-testable.
 */
export function resolveBackupS3Target(
  projectDir: string,
  envPrefix: string,
): BackupS3Target | null {
  try {
    const configPath = join(projectDir, '.vibecarbon.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      environments?: Record<string, { backupS3?: Partial<BackupS3Target> }>;
    };
    const backupS3 = config.environments?.[envPrefix]?.backupS3;
    if (!backupS3?.bucket || !backupS3.region) return null;
    return { bucket: backupS3.bucket, region: backupS3.region, endpoint: backupS3.endpoint };
  } catch {
    return null;
  }
}

/**
 * Resolve the object-storage credentials for a provider from the environment,
 * via the provider's own `OBJECT_STORAGE_ENV` pair. Keeps DO's
 * `DIGITALOCEAN_ACCESS_KEY`/`_SECRET_KEY` and Hetzner's `HETZNER_ACCESS_KEY`/
 * `HETZNER_SECRET_KEY` on one code path — adding a third provider needs no edit here.
 *
 * @returns the pair, or the names of whatever is missing.
 */
export function resolveObjectStorageCreds(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): { accessKey: string; secretKey: string } | { missing: string[] } {
  const ProviderClass = getProviderClass(providerId) as { OBJECT_STORAGE_ENV?: string[] };
  const [accessEnv, secretEnv] = ProviderClass.OBJECT_STORAGE_ENV ?? [];
  if (!accessEnv || !secretEnv) return { missing: [`${providerId}.OBJECT_STORAGE_ENV`] };
  const missing = [accessEnv, secretEnv].filter((k) => !env[k]);
  if (missing.length > 0) return { missing };
  return { accessKey: env[accessEnv] as string, secretKey: env[secretEnv] as string };
}

/**
 * Shell probe executed INSIDE the db container/pod. Reports `KEY=value` lines
 * and always exits 0, so the VERDICT lives in TypeScript (one evaluator, same
 * message on both exec paths) rather than in shell — the same split
 * buildWalgAuditProbe uses, for the same reason.
 *
 * INVARIANT: contains no single quote in any branch. It is passed as one
 * single-quoted word through `bash -c '<probe>'` on both paths; a stray `'`
 * would split the command. Pinned by a unit test.
 *
 * Guard order mirrors walg-audit's, and for the same reasons:
 *   1. No prefix (or the `s3:///…` empty-bucket form both paths render when no
 *      bucket is configured) → backups are deliberately OFF → skip.
 *   2. A standby must never be provoked — its writes are guarded off by
 *      design. Callers only ever run this against the node they have already
 *      resolved as the PRIMARY, so a standby answer here is the stale-role rot
 *      #218 fixed, and is reported as a failure rather than a skip.
 *   3. `txid_current()` before the switch: on an idle cluster `pg_switch_wal()`
 *      returns the current position WITHOUT switching, and we would then wait
 *      120s for a segment that was never closed. Forcing an XID guarantees a
 *      WAL record exists, so the switch always closes a real segment.
 */
export function buildWalSwitchProbe(): string {
  return [
    'set -u',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS placeholder
    'PFX="${WALG_S3_PREFIX:-}"',
    'case "$PFX" in "" | s3:///*) echo "WAL_SWITCH=skip:no-backup-target"; exit 0 ;; esac',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS placeholder
    'if [ "${WALG_ROLE:-primary}" = "standby" ]; then',
    '  echo "WAL_SWITCH=fail:standby-role"; echo "WAL_SWITCH_PREFIX=$PFX"; exit 0',
    'fi',
    'REC="$(psql -U supabase_admin -d postgres -tAXc "SELECT pg_is_in_recovery()" 2>/dev/null | tr -d "[:space:]")"',
    'if [ "$REC" = "t" ]; then',
    '  echo "WAL_SWITCH=fail:in-recovery"; echo "WAL_SWITCH_PREFIX=$PFX"; exit 0',
    'fi',
    // -tAX: tuples-only, unaligned, no .psqlrc. Two -c statements run in one
    // session, in order; `tr -d "[:blank:]"` strips padding but KEEPS newlines
    // (a [:space:] class would fold both answers onto one line), and the last
    // non-empty line is the walfile name.
    'SEG="$(psql -U supabase_admin -d postgres -tAX -c "SELECT txid_current()" -c "SELECT pg_walfile_name(pg_switch_wal())" 2>/dev/null | tr -d "[:blank:]" | grep -v "^$" | tail -1)"',
    'if [ -z "$SEG" ]; then',
    '  echo "WAL_SWITCH=fail:switch-returned-nothing"; echo "WAL_SWITCH_PREFIX=$PFX"; exit 0',
    'fi',
    'echo "WAL_SWITCH=switched"',
    'echo "WAL_SWITCH_PREFIX=$PFX"',
    'echo "WAL_SWITCH_SEGMENT=$SEG"',
    'exit 0',
  ].join('\n');
}

export type WalSwitchStatus =
  | 'switched'
  | 'skip:no-backup-target'
  | 'fail:standby-role'
  | 'fail:in-recovery'
  | 'fail:switch-returned-nothing'
  | 'unparsed';

export interface WalSwitchResult {
  status: WalSwitchStatus;
  prefix?: string;
  segment?: string;
}

const KNOWN_STATUSES: WalSwitchStatus[] = [
  'switched',
  'skip:no-backup-target',
  'fail:standby-role',
  'fail:in-recovery',
  'fail:switch-returned-nothing',
];

/**
 * Parse the probe's `KEY=value` lines. Pure — the whole verdict matrix is
 * unit-tested without a cluster. Unknown/garbled output becomes `unparsed`
 * rather than silently reading as a pass.
 */
export function parseWalSwitchOutput(raw: string): WalSwitchResult {
  const out: WalSwitchResult = { status: 'unparsed' };
  for (const line of (raw ?? '').split('\n')) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === 'WAL_SWITCH') {
      const match = KNOWN_STATUSES.find((s) => s === value);
      if (match) out.status = match;
    } else if (key === 'WAL_SWITCH_PREFIX') {
      out.prefix = value;
    } else if (key === 'WAL_SWITCH_SEGMENT') {
      out.segment = value;
    }
  }
  return out;
}

/**
 * Remote command that runs the probe in the db container (compose) or the
 * supabase-db pod (k8s). Same probe, same evaluator — only the exec seam
 * differs, mirroring walg-audit's composeWalgAuditShell / k8sWalgAuditArgv
 * split. Exported for the unit test that pins the single-quote invariant.
 *
 * KUBECONFIG is set explicitly on the k8s path: the same form replication.ts
 * uses, so the command works regardless of root's default kubeconfig resolution.
 */
export function buildWalSwitchRemoteCommand(projectName: string, isCompose: boolean): string {
  const probe = buildWalSwitchProbe();
  if (isCompose) {
    return `cd /opt/${projectName} && docker compose exec -T db bash -c '${probe}'`;
  }
  return (
    'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n vibecarbon exec ' +
    `supabase-supabase-db-0 -- bash -c '${probe}'`
  );
}

function ssh(ip: string, sshKeyPath: string, cmd: string): string {
  // SECURITY: all arguments come from trusted test config, never user input.
  // e2eSshOpts carries BatchMode=yes (a password fallback would hang the step
  // for the full timeout instead of failing fast).
  return execFileSync('ssh', [...e2eSshOpts(10), '-i', sshKeyPath, `root@${ip}`, cmd], {
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: 'pipe',
  }).trim();
}

function timer() {
  const start = process.hrtime.bigint();
  return () => Number((process.hrtime.bigint() - start) / 1_000_000n);
}

export interface BackupEvidenceOptions {
  /** The node to provoke from — MUST already be resolved to the HA primary. */
  masterIp: string | undefined;
  sshKeyPath: string | undefined;
  projectDir: string;
  projectName: string;
  envPrefix: string;
  isCompose: boolean;
  /** Scenario provider; undefined means hetzner (same default as everywhere). */
  provider?: string;
  /** Which lifecycle phase invoked us — recorded in details for triage. */
  phase: string;
  /** Seam for unit tests; defaults to the real SSH exec. */
  execRemote?: (ip: string, keyPath: string, cmd: string) => string;
  /** Seam for unit tests; defaults to the real S3 prefix probe. */
  probePrefix?: (prefix: string) => Promise<boolean>;
  budgetMs?: number;
  intervalMs?: number;
}

/**
 * Two assertions, both non-vacuous:
 *
 *  - `backup_walg_wal_archived` — the segment Postgres just closed is in the
 *    bucket. This is the one nothing else in the repo can see.
 *  - `backup_walg_canonical_prefix` — nothing lives under a role-namespaced
 *    prefix. Cheap (two LISTs) and it pins, against live storage, the
 *    single-prefix invariant that restore and failover both depend on.
 */
export async function runBackupEvidenceChecks(
  opts: BackupEvidenceOptions,
): Promise<VerificationResult[]> {
  const {
    masterIp,
    sshKeyPath,
    projectDir,
    projectName,
    envPrefix,
    isCompose,
    phase,
    execRemote = ssh,
    budgetMs = WAL_EVIDENCE_BUDGET_MS,
    intervalMs = WAL_EVIDENCE_INTERVAL_MS,
  } = opts;
  const providerId = opts.provider ?? 'hetzner';
  const elapsed = timer();
  const mode = isCompose ? 'compose' : 'k8s';

  const fail = (checkName: string, errorMessage: string, details?: Record<string, unknown>) => ({
    checkName,
    status: 'fail' as const,
    responseTimeMs: elapsed(),
    errorMessage,
    details: { mode, phase, ...details },
  });
  const pass = (checkName: string, details?: Record<string, unknown>) => ({
    checkName,
    status: 'pass' as const,
    responseTimeMs: elapsed(),
    details: { mode, phase, ...details },
  });
  // Precondition missing (no SSH handle, no backup target configured, backups
  // off, or an upstream probe that never switched) — a skip, NEVER a green
  // pass. The env carrying a bucket but lacking creds is a FAILURE, not a skip
  // (handled below); a skip is only for "this environment legitimately has
  // nothing to assert here".
  const skip = (checkName: string, details?: Record<string, unknown>) => ({
    checkName,
    status: 'skip' as const,
    responseTimeMs: elapsed(),
    details: { mode, phase, ...details },
  });

  const missingHandle = !masterIp
    ? sshKeyPath
      ? 'no serverIp (sshKeyPath present)'
      : 'no serverIp and no sshKeyPath'
    : 'no sshKeyPath (serverIp present)';
  if (!masterIp || !sshKeyPath) {
    // Consistent with the other SSH-based checks: no handle in, no verdict out.
    return [
      // Names WHICH handle is missing — see config-canary.ts for why the
      // combined wording cost a diagnostic cycle.
      skip('backup_walg_wal_archived', { skipped: missingHandle }),
      skip('backup_walg_canonical_prefix', { skipped: missingHandle }),
    ];
  }

  const target = resolveBackupS3Target(projectDir, envPrefix);
  if (!target) {
    // No `backupS3` block means the deploy never configured a backup bucket.
    // That is a legitimate shape (backups can be off), and the in-container
    // probe reports the same thing from the other side.
    return [
      skip('backup_walg_wal_archived', { skipped: 'no backupS3 in .vibecarbon.json' }),
      skip('backup_walg_canonical_prefix', { skipped: 'no backupS3 in .vibecarbon.json' }),
    ];
  }

  // --- 1. Provoke a WAL boundary on the primary --------------------------
  // Deliberately BEFORE the credential gate: the container is the authority on
  // whether backups are configured at all (it reads the live WALG_S3_PREFIX),
  // and an environment with backups switched off must not be failed for
  // missing runner credentials it has no use for.
  let probeRaw: string;
  try {
    probeRaw = execRemote(
      masterIp,
      sshKeyPath,
      buildWalSwitchRemoteCommand(projectName, isCompose),
    );
  } catch (err) {
    return [
      fail(
        'backup_walg_wal_archived',
        `Could not run the WAL-switch probe on ${masterIp}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        { bucket: target.bucket },
      ),
      skip('backup_walg_canonical_prefix', { skipped: 'probe unreachable' }),
    ];
  }

  const probe = parseWalSwitchOutput(probeRaw);
  if (probe.status === 'skip:no-backup-target') {
    return [
      skip('backup_walg_wal_archived', { skipped: 'WALG_S3_PREFIX empty (backups off)' }),
      skip('backup_walg_canonical_prefix', { skipped: 'WALG_S3_PREFIX empty (backups off)' }),
    ];
  }
  if (probe.status !== 'switched' || !probe.segment) {
    const why =
      probe.status === 'fail:standby-role'
        ? 'the node resolved as PRIMARY still carries WALG_ROLE=standby — its archive path is write-guarded off, so nothing is being backed up (the rot #218 fixed)'
        : probe.status === 'fail:in-recovery'
          ? 'the node resolved as PRIMARY is still in recovery — it cannot archive WAL'
          : probe.status === 'fail:switch-returned-nothing'
            ? 'pg_switch_wal() returned no segment name (psql unreachable inside the container?)'
            : `unrecognized probe output: ${probeRaw.slice(0, 300)}`;
    return [
      fail('backup_walg_wal_archived', `WAL-switch probe did not close a segment — ${why}`, {
        probeStatus: probe.status,
        walgPrefix: probe.prefix,
      }),
      skip('backup_walg_canonical_prefix', { skipped: 'probe did not switch' }),
    ];
  }

  // --- 2. Observe the closed segment landing in S3 -----------------------
  // Credentials are resolved only now that the container has confirmed backups
  // ARE configured. Missing keys at this point are deliberately a FAILURE, not
  // a skip: the environment records a bucket, so the deploy intended backups,
  // and a runner that silently cannot read the bucket would turn this whole
  // guard vacuous exactly when it matters most.
  let probePrefix = opts.probePrefix;
  if (!probePrefix) {
    const creds = resolveObjectStorageCreds(providerId);
    if ('missing' in creds) {
      const why =
        `Cannot verify backups: ${creds.missing.join(' and ')} not set for provider ${providerId}, ` +
        `but ${envPrefix} records backup bucket ${target.bucket}.`;
      return [
        fail('backup_walg_wal_archived', why, { bucket: target.bucket, providerId }),
        fail('backup_walg_canonical_prefix', why, { bucket: target.bucket, providerId }),
      ];
    }
    // The PRODUCT's S3 client — retry ladder, explicit socket timeouts and
    // path-style addressing all come along, and both providers resolve through
    // the same call, so no endpoint template is duplicated into test code.
    const s3 = (await getObjectStorageProvider(
      providerId,
      creds.accessKey,
      creds.secretKey,
      target.region,
    )) as PrefixProbeCapableS3;
    probePrefix = (prefix: string) => s3.hasObjectsWithPrefix(target.bucket, prefix);
  }

  const segmentPrefix = walSegmentKeyPrefix(projectName, probe.segment);
  const deadline = Date.now() + budgetMs;
  let landed = false;
  let lastError: string | undefined;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      // Prefix probe (not an exact key): wal-g appends its compression
      // extension (.lz4 here) and could add others without this breaking.
      landed = await probePrefix(segmentPrefix);
      lastError = undefined;
    } catch (err) {
      // Hetzner Object Storage serves read-after-write 404s / NoSuchBucket
      // against a just-written prefix (RCA #223) — that is what this poll
      // absorbs, so a transient answer must not end the loop.
      lastError = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }
    if (landed) break;
    if (Date.now() + intervalMs >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const results: VerificationResult[] = [];
  const evidenceDetails = {
    bucket: target.bucket,
    region: target.region,
    segment: probe.segment,
    key: segmentPrefix,
    walgPrefix: probe.prefix,
    attempts,
  };
  if (landed) {
    results.push(pass('backup_walg_wal_archived', evidenceDetails));
  } else {
    results.push(
      fail(
        'backup_walg_wal_archived',
        `Postgres closed WAL segment ${probe.segment} but no object appeared under ` +
          `s3://${target.bucket}/${segmentPrefix} within ${Math.round(budgetMs / 1000)}s. ` +
          'The archive path is dropping WAL: wal-archive.sh exits 0 on push failure by design, ' +
          'so postgres and pg_stat_archiver both report success while nothing is recoverable. ' +
          `Check wal-g credentials/endpoint for ${target.bucket}.` +
          (lastError ? ` Last S3 error: ${lastError}` : ''),
        evidenceDetails,
      ),
    );
  }

  // --- 3. Nothing may live under a role-namespaced prefix ----------------
  const base = walgPrefixFor(projectName);
  const offenders: string[] = [];
  let roleProbeError: string | undefined;
  for (const role of FORBIDDEN_ROLE_PREFIXES) {
    try {
      if (await probePrefix(`${base}${role}`)) offenders.push(`${base}${role}`);
    } catch (err) {
      roleProbeError = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }
  }
  if (offenders.length > 0) {
    results.push(
      fail(
        'backup_walg_canonical_prefix',
        `Objects found under role-namespaced prefixes (${offenders.join(', ')}). wal-g must write ` +
          'to ONE canonical prefix for both roles — a split prefix makes a promoted standby read ' +
          'an empty folder and fail restore with "No backups found".',
        { bucket: target.bucket, offenders },
      ),
    );
  } else if (roleProbeError) {
    results.push(
      fail('backup_walg_canonical_prefix', `Could not probe role prefixes: ${roleProbeError}`, {
        bucket: target.bucket,
      }),
    );
  } else {
    results.push(pass('backup_walg_canonical_prefix', { bucket: target.bucket, base }));
  }

  return results;
}
