/**
 * Independent replication verification for HA deploy modes (compose-ha, k8s-ha).
 *
 * The deploy CLI already probes streaming replication and exits non-zero when
 * it can't establish it — but a green e2e run that trusts that exit code proves
 * nothing on its own. These checks reach the databases directly, over SSH, and
 * assert the replication invariants from the OUTSIDE:
 *
 *   - replication_streaming     — primary's pg_stat_replication has a row in
 *                                 state='streaming' AND the standby reports
 *                                 pg_is_in_recovery() = t.
 *   - replication_data_propagation — a probe row INSERTed on the primary shows
 *                                 up on the standby within a budget (proves the
 *                                 WAL stream actually carries data, not just a
 *                                 walsender handshake).
 *
 * Plus a failover continuity assertion (see runFailoverContinuityCheck): a
 * marker row written on the OLD primary right before `vibecarbon failover` must
 * survive onto the PROMOTED (new) primary.
 *
 * Mode anatomy (how we reach postgres per mode):
 *   compose-ha: postgres is the `db` compose service on each VPS. We SSH to the
 *     VPS and `docker compose exec -T db psql -U supabase_admin`.
 *   k8s-ha:     postgres is pod supabase-supabase-db-0 (ns vibecarbon) on each
 *     cluster. We SSH to that cluster's MASTER node (k3s API server) and
 *     `kubectl exec ... -- psql -U supabase_admin`. The standby postgres is a
 *     streaming replica, so read-only queries against it are safe.
 *
 * All SSH command strings are built from trusted test config + a sanitized
 * marker id (buildMarkerId strips everything outside [A-Za-z0-9-]), so the
 * single-quoted SQL literal can never break out. Every function fails soft on
 * an SSH/exec error — the check reports fail with a diagnostic, it never throws.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployMode, VerificationResult } from '../scenarios/types.js';
import { e2eSshOpts } from '../utils/ssh.js';
import {
  isSshConnectTimeout,
  noteSshConnectTimeout,
  sshUnreachableDiagnosis,
  sshUnreachableSince,
} from '../utils/ssh-reachability.js';

/**
 * Stable probe/marker table. Prefixed with `_e2e_` and never referenced by any
 * migration or application code, so our DDL/DML can only ever touch our own
 * table — user tables are never in scope. It lives in `public` like any
 * customer table, so it must satisfy the deploy-time RLS audit
 * (src/lib/deploy/rls-audit.js) exactly like one would: every CREATE enables
 * RLS in the same statement batch (buildCreateMarkerSql), and every check
 * that creates it drops it again in a finally block (buildDropProbeTableSql)
 * so no unprotected residue survives into the next deploy's migrate step.
 */
export const REPL_PROBE_TABLE = '_e2e_repl_probe';

/**
 * Fully-qualified probe table name used in every SQL statement below.
 * Explicit `public.` schema qualification (rather than relying on
 * search_path) keeps the DDL/DML unambiguous — `public` is exactly the
 * schema the RLS audit scans.
 */
const QUALIFIED_PROBE_TABLE = `public.${REPL_PROBE_TABLE}`;

/**
 * SQL batch that creates the probe table (if absent), enables row-level
 * security on it, and inserts the marker row — in that order, in ONE
 * statement batch. Belt #1 against the deploy-time RLS audit
 * (src/lib/deploy/rls-audit.js), which fails any warm-deploy/restore/
 * reconverge that finds a public table with RLS disabled. supabase_admin is
 * a postgres SUPERUSER (carbon/volumes/db/roles.sql), and superusers always
 * bypass RLS regardless of table ownership or FORCE ROW LEVEL SECURITY — so
 * enabling RLS here never blocks the probe's own reads/writes, which all run
 * as supabase_admin.
 */
export function buildCreateMarkerSql(markerId: string): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${QUALIFIED_PROBE_TABLE} (id text primary key, ts timestamptz default now()); ` +
    `ALTER TABLE ${QUALIFIED_PROBE_TABLE} ENABLE ROW LEVEL SECURITY; ` +
    `INSERT INTO ${QUALIFIED_PROBE_TABLE} (id) VALUES ('${markerId}') ON CONFLICT DO NOTHING;`
  );
}

/**
 * SQL that drops the probe table outright (not just a row). Belt #2 against
 * the RLS audit: even if the ENABLE ROW LEVEL SECURITY above were ever
 * skipped, a table that doesn't exist can't fail "public tables without
 * RLS". Every check that creates the probe table issues this in a
 * try/finally, on BOTH the pass and fail path, so no residue survives into
 * the next deploy's migrate step regardless of how the check turned out.
 */
export function buildDropProbeTableSql(): string {
  return `DROP TABLE IF EXISTS ${QUALIFIED_PROBE_TABLE};`;
}

const SSH_OPTS = e2eSshOpts(10);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested — no SSH round-trips)
// ---------------------------------------------------------------------------

/**
 * Assemble a stable, SQL-safe marker/probe id from the run id, step name and a
 * timestamp. Every component is stripped to [A-Za-z0-9] so the assembled id
 * contains only [A-Za-z0-9-] — it can be dropped into a single-quoted SQL
 * literal with zero injection surface, and is a valid text primary key.
 */
export function buildMarkerId(runId: string, step: string, ts: number): string {
  const clean = (s: string): string =>
    String(s)
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 40);
  return `e2e-${clean(runId)}-${clean(step)}-${Math.trunc(ts)}`;
}

/**
 * Build the remote shell command that runs `sql` in the primary/standby
 * postgres for the given mode. `sql` MUST be single-line and contain no double
 * quotes (we wrap it in "…" for psql -c). Marker ids are sanitized upstream.
 */
export function buildPsqlCommand(mode: DeployMode, projectName: string, sql: string): string {
  if (mode.startsWith('compose')) {
    return `cd /opt/${projectName} && docker compose exec -T db psql -U supabase_admin -d postgres -tAc "${sql}"`;
  }
  // k8s / k8s-ha: exec into the supabase-db pod from the master node.
  return (
    `KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl exec -n vibecarbon supabase-supabase-db-0 ` +
    `-- psql -U supabase_admin -d postgres -tAc "${sql}"`
  );
}

/**
 * Build the command that dumps the primary postgres log tail filtered for
 * replication / pg_hba lines — the diagnostic we otherwise capture by hand
 * every time a replication check fails.
 */
export function buildLogDiagCommand(mode: DeployMode, projectName: string): string {
  const filter = `grep -iE 'replication|pg_hba|walsender|wal sender|standby|streaming|authentication' | tail -20`;
  if (mode.startsWith('compose')) {
    return `cd /opt/${projectName} && docker compose logs --no-color --tail=400 db 2>&1 | ${filter}`;
  }
  return (
    `KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl logs -n vibecarbon supabase-supabase-db-0 ` +
    `--tail=400 2>&1 | ${filter}`
  );
}

/**
 * Classify a `SELECT pg_is_in_recovery()` result. psql -tA emits `t` / `f`.
 * Returns null when the output is empty/unparseable (SSH failure, pod down).
 */
export function parseIsInRecovery(output: string | null | undefined): boolean | null {
  if (output == null) return null;
  const v = output.trim().toLowerCase();
  if (v === 't' || v === 'true') return true;
  if (v === 'f' || v === 'false') return false;
  return null;
}

/**
 * Parse the `SELECT state FROM pg_stat_replication` output into the list of
 * non-empty state strings (one row per streaming/catching-up standby).
 */
export function parseReplicationStates(output: string | null | undefined): string[] {
  if (!output) return [];
  return output
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);
}

/** True when at least one pg_stat_replication row is in state 'streaming'. */
export function hasStreamingState(states: string[]): boolean {
  return states.includes('streaming');
}

/**
 * Extract source IPs from pg_hba "no entry"/reject log lines so a failure
 * message names the address postgres refused (the fix is almost always a
 * missing pg_hba/firewall entry for that IP). Matches both the quoted-host
 * form (`no pg_hba.conf entry for host "10.0.1.5"`) and the bare form.
 */
export function extractPgHbaRejectIps(logText: string | null | undefined): string[] {
  if (!logText) return [];
  const ips = new Set<string>();
  const re = /pg_hba\.conf entry for host\s+"?([0-9a-fA-F:.]+)"?/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(logText)) !== null) {
    ips.add(m[1]);
  }
  return [...ips];
}

// ---------------------------------------------------------------------------
// HA db-IP resolution (mirrors src/failover.js identifyServers)
// ---------------------------------------------------------------------------

interface RawEnvConfig {
  region?: string;
  secondaryRegion?: string;
  servers?: Array<{ ip: string; name?: string; role?: string; supabaseIp?: string }>;
  ha?: {
    failoverRegion?: string;
    primary?: { masterIp?: string };
    standby?: { masterIp?: string };
  };
}

/**
 * Resolve the SSH targets that front the primary and standby databases from
 * `.vibecarbon.json`. For BOTH HA modes the master/VPS IP is the right SSH
 * target: compose-ha's `db` service and k8s-ha's kubectl both run there.
 *
 * Mirrors src/failover.js's identifyServers so the test's notion of
 * primary/standby matches the CLI's — prefer the nested ha.primary/ha.standby
 * block, fall back to the servers[] array keyed by name/region.
 */
export function resolveHaDbIps(
  projectDir: string,
  env: string,
): { primaryIp: string | null; standbyIp: string | null } {
  try {
    const configPath = join(projectDir, '.vibecarbon.json');
    if (!existsSync(configPath)) return { primaryIp: null, standbyIp: null };
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      environments?: Record<string, RawEnvConfig>;
    };
    const envConfig = config.environments?.[env];
    if (!envConfig) return { primaryIp: null, standbyIp: null };

    if (envConfig.ha?.primary?.masterIp && envConfig.ha?.standby?.masterIp) {
      return {
        primaryIp: envConfig.ha.primary.masterIp,
        standbyIp: envConfig.ha.standby.masterIp,
      };
    }

    const servers = envConfig.servers ?? [];
    const primaryRegion = envConfig.region;
    const standbyRegion = envConfig.secondaryRegion || envConfig.ha?.failoverRegion;
    if (servers.length >= 2) {
      // `role` FIRST. A compose-HA failover records itself by flipping this
      // field in place (failoverComposeHA) — it never reorders the array and
      // never renames the servers, because `<project>-<env>-primary` is a
      // Pulumi resource identity that outlives the role it was born with.
      // Resolving by name/region/index therefore keeps naming the OLD primary
      // forever, which is what pointed verify-failover's SSH checks at the
      // decommissioned node (2026-08-10/11 d2 compose-ha).
      const byRole = (role: string) => servers.find((s) => s.role === role);
      const byName = (role: string) => servers.find((s) => s.name === role);
      const byRegion = (region?: string) =>
        region ? servers.find((s) => s.name?.includes(region)) : undefined;
      const primary =
        byRole('primary') || byName('primary') || byRegion(primaryRegion) || servers[0];
      const standby =
        byRole('standby') || byName('standby') || byRegion(standbyRegion) || servers[1];
      return { primaryIp: primary?.ip ?? null, standbyIp: standby?.ip ?? null };
    }

    return { primaryIp: null, standbyIp: null };
  } catch {
    return { primaryIp: null, standbyIp: null };
  }
}

/**
 * Post-scale serving IP for a NON-HA compose environment: the single
 * `servers[]` entry in `.vibecarbon.json`. Scale's update-project-config step
 * rewrites it to the replacement server before verify-scale runs, so this is
 * the address the verify-scale resolution pin dials (the old server is
 * already destroyed by then).
 */
export function readSingleServerIp(projectDir: string, env: string): string | null {
  try {
    const configPath = join(projectDir, '.vibecarbon.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      environments?: Record<string, RawEnvConfig>;
    };
    return config.environments?.[env]?.servers?.[0]?.ip ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSH exec — retried, transport-vs-remote classified
// ---------------------------------------------------------------------------

export interface ReplTarget {
  ip: string;
  sshKeyPath: string;
  mode: DeployMode;
  projectName: string;
  /** Human label for messages, e.g. "primary" / "standby". */
  label: string;
}

/**
 * Where an SSH-carried command failed. 'ssh-transport' means the SSH session
 * itself never delivered the command (banner exchange timeout, kex reset,
 * refused connection — sshd MaxStartups penalties during the verify burst look
 * exactly like this); 'remote' means SSH worked and the REMOTE command (psql /
 * docker / kubectl) exited non-zero. Distinguishing the two makes triage
 * instant: transport failures point at SSH saturation/network, remote failures
 * point at the database.
 */
export type SshExecFailureKind = 'ssh-transport' | 'remote';

/**
 * Transient-SSH classifier — same vocabulary as the deploy CLI's sshRunAsync
 * (src/lib/deploy/compose/index.js): connection resets/refusals, kex/banner
 * exchange failures, timeouts, and no-route blips are all worth a retry;
 * anything else (auth failure, host-key mismatch) is not.
 */
export function isTransientSshError(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes('connection reset') ||
    t.includes('connection refused') ||
    t.includes('connection closed') ||
    t.includes('kex_exchange_identification') ||
    t.includes('ssh_exchange_identification') ||
    t.includes('banner exchange') ||
    t.includes('timed out') ||
    t.includes('etimedout') ||
    t.includes('no route to host')
  );
}

/**
 * Classify a failed ssh exec. OpenSSH reserves exit status 255 for its OWN
 * failures (transport/auth); any other status is the remote command's exit
 * relayed back. A null status means the local process was killed (our
 * execFileSync timeout) — also a transport-shaped failure. Transient only when
 * it's transport-shaped AND matches the transient vocabulary (auth failures
 * and host-key mismatches also exit 255 but retrying those is useless).
 */
export function classifySshExecFailure(
  status: number | null | undefined,
  errText: string | null | undefined,
): { kind: SshExecFailureKind; transient: boolean } {
  const kind: SshExecFailureKind = status === 255 || status == null ? 'ssh-transport' : 'remote';
  // A locally-killed ssh (status null, e.g. execFileSync timeout) is transient
  // even when the error text is bare ("spawnSync ssh ETIMEDOUT" / signal only).
  const transient = kind === 'ssh-transport' && (status == null || isTransientSshError(errText));
  return { kind, transient };
}

interface PsqlResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Set when ok=false: did SSH transport fail, or the remote psql? */
  failureKind?: SshExecFailureKind;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Single ssh exec attempt. Never throws. */
function sshExecOnce(
  target: ReplTarget,
  remote: string,
): { ok: boolean; status: number | null; stdout: string; stderr: string; message: string } {
  try {
    // SECURITY: execFileSync invokes ssh directly (no shell). ip/key come from
    // our own config; `remote` embeds only fixed SQL + a sanitized marker id.
    const out = execFileSync(
      'ssh',
      [...SSH_OPTS, '-i', target.sshKeyPath, `root@${target.ip}`, remote],
      { encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' },
    );
    return { ok: true, status: 0, stdout: out.trim(), stderr: '', message: '' };
  } catch (err) {
    // execFileSync throws on non-zero exit / timeout; stdout/stderr still
    // carry the remote command's own error text, which is the useful part.
    const e = err as {
      status?: number | null;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
    };
    return {
      ok: false,
      status: typeof e.status === 'number' ? e.status : null,
      stdout: e.stdout ? e.stdout.toString().trim() : '',
      stderr: e.stderr ? e.stderr.toString().trim() : '',
      message: e.message ?? 'ssh exec failed',
    };
  }
}

// 3 attempts, 5s apart — matches the deploy CLI's sshRunAsync budget. Small
// enough that a real outage still surfaces fast, big enough to ride out an
// sshd MaxStartups penalty window (the verify-step check fan-out opens many
// SSH sessions to the same hosts; excess unauthenticated connections get
// dropped and show up as "Connection timed out during banner exchange").
const SSH_ATTEMPTS = 3;
const SSH_RETRY_DELAY_MS = 5_000;

/**
 * ssh exec with transient-transport retry. Never throws. Remote (psql-level)
 * failures are NOT retried here — the check-level polling loops own that.
 */
async function sshExecWithRetry(
  target: ReplTarget,
  remote: string,
): Promise<{
  ok: boolean;
  stdout: string;
  errorText: string;
  failureKind?: SshExecFailureKind;
  attempts: number;
}> {
  // Fail fast against a host that already proved its :22 is black-holed —
  // retrying a DROPping firewall just re-pays the connect timeout.
  const alreadyDead = sshUnreachableSince(target.ip);
  if (alreadyDead) {
    return {
      ok: false,
      stdout: '',
      errorText: `${alreadyDead} — ${sshUnreachableDiagnosis(target.ip)}`,
      failureKind: 'ssh-transport',
      attempts: 0,
    };
  }

  let last = sshExecOnce(target, remote);
  let attempts = 1;
  while (!last.ok && attempts < SSH_ATTEMPTS) {
    const cls = classifySshExecFailure(last.status, `${last.stderr}\n${last.message}`);
    if (!cls.transient) break;
    await sleep(SSH_RETRY_DELAY_MS);
    last = sshExecOnce(target, remote);
    attempts++;
  }
  if (last.ok) {
    return { ok: true, stdout: last.stdout, errorText: '', attempts };
  }
  const cls = classifySshExecFailure(last.status, `${last.stderr}\n${last.message}`);
  const errorText = last.stderr || last.message;
  if (isSshConnectTimeout(`${last.stderr}\n${last.message}`)) {
    noteSshConnectTimeout(target.ip, errorText);
  }
  return {
    ok: false,
    stdout: last.stdout,
    errorText,
    failureKind: cls.kind,
    attempts,
  };
}

/** Run a psql statement on `target` over SSH (retried). Never throws. */
async function runPsql(target: ReplTarget, sql: string): Promise<PsqlResult> {
  const remote = buildPsqlCommand(target.mode, target.projectName, sql);
  const res = await sshExecWithRetry(target, remote);
  if (res.ok) return { ok: true, output: res.stdout };
  // Prefix the error with WHERE it failed so the next triage is instant:
  // [ssh-transport] = the session never delivered the command (SSH burst /
  // network); [psql] = SSH was fine, the remote psql/docker/kubectl failed.
  const prefix =
    res.failureKind === 'ssh-transport' ? `[ssh-transport, ${res.attempts} attempts]` : '[psql]';
  return {
    ok: false,
    output: res.stdout,
    error: `${prefix} ${res.errorText || 'ssh/psql failed'}`,
    failureKind: res.failureKind,
  };
}

/** Capture the primary's replication/pg_hba log tail. Best-effort, never throws. */
async function captureReplDiagnostics(primary: ReplTarget): Promise<string> {
  const remote = buildLogDiagCommand(primary.mode, primary.projectName);
  const res = await sshExecWithRetry(primary, remote);
  if (res.ok) return res.stdout;
  return res.stdout || `(log capture failed [${res.failureKind}]: ${res.errorText})`;
}

/**
 * Compose a failure errorMessage that embeds the primary's replication log
 * tail and, if pg_hba rejects appear, the source IP(s) postgres refused.
 */
async function withDiagnostics(base: string, primary: ReplTarget): Promise<string> {
  const logs = await captureReplDiagnostics(primary);
  const rejectIps = extractPgHbaRejectIps(logs);
  const hbaLine =
    rejectIps.length > 0
      ? `\npg_hba REJECTED source IP(s): ${rejectIps.join(', ')} — add a pg_hba/firewall entry for these.`
      : '';
  return `${base}${hbaLine}\n--- ${primary.label} postgres log (replication/pg_hba, last 20) ---\n${logs || '(no matching log lines)'}`;
}

// ---------------------------------------------------------------------------
// Marker write / read (used by both data-propagation and failover continuity)
// ---------------------------------------------------------------------------

/**
 * CREATE the probe table if needed, ENABLE ROW LEVEL SECURITY on it, and
 * INSERT a marker row on the primary — one statement batch (see
 * buildCreateMarkerSql). Idempotent (ON CONFLICT DO NOTHING). Returns the
 * runPsql result.
 */
export async function writeReplicationMarker(
  primary: ReplTarget,
  markerId: string,
): Promise<PsqlResult> {
  return runPsql(primary, buildCreateMarkerSql(markerId));
}

/** Read-only: is `markerId` present in the probe table on `target`? */
async function markerPresent(
  target: ReplTarget,
  markerId: string,
): Promise<PsqlResult & { present: boolean }> {
  const sql = `SELECT id FROM ${QUALIFIED_PROBE_TABLE} WHERE id = '${markerId}'`;
  const res = await runPsql(target, sql);
  // A missing table on the standby surfaces as ok=false with a relation error;
  // treat that as "not present yet" rather than a hard error while polling.
  return { ...res, present: res.ok && res.output.includes(markerId) };
}

/**
 * Best-effort cleanup: drop the probe table outright on `target` (see
 * buildDropProbeTableSql). Never throws. Table-level rather than row-level so
 * no unprotected `public` table can ever survive into the next deploy's
 * migrate step / RLS audit — the next check that needs the probe recreates
 * it fresh via writeReplicationMarker's CREATE TABLE IF NOT EXISTS.
 */
async function dropProbeTable(target: ReplTarget): Promise<void> {
  await runPsql(target, buildDropProbeTableSql());
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * replication_streaming — primary has a streaming standby AND the standby is in
 * recovery. Polls for streaming to appear (it can lag a few seconds behind a
 * fresh deploy/reseed) before failing with the primary's log tail.
 */
async function checkStreaming(
  primary: ReplTarget,
  standby: ReplTarget,
): Promise<VerificationResult> {
  const start = Date.now();
  const BUDGET_MS = 60_000;
  const INTERVAL_MS = 5_000;
  const deadline = start + BUDGET_MS;

  let lastStates: string[] = [];
  let lastErr: string | undefined;
  let streaming = false;
  do {
    const res = await runPsql(primary, 'SELECT state FROM pg_stat_replication');
    lastErr = res.ok ? undefined : res.error;
    lastStates = parseReplicationStates(res.output);
    if (hasStreamingState(lastStates)) {
      streaming = true;
      break;
    }
    if (Date.now() + INTERVAL_MS < deadline) await sleep(INTERVAL_MS);
  } while (Date.now() < deadline);

  if (!streaming) {
    return {
      checkName: 'replication_streaming',
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: await withDiagnostics(
        `Primary pg_stat_replication had no 'streaming' row within ${BUDGET_MS / 1000}s ` +
          `(states=[${lastStates.join(', ') || 'none'}]${lastErr ? `; last error: ${lastErr}` : ''})`,
        primary,
      ),
      details: { states: lastStates, primaryIp: primary.ip },
    };
  }

  // Standby must be a read-only replica in recovery.
  const recRes = await runPsql(standby, 'SELECT pg_is_in_recovery()');
  const inRecovery = parseIsInRecovery(recRes.output);
  if (inRecovery !== true) {
    return {
      checkName: 'replication_streaming',
      status: 'fail',
      responseTimeMs: Date.now() - start,
      errorMessage: await withDiagnostics(
        `Primary is streaming but standby pg_is_in_recovery() = ${
          recRes.output || '(empty)'
        } (expected 't')${recRes.ok ? '' : `; standby error: ${recRes.error}`}`,
        primary,
      ),
      details: { states: lastStates, standbyInRecovery: inRecovery, standbyIp: standby.ip },
    };
  }

  return {
    checkName: 'replication_streaming',
    status: 'pass',
    responseTimeMs: Date.now() - start,
    details: { states: lastStates, standbyInRecovery: true },
  };
}

/**
 * replication_data_propagation — a row INSERTed on the primary must appear on
 * the standby within the budget. Proves the WAL stream carries data end-to-end,
 * not just that a walsender handshake exists. Drops the probe table afterward
 * (best-effort, try/finally — success AND failure paths) so it never survives
 * as public-schema residue into the next deploy's RLS audit; the DROP only
 * ever targets our own _e2e_repl_probe table.
 */
async function checkDataPropagation(
  primary: ReplTarget,
  standby: ReplTarget,
  markerId: string,
): Promise<VerificationResult> {
  const start = Date.now();
  const BUDGET_MS = 60_000;
  const INTERVAL_MS = 3_000;

  try {
    const write = await writeReplicationMarker(primary, markerId);
    if (!write.ok) {
      return {
        checkName: 'replication_data_propagation',
        status: 'fail',
        responseTimeMs: Date.now() - start,
        errorMessage: await withDiagnostics(
          `Could not write probe row on primary: ${write.error ?? 'unknown error'}`,
          primary,
        ),
        details: { markerId, primaryIp: primary.ip },
      };
    }

    const deadline = start + BUDGET_MS;
    let present = false;
    let lastErr: string | undefined;
    do {
      const res = await markerPresent(standby, markerId);
      lastErr = res.ok ? undefined : res.error;
      if (res.present) {
        present = true;
        break;
      }
      if (Date.now() + INTERVAL_MS < deadline) await sleep(INTERVAL_MS);
    } while (Date.now() < deadline);

    if (!present) {
      return {
        checkName: 'replication_data_propagation',
        status: 'fail',
        responseTimeMs: Date.now() - start,
        errorMessage: await withDiagnostics(
          `Probe row ${markerId} written on primary did not appear on standby within ` +
            `${BUDGET_MS / 1000}s${lastErr ? ` (last standby error: ${lastErr})` : ''}`,
          primary,
        ),
        details: { markerId, standbyIp: standby.ip },
      };
    }

    return {
      checkName: 'replication_data_propagation',
      status: 'pass',
      responseTimeMs: Date.now() - start,
      details: { markerId, propagated: true },
    };
  } finally {
    // Table-level cleanup regardless of outcome — see dropProbeTable's doc
    // comment for why this drops the whole table rather than just the row.
    await dropProbeTable(primary);
  }
}

/**
 * Run both HA replication checks (streaming + data propagation). Self-skips
 * (status 'skip', NOT pass) when we lack an SSH handle or can't resolve both db
 * IPs — a missing precondition must not read as green, so a refactor that
 * breaks standby-IP resolution reddens (as skip, distinct from pass) instead of
 * turning these into silent green no-ops.
 */
export async function runReplicationChecks(opts: {
  mode: DeployMode;
  projectName: string;
  primaryIp: string | null;
  standbyIp: string | null;
  sshKeyPath: string | null;
  markerId: string;
}): Promise<VerificationResult[]> {
  const { mode, projectName, primaryIp, standbyIp, sshKeyPath, markerId } = opts;
  if (!sshKeyPath || !primaryIp || !standbyIp) {
    return [
      {
        checkName: 'replication_streaming',
        status: 'skip',
        details: { skipped: 'no sshKeyPath or unresolved primary/standby IP' },
      },
      {
        checkName: 'replication_data_propagation',
        status: 'skip',
        details: { skipped: 'no sshKeyPath or unresolved primary/standby IP' },
      },
    ];
  }

  const primary: ReplTarget = { ip: primaryIp, sshKeyPath, mode, projectName, label: 'primary' };
  const standby: ReplTarget = { ip: standbyIp, sshKeyPath, mode, projectName, label: 'standby' };

  const results: VerificationResult[] = [];
  results.push(await checkStreaming(primary, standby));
  results.push(await checkDataPropagation(primary, standby, markerId));
  return results;
}

/**
 * Whether post-failover role resolution is still pointing at the node the
 * continuity marker was WRITTEN to.
 *
 * The continuity check below proves replication only if it reads the marker off
 * a DIFFERENT node than the one it was written to. When these are the same node
 * the check is structurally incapable of proving anything: it either passes
 * trivially (the marker is trivially present on its own origin) or fails with a
 * misleading "data was lost". Both readings are wrong, so the condition has to
 * be detected BEFORE the check runs — this is the assertion that would have
 * caught the 2026-08-10/11 compose-ha defect years before a red run did.
 */
export function isContinuityTargetSameAsMarkerOrigin(
  resolvedPrimaryIp: string | null | undefined,
  markerOriginIp: string | null | undefined,
): boolean {
  return Boolean(resolvedPrimaryIp && markerOriginIp && resolvedPrimaryIp === markerOriginIp);
}

/** The failure message for the false-green condition above. */
export function continuityTargetSameAsOriginMessage(host: string): string {
  return (
    `Post-failover role resolution still names ${host} — the node the continuity marker was ` +
    `WRITTEN to — as the primary. The failover's role swap did not reach .vibecarbon.json, so ` +
    `this check cannot prove the marker was replicated forward: reading it back from its own ` +
    `origin node would succeed no matter what replication did. Fix role persistence/resolution ` +
    `before trusting any verify-failover result.`
  );
}

/**
 * Whether a failed continuity lookup failed in TRANSPORT — i.e. the SQL never
 * reached a database, so the result says nothing about the data.
 *
 * Keyed on the whole 'ssh-transport' CLASS, not just on a memo-condemned host:
 * exhausted banner-exchange retries, a kex reset, and an auth/host-key
 * rejection all mean the question was never asked, and every one of them would
 * otherwise be reported as "data written pre-failover was lost".
 */
export function continuityTransportFailed(
  res: { ok: boolean; failureKind?: SshExecFailureKind },
  hostCondemned: boolean,
): boolean {
  return !res.ok && (res.failureKind === 'ssh-transport' || hostCondemned);
}

/**
 * replication_failover_continuity — assert the marker row written on the OLD
 * primary right before `vibecarbon failover` survives onto the PROMOTED (new)
 * primary.
 *
 * Post-failover there is intentionally NO streaming standby (the old primary is
 * scaled down by design and there is no reverse reseed), so this asserts ONLY
 * data continuity, never streaming — the app-serves assertion lives in the
 * shared verification suite. Self-skips (status 'skip', NOT pass) when no marker
 * was written or we lack an SSH handle.
 */
export async function runFailoverContinuityCheck(opts: {
  mode: DeployMode;
  projectName: string;
  newPrimaryIp: string | null;
  sshKeyPath: string | null;
  markerId: string | null;
}): Promise<VerificationResult> {
  const start = Date.now();
  const { mode, projectName, newPrimaryIp, sshKeyPath, markerId } = opts;
  if (!markerId || !sshKeyPath || !newPrimaryIp) {
    return {
      checkName: 'replication_failover_continuity',
      status: 'skip',
      details: { skipped: 'no pre-failover marker or SSH handle' },
    };
  }

  const newPrimary: ReplTarget = {
    ip: newPrimaryIp,
    sshKeyPath,
    mode,
    projectName,
    label: 'promoted-primary',
  };

  try {
    const res = await markerPresent(newPrimary, markerId);
    if (!res.present) {
      // Lead with the TRANSPORT verdict when the query never reached a
      // database. "Data written pre-failover was lost" is the single most
      // alarming sentence this suite can emit, and triage reads headlines —
      // it must be reserved for a marker genuinely absent from a database we
      // actually talked to. An unreachable host proves nothing about the data.
      const transportFailed = continuityTransportFailed(
        res,
        sshUnreachableSince(newPrimaryIp) !== null,
      );
      const message = transportFailed
        ? `Continuity UNVERIFIED for marker ${markerId} — could not reach the promoted primary ` +
          `to ask (${res.failureKind ?? 'ssh-transport'}). This is a transport failure, NOT ` +
          `evidence of data loss. ${sshUnreachableDiagnosis(newPrimaryIp)}`
        : await withDiagnostics(
            `Continuity marker ${markerId} written on the old primary before failover was NOT ` +
              `found on the promoted primary — data written pre-failover was lost` +
              `${res.ok ? '' : ` (query error: ${res.error})`}`,
            newPrimary,
          );
      return {
        checkName: 'replication_failover_continuity',
        status: 'fail',
        responseTimeMs: Date.now() - start,
        errorMessage: message,
        details: { markerId, newPrimaryIp, transportFailed },
      };
    }

    return {
      checkName: 'replication_failover_continuity',
      status: 'pass',
      responseTimeMs: Date.now() - start,
      details: { markerId, survived: true },
    };
  } finally {
    // Table-level cleanup regardless of outcome — see dropProbeTable's doc
    // comment for why this drops the whole table rather than just the row.
    // The reconverge-deploy step that follows verify-failover writes its OWN
    // fresh marker (recreating the table via writeReplicationMarker), so
    // dropping here on both pass and fail is safe and self-healing.
    await dropProbeTable(newPrimary);
  }
}
