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
 *   - old_primary_disarmed    the retired side's wal-g role file reads standby
 *                             (k8s: its intent too) and it carries the retired
 *                             marker its backup scripts refuse on
 *                             (src/lib/deploy/retired-fence.js).
 *   - primary_not_restarted   the serving primary's db container (compose) or
 *                             pod (k8s) has the same identity and start time
 *                             before and after a warm or reconverge deploy.
 *   - standby_db_created_once a cold k8s-ha deploy seeded its standby in place:
 *                             db-0 created once, its volume attached once,
 *                             `.vc-reseeded-from` written inside that pod.
 *   - reseed_in_place         a k8s-ha failover or restore reseed swapped a new
 *                             tree in with the same db-0, claim, volume and
 *                             VolumeAttachment. Both read objects and files,
 *                             never Events (they age out).
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
import {
  DB_CONTAINER,
  DB_POD,
  DB_PVC,
  DB_STATEFULSET,
} from '../../../src/lib/deploy/db-workload.js';
import { swappedSinceLastDeploy } from '../../../src/lib/deploy/failover-guard.js';
import { clusterIngressIp } from '../../../src/lib/deploy/k8s/ingress-ip.js';
import {
  RETIRED_HOST_MARKER,
  RETIRED_ROLE,
  RETIRED_ROLE_KEY,
} from '../../../src/lib/deploy/retired-fence.js';
import {
  COMPOSE_WALG_ROLE_HOST_DIR,
  DB_ROLE_CONFIGMAP,
  DB_ROLE_INTENT_KEY,
  WALG_ROLE_DIR,
  walgRoleReadShell,
} from '../../../src/lib/deploy/walg-role.js';
import {
  DNS_PROVIDERS,
  getDnsProvider,
  hasAutomatedDns,
  resolveDnsToken,
} from '../../../src/lib/dns-provider.js';
import type { readARecord } from '../../../src/lib/hetzner-dns.js';
import { getObjectStorageProvider } from '../../../src/lib/providers/index.js';
import { shEscape } from '../../../src/lib/shell.js';
import { WALG_ENV_SOURCE } from '../../../src/lib/walg/restore-layout.js';
import type { DeployMode, VerificationResult } from '../scenarios/types.js';
import {
  resolveBackupS3Target,
  resolveObjectStorageCreds,
  walSegmentKeyPrefix,
} from './backup-evidence.js';
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

export function defaultRun(
  mode: DeployMode,
  projectName: string,
  sshKeyPath: string,
  label: string,
) {
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

export function fail(checkName: string, errorMessage: string, details?: Record<string, unknown>) {
  return { checkName, status: 'fail' as const, errorMessage, ...(details && { details }) };
}

// ---------------------------------------------------------------------------
// old_primary_disarmed
// ---------------------------------------------------------------------------

/** The k8s retired side's role reads, as probe lines (KEY=value). */
const k8sDisarmProbe = () => {
  const cm = (name: string, key: string) =>
    `${KUBECTL} get configmap ${name} -o jsonpath='{.data.${key}}' 2>/dev/null`;
  return [
    `echo "INTENT=$(${cm(DB_ROLE_CONFIGMAP, DB_ROLE_INTENT_KEY)})"`,
    `if [ "$(${cm('vibecarbon-config', RETIRED_ROLE_KEY)})" = ${RETIRED_ROLE} ]; then echo RETIRED=1; else echo RETIRED=0; fi`,
    // The live file, read in db-0 through the one parser. A pod that does
    // not answer prints no WALG_ROLE_FILE line: the role reads as unreadable.
    `${KUBECTL} exec ${DB_POD} -c ${DB_CONTAINER} -- sh -c ${shEscape(walgRoleReadShell(WALG_ROLE_DIR))} 2>/dev/null`,
    'echo PROBE_DONE',
  ].join('\n');
};

/**
 * The retired side's wal-g role, read through the one role reader
 * (walgRoleReadShell), never an env var: the role is a file, so a running
 * container's environment says nothing about it.
 *
 * compose: the host marker and the host role file `/opt/<p>/.vibecarbon-role`
 * (bound read-only into the db). k8s: the retired marker in vibecarbon-config,
 * the durable intent in the vibecarbon-db-role ConfigMap (the db's next start
 * applies it) and the live file read inside db-0.
 */
export function buildDisarmProbeCommand(mode: DeployMode, projectName: string): string {
  if (isCompose(mode)) {
    return [
      `cd /opt/${projectName} || exit 1`,
      `if [ -f ${RETIRED_HOST_MARKER} ]; then echo HOST_MARKER=1; else echo HOST_MARKER=0; fi`,
      walgRoleReadShell(`/opt/${projectName}/${COMPOSE_WALG_ROLE_HOST_DIR}`),
      'echo PROBE_DONE',
    ].join('\n');
  }
  return k8sDisarmProbe();
}

export interface DisarmState {
  /** The live role file through the one parser; null when unreadable, empty or unknown. */
  walgRole: string | null;
  /** k8s: the vibecarbon-db-role intent; null when unreadable (and always on compose). */
  walgIntent: string | null;
  retiredMarker: boolean;
}

/** The retired side's disarm state; null when the probe output is unreadable. */
export function parseDisarmProbe(
  mode: DeployMode,
  output: string | null | undefined,
): DisarmState | null {
  const lines = String(output ?? '')
    .split('\n')
    .map((l) => l.trim());
  if (!lines.includes('PROBE_DONE')) return null;
  const value = (key: string) =>
    lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
  const walgRole = value('WALG_ROLE_FILE') || null;
  if (isCompose(mode)) {
    return { walgRole, walgIntent: null, retiredMarker: value('HOST_MARKER') === '1' };
  }
  return {
    walgRole,
    walgIntent: value('INTENT') || null,
    retiredMarker: value('RETIRED') === '1',
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
    problems.push(
      `its wal-g role file reads ${state.walgRole ?? '(unreadable or empty)'}, not standby, so it ` +
        'still archives or holds every segment',
    );
  }
  if (!isCompose(mode) && state.walgIntent !== 'standby') {
    problems.push(
      `the ${DB_ROLE_CONFIGMAP} intent reads ${state.walgIntent ?? '(unreadable or empty)'}, ` +
        'not standby, so the db re-arms on its next start',
    );
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
// primary_db_created_once
// ---------------------------------------------------------------------------

/**
 * primary_db_created_once: a cold k8s-ha deploy creates the primary db-0 once
 * and attaches its volume once. The DO e2e of 2026-11-01 failed because a
 * replication-time patch recreated db-0 seconds after its first attach, and
 * the same-node re-attach went stale (docs/mitigations.yml
 * do-csi-stale-volumeattachment). Two reads prove it did not happen again:
 * the StatefulSet is still at generation 1 (its template never changed after
 * creation, so nothing rolled the pod), and db-0 is still the pod the deploy
 * ended with (uid read right after the deploy, compared at verify).
 */
export async function checkPrimaryDbCreatedOnce(
  opts: SshArgs & {
    ip: string | null;
    atDeploy: IncarnationRead;
    atVerify: IncarnationRead;
  },
): Promise<VerificationResult> {
  const checkName = 'primary_db_created_once';
  const { mode, projectName, ip, sshKeyPath, atDeploy, atVerify } = opts;
  const readError = (r: IncarnationRead) => (r as { error: string }).error;
  if (!atDeploy.ok)
    return fail(checkName, `could not read db-0 after the deploy: ${readError(atDeploy)}`);
  if (!atVerify.ok) return fail(checkName, `could not read db-0 at verify: ${readError(atVerify)}`);
  const missing = missingHandle(ip, sshKeyPath, 'primary');
  if (missing) return fail(checkName, `cannot reach the primary: ${missing}`);
  const before = (atDeploy as { incarnation: DbIncarnation }).incarnation;
  const after = (atVerify as { incarnation: DbIncarnation }).incarnation;
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath, 'primary');
  const res = await run(ip, DB_GENERATION_COMMAND);
  if (!res.ok) return fail(checkName, `could not read the db StatefulSet generation: ${res.error}`);
  const generation = res.output.trim();
  const details = { ip, atDeploy: before, atVerify: after, generation };
  if (generation !== '1') {
    return fail(
      checkName,
      `the primary db StatefulSet on ${ip} is at generation ${generation || '(empty)'}: its pod ` +
        'template changed after creation, so db-0 was rolled and its volume re-attached',
      details,
    );
  }
  if (before.id !== after.id) {
    return fail(
      checkName,
      `the primary db-0 on ${ip} was recreated after the deploy (${before.id} -> ${after.id})`,
      details,
    );
  }
  return { checkName, status: 'pass', details };
}

// ---------------------------------------------------------------------------
// standby_db_created_once, reseed_in_place
// ---------------------------------------------------------------------------

/**
 * The k8s standby db's attach state, read from objects and files only. Events
 * age out (one hour), so a "no transition" verdict built on them goes green
 * by itself. These do not:
 *
 *   - db-0's uid and creationTimestamp: a recreate changes both.
 *   - the db container's restartCount and containerID: an in-place restart
 *     raises the one and changes the other, inside the same pod.
 *   - the claim's uid and its volume: a re-provision changes them.
 *   - the volume's VolumeAttachment, name and creationTimestamp: a detach
 *     deletes it and a re-attach creates a new one.
 *   - `$PGDATA/.vc-reseeded-from`, its mtime and content: db-guard.sh writes
 *     the attempt id there when it swaps a staged reseed in.
 *
 * The extra identities are optional in the type so a comparison can be
 * stated on the fields it needs; parseDbAttachState always fills every one.
 * Both verdicts fail on an unread restartCount, never skip it.
 */
export interface DbAttachState {
  uid: string;
  podAt: string;
  vaName: string;
  vaAt: string;
  /** `.vc-reseeded-from`'s mtime, epoch seconds; null when there is no swap record. */
  reseededAt: number | null;
  /** `.vc-reseeded-from`'s content (the swapped attempt id); null when absent. */
  reseededFrom: string | null;
  /** The db StatefulSet's metadata.generation. */
  generation: string;
  restartCount?: number;
  containerId?: string;
  pvcUid?: string;
  pvName?: string;
}

export type AttachStateRead = { ok: true; state: DbAttachState } | { ok: false; error: string };

/** The db pod's PGDATA (replication.js PGDATA_DIR), where db-guard.sh leaves its swap record. */
const PGDATA = '/var/lib/postgresql/data';

/**
 * The in-pod read of the swap record: `absent`, or its mtime and content. A
 * failed exec prints neither, so an unreadable record is never taken for
 * "no swap ran".
 */
export function reseededFromProbe(pgdata = PGDATA): string {
  const f = `${pgdata}/.vc-reseeded-from`;
  return (
    `f=${shEscape(f)}; if [ -f "$f" ]; then ` +
    'echo "mtime=$(stat -c %Y "$f")"; echo "from=$(cat "$f")"; else echo absent; fi'
  );
}

/** One remote: db-0, the StatefulSet generation, the claim, every VolumeAttachment, the swap record. */
export function buildDbAttachStateCommand(): string {
  return [
    "echo '@@pod'",
    `${KUBECTL} get pod ${DB_POD} -o json`,
    "echo '@@sts'",
    `${KUBECTL} get statefulset ${DB_STATEFULSET} -o jsonpath='{.metadata.generation}'`,
    'echo',
    "echo '@@pvc'",
    `${KUBECTL} get pvc ${DB_PVC} -o json`,
    "echo '@@va'",
    // Cluster-scoped: no namespace.
    'KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl get volumeattachments -o json',
    "echo '@@reseeded'",
    `${KUBECTL} exec ${DB_POD} -c ${DB_CONTAINER} -- sh -c ${shEscape(reseededFromProbe())}`,
  ].join('; ');
}

function sections(output: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of String(output ?? '').split('\n')) {
    const m = line.match(/^@@(\w+)\s*$/);
    if (m) {
      if (name) out.set(name, body.join('\n').trim());
      name = m[1];
      body = [];
    } else if (name) body.push(line);
  }
  if (name) out.set(name, body.join('\n').trim());
  return out;
}

function parseJson<T>(text: string | undefined): T | null {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Parse buildDbAttachStateCommand's output. Every field is required: a gap is an error. */
export function parseDbAttachState(output: string | null | undefined): AttachStateRead {
  const s = sections(String(output ?? ''));
  const err = (error: string): AttachStateRead => ({ ok: false, error });

  const pod = parseJson<{
    metadata?: { uid?: string; creationTimestamp?: string };
    status?: {
      containerStatuses?: Array<{ name?: string; restartCount?: number; containerID?: string }>;
    };
  }>(s.get('pod'));
  const uid = pod?.metadata?.uid;
  const podAt = pod?.metadata?.creationTimestamp;
  if (!uid || !podAt) return err(`could not read pod ${DB_POD} (uid, creationTimestamp)`);
  const db = (pod.status?.containerStatuses ?? []).find((c) => c.name === DB_CONTAINER);
  if (!db || typeof db.restartCount !== 'number' || !db.containerID) {
    return err(`pod ${DB_POD} has no ${DB_CONTAINER} container status (restartCount, containerID)`);
  }

  const generation = s.get('sts') ?? '';
  if (!/^\d+$/.test(generation)) {
    return err(
      `could not read the ${DB_STATEFULSET} StatefulSet generation (${generation || 'empty'})`,
    );
  }

  const pvc = parseJson<{ metadata?: { uid?: string }; spec?: { volumeName?: string } }>(
    s.get('pvc'),
  );
  const pvcUid = pvc?.metadata?.uid;
  const pvName = pvc?.spec?.volumeName;
  if (!pvcUid || !pvName) return err(`the claim ${DB_PVC} is unreadable or not bound to a volume`);

  const list = parseJson<{
    items?: Array<{
      metadata?: { name?: string; creationTimestamp?: string };
      spec?: { source?: { persistentVolumeName?: string } };
    }>;
  }>(s.get('va'));
  if (!list?.items) return err('could not list the VolumeAttachments');
  const attachments = list.items.filter((v) => v.spec?.source?.persistentVolumeName === pvName);
  if (attachments.length === 0) return err(`no VolumeAttachment for ${pvName} (${DB_PVC})`);
  if (attachments.length > 1) {
    const names = attachments.map((v) => v.metadata?.name).join(', ');
    return err(
      `${attachments.length} VolumeAttachments for ${pvName} (${names}): it is mid re-attach`,
    );
  }
  const vaName = attachments[0].metadata?.name;
  const vaAt = attachments[0].metadata?.creationTimestamp;
  if (!vaName || !vaAt)
    return err(`the VolumeAttachment for ${pvName} has no name or creationTimestamp`);

  const rec = s.get('reseeded') ?? '';
  let reseededAt: number | null = null;
  let reseededFrom: string | null = null;
  if (rec !== 'absent') {
    const mtime = rec.match(/^mtime=(\d+)$/m)?.[1];
    const from = rec.match(/^from=(.+)$/m)?.[1]?.trim();
    if (!mtime || !from) {
      return err(`could not read ${PGDATA}/.vc-reseeded-from in ${DB_POD} (${rec || 'no output'})`);
    }
    reseededAt = Number(mtime);
    reseededFrom = from;
  }

  return {
    ok: true,
    state: {
      uid,
      podAt,
      restartCount: db.restartCount,
      containerId: db.containerID,
      generation,
      pvcUid,
      pvName,
      vaName,
      vaAt,
      reseededAt,
      reseededFrom,
    },
  };
}

/** Read a k8s cluster's db attach state (the standby, in practice). Never throws. */
export async function readDbAttachState(
  opts: SshArgs & { ip: string | null },
): Promise<AttachStateRead> {
  const { mode, projectName, ip, sshKeyPath } = opts;
  const missing = missingHandle(ip, sshKeyPath, 'standby');
  if (missing) return { ok: false, error: missing };
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath, 'standby');
  const res = await run(ip, buildDbAttachStateCommand());
  if (!res.ok) return { ok: false, error: res.error ?? 'remote read failed' };
  return parseDbAttachState(res.output);
}

/** How long after db-0's creation its volume's first attach may land. */
export const FIRST_ATTACH_WINDOW_S = 120;

/**
 * standby_db_created_once, the verdict: the cold deploy created the standby
 * db-0 once, attached its volume once, and seeded it in place.
 *
 *   - generation 1: the pod template never changed, so nothing rolled db-0.
 *   - `.vc-reseeded-from` exists: the in-place swap ran.
 *   - the db container's restartCount is at least 1: the swap came from a
 *     restart inside this pod (a recreated pod starts at 0). One clock.
 *   - db-0 was created before that file's mtime: the swap ran in a pod that
 *     already existed, so it was not recreated for it.
 *   - the VolumeAttachment is no later than db-0's creation plus 120 s: one
 *     attach, at pod creation.
 */
export function evaluateStandbyCreatedOnce(state: DbAttachState): VerificationResult {
  const checkName = 'standby_db_created_once';
  const details = { state };
  if (state.generation !== '1') {
    return fail(
      checkName,
      `the standby db StatefulSet is at generation ${state.generation}: its pod template ` +
        'changed after creation, so db-0 was rolled and its volume re-attached',
      details,
    );
  }
  if (!state.reseededFrom || state.reseededAt === null) {
    return fail(
      checkName,
      `the standby db-0 has no ${PGDATA}/.vc-reseeded-from: the cold deploy's in-place seed never swapped`,
      details,
    );
  }
  // The single-clock proof: the swap needs one container restart inside the
  // pod, and a recreated pod starts at 0. The timestamps below corroborate.
  if (typeof state.restartCount !== 'number') {
    return fail(
      checkName,
      "the standby db container's restartCount was not read, so an in-place restart cannot be shown",
      details,
    );
  }
  if (state.restartCount < 1) {
    return fail(
      checkName,
      `the standby db container's restartCount is ${state.restartCount}: the swap record did not ` +
        'come from an in-place restart of this pod (a recreated pod starts at 0)',
      details,
    );
  }
  const podS = Date.parse(state.podAt) / 1000;
  const vaS = Date.parse(state.vaAt) / 1000;
  if (!Number.isFinite(podS) || !Number.isFinite(vaS)) {
    return fail(
      checkName,
      `unparseable timestamps (pod ${state.podAt}, attachment ${state.vaAt})`,
      details,
    );
  }
  if (!(podS < state.reseededAt)) {
    return fail(
      checkName,
      `the standby db-0 was created at ${state.podAt}, after its swap ` +
        `(${new Date(state.reseededAt * 1000).toISOString()}): the pod was recreated, not restarted in place`,
      details,
    );
  }
  if (vaS > podS + FIRST_ATTACH_WINDOW_S) {
    return fail(
      checkName,
      `the standby volume's VolumeAttachment ${state.vaName} was created at ${state.vaAt}, more than ` +
        `${FIRST_ATTACH_WINDOW_S}s after db-0 (${state.podAt}): it detached and re-attached`,
      details,
    );
  }
  return { checkName, status: 'pass', details };
}

/**
 * reseed_in_place, the verdict: a reseed across one step (failover, restore)
 * swapped a new tree in while db-0, its claim, its volume and its
 * VolumeAttachment stayed the same objects, and the db container restarted
 * inside the pod.
 */
export function evaluateReseedInPlace(
  before: DbAttachState,
  after: DbAttachState,
): VerificationResult {
  const checkName = 'reseed_in_place';
  const details = { before, after };
  const same = (k: keyof DbAttachState, what: string): VerificationResult | null => {
    if (before[k] === undefined || after[k] === undefined || before[k] === after[k]) return null;
    return fail(
      checkName,
      `${what} changed across the reseed (${before[k]} -> ${after[k]})`,
      details,
    );
  };
  const changed =
    same('uid', 'the standby db-0 was recreated: its uid') ??
    same('pvcUid', `the claim ${DB_PVC} was replaced: its uid`) ??
    same('pvName', `the claim ${DB_PVC} moved volumes: its volume`) ??
    same('vaName', 'the standby volume detached and re-attached: its VolumeAttachment') ??
    same('vaAt', 'the standby volume re-attached: its VolumeAttachment creationTimestamp');
  if (changed) return changed;
  if (!after.reseededFrom || after.reseededFrom === before.reseededFrom) {
    return fail(
      checkName,
      `no new swap ran: ${PGDATA}/.vc-reseeded-from is ${after.reseededFrom ?? 'absent'} ` +
        `(before the step: ${before.reseededFrom ?? 'absent'})`,
      details,
    );
  }
  if (typeof before.restartCount !== 'number' || typeof after.restartCount !== 'number') {
    return fail(
      checkName,
      `the db container's restartCount was not read (before: ${before.restartCount}, after: ` +
        `${after.restartCount}), so an in-place restart cannot be shown`,
      details,
    );
  }
  if (after.restartCount <= before.restartCount) {
    return fail(
      checkName,
      `the db container's restartCount did not rise (${before.restartCount} -> ${after.restartCount}), ` +
        'yet a new swap is recorded: the swap did not come from an in-place restart',
      details,
    );
  }
  return { checkName, status: 'pass', details };
}

const readError = (r: AttachStateRead) => (r as { error: string }).error;

/** standby_db_created_once over a read taken right after the cold deploy. */
export function checkStandbyDbCreatedOnce(opts: {
  ip: string | null;
  state: AttachStateRead | null;
}): VerificationResult {
  const checkName = 'standby_db_created_once';
  const { ip, state } = opts;
  if (!state) return fail(checkName, 'the standby db was never read after the cold deploy');
  if (!state.ok) {
    return fail(
      checkName,
      `could not read the standby db on ${ip ?? '(no IP)'}: ${readError(state)}`,
    );
  }
  return evaluateStandbyCreatedOnce((state as { state: DbAttachState }).state);
}

/** reseed_in_place over the reads taken right before and right after `step`. */
export function checkReseedInPlace(opts: {
  ip: string | null;
  step: 'failover' | 'failback' | 'restore';
  before: AttachStateRead | null;
  after: AttachStateRead | null;
}): VerificationResult {
  const checkName = 'reseed_in_place';
  const { ip, step, before, after } = opts;
  const where = ip ?? '(no IP)';
  if (!before) return fail(checkName, `the standby db was never read before the ${step}`);
  if (!after) return fail(checkName, `the standby db was never read after the ${step}`);
  if (!before.ok) {
    return fail(
      checkName,
      `could not read the standby db on ${where} before the ${step}: ${readError(before)}`,
    );
  }
  if (!after.ok) {
    return fail(
      checkName,
      `could not read the standby db on ${where} after the ${step}: ${readError(after)}`,
    );
  }
  return evaluateReseedInPlace(
    (before as { state: DbAttachState }).state,
    (after as { state: DbAttachState }).state,
  );
}

/**
 * The lines src/failover.js prints when it promotes WITHOUT a reseed (a
 * unit test pins each one to that file). Any other output means a reseed
 * ran, so reseed_in_place runs and fails closed on a missing swap.
 */
export const FAILOVER_RESEED_SKIP_LINES = Object.freeze([
  'Standby already streaming, skipping re-seed',
  'Primary unreachable, skipping re-seed',
  'Primary unreachable mid-probe, promoting standby with current state',
]);

/** Whether a failover's output says it promoted without a reseed. */
export function failoverReseedSkipped(output: string): boolean {
  return FAILOVER_RESEED_SKIP_LINES.some((line) => String(output ?? '').includes(line));
}

// ---------------------------------------------------------------------------
// promoted_db_not_recreated
// ---------------------------------------------------------------------------

/** k8s: the db StatefulSet's generation (it moves on every pod-template change). */
const DB_GENERATION_COMMAND = `${KUBECTL} get statefulset ${DB_STATEFULSET} -o jsonpath='{.metadata.generation}'`;

export type GenerationRead = { ok: true; generation: string } | { ok: false; error: string };

/** Read a k8s cluster's db StatefulSet generation. Never throws. */
export async function readDbGeneration(
  opts: SshArgs & { ip: string | null },
): Promise<GenerationRead> {
  const { mode, projectName, ip, sshKeyPath } = opts;
  const missing = missingHandle(ip, sshKeyPath, 'promotion target');
  if (missing) return { ok: false, error: missing };
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath, 'standby');
  const res = await run(ip, DB_GENERATION_COMMAND);
  if (!res.ok) return { ok: false, error: res.error ?? 'remote read failed' };
  const generation = res.output.trim();
  if (!generation) return { ok: false, error: `no db StatefulSet generation on ${ip}` };
  return { ok: true, generation };
}

/**
 * promoted_db_not_recreated: the promotion moved the wal-g role with one file
 * write and never recreated the promoted db (both HA modes).
 *
 *   - compose: compares the db container id only, read on the promotion
 *     target right before the failover and after it (a changed start time
 *     alone is not a recreate). `generationBefore` is ignored.
 *   - k8s: compares db-0's pod uid the same way, AND the db StatefulSet's
 *     generation now against `generationBefore`: the old role move
 *     (`kubectl set env` on the db) changed the pod template, which bumps the
 *     generation and rolls db-0.
 */
export async function checkPromotedDbNotRecreated(
  opts: SshArgs & {
    ip: string | null;
    /** The promotion target's db, read right before the failover. */
    before: IncarnationRead;
    /** The same node's db, read after it. */
    after: IncarnationRead;
    /** k8s: its db StatefulSet generation read before the failover; null when unread. */
    generationBefore: string | null;
  },
): Promise<VerificationResult> {
  const checkName = 'promoted_db_not_recreated';
  const { mode, projectName, ip, sshKeyPath, before, after, generationBefore } = opts;
  const readError = (r: IncarnationRead) => (r as { error: string }).error;
  if (!before.ok) {
    return fail(checkName, `could not read the db before the promotion: ${readError(before)}`);
  }
  if (!after.ok) {
    return fail(checkName, `could not read the db after the promotion: ${readError(after)}`);
  }
  const b = (before as { incarnation: DbIncarnation }).incarnation;
  const a = (after as { incarnation: DbIncarnation }).incarnation;
  if (a.id !== b.id) {
    return fail(checkName, `the promotion recreated the db on ${ip} (${b.id} -> ${a.id})`, {
      ip,
      before: b,
      after: a,
    });
  }
  if (isCompose(mode)) return { checkName, status: 'pass', details: { ip, before: b, after: a } };
  if (!generationBefore) {
    return fail(
      checkName,
      'the db StatefulSet generation was never read before the promotion, so a template ' +
        'change cannot be ruled out',
    );
  }
  const missing = missingHandle(ip, sshKeyPath, 'promoted');
  if (missing) return fail(checkName, `cannot reach the promoted cluster: ${missing}`);
  const now = await readDbGeneration({ ...opts, mode, projectName, ip, sshKeyPath });
  if (!now.ok) {
    return fail(
      checkName,
      `could not read the db StatefulSet generation: ${(now as { error: string }).error}`,
    );
  }
  const generation = (now as { generation: string }).generation;
  const details = { ip, before: b, after: a, generationBefore, generation };
  if (generation !== generationBefore) {
    return fail(
      checkName,
      `the promotion changed the db StatefulSet on ${ip} (generation ${generationBefore} -> ` +
        `${generation}): its pod template moved, so db-0 was rolled`,
      details,
    );
  }
  return { checkName, status: 'pass', details };
}

// ---------------------------------------------------------------------------
// promotion_history_archived
// ---------------------------------------------------------------------------

/** A timeline's history file name stem: 8 upper-case hex digits + `.history`. */
const historyStem = (tl: number) => `${tl.toString(16).toUpperCase().padStart(8, '0')}.history`;

/**
 * Whether a listing (one object name per line, keys or basenames) holds the
 * timeline's history file. A prefix match: wal-g stores it compressed
 * (`00000002.history.lz4`, `.br`, ...).
 */
export function historyArchived(listing: string, tl: number): boolean {
  const stem = historyStem(tl);
  return listing
    .split('\n')
    .map((l) => l.trim().split('/').pop() ?? '')
    .some((name) => name.startsWith(stem));
}

/**
 * In-db probe: the archive lineage (walg-env.sh) and the WAL file the db is
 * writing now, whose first 8 hex digits are its timeline. KEY=value lines,
 * always exits 0, no single quote (it travels as one `bash -c '...'` word).
 */
export function buildHistoryProbe(): string {
  return [
    'set -u',
    `if ! ( ${WALG_ENV_SOURCE} ) >/dev/null 2>&1; then echo "HIST=fail:no-lineage"; exit 0; fi`,
    WALG_ENV_SOURCE,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS placeholder
    'PFX="${WALG_S3_PREFIX:-}"',
    'case "$PFX" in "" | s3:///*) echo "HIST=skip:no-backup-target"; exit 0 ;; esac',
    'WF="$(psql -U postgres -d postgres -tAXc "SELECT pg_walfile_name(pg_current_wal_lsn())" 2>/dev/null | tr -d "[:space:]")"',
    'echo "HIST=probed"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion, not a JS placeholder
    'echo "HIST_LINEAGE=${PFX##*/}"',
    'echo "HIST_WALFILE=$WF"',
    'exit 0',
  ].join('\n');
}

export function buildHistoryRemoteCommand(mode: DeployMode, projectName: string): string {
  const probe = buildHistoryProbe();
  if (isCompose(mode)) {
    return `cd /opt/${projectName} && docker compose exec -T db bash -c '${probe}'`;
  }
  return `${KUBECTL} exec ${DB_POD} -c ${DB_CONTAINER} -- bash -c '${probe}'`;
}

/** Keys under a prefix in the env's backup bucket. Injected in unit tests. */
export type ListKeys = (prefix: string) => Promise<string[]>;

/** The one public method of the product's S3 provider this check uses. */
interface PrefixProbeCapableS3 {
  hasObjectsWithPrefix(bucketName: string, prefix: string): Promise<boolean>;
}

/**
 * The product's S3 client over the env's backup bucket, or why there is none.
 * The history file is one key prefix (`<timeline prefix>.history`, compressed
 * suffix after it), so a prefix probe through the public hasObjectsWithPrefix
 * is the whole listing: the history key when it is there, nothing otherwise.
 */
async function defaultListKeys(
  projectDir: string,
  envPrefix: string,
  provider: string,
): Promise<ListKeys | string> {
  const target = resolveBackupS3Target(projectDir, envPrefix);
  if (!target) return `no backupS3 in ${envPrefix}'s .vibecarbon.json`;
  const creds = resolveObjectStorageCreds(provider);
  if ('missing' in creds) return `${creds.missing.join(' and ')} not set for ${provider}`;
  const s3 = (await getObjectStorageProvider(
    provider,
    creds.accessKey,
    creds.secretKey,
    target.region,
  )) as PrefixProbeCapableS3;
  return async (prefix) => {
    const historyKey = `${prefix}.history`;
    return (await s3.hasObjectsWithPrefix(target.bucket, historyKey)) ? [historyKey] : [];
  };
}

/** How long the archive gets to show the history file (read-after-write lag). */
export const HISTORY_EVIDENCE_BUDGET_MS = 60_000;
const HISTORY_EVIDENCE_INTERVAL_MS = 5_000;

/**
 * promotion_history_archived: the promoted node archived its new timeline's
 * `.history` file. The promote-then-roll order this branch replaced left the
 * promoted node reading `standby` while it wrote that file, so wal-archive.sh
 * dropped it. Writing `primary` before pg_promote (D2) is what archives it;
 * this reads the env's backup bucket from outside to prove it.
 */
export async function checkPromotionHistoryArchived(
  opts: SshArgs & {
    ip: string | null;
    projectDir: string;
    envPrefix: string;
    /** Scenario provider; undefined means hetzner. */
    provider?: string;
    listKeys?: ListKeys;
    budgetMs?: number;
    intervalMs?: number;
  },
): Promise<VerificationResult> {
  const checkName = 'promotion_history_archived';
  const { mode, projectName, ip, sshKeyPath, projectDir, envPrefix } = opts;
  const missing = missingHandle(ip, sshKeyPath, 'promoted');
  if (missing) return fail(checkName, `cannot reach the promoted primary: ${missing}`);
  const run = opts.run ?? defaultRun(mode, projectName, sshKeyPath, 'primary');
  const res = await run(ip, buildHistoryRemoteCommand(mode, projectName));
  if (!res.ok) return fail(checkName, `could not probe the promoted db on ${ip}: ${res.error}`);
  const lines = res.output.split('\n').map((l) => l.trim());
  const value = (key: string) =>
    lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
  const status = value('HIST');
  if (status === 'skip:no-backup-target') {
    return {
      checkName,
      status: 'skip',
      details: { skipped: 'WALG_S3_PREFIX empty (backups off)' },
    };
  }
  if (status === 'fail:no-lineage') {
    return fail(
      checkName,
      `walg-env.sh on ${ip} could not read the system identifier, so it names no archive lineage`,
    );
  }
  if (status !== 'probed') {
    return fail(checkName, `unreadable history probe from ${ip}: ${res.output.slice(0, 200)}`);
  }
  const lineage = value('HIST_LINEAGE');
  const walfile = value('HIST_WALFILE');
  if (!/^[0-9]+$/.test(lineage) || !/^[0-9A-F]{24}$/.test(walfile)) {
    return fail(
      checkName,
      `the promoted db on ${ip} reported no lineage or WAL file (lineage ${lineage || '(empty)'}, ` +
        `WAL file ${walfile || '(empty)'}): still in recovery, or psql did not answer`,
    );
  }
  const tl = Number.parseInt(walfile.slice(0, 8), 16);
  if (tl < 2) {
    return fail(checkName, `the promoted db on ${ip} is on timeline 1: nothing was promoted`);
  }
  let listKeys = opts.listKeys;
  if (!listKeys) {
    const resolved = await defaultListKeys(projectDir, envPrefix, opts.provider ?? 'hetzner');
    if (typeof resolved === 'string') {
      return fail(
        checkName,
        `cannot list the archive, but the promoted db archives to a bucket: ${resolved}`,
      );
    }
    listKeys = resolved;
  }
  const prefix = walSegmentKeyPrefix(projectName, envPrefix, lineage, walfile.slice(0, 8));
  const stem = historyStem(tl);
  const budgetMs = opts.budgetMs ?? HISTORY_EVIDENCE_BUDGET_MS;
  const intervalMs = opts.intervalMs ?? HISTORY_EVIDENCE_INTERVAL_MS;
  const deadline = Date.now() + budgetMs;
  let found = false;
  let lastError: string | undefined;
  // One bounded wait on one condition (the object is listed), as
  // backup-evidence.ts waits for a segment: object storage lags its writes.
  for (;;) {
    try {
      found = historyArchived((await listKeys(prefix)).join('\n'), tl);
      lastError = undefined;
    } catch (err) {
      lastError = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }
    if (found || Date.now() + intervalMs > deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const details = { ip, lineage, timeline: tl, prefix };
  if (!found) {
    return fail(
      checkName,
      `the promoted db on ${ip} is on timeline ${tl}, but no ${stem} is archived under ${prefix}: ` +
        'the promotion was not archived as primary' +
        (lastError ? `. Last listing error: ${lastError}` : ''),
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

/**
 * The backend read the CLI's flipAndVerifyDns uses, typed from a real backend
 * so a change to its return shape breaks tsc here. Every A target at a name.
 */
type BackendReadARecord = typeof readARecord;
type ReadA = (name: string) => ReturnType<BackendReadARecord>;

interface RawEnv {
  lastFailover?: string;
  deployedAt?: string;
  dns?: { provider?: string; zoneId?: string } | null;
  servers?: Array<{ ip?: string; role?: string }>;
  ha?: {
    primary?: { masterIp?: string; floatingIp?: string; ingressIp?: string };
    standby?: { masterIp?: string };
  };
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
 * The IP the A records must carry: k8s-ha flips them to the primary's ingress
 * IP (clusterIngressIp, as src/failover.js reads it: the recorded ingressIp,
 * else the floating IP, else the master, which is what DigitalOcean clusters
 * use), compose-ha to the node whose role is primary.
 */
export function readServingIp(projectDir: string, env: string): string | null {
  const envConfig = readEnv(projectDir, env);
  if (!envConfig) return null;
  const ha = envConfig.ha;
  if (ha?.primary?.masterIp && ha?.standby?.masterIp) {
    return clusterIngressIp(ha.primary);
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
  // getDnsProvider resolves a module typed `object`; the contract surface is
  // uniform across backends (dns-mutation-status-census), so name its reader
  // with the real backend's type rather than a hand-written one.
  let backend: { readARecord: BackendReadARecord };
  try {
    backend = (await getDnsProvider(dns.provider)) as { readARecord: BackendReadARecord };
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
  const seen: Record<string, string[]> = {};
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
  // Exactly [expectedIp], as flipAndVerifyDns requires: a stale second A
  // record would keep sending part of the traffic to the retired node.
  const wrong = Object.entries(seen).filter(
    ([, ips]) => !Array.isArray(ips) || ips.length !== 1 || ips[0] !== expectedIp,
  );
  if (wrong.length > 0) {
    const shown = (ips: string[]) =>
      Array.isArray(ips) && ips.length > 0 ? ips.join(', ') : 'nothing';
    return fail(
      checkName,
      `the DNS provider holds ${wrong.map(([n, ips]) => `${n} -> ${shown(ips)}`).join('; ')}, not only ${expectedIp}`,
      { expectedIp, seen },
    );
  }
  return { checkName, status: 'pass', details: { expectedIp, seen } };
}

/**
 * dns_flip_verified for one scenario: read the env's serving IP and its A
 * records through the DNS provider API and check them. `computeToken` is the
 * scenario's OWN compute provider's token, so a compute-backed DNS row
 * (same-token rule in resolveDnsToken) authenticates with the right cloud.
 */
export async function verifyDnsFlip(opts: {
  projectDir: string;
  envPrefix: string;
  domain: string;
  provider: string;
  computeToken: string;
}): Promise<VerificationResult> {
  const reader = await providerApiAReader(opts.projectDir, opts.envPrefix, {
    computeProviderId: opts.provider,
    computeToken: opts.computeToken,
  });
  return checkDnsFlipVerified({
    domain: opts.domain,
    expectedIp: readServingIp(opts.projectDir, opts.envPrefix),
    readA: reader.readA,
    readerError: reader.error,
    skipReason: reader.skipReason,
  });
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
