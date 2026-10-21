/**
 * HA integrity checks: the assertions that would have caught the bugs the
 * HA-correctness branch fixed, read from the OUTSIDE (SSH, the DNS provider's
 * own API), never from the CLI's exit code.
 *
 *   - dns_flip_verified       apex and wildcard A records read back through the
 *                             DNS provider's API equal the promoted side's IP.
 *                             (dns_failover_flip, checks/dns-flip.ts, asks the
 *                             zone's nameservers; this asks the provider, the
 *                             same read the CLI's flipAndVerifyDns trusts.)
 *   - old_primary_disarmed    the retired side runs WALG_ROLE=standby and
 *                             carries the retired marker its backup scripts
 *                             refuse on (src/lib/deploy/retired-fence.js).
 *   - primary_not_restarted   the serving primary's db container (compose) or
 *                             pod (k8s) has the same identity and start time
 *                             before and after a warm or reconverge deploy.
 *   - slot_capped             SHOW max_slot_wal_keep_size on the primary is 4GB.
 *   - app_endpoints_ready     the k8s app Service has a Ready endpoint after
 *                             the first deploy's db-0 recreate (no rollout
 *                             restart reconnects it any more).
 *   - second_failover_refused a failover before the reconverge deploy exits
 *                             non-zero naming `vibecarbon deploy`, and moves
 *                             no role.
 *
 * HA scenarios always have an SSH handle, so a missing one FAILS these checks
 * (it is never a skip): a refactor that loses the key or the retired IP must
 * not turn them into green or skipped no-ops (hollow-pass-census.test.ts).
 *
 * Every remote command here is fixed text built from config values (project
 * name, constants), never user input.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_CONTAINER, DB_POD, DB_STATEFULSET } from '../../../src/lib/deploy/db-workload.js';
import { swappedSinceLastDeploy } from '../../../src/lib/deploy/failover-guard.js';
import {
  RETIRED_HOST_MARKER,
  RETIRED_ROLE,
  RETIRED_ROLE_KEY,
} from '../../../src/lib/deploy/retired-fence.js';
import {
  DNS_PROVIDERS,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from '../../../src/lib/dns-provider.js';
import type { DeployMode, VerificationResult } from '../scenarios/types.js';
import { buildPsqlCommand, runRemote } from './replication.js';

/** The cap both db argv lists carry (slot-wal-cap-census.test.ts). */
export const SLOT_WAL_CAP = '4GB';

const KUBECTL = 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n vibecarbon';
const APP_SERVICE = 'app';

export type RemoteResult = { ok: boolean; output: string; error?: string };
/** Run a fixed command on a node. Injected in unit tests; SSH in production. */
export type RemoteRun = (ip: string, remote: string) => Promise<RemoteResult>;

interface SshArgs {
  mode: DeployMode;
  projectName: string;
  sshKeyPath: string | null;
  run?: RemoteRun;
}

const isCompose = (mode: DeployMode) => mode.startsWith('compose');

function defaultRun(mode: DeployMode, projectName: string, sshKeyPath: string, label: string) {
  return (ip: string, remote: string) =>
    runRemote({ ip, sshKeyPath, mode, projectName, label }, remote);
}

/** Which half of the SSH handle is missing, or null when both are present. */
export function missingHandle(
  ip: string | null | undefined,
  sshKeyPath: string | null | undefined,
  role: string,
): string | null {
  if (!ip && !sshKeyPath) return `no ${role} IP and no sshKeyPath`;
  if (!ip) return `no ${role} IP (sshKeyPath present)`;
  if (!sshKeyPath) return `no sshKeyPath (${role} IP present)`;
  return null;
}

function fail(checkName: string, errorMessage: string, details?: Record<string, unknown>) {
  return { checkName, status: 'fail' as const, errorMessage, ...(details && { details }) };
}

// ---------------------------------------------------------------------------
// old_primary_disarmed
// ---------------------------------------------------------------------------

/**
 * compose: the host marker and the RUNNING db container's WALG_ROLE (a merged
 * .env does nothing until the container is recreated). k8s: the ConfigMap role
 * the backup CronJob reads and the db StatefulSet's WALG_ROLE.
 */
export function buildDisarmProbeCommand(mode: DeployMode, projectName: string): string {
  if (isCompose(mode)) {
    const dbCt = `${projectName}-db`;
    return [
      `cd /opt/${projectName} || exit 1`,
      `if [ -f ${RETIRED_HOST_MARKER} ]; then echo HOST_MARKER=1; else echo HOST_MARKER=0; fi`,
      `echo "WALG_ROLE=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${dbCt} 2>/dev/null | sed -n 's/^WALG_ROLE=//p' | head -n1)"`,
      'echo PROBE_DONE',
    ].join('\n');
  }
  return `${KUBECTL} get configmap/vibecarbon-config statefulset/${DB_STATEFULSET} -o json`;
}

/** The retired side's disarm state; null when the probe output is unreadable. */
export function parseDisarmProbe(
  mode: DeployMode,
  output: string | null | undefined,
): { walgRole: string | null; retiredMarker: boolean } | null {
  const text = String(output ?? '');
  if (isCompose(mode)) {
    const lines = text.split('\n').map((l) => l.trim());
    if (!lines.includes('PROBE_DONE')) return null;
    const value = (key: string) =>
      lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
    return {
      walgRole: value('WALG_ROLE') || null,
      retiredMarker: value('HOST_MARKER') === '1',
    };
  }
  type K8sItem = {
    kind?: string;
    data?: Record<string, string>;
    spec?: {
      template?: {
        spec?: {
          containers?: Array<{ name?: string; env?: Array<{ name?: string; value?: string }> }>;
        };
      };
    };
  };
  let listed: K8sItem & { items?: K8sItem[] };
  try {
    listed = JSON.parse(text);
  } catch {
    return null;
  }
  const items = listed?.kind === 'List' ? (listed.items ?? []) : [listed];
  const of = (kind: string) => items.find((i) => i?.kind === kind);
  const db = (of('StatefulSet')?.spec?.template?.spec?.containers ?? []).find(
    (c) => c.name === DB_CONTAINER,
  );
  return {
    walgRole: (db?.env ?? []).find((e) => e.name === 'WALG_ROLE')?.value ?? null,
    retiredMarker: of('ConfigMap')?.data?.[RETIRED_ROLE_KEY] === RETIRED_ROLE,
  };
}

/** old_primary_disarmed: the retired side archives nothing and refuses its backups. */
export async function checkOldPrimaryDisarmed(
  opts: SshArgs & { retiredIp: string | null },
): Promise<VerificationResult> {
  const checkName = 'old_primary_disarmed';
  const { mode, projectName, retiredIp, sshKeyPath } = opts;
  const missing = missingHandle(retiredIp, sshKeyPath, 'retired-side');
  if (missing) return fail(checkName, `cannot reach the retired side: ${missing}`);
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath, 'retired');
  const res = await run(retiredIp, buildDisarmProbeCommand(mode, projectName));
  if (!res.ok) {
    return fail(checkName, `could not read the retired side ${retiredIp}: ${res.error}`);
  }
  const state = parseDisarmProbe(mode, res.output);
  if (!state) {
    return fail(
      checkName,
      `unreadable disarm probe from ${retiredIp}: ${res.output.slice(0, 200)}`,
    );
  }
  const problems: string[] = [];
  if (state.walgRole !== 'standby') {
    problems.push(`WALG_ROLE=${state.walgRole ?? '(unset)'}, not standby, so it still archives`);
  }
  if (!state.retiredMarker) {
    problems.push(
      isCompose(mode)
        ? `the retired marker ${RETIRED_HOST_MARKER} is missing, so its nightly backup still runs`
        : `the retired marker ${RETIRED_ROLE_KEY}=${RETIRED_ROLE} is missing from vibecarbon-config, so its backup CronJob still runs`,
    );
  }
  if (problems.length > 0) {
    return fail(checkName, `old primary ${retiredIp} is not disarmed: ${problems.join('; ')}`, {
      retiredIp,
      ...state,
    });
  }
  return { checkName, status: 'pass', details: { retiredIp, ...state } };
}

// ---------------------------------------------------------------------------
// primary_not_restarted
// ---------------------------------------------------------------------------

export interface DbIncarnation {
  /** compose: container id (a recreate changes it); k8s: pod uid. */
  id: string;
  /** The db container's start time (a restart in place changes it). */
  startedAt: string;
}

export type IncarnationRead =
  | { ok: true; incarnation: DbIncarnation }
  | { ok: false; error: string };

export function buildDbIncarnationCommand(mode: DeployMode, projectName: string): string {
  if (isCompose(mode)) {
    return `docker inspect -f '{{.Id}} {{.State.StartedAt}}' ${projectName}-db`;
  }
  return `${KUBECTL} get pod ${DB_POD} -o json`;
}

/** Null when the db is not running (no start time to compare). */
export function parseDbIncarnation(
  mode: DeployMode,
  output: string | null | undefined,
): DbIncarnation | null {
  const text = String(output ?? '').trim();
  if (isCompose(mode)) {
    const [id, startedAt] = text.split(/\s+/);
    return id && startedAt ? { id, startedAt } : null;
  }
  try {
    const pod = JSON.parse(text) as {
      metadata?: { uid?: string };
      status?: {
        containerStatuses?: Array<{ name?: string; state?: { running?: { startedAt?: string } } }>;
      };
    };
    const startedAt = (pod.status?.containerStatuses ?? []).find((c) => c.name === DB_CONTAINER)
      ?.state?.running?.startedAt;
    const id = pod.metadata?.uid;
    return id && startedAt ? { id, startedAt } : null;
  } catch {
    return null;
  }
}

/** Read the serving primary's db incarnation. Never throws. */
export async function readDbIncarnation(
  opts: SshArgs & { ip: string | null },
): Promise<IncarnationRead> {
  const { mode, projectName, ip, sshKeyPath } = opts;
  const missing = missingHandle(ip, sshKeyPath, 'primary');
  if (missing) return { ok: false, error: missing };
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath, 'primary');
  const res = await run(ip, buildDbIncarnationCommand(mode, projectName));
  if (!res.ok) return { ok: false, error: res.error ?? 'remote read failed' };
  const incarnation = parseDbIncarnation(mode, res.output);
  if (!incarnation) return { ok: false, error: `db is not running on ${ip}` };
  return { ok: true, incarnation };
}

/** primary_not_restarted: the deploy left the serving primary's db alone. */
export function checkPrimaryNotRestarted(opts: {
  ip: string | null;
  before: IncarnationRead;
  after: IncarnationRead;
}): VerificationResult {
  const checkName = 'primary_not_restarted';
  const { ip, before, after } = opts;
  // An unread start time proves nothing either way: fail with the read error.
  const readError = (r: IncarnationRead) => (r as { error: string }).error;
  if (!before.ok) {
    return fail(
      checkName,
      `could not read the db start time before the deploy: ${readError(before)}`,
    );
  }
  if (!after.ok) {
    return fail(
      checkName,
      `could not read the db start time after the deploy: ${readError(after)}`,
    );
  }
  const b = (before as { incarnation: DbIncarnation }).incarnation;
  const a = (after as { incarnation: DbIncarnation }).incarnation;
  const details = { ip, before: b, after: a };
  if (a.id !== b.id) {
    return fail(
      checkName,
      `the deploy recreated the serving primary's db on ${ip} (${b.id} -> ${a.id})`,
      details,
    );
  }
  if (a.startedAt !== b.startedAt) {
    return fail(
      checkName,
      `the deploy restarted the serving primary's db on ${ip} (started ${b.startedAt}, now ${a.startedAt})`,
      details,
    );
  }
  return { checkName, status: 'pass', details };
}

// ---------------------------------------------------------------------------
// slot_capped
// ---------------------------------------------------------------------------

/** slot_capped: a standby that is down cannot fill the primary's volume. */
export async function checkSlotCapped(
  opts: SshArgs & { primaryIp: string | null },
): Promise<VerificationResult> {
  const checkName = 'slot_capped';
  const { mode, projectName, primaryIp, sshKeyPath } = opts;
  const missing = missingHandle(primaryIp, sshKeyPath, 'primary');
  if (missing) return fail(checkName, `cannot reach the primary: ${missing}`);
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath, 'primary');
  const res = await run(
    primaryIp,
    buildPsqlCommand(mode, projectName, 'SHOW max_slot_wal_keep_size'),
  );
  if (!res.ok) return fail(checkName, `could not read max_slot_wal_keep_size: ${res.error}`);
  const value = res.output.trim();
  if (value !== SLOT_WAL_CAP) {
    return fail(
      checkName,
      `max_slot_wal_keep_size on ${primaryIp} is ${value || '(empty)'}, not ${SLOT_WAL_CAP}`,
      { value },
    );
  }
  return { checkName, status: 'pass', details: { value } };
}

// ---------------------------------------------------------------------------
// app_endpoints_ready
// ---------------------------------------------------------------------------

/** Ready endpoints across the app Service's EndpointSlices; null when unreadable. */
export function parseReadyEndpointCount(json: string | null | undefined): number | null {
  try {
    const parsed = JSON.parse(String(json ?? '')) as {
      items?: Array<{ endpoints?: Array<{ conditions?: { ready?: boolean } }> }>;
    };
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items
      .flatMap((s) => s.endpoints ?? [])
      .filter((e) => e.conditions?.ready === true).length;
  } catch {
    return null;
  }
}

/** app_endpoints_ready: the app reconnected on its own after the db-0 recreate. */
export async function checkAppEndpointsReady(opts: {
  primaryIp: string | null;
  sshKeyPath: string | null;
  run?: RemoteRun;
}): Promise<VerificationResult> {
  const checkName = 'app_endpoints_ready';
  const { primaryIp, sshKeyPath } = opts;
  const missing = missingHandle(primaryIp, sshKeyPath, 'primary');
  if (missing) return fail(checkName, `cannot reach the primary cluster: ${missing}`);
  const run = opts.run ?? defaultRun('k8s-ha', '', sshKeyPath, 'primary');
  const res = await run(
    primaryIp,
    `${KUBECTL} get endpointslices -l kubernetes.io/service-name=${APP_SERVICE} -o json`,
  );
  if (!res.ok) return fail(checkName, `could not list the app endpoints: ${res.error}`);
  const ready = parseReadyEndpointCount(res.output);
  if (ready === null) {
    return fail(checkName, `unreadable EndpointSlice list: ${res.output.slice(0, 200)}`);
  }
  if (ready === 0) {
    return fail(
      checkName,
      `Service ${APP_SERVICE} has no Ready endpoint on ${primaryIp}, so the ingress has nothing to route to`,
      { ready },
    );
  }
  return { checkName, status: 'pass', details: { ready } };
}

// ---------------------------------------------------------------------------
// dns_flip_verified
// ---------------------------------------------------------------------------

type ReadA = (name: string) => Promise<string | null>;

interface RawEnv {
  lastFailover?: string;
  deployedAt?: string;
  dns?: { provider?: string; zoneId?: string } | null;
  servers?: Array<{ ip?: string; role?: string }>;
  ha?: { primary?: { masterIp?: string; floatingIp?: string }; standby?: { masterIp?: string } };
}

function readEnv(projectDir: string, env: string): RawEnv | null {
  try {
    const path = join(projectDir, '.vibecarbon.json');
    if (!existsSync(path)) return null;
    const config = JSON.parse(readFileSync(path, 'utf-8')) as {
      environments?: Record<string, RawEnv>;
    };
    return config.environments?.[env] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the persisted env still reads as failed over and not reconverged:
 * the CLI's own guard (swappedSinceLastDeploy), so the harness and failover
 * agree on when a second failover must refuse. Null when the config is
 * unreadable.
 */
export function readSwappedSinceLastDeploy(projectDir: string, env: string): boolean | null {
  const envConfig = readEnv(projectDir, env);
  return envConfig ? swappedSinceLastDeploy(envConfig) : null;
}

/**
 * The IP the A records must carry: k8s-ha flips them to the primary's floating
 * IP (src/failover.js `floatingIp || masterIp`), compose-ha to the node whose
 * role is primary.
 */
export function readServingIp(projectDir: string, env: string): string | null {
  const envConfig = readEnv(projectDir, env);
  if (!envConfig) return null;
  const ha = envConfig.ha;
  if (ha?.primary?.masterIp && ha?.standby?.masterIp) {
    return ha.primary.floatingIp || ha.primary.masterIp;
  }
  return (envConfig.servers ?? []).find((s) => s.role === 'primary')?.ip ?? null;
}

/**
 * A reader for the env's A records through its DNS provider's own API, the
 * same backend call failover's flipAndVerifyDns reads back with. Never throws:
 * a missing zone, token or backend comes back as `error`.
 */
export async function providerApiAReader(
  projectDir: string,
  env: string,
  ctx: { computeProviderId: string; computeToken?: string },
): Promise<{ readA: ReadA | null; error?: string; skipReason?: string }> {
  const dns = readEnv(projectDir, env)?.dns;
  if (!dns?.provider || !hasAutomatedDns(dns.provider)) {
    return {
      readA: null,
      skipReason: 'manual DNS: failover flips no record, so there is nothing to read back',
    };
  }
  if (!dns.zoneId) return { readA: null, error: `no dns.zoneId for ${env} in .vibecarbon.json` };
  const token = resolveDnsToken(dns.provider, ctx);
  if (!token) {
    const row = (DNS_PROVIDERS as Record<string, { tokenEnv?: string }>)[dns.provider];
    return { readA: null, error: `${row?.tokenEnv ?? 'the DNS token'} is not set` };
  }
  let backend: {
    readARecord: (token: string, zoneId: string, name: string) => Promise<string | null>;
  };
  try {
    backend = (await getDnsProvider(dns.provider)) as typeof backend;
  } catch (err) {
    return { readA: null, error: `no DNS backend for ${dns.provider}: ${(err as Error).message}` };
  }
  return { readA: (name) => backend.readARecord(token, dns.zoneId, name) };
}

/** dns_flip_verified: apex and wildcard read back as the promoted side's IP. */
export async function checkDnsFlipVerified(opts: {
  domain: string;
  expectedIp: string | null;
  readA: ReadA | null;
  readerError?: string;
  skipReason?: string;
}): Promise<VerificationResult> {
  const checkName = 'dns_flip_verified';
  const { domain, expectedIp, readA, readerError, skipReason } = opts;
  if (skipReason) {
    return { checkName, status: 'skip', details: { skipped: true, reason: skipReason } };
  }
  if (!expectedIp) {
    return fail(checkName, 'no promoted IP in .vibecarbon.json to compare the A records against');
  }
  if (!readA) {
    return fail(checkName, `cannot read the A records: ${readerError ?? 'no DNS provider reader'}`);
  }
  const seen: Record<string, string | null> = {};
  for (const name of [domain, `*.${domain}`]) {
    try {
      seen[name] = await readA(name);
    } catch (err) {
      return fail(
        checkName,
        `could not read ${name} through the DNS provider API: ${(err as Error).message}`,
      );
    }
  }
  const wrong = Object.entries(seen).filter(([, ip]) => ip !== expectedIp);
  if (wrong.length > 0) {
    return fail(
      checkName,
      `the DNS provider holds ${wrong.map(([n, ip]) => `${n} -> ${ip ?? 'nothing'}`).join(', ')}, not ${expectedIp}`,
      { expectedIp, seen },
    );
  }
  return { checkName, status: 'pass', details: { expectedIp, seen } };
}

// ---------------------------------------------------------------------------
// second_failover_refused
// ---------------------------------------------------------------------------

export interface HaRoles {
  primaryIp: string | null;
  standbyIp: string | null;
}

/**
 * second_failover_refused: a failover before the reconverge deploy must refuse
 * (the standby is the retired old primary, holding none of the new writes),
 * name the fix, and leave the roles where they were.
 */
export function checkSecondFailoverRefused(opts: {
  exitCode: number;
  output: string;
  rolesBefore: HaRoles;
  rolesAfter: HaRoles;
}): VerificationResult {
  const checkName = 'second_failover_refused';
  const { exitCode, output, rolesBefore, rolesAfter } = opts;
  const details = { exitCode, rolesBefore, rolesAfter };
  if (exitCode === 0) {
    return fail(
      checkName,
      'a second failover before the reconverge deploy succeeded; it must refuse',
      details,
    );
  }
  if (!/vibecarbon deploy/.test(output)) {
    return fail(
      checkName,
      `the second failover exited ${exitCode} without naming vibecarbon deploy as the fix: ${output.slice(-400)}`,
      details,
    );
  }
  if (
    rolesAfter.primaryIp !== rolesBefore.primaryIp ||
    rolesAfter.standbyIp !== rolesBefore.standbyIp
  ) {
    return fail(checkName, 'the refused failover still moved the roles', details);
  }
  return { checkName, status: 'pass', details };
}
