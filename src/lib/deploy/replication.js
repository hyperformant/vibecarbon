/**
 * Shared PostgreSQL replication / re-seed / promotion primitives.
 *
 * The standby re-seed, streaming verification, and promotion logic used to be
 * duplicated (and slowly diverging) across:
 *   - src/lib/deploy/k8s/ha/index.js   (setupReplication — deploy-time seed)
 *   - src/failover.js                  (reseed + promote at failover)
 *   - src/lib/deploy/compose/ha.js     (configureStandbyReplication + verify)
 *   - src/restore.js                   (post-restore standby resync)
 *
 * This module houses the reusable, exec-backend-parameterized primitives so the
 * call sites share ONE hardened implementation instead of forking it. The two
 * exec backends differ only in HOW a command reaches postgres:
 *   - compose: `docker compose exec -T db psql …`  (via sshRun)
 *   - k8s:     `sshKubectl exec -n vibecarbon <pod> -- …`
 * so the primitives take an injected runner / readState closure rather than
 * hardcoding either transport.
 */

import { randomBytes } from 'node:crypto';
import { loadProjectConfig } from '../config.js';
import { hasSentinelLine, refusalFromError, sentinelLinePayload } from '../remote-sentinel.js';
import { getPostgresPod, sshKubectl } from '../ssh.js';
import {
  DB_CONTAINER,
  DB_GUARD_COMMAND,
  DB_GUARD_PROTOCOL_MARKER,
  DB_POD,
  DB_STATEFULSET,
} from './db-workload.js';
import { ensureReplicationSlotSql, REPLICATION_SLOT } from './replication-slot.js';
import {
  DB_ROLE_CONFIGMAP,
  DB_ROLE_INTENT_KEY,
  podMountsWalgRoleDir,
  WALG_ROLE_DIR,
} from './walg-role.js';
import { REPL_GATEWAY_PORT } from './wireguard.js';

/**
 * Shared budget for every db-StatefulSet boot/rollout wait (the deploy-side
 * reseed standbyBoot in k8s/ha/index.js, and the failover/restore-side
 * in-place reseed: its restart wait and recovery wait below). 600s, raised from 300s
 * 2026-08-29: DigitalOcean CSI detach/attach settle pushed a HEALTHY
 * standby boot past 300s (run 33252884427 — the rollout wait timed out and
 * the failure diagnostics a minute later showed the pod Ready); Hetzner
 * CSI reattach was already documented as "minutes" beside those waits. Any
 * SSH client timeout wrapping a wait on this budget must exceed it, or the
 * transport kills kubectl before kubectl can name the stuck sts
 * (k8sDbRolloutWait keeps its ssh budget 30s above it;
 * db-sts-boot-timeout-census.test.ts drafts new waits into this budget).
 */
export const DB_STS_BOOT_TIMEOUT_S = 600;

/** Staged restore fetches stream at least this fast; it sizes the rollout wait (M1). */
export const RESTORE_FETCH_FLOOR_BYTES_PER_S = 20 * 1024 ** 2;

/**
 * The db rollout wait for a restore of `sizeBytes`: the boot floor, or the
 * time the fetch needs at RESTORE_FETCH_FLOOR_BYTES_PER_S, whichever is
 * longer. Shared by `vibecarbon restore` and `deploy -restore` (C13).
 */
export function restoreRolloutTimeoutS(sizeBytes) {
  return Math.max(
    DB_STS_BOOT_TIMEOUT_S,
    Math.ceil((Number(sizeBytes) || 0) / RESTORE_FETCH_FLOOR_BYTES_PER_S),
  );
}

/**
 * The slowest an in-place reseed's pg_basebackup is expected to move the
 * primary's databases: 10 MiB/s. Half the restore fetch floor
 * (RESTORE_FETCH_FLOOR_BYTES_PER_S, parallel S3 GETs inside one region),
 * because the basebackup is ONE TCP stream from the primary cluster in
 * another region, through the socat relays and the WireGuard tunnel, and
 * the primary keeps serving while it reads.
 */
export const RESEED_BASEBACKUP_FLOOR_BYTES_PER_S = 10 * 1024 ** 2;

/**
 * The in-place stage's two bounds for a primary of `sizeBytes`, the way
 * restoreRolloutTimeoutS sizes a restore:
 *   - remoteS: the deadline the stage puts on pg_basebackup itself (killed
 *     past it): the boot floor, or the transfer at the floor rate, whichever
 *     is longer;
 *   - clientS: twice that, the ssh client's bound on the whole exec. The
 *     second half covers the stage's pass over the tree it fetched (the
 *     PG_VERSION check, the .vc-* strip, chown -R, the syncs), so the client
 *     never gives up on a stage that is still running and holds the lock.
 * An unknown size gets the floor.
 *
 * @param {number} sizeBytes
 * @returns {{remoteS: number, clientS: number}}
 */
export function reseedStageBoundsS(sizeBytes) {
  const remoteS = Math.max(
    DB_STS_BOOT_TIMEOUT_S,
    Math.ceil((Number(sizeBytes) || 0) / RESEED_BASEBACKUP_FLOOR_BYTES_PER_S),
  );
  return { remoteS, clientS: 2 * remoteS };
}

/** The db container's PGDATA (both tiers mount the data volume here). */
const PGDATA_DIR = '/var/lib/postgresql/data';

/**
 * Where the in-place standby reseed stages its tree: inside the live PGDATA,
 * on the same filesystem, the exact path db-guard.sh swaps from
 * (carbon/volumes/db/db-guard.sh, `R_STAGE`).
 */
export const IN_PLACE_RESEED_DIR = '/var/lib/postgresql/data/.vc-reseed';

/** An in-place reseed attempt id: one shell word, safe unquoted in any marker. */
const IN_PLACE_ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The planned-failover write fence: a server-wide default set with ALTER
 * SYSTEM (postgresql.auto.conf). Never ALTER ROLE / ALTER DATABASE SET: those
 * are catalog writes, so they replicate to the standby and survive its promote.
 * ALTER SYSTEM is a file on the node, so the stream never carries it.
 */
export const WRITE_FENCE_SETTING = 'default_transaction_read_only';

// The single replication port for BOTH HA modes. compose publishes db:5432 →
// host:5433 (over WireGuard only); k8s uses a hostPort 5433 → container
// 5432. One port keeps primary_conninfo / pg_basebackup byte-identical.
export const REPL_PORT = 5433;

/** The cluster identity pg_basebackup copies and initdb mints fresh. */
export const SYSTEM_IDENTIFIER_SQL = 'SELECT system_identifier FROM pg_control_system()';

/**
 * The `primary_conninfo` the standby uses to stream from the primary. The
 * transport is a point-to-point WireGuard tunnel (see wireguard.js) — the
 * wire is already encrypted at the network layer, so Postgres itself runs
 * plaintext (`sslmode=disable`, no CA to verify against). `primaryHost` is
 * the local tunnel-side endpoint the transport layer supplies (e.g. the
 * WireGuard gateway IP), not a public address. `port` defaults to REPL_PORT
 * (5433) for the compose path where the standby dials the primary db directly;
 * the k8s-ha path passes the repl-gateway relay port (15433) since it dials its
 * local socat gateway rather than postgres directly.
 * @param {{primaryHost:string, replPassword:string, applicationName?:string, port?:string|number}} o
 * @returns {string}
 */
export function buildPrimaryConninfo({
  primaryHost,
  replPassword,
  applicationName = 'standby',
  port = REPL_PORT,
}) {
  return (
    `host=${primaryHost} port=${port} user=replicator ` +
    `password=${replPassword} sslmode=disable ` +
    `application_name=${applicationName}`
  );
}

/**
 * pg_hba.conf line allowing replication from the given CIDR. Plain `host`
 * (not `hostssl`) — WireGuard encrypts the wire, so Postgres does not also
 * require TLS. Auth stays scram-sha-256 with the per-deploy random
 * REPL_PASSWORD regardless of source.
 * @param {string} peerCidr
 * @returns {string}
 */
export function buildReplicationHbaLine(peerCidr) {
  return `host replication replicator ${peerCidr} scram-sha-256`;
}

/**
 * Multi-CIDR form of buildReplicationHbaLine — one line per CIDR, in order.
 *
 * Why more than the WireGuard /30: the replication connection is RELAYED
 * (socat gateway → hostPort/published-port → NAT into the pod/bridge network),
 * so the source address postgres actually sees is NOT the tunnel IP — it is
 * the last NAT hop:
 *   - k8s: the node's CNI gateway inside the cluster pod CIDR (live RCA
 *     2026-07-06 e4 rig: `FATAL: no pg_hba.conf entry … from host "10.42.2.1"`
 *     — k3s cni0; per-node /24s carved from the 10.42.0.0/16 default, so a
 *     single /32 or per-node /24 would be fragile).
 *   - compose: the docker bridge gateway of the project network (docker-proxy
 *     for the published 5433 port).
 * Security framing: every admitted CIDR is a non-routable, cluster/host-
 * INTERNAL source. The only cross-host path into these sources remains the
 * WireGuard tunnel (UDP 51821, peer-scoped Hetzner firewall rule), and auth
 * remains scram-sha-256 with a per-deploy random password.
 *
 * @param {string[]} cidrs
 * @returns {string[]} one pg_hba line per CIDR
 */
export function buildReplicationHbaLines(cidrs) {
  return cidrs.map((cidr) => buildReplicationHbaLine(cidr));
}

/**
 * Build the hardened staged-basebackup + atomic-swap bash script.
 *
 * This is the SINGLE source for the k8s re-seed script used at deploy time
 * (k8s/ha/index.js setupReplication) AND at failover/restore time (failover.js,
 * restore.js). Hardenings preserved from the previous inline copies:
 *   1. `set -e -o pipefail` — a partial pg_basebackup leaves PGDATA non-empty
 *      without PG_VERSION; the db entrypoint then runs initdb on next
 *      restart, aborts on "directory exists but is not empty", and CrashLoops.
 *   2. Stage into a tmp dir + atomic swap — a failed backup never leaves PGDATA
 *      half-formed; the original survives at data.prev until the swap succeeds.
 *   3. Verify PG_VERSION present before swapping in.
 *   4. `probeFirst` embeds a pg_isready guard that aborts (exit 0) BEFORE any
 *      destructive work when the primary is unreachable — the standby then keeps
 *      its self-bootstrapped postgres instead of a permanent CrashLoopBackOff.
 *      (Used by the deploy-time k8s seed, where the probe is inline; the
 *      failover/restore path probes separately, so it passes probeFirst=false.)
 *
 * The replication password is embedded in PGPASSWORD inside the returned script,
 * which callers MUST deliver over stdin (never argv) so it stays out of
 * /proc/cmdline and the ssh command string.
 *
 * The connection itself is plaintext (no PGSSLMODE/PGSSLROOTCERT) — the
 * transport is a point-to-point WireGuard tunnel (wireguard.js) that already
 * encrypts the wire, so app-layer TLS is redundant.
 *
 * Swap phase (finding 2026-07-06): the destructive in-container swap is now
 * OPTIONAL (`swap`, default true). The k8s-HA deploy seed sets `swap:false` and
 * stages the basebackup into a subdir of PGDATA (`stagingDir`), then performs
 * the atomic swap NODE-SIDE after scaling the pod to zero — because in the
 * db pod the postmaster is PID 1, so an in-pod `pg_ctl stop` (which
 * every swap-in-place path implicitly relied on the caller running first)
 * terminates the container and kubelet restarts it as a fresh independent
 * primary. compose + failover/restore keep the combined `swap:true` behavior
 * (their re-seed stops the db from OUTSIDE the container, so it is unaffected).
 *
 * @param {object} opts
 * @param {string} opts.replPassword
 * @param {string} opts.primaryHost
 * @param {string} [opts.primaryPort='5432']
 * @param {string} [opts.slotName=REPLICATION_SLOT] - the PERSISTENT physical
 *   slot the post-swap standby streams through (written as `primary_slot_name`
 *   into the staged postgresql.auto.conf). NOT used for the basebackup itself —
 *   see basebackupSlot.
 * @param {string|null} [opts.basebackupSlot=null] - the slot pg_basebackup's
 *   `-Xs` WAL receiver attaches to DURING the backup. Default null → NO `-S`
 *   flag → pg_basebackup uses a TEMPORARY slot. This is deliberate: a re-seed
 *   can run while the standby's own walreceiver still holds the persistent slot
 *   (an already-streaming standby, or one mid-reconnect), and
 *   `pg_basebackup -S <persistent slot>` then errors "replication slot is active
 *   for PID …" (live RCA compose-ha 2026-07-07). A temporary slot never
 *   collides. The gap between the temp slot dropping and the standby reconnecting
 *   on the persistent slot is covered by wal_keep_size (512MB). Pass an explicit
 *   name only if a caller truly needs the backup to advance the persistent slot.
 * @param {boolean} [opts.probeFirst=false]
 * @param {number} [opts.probeAttempts=12] - probe retry budget. A single-shot
 *   probe races transport re-establishment (RCA 2026-07-06 e4 rig: the k8s
 *   deploy deletes the primary db pod moments before the seed, and the relay
 *   path can lag pg_isready-in-pod readiness), silently skipping the whole
 *   reseed. Retry with a real budget (default 12 × 10s ≈ 2 min, each attempt
 *   logged) before concluding the primary is unreachable.
 * @param {number} [opts.probeDelayS=10] - seconds between probe attempts.
 * @param {boolean} [opts.swap=true] - perform the destructive in-place PGDATA
 *   swap at the end. false leaves the verified basebackup in `stagingDir` for a
 *   node-side swap (k8s-HA deploy seed).
 * @param {string} [opts.stagingDir='/var/lib/postgresql/data.staging'] - where
 *   pg_basebackup stages. For a node-side swap this MUST live on the PVC
 *   filesystem (a subdir of PGDATA) so the later rename is atomic.
 * @param {string} [opts.pgdataDir='/var/lib/postgresql/data'] - the live PGDATA
 *   (only used by the in-place swap block).
 * @param {string} [opts.primaryConninfo=''] - when set, the explicit streaming
 *   primary_conninfo is appended to the STAGING dir's postgresql.auto.conf
 *   (used by swap:false so the conninfo is in place before the node-side swap;
 *   the password is embedded here and MUST be delivered over stdin, never argv).
 * @param {string} [opts.label='reseed'] - tag for the script's stderr breadcrumbs
 * @param {string|null} [opts.inPlaceAttempt=null] - in-place reseed mode: the
 *   attempt id. Requires `swap: false` and `stagingDir` = `<pgdataDir>/.vc-reseed`
 *   (IN_PLACE_RESEED_DIR). The script then runs only under the standby intent,
 *   clears any earlier ready marker and staging, stages, strips every `.vc-*`
 *   the source carried, stamps `.vc-reseed-id`, and writes
 *   `<pgdataDir>/.vc-reseed-ready` LAST (tmp, sync, rename, sync) for
 *   db-guard.sh to swap on the next container start. Prints
 *   `RESEED_STAGED <id>`, or `RESEED_SKIPPED` when the probe gives up.
 * @returns {string}
 */
export function buildStagedBasebackupScript({
  replPassword,
  primaryHost,
  primaryPort = String(REPL_PORT),
  slotName = REPLICATION_SLOT,
  basebackupSlot = null,
  probeFirst = false,
  probeAttempts = 12,
  probeDelayS = 10,
  swap = true,
  stagingDir = '/var/lib/postgresql/data.staging',
  pgdataDir = '/var/lib/postgresql/data',
  primaryConninfo = '',
  label = 'reseed',
  inPlaceAttempt = null,
  basebackupDeadlineS = null,
  intent = null,
}) {
  const inPlace = inPlaceAttempt !== null && inPlaceAttempt !== undefined;
  if (inPlace && intent !== 'standby') {
    // The intent that decides is the one the NEXT container start reads (the
    // vibecarbon-db-role ConfigMap, which the CLI's guard read), never the
    // running container's env, which still names the old role after a
    // failover swapped them.
    throw new Error(
      `buildStagedBasebackupScript: an in-place stage needs the standby role intent the CLI read (got ${intent ? `'${intent}'` : 'none'})`,
    );
  }
  if (basebackupDeadlineS !== null && basebackupDeadlineS !== undefined) {
    if (!inPlace) {
      throw new Error('buildStagedBasebackupScript: basebackupDeadlineS is for an in-place stage');
    }
    if (!Number.isInteger(basebackupDeadlineS) || basebackupDeadlineS < 1) {
      throw new Error(
        `buildStagedBasebackupScript: ${JSON.stringify(basebackupDeadlineS)} is not a deadline in whole seconds`,
      );
    }
  }
  const deadline = inPlace && basebackupDeadlineS ? basebackupDeadlineS : null;
  const readyMarker = `${pgdataDir}/.vc-reseed-ready`;
  if (inPlace) {
    if (typeof inPlaceAttempt !== 'string' || !IN_PLACE_ATTEMPT_RE.test(inPlaceAttempt)) {
      throw new Error(
        `buildStagedBasebackupScript: ${JSON.stringify(inPlaceAttempt)} is not an in-place reseed attempt id`,
      );
    }
    if (swap) {
      throw new Error(
        'buildStagedBasebackupScript: an in-place reseed never swaps in-pod (swap: false)',
      );
    }
    if (stagingDir !== `${pgdataDir}/.vc-reseed`) {
      throw new Error(
        `buildStagedBasebackupScript: an in-place reseed stages at ${pgdataDir}/.vc-reseed, where db-guard.sh swaps from, not ${stagingDir}`,
      );
    }
  }
  // In-place mode words the probe so that nothing before the skip names the
  // base backup tool: the skip provably comes first.
  const probeUnreachable = inPlace
    ? `  echo "[${label}] primary postgres at ${primaryHost}:${primaryPort} not reachable from standby after ${probeAttempts} attempts; nothing staged, the standby keeps its data directory." >&2
  echo RESEED_SKIPPED
  exit 0`
    : `  echo "[${label}] primary postgres at ${primaryHost}:${primaryPort} not reachable from standby after ${probeAttempts} attempts, skipping pg_basebackup. Standby keeps its independent postgres; failover serves the app but data does not sync from primary." >&2
  exit 0`;
  const probeBlock = probeFirst
    ? `
# Probe primary's postgres from inside the standby container, WITH a retry
# budget: the transport (relay/tunnel or a just-restarted primary pod) can lag
# a single-shot probe by tens of seconds (RCA 2026-07-06: the k8s deploy
# deletes the primary db pod moments before this seed runs). Only after the
# whole budget lapses do we conclude "unreachable" and abort cleanly, so the
# standby keeps its self-bootstrapped postgres rather than entering a
# permanent CrashLoopBackOff via half-wiped PGDATA.
#
# NOTE: pg_isready does NOT authenticate — it only checks that the server
# answers the startup packet, so it sails straight through pg_hba. A green
# probe therefore proves the RELAY PATH is up, not that replication auth will
# succeed (live RCA 2026-07-06: probe OK, then ${inPlace ? 'the base backup' : 'pg_basebackup'} FATAL
# "no pg_hba.conf entry" — the post-NAT source CIDR was missing from pg_hba).
probe_ok=0
for probe_i in $(seq 1 ${probeAttempts}); do
  if pg_isready -h ${primaryHost} -p ${primaryPort} -t 5 -U replicator -d postgres > /dev/null 2>&1; then
    probe_ok=1
    break
  fi
  echo "[${label}] probe attempt \${probe_i}/${probeAttempts}: primary postgres at ${primaryHost}:${primaryPort} not reachable yet" >&2
  if [ "\${probe_i}" -lt ${probeAttempts} ]; then
    sleep ${probeDelayS}
  fi
done
if [ "\${probe_ok}" != "1" ]; then
${probeUnreachable}
fi
`
    : '';

  // Explicit primary_conninfo (last entry in postgresql.auto.conf wins). Written
  // into the STAGING dir so it survives the node-side swap. Heredoc-quoted so the
  // interpolated value (already a literal) is not re-expanded by the shell.
  const conninfoBlock = primaryConninfo
    ? `
cat >> ${stagingDir}/postgresql.auto.conf <<'REPL_CONNINFO_EOF'
primary_conninfo = '${primaryConninfo}'
REPL_CONNINFO_EOF
`
    : '';

  // Replace PGDATA CONTENTS in place. /var/lib/postgresql/data is a container
  // volume MOUNTPOINT in both compose (db_data:/var/lib/postgresql/data) and the
  // failover/restore k8s re-seed — it CANNOT be renamed (mv of a mountpoint fails
  // with EBUSY/EXDEV), so we clear the mountpoint and move the verified staged
  // basebackup in. The staged copy is already verified good (PG_VERSION check
  // above) before this destructive clear, so a known-good replacement exists
  // before we touch the live dir.
  const swapBlock = inPlace
    ? `
# In-place reseed: the staged tree is complete and every edit is in. The
# ready marker goes in last, by rename between two syncs, so it is never on
# disk ahead of the tree it names. db-guard.sh swaps the tree in on the db
# container's next start, and only under the standby intent.
sync
printf '%s' '${inPlaceAttempt}' > ${readyMarker}.tmp
sync
mv -f ${readyMarker}.tmp ${readyMarker}
sync
echo "RESEED_STAGED ${inPlaceAttempt}"
`
    : swap
      ? `
find ${pgdataDir} -mindepth 1 -delete
find ${stagingDir} -mindepth 1 -maxdepth 1 -exec mv -t ${pgdataDir}/ {} +
rmdir ${stagingDir}
chown -R postgres:postgres ${pgdataDir}
`
      : `
# swap=false: leave the verified basebackup in ${stagingDir}. The caller stops
# the db container and performs the atomic PGDATA swap on the host (stopping
# postgres from inside would kill the container: the postmaster is PID 1).
`;

  // pg_basebackup slot policy: default (basebackupSlot=null) omits `-S`, so the
  // `-Xs` WAL receiver spins up a TEMPORARY slot for the duration of the backup.
  // The persistent slot (slotName) is reserved for post-swap streaming
  // (primary_slot_name, below) — attaching the basebackup to it would collide
  // with an already-streaming standby's live walreceiver ("slot is active").
  const basebackupSlotFlag = basebackupSlot ? ` -S ${basebackupSlot}` : '';

  const basebackupBlock = deadline
    ? `
# Stage into a tmp dir; atomic swap only after basebackup verifies good.
rm -rf ${stagingDir}
mkdir -p ${stagingDir}
chown postgres:postgres ${stagingDir}

# The remote deadline (reseedStageBoundsS): past it the transfer is killed,
# so the stage, and the lock it holds, never outlive the client waiting on
# it. The kill takes pg_basebackup's whole process tree: -Xs forks a WAL
# streamer that keeps writing into the staging (and holds this lock's fd)
# when only its parent dies, and busybox timeout kills only the parent. A
# frozen (SIGSTOP) process forks nothing new while its children go first.
# The watchdog keeps no fd of the stage: not the lock, not the exec's output.
vc_kill_tree() {
  kill -STOP "$1" 2>/dev/null || return 0
  for vc_child in $(pgrep -P "$1" 2>/dev/null); do vc_kill_tree "$vc_child"; done
  kill -KILL "$1" 2>/dev/null || true
}
vc_bb_start=$(date +%s)
vc_bb_rc=0
PGPASSWORD='${replPassword}' pg_basebackup \\
  -h ${primaryHost} -p ${primaryPort} \\
  -U replicator -D ${stagingDir} \\
  -Fp -Xs -R -c fast${basebackupSlotFlag} &
vc_bb_pid=$!
( sleep ${deadline}; vc_kill_tree "$vc_bb_pid" ) >/dev/null 2>&1 9>&- &
vc_wd_pid=$!
wait "$vc_bb_pid" || vc_bb_rc=$?
vc_kill_tree "$vc_wd_pid"
if [ "$vc_bb_rc" != 0 ]; then
  # The verdict first: the cleanup below may not finish, the sentinel must.
  if [ $(( $(date +%s) - vc_bb_start )) -ge ${deadline} ]; then
    echo "[${label}] pg_basebackup did not finish within ${deadline}s and was stopped; nothing staged" >&2
    echo "RESEED_TIMEOUT ${deadline}"
  fi
  rm -rf ${stagingDir} 2>/dev/null || true
  if [ -e ${stagingDir} ]; then
    echo "[${label}] ${stagingDir} was not fully removed; it has no ready marker, so nothing swaps it in, and the next stage clears it" >&2
  fi
  exit 1
fi

# A successful pg_basebackup always writes PG_VERSION (and standby.signal via -R).
if [ ! -f ${stagingDir}/PG_VERSION ]; then
  echo "[${label}] pg_basebackup produced no PG_VERSION, refusing to swap" >&2
  rm -rf ${stagingDir}
  exit 1
fi`
    : `
# Stage into a tmp dir; atomic swap only after basebackup verifies good.
rm -rf ${stagingDir}
mkdir -p ${stagingDir}
chown postgres:postgres ${stagingDir}

PGPASSWORD='${replPassword}' pg_basebackup \\
  -h ${primaryHost} -p ${primaryPort} \\
  -U replicator -D ${stagingDir} \\
  -Fp -Xs -R -c fast${basebackupSlotFlag}

# A successful pg_basebackup always writes PG_VERSION (and standby.signal via -R).
if [ ! -f ${stagingDir}/PG_VERSION ]; then
  echo "[${label}] pg_basebackup produced no PG_VERSION, refusing to swap" >&2
  rm -rf ${stagingDir}
  exit 1
fi`;

  // In-place mode: the lock and the clean slate come before anything else.
  // No intent gate here: the running container's VC_WALG_ROLE_INTENT is the
  // value from its own start, stale after a failover swapped the roles (a
  // reconverge refused on exactly that, 2026-11-04). The caller passes the
  // ConfigMap intent its guard read (checked above), and db-guard.sh swaps
  // only under the intent the restarted container resolves. The lock is
  // the one restore and db-guard.sh take: a kubectl exec whose client dropped
  // keeps running, and a second stage over it would mix two base backups into
  // a tree that passes every proof. The loser prints RESEED_REFUSED busy and
  // exits 1: a refusal to report, never one to retry. The old ready marker
  // goes first (and durably), so it can never name the tree staged next;
  // then any staging it leaves is cleared.
  const lockFile = `${pgdataDir}/.vc-restore.lock`;
  const inPlaceHead = inPlace
    ? `
if [ -L ${lockFile} ]; then
  echo "[${label}] RESEED_REFUSED: ${lockFile} is a symlink; nothing staged" >&2
  exit 1
fi
exec 9>${lockFile}
if ! flock -n 9; then
  echo "[${label}] a restore or another reseed stage holds ${lockFile}; nothing staged" >&2
  echo "RESEED_REFUSED busy"
  exit 1
fi
# Defensive: db-guard.sh settles a swap before postgres starts, so a running
# standby never holds this marker. If one is here anyway, leave it alone.
if [ -e ${pgdataDir}/.vc-reseed-in-progress ] || [ -L ${pgdataDir}/.vc-reseed-in-progress ]; then
  echo "[${label}] RESEED_REFUSED: a reseed swap is in progress (${pgdataDir}/.vc-reseed-in-progress); nothing staged" >&2
  exit 1
fi
rm -f ${readyMarker} ${readyMarker}.tmp
sync
rm -rf ${stagingDir}
`
    : '';

  // In-place mode: a source that was once a standby (a failed-back primary)
  // carries its .vc-* entries, and db-guard.sh refuses a staging holding any
  // but the attempt id. Strip them all, then stamp this attempt.
  const inPlaceStamp = inPlace
    ? `
find ${stagingDir} -mindepth 1 -maxdepth 1 -name '.vc-*' -exec rm -rf {} +
printf '%s' '${inPlaceAttempt}' > ${stagingDir}/.vc-reseed-id`
    : '';

  // In-place mode runs under the db image's sh, POSIX: nothing here pipes, so
  // pipefail is not needed (and dash has none).
  const setLine = inPlace ? 'set -eu' : 'set -e -o pipefail';

  return `
${setLine}
${inPlaceHead}${probeBlock}${basebackupBlock}${inPlaceStamp}
# -R should already have created standby.signal; touch belt-and-suspenders.
touch ${stagingDir}/standby.signal
echo "primary_slot_name = '${slotName}'" >> ${stagingDir}/postgresql.auto.conf
# hot_standby MUST be on: with it off, the reseeded standby streams fine but
# REFUSES read-only connections ("FATAL: the database system is not accepting
# connections / DETAIL: Hot standby mode is disabled"), failing every
# pg_is_in_recovery() check. The previous image shipped a config include with
# 'hot_standby = off' (live RCA 2026-07-06 e4 rig); postgresql.auto.conf is read
# LAST, so pinning it here wins over any image config on both staging paths
# (k8s + compose). Harmless after promotion (ignored outside recovery).
echo "hot_standby = on" >> ${stagingDir}/postgresql.auto.conf
# A planned failover fences the primary with ALTER SYSTEM SET
# default_transaction_read_only, which lives in postgresql.auto.conf, and
# pg_basebackup copies that file: a standby seeded from a fenced primary would
# come up read-only once promoted. The staged copy never keeps it.
sed -i '/^[[:space:]]*${WRITE_FENCE_SETTING}[[:space:]]*=/d' ${stagingDir}/postgresql.auto.conf
${conninfoBlock}chown -R postgres:postgres ${stagingDir}
${swapBlock}`.trim();
}

/**
 * Build the atomic PGDATA swap script for the compose-ha standby re-seed.
 *
 * Runs AFTER the db has been stopped from outside (never inside the db
 * container, whose PID 1 is the postmaster), on the HOST via ssh
 * (`pgdataDir` is the db volume's host Mountpoint) after
 * `docker compose stop db`. k8s never uses it: a k8s standby reseeds in
 * place (reseedStandbyInPlace, db-guard.sh swaps the tree on the db
 * container's next start), so its volume never detaches.
 * `buildStagedBasebackupScript({swap:false})` has already staged a verified
 * basebackup into `<pgdataDir>/<stagingName>` (a subdir of PGDATA, hence on the
 * same filesystem), with standby.signal + primary_conninfo written in. This
 * script swaps it in with three same-filesystem renames (atomic, no copy) and
 * preserves numeric ownership (the staging tree was chowned to the in-container
 * postgres uid, which the same image reuses on restart — so NO host-side chown,
 * whose name→uid mapping would differ).
 *
 * Emits a sentinel on stdout the caller reads:
 *   - `RESEED_SWAPPED` — the new basebackup is now PGDATA.
 *   - `RESEED_SKIPPED` — no verified staging (basebackup was skipped because the
 *     primary was unreachable, or it failed); the standby's own PGDATA is left
 *     untouched. The caller must treat this as DEGRADED (warm standby), NOT as a
 *     hard failure — it mirrors the probeFirst skip.
 * Exits non-zero (fails loud) only when staging exists but is missing an
 * invariant (standby.signal / primary_conninfo) — a corrupt reseed.
 *
 * Keeps at most ONE stale prev-generation copy: `${pgdataDir}.old` from a prior
 * reseed is removed at the start of every swap.
 *
 * @param {object} opts
 * @param {string} opts.pgdataDir - node-local PGDATA path (…/<pvc-dir>/<subPath>).
 * @param {string} [opts.stagingName='.reseed_staging'] - staging subdir name.
 * @returns {string}
 */
export function buildNodePgdataSwapScript({ pgdataDir, stagingName = '.reseed_staging' }) {
  return `
set -e -o pipefail
PGDATA='${pgdataDir}'
STAGING="$PGDATA/${stagingName}"

# Bounded cleanup: at most one stale prev-generation PGDATA survives a reseed.
rm -rf "$PGDATA.old" "$PGDATA.new"

if [ ! -f "$STAGING/PG_VERSION" ]; then
  # No verified staging: the basebackup was skipped (primary unreachable) or
  # failed. Leave the standby's independent PGDATA untouched — DEGRADED path.
  rm -rf "$STAGING"
  echo RESEED_SKIPPED
  exit 0
fi
if [ ! -f "$STAGING/standby.signal" ]; then
  echo "[reseed-swap] staging is missing standby.signal, refusing to swap" >&2
  exit 1
fi
if ! grep -q primary_conninfo "$STAGING/postgresql.auto.conf" 2>/dev/null; then
  echo "[reseed-swap] staging is missing primary_conninfo, refusing to swap" >&2
  exit 1
fi

# Three same-filesystem renames inside the PVC dir → atomic, no cross-device copy.
# Move staging OUT to a sibling first (it currently lives inside PGDATA), then
# rotate the old PGDATA aside and promote the new one.
mv "$STAGING" "$PGDATA.new"
mv "$PGDATA" "$PGDATA.old"
mv "$PGDATA.new" "$PGDATA"
echo RESEED_SWAPPED
`.trim();
}

/**
 * The kubelet event signature of a STALE VolumeAttachment (d4 run 6,
 * 2026-08-28, DigitalOcean CSI): the k8s VolumeAttachment says
 * `attached: true` while the provider API shows the volume attached to NO
 * droplet, so the node's device file never appears and NodeStageVolume
 * probes it as an unformatted disk — `mkfs.ext4` against a path that does
 * not exist, forever. Live-verified both ways on the kept rig: a pod bounce
 * did NOT heal it (fresh attach "succeeded" into the same stale record);
 * deleting the VolumeAttachment forced a real ControllerPublishVolume and
 * the pod went Ready in 150s.
 */
export const STALE_ATTACH_EVENT_PATTERN =
  /MountVolume\.MountDevice failed[\s\S]*?(does not exist and no size was specified|formatting disk failed)/;

/**
 * How long the stale-attachment signature must have held before a db rollout
 * wait gives up on it. kubelet retries MountDevice with an exponential
 * backoff (0.5s doubling, capped near 2 minutes), so a device that is merely
 * slow to appear clears within the first few retries; two minutes of
 * `mkfs` on a device that still does not exist is the stale state itself.
 */
export const STALE_ATTACH_PERSIST_MS = 120_000;

/**
 * The missing-device half of the signature. STALE_ATTACH_EVENT_PATTERN also
 * admits any "formatting disk failed" (the reseed repair's wider net); the
 * wait diagnosis names only the state it can name: mkfs against a device
 * path that does not exist.
 */
const MISSING_DEVICE_PATTERN = /does not exist and no size was specified/;

/**
 * Read `kubectl get events -o json` for ONE db pod (the caller scopes the
 * read to the pod's uid) and decide whether it is in the stale-attachment
 * state: STALE_ATTACH_EVENT_PATTERN with a device that does not exist, held
 * for at least `minPersistMs`. Pure. Both timestamps come from the cluster;
 * this machine's clock is never compared with them. Unreadable input is no
 * evidence. Reads the core/v1 shape (firstTimestamp/lastTimestamp/count) and
 * the events.k8s.io one (eventTime + series).
 *
 * @param {string} eventsJson
 * @param {{minPersistMs?: number}} [opts]
 * @returns {{volume: string, count: number, persistedS: number}|null}
 */
export function persistentStaleAttach(eventsJson, { minPersistMs = STALE_ATTACH_PERSIST_MS } = {}) {
  let items;
  try {
    items = JSON.parse(String(eventsJson))?.items;
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  for (const ev of items) {
    const message = String(ev?.message ?? '');
    if (!STALE_ATTACH_EVENT_PATTERN.test(message) || !MISSING_DEVICE_PATTERN.test(message)) {
      continue;
    }
    const first = Date.parse(ev.firstTimestamp ?? ev.eventTime ?? '');
    const last = Date.parse(ev.series?.lastObservedTime ?? ev.lastTimestamp ?? ev.eventTime ?? '');
    if (!Number.isFinite(first) || !Number.isFinite(last) || last - first < minPersistMs) continue;
    return {
      volume: message.match(/for volume "([^"]+)"/)?.[1] ?? 'the db volume',
      count: Number(ev.series?.count ?? ev.count ?? 1),
      persistedS: Math.round((last - first) / 1000),
    };
  }
  return null;
}

/**
 * A db rollout wait stopped because the db volume is in the stale-attachment
 * state. Its message says what that is and how to recover.
 */
export class StaleVolumeAttachmentError extends Error {
  /** @param {{volume: string, count: number, persistedS: number}} stale */
  constructor(stale) {
    super(
      `The db volume ${stale.volume} reads attached, but its device never appeared on the ` +
        `database node: kubelet has tried to format a disk that does not exist for ` +
        `${stale.persistedS}s (${stale.count} times). This is a stale volume attachment at ` +
        'the provider, and waiting does not clear it. To recover, run ' +
        `\`kubectl scale statefulset ${DB_STATEFULSET} --replicas=0 -n vibecarbon\` on that ` +
        `cluster, delete the VolumeAttachment for ${stale.volume} ` +
        '(`kubectl get volumeattachment`), wait a minute, then scale it back to 1 or re-run ' +
        'the command that failed.',
    );
    this.name = 'StaleVolumeAttachmentError';
    this.volume = stale.volume;
    this.count = stale.count;
    this.persistedS = stale.persistedS;
  }
}

/** Every watcher read is bounded: kubectl's own request timeout, then the process. */
const ATTACH_WATCH_REQUEST_TIMEOUT = '--request-timeout=20s';
const ATTACH_WATCH_READ_TIMEOUT_MS = 30_000;

/**
 * Run a db rollout wait while watching the db pod for the stale-attachment
 * state, and stop the wait early, with StaleVolumeAttachmentError, once it
 * has held (persistentStaleAttach). Every db rollout wait that (re)attaches
 * the db volume goes through here: the cold and redeploy rollout
 * (awaitDbRollout), the deploy-side reseed's standby boot, and the remote
 * db settles (k8sDbRolloutWait). A volume in that state never mounts by
 * itself (DO e2e 2026-11-01: 600s of the same event; docs/mitigations.yml
 * do-csi-stale-volumeattachment), so the rest of the budget would only delay
 * the same failure.
 *
 * A diagnosis, not a recovery: nothing is retried or repaired, and a wait
 * that fails without the signature rethrows its own error untouched.
 *
 * Each poll reads the CURRENT db-0's uid, then only that pod's events
 * (`involvedObject.uid`), so the events an earlier, replaced db-0 left behind
 * (a recovery redeploy) never count. Every read carries the stop signal and a
 * bounded timeout, and is raced against the stop, so a hung read can neither
 * hang the wait nor outlive it.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} waitRollout - the rollout wait; must honor the signal
 * @param {object} o
 * @param {(argv: string[], opts: {signal: AbortSignal, timeout: number}) => Promise<string>} o.kubectl - runs `kubectl <argv>` against the cluster (locally, or over ssh) and returns stdout
 * @param {number} [o.pollMs]
 * @returns {Promise<T>}
 */
export async function watchDbAttach(waitRollout, { kubectl, pollMs = 15_000 }) {
  const rollout = new AbortController();
  const stop = new AbortController();
  const stopped = new Promise((resolve) => stop.signal.addEventListener('abort', resolve));
  let stale = null;
  const read = (argv) =>
    Promise.race([
      kubectl([...argv, ATTACH_WATCH_REQUEST_TIMEOUT], {
        signal: stop.signal,
        timeout: ATTACH_WATCH_READ_TIMEOUT_MS,
      }),
      stopped.then(() => null),
    ]);
  const pause = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      stop.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  const watch = (async () => {
    while (!stop.signal.aborted) {
      await pause(pollMs);
      if (stop.signal.aborted) return;
      try {
        const pod = await read(['get', 'pod', DB_POD, '-n', 'vibecarbon', '-o', 'json']);
        const uid = pod && JSON.parse(String(pod))?.metadata?.uid;
        if (!uid || stop.signal.aborted) continue;
        const events = await read([
          'get',
          'events',
          '-n',
          'vibecarbon',
          '--field-selector',
          `involvedObject.uid=${uid}`,
          '-o',
          'json',
        ]);
        if (events == null) continue;
        stale = persistentStaleAttach(events);
      } catch {
        continue; // an unreadable pod or listing is no evidence
      }
      if (stale) {
        rollout.abort();
        return;
      }
    }
  })();
  try {
    return await waitRollout(rollout.signal);
  } catch (err) {
    if (stale) throw new StaleVolumeAttachmentError(stale);
    throw err;
  } finally {
    stop.abort();
    await watch;
  }
}

/**
 * Wait for the db StatefulSet to roll on a remote cluster, under
 * watchDbAttach: a db pod that is down or mid-roll re-attaches its volume on
 * the way back (the do-csi-stale-volumeattachment trigger), so a stale
 * attachment stops the wait early with StaleVolumeAttachmentError instead of
 * burning the budget. The ssh budget sits 30s above the kubectl --timeout so
 * kubectl reports a rollout failure itself. The one way a remote caller waits
 * on a db roll (db-rollout-wait census in
 * tests/unit/deploy/db-attach-watch.test.ts).
 *
 * @param {object} o
 * @param {(ip: string, argv: string[], opts?: object) => Promise<string>} o.kubectl - sshKubectl-shaped
 * @param {string} o.ip
 * @param {number} [o.timeoutS]
 * @param {number} [o.pollMs] - watchDbAttach's poll interval (test seam)
 * @returns {Promise<string>}
 */
export function k8sDbRolloutWait({ kubectl, ip, timeoutS = DB_STS_BOOT_TIMEOUT_S, pollMs }) {
  return watchDbAttach(
    (signal) =>
      kubectl(ip, k8sDbRolloutStatusArgv(timeoutS), { timeout: (timeoutS + 30) * 1000, signal }),
    { kubectl: (argv, opts) => kubectl(ip, argv, opts), pollMs },
  );
}

/**
 * `kubectl` argv (no leading `kubectl`) that blocks until the db StatefulSet
 * has finished rolling. Spent only by k8sDbRolloutWait.
 *
 * @param {number} [timeoutSeconds]
 * @returns {string[]}
 */
export function k8sDbRolloutStatusArgv(timeoutSeconds = DB_STS_BOOT_TIMEOUT_S) {
  return [
    '-n',
    'vibecarbon',
    'rollout',
    'status',
    `statefulset/${DB_STATEFULSET}`,
    `--timeout=${timeoutSeconds}s`,
  ];
}

/**
 * Poll a "read the standby's replication state on the primary" closure until it
 * reports `streaming`, or the attempt budget lapses. Injected `readState`
 * (returns pg_stat_replication.state, or '' when no replica is connected) keeps
 * this transport-agnostic — compose passes a `docker compose exec` reader, k8s a
 * `sshKubectl exec` reader.
 *
 * @param {object} opts
 * @param {() => Promise<string>} opts.readState
 * @param {number} [opts.attempts=15]
 * @param {number[]} [opts.delaysMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ streaming: boolean, lastState: string }>}
 */
export async function verifyStreaming({
  readState,
  attempts = 15,
  delaysMs = [250, 500, 1000, 2000, 3000],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let lastState = '';
  let sawValidRead = false;
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const state = await readState();
      sawValidRead = true;
      lastState = typeof state === 'string' ? state.trim() : '';
      if (lastState === 'streaming') return { streaming: true, lastState };
    } catch (err) {
      // Retry — the standby may still be catching up, or the read itself
      // (SSH/kubectl exec) transiently failed, e.g. against a just-recreated
      // primary pod. A transient exec failure must NEVER be terminal; only a
      // read that never yields a valid answer within the whole budget is
      // reported (below), so the abort message stays honest.
      lastError = err?.message || String(err);
    }
    if (i < attempts - 1) {
      await sleep(delaysMs[Math.min(i, delaysMs.length - 1)] ?? 3000);
    }
  }
  // Distinguish "connected but not streaming" (reads succeeded, state != streaming)
  // from "could not read at all" (every read threw — e.g. the primary was
  // unreachable for the whole window). Without this, the latter reports as a bare
  // "not streaming" which hides a connectivity failure. Include the last read
  // error so the budget-exhausted report names the actual failure.
  if (!sawValidRead) {
    lastState = `unreadable (could not query pg_stat_replication${
      lastError ? `: ${lastError.slice(0, 160)}` : ''
    })`;
  }
  return { streaming: false, lastState };
}

/**
 * The primary's view of its standby: the best `state` in pg_stat_replication
 * (`streaming` sorts first), or no row when nothing is connected.
 */
export const STREAMING_STATE_SQL =
  "SELECT state FROM pg_stat_replication ORDER BY (state = 'streaming') DESC LIMIT 1";

/**
 * Is the standby already streaming from the current primary? Asks the primary,
 * so a streaming answer proves the connection is to THIS primary. The probe a
 * deploy runs before it reseeds (a reseed wipes the standby's PGDATA), shared
 * by both HA tiers; each tier supplies its transport as `exec`.
 *
 * @param {object} opts
 * @param {(sql: string) => Promise<string|false|undefined>} opts.exec
 *   runs one SQL statement on the primary and returns its tuples-only stdout;
 *   a failed exec may throw or answer false (read as nothing)
 * @param {number} [opts.attempts]
 * @param {number[]} [opts.delaysMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{streaming: boolean, lastState: string}>}
 */
export function probeStreaming({ exec, attempts = 3, delaysMs = [2000], sleep }) {
  return verifyStreaming({
    readState: async () => {
      const out = await exec(STREAMING_STATE_SQL);
      return typeof out === 'string' ? out.trim() : '';
    },
    attempts,
    delaysMs,
    ...(sleep ? { sleep } : {}),
  });
}

/**
 * Finding #1 — the hard-gate policy, shared by the compose-HA and k8s-HA deploy
 * paths so they behave identically. Given the verified streaming result:
 *   - streaming            → returns { degraded: false } (deploy proceeds).
 *   - !streaming + allowDegraded → returns { degraded: true, reason } (proceed,
 *     but the caller must record + surface a DEGRADED / warm-standby state).
 *   - !streaming + !allowDegraded → THROWS an actionable Error (abort the deploy):
 *     it states WHY (standby not streaming, last observed state) and that
 *     `-allow-degraded` will proceed with warm-standby DR.
 *
 * DECISION: hard-gate-by-default was the chosen policy — a green `deployed` HA
 * env must have a verifiably streaming standby. Warm-standby DR is opt-in only.
 *
 * @param {object} opts
 * @param {boolean} opts.streaming
 * @param {string} [opts.lastState]
 * @param {boolean} [opts.allowDegraded=false]
 * @param {string} [opts.fixHint] - mode-specific remediation appended to the error
 * @returns {{ degraded: boolean, reason?: string }}
 */
export function assertReplicationStreamingOrDegraded({
  streaming,
  lastState = '',
  allowDegraded = false,
  fixHint = '',
}) {
  if (streaming) return { degraded: false };

  const stateDesc = lastState ? JSON.stringify(lastState) : 'no replica connected';
  const reason = `standby not streaming (last pg_stat_replication.state=${stateDesc})`;

  if (allowDegraded) {
    return { degraded: true, reason };
  }

  throw new Error(
    `HA deploy aborted: the standby is not verifiably streaming from the primary, so ` +
      `disaster recovery is not guaranteed.\n  Reason: ${reason}.\n` +
      `${fixHint ? `  ${fixHint}\n` : ''}` +
      `  Re-run \`vibecarbon deploy\` after fixing replication, or re-run with ` +
      `\`-allow-degraded\` to finalize a warm-standby (DEGRADED) deployment that accepts ` +
      `reduced DR.`,
  );
}

/**
 * Read REPL_PASSWORD from the `vibecarbon-infra-secrets` k8s Secret — the SAME source
 * the db uses. k8s nodes have NO compose-style `/opt/<project>/.env.local`; the
 * old grep of that path always returned empty, so a re-seed silently no-op'd and
 * the caller promoted a possibly-stale (or empty) standby. jsonpath returns the
 * base64-encoded value; decode it locally.
 *
 * Returns the plaintext password, or null if the key is absent/undecodable.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @returns {Promise<string|null>}
 */
export async function getReplPasswordFromSecret(ip, sshKeyPath) {
  const b64 = await sshKubectl(ip, sshKeyPath, [
    'get',
    'secret',
    'vibecarbon-infra-secrets',
    '-n',
    'vibecarbon',
    '-o',
    'jsonpath={.data.REPL_PASSWORD}',
  ]);
  const trimmed = (typeof b64 === 'string' ? b64 : '').trim();
  if (!trimmed) return null;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf-8').trim();
    return decoded || null;
  } catch {
    return null;
  }
}

/**
 * Ensure the physical replication slot exists on the primary (k8s transport).
 *
 * A wal-g primary restore wipes pg_replslot (slots are never part of a base
 * backup). The persistent slot is what the reseeded standby STREAMS through
 * post-swap (primary_slot_name in its postgresql.auto.conf) — without it the
 * standby connects and immediately errors `replication slot "…" does not exist`,
 * so it never streams. (The basebackup itself no longer needs the slot — it uses
 * a temporary slot now — but streaming does.) Recreate it idempotently BEFORE the
 * re-seed with ensureReplicationSlotSql, the one builder primary-init.sql and the
 * compose-HA sites use too: it also drops a `lost` slot (WAL past the
 * max_slot_wal_keep_size cap), which could never stream again.
 *
 * Failover does NOT need this: its re-seed sources from a live, untouched
 * primary whose slot survives.
 *
 * @param {string} primaryIp - primary cluster master IP (kubectl target)
 * @param {string} sshKeyPath
 * @param {string} [slotName=REPLICATION_SLOT]
 * @returns {Promise<void>}
 */
export async function ensureReplicationSlot(primaryIp, sshKeyPath, slotName = REPLICATION_SLOT) {
  const pod = await getPostgresPod(primaryIp, sshKeyPath);
  const sql = `${ensureReplicationSlotSql(slotName)}\n`;
  await sshKubectl(
    primaryIp,
    sshKeyPath,
    [
      'exec',
      '-i',
      '-n',
      'vibecarbon',
      pod,
      '--',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql },
  );
}

/**
 * Re-seed the k8s standby Postgres from the primary, in place (Task A4).
 * Closes the drift window that opens when streaming silently falls behind or the
 * standby pod restarted and missed WAL. Used by BOTH failover (before promotion)
 * and restore (post-restore standby resync).
 *
 * The db volume never detaches: no scale to zero, no helper pod, no detach
 * wait (the do-csi-stale-volumeattachment trigger is gone from this path).
 *   0. Target: the standby the FRESH env config names (.vibecarbon.json read
 *      now, not the snapshot the command started with), with the primary it
 *      names as the source. Any disagreement refuses before a remote call.
 *   1. reseedStandbyInPlace: the live-pod guard, the source primary's checks
 *      (it reports the primary intent; its .vc-discard is gone so
 *      pg_basebackup never ships it), the stage over stdin, one in-pod stop,
 *      the swap proof (.vc-reseeded-from), the recovery wait, then the
 *      standby's .vc-discard goes (D9).
 *   2. The seeded system identifier is read and handed to onSeeded.
 *
 * Safety contract:
 *   - REPL_PASSWORD is read from the `vibecarbon-infra-secrets` Secret. If it is
 *     not found we CANNOT safely re-seed: a HARD ERROR, distinct from "primary
 *     unreachable".
 *   - Reachability is probed from inside the standby db by the stage itself
 *     (probeFirst): an unreachable primary prints RESEED_SKIPPED, nothing is
 *     staged and nothing stops ('skipped').
 *   - A stage another stage still runs over (RESEED_REFUSED busy) is a
 *     terminal ReseedStageBusyError: wait, then rerun. Never retried.
 *
 * Transport: the standby dials its OWN database node's private IP on the
 * repl-gateway relay port (REPL_GATEWAY_PORT), the path the deploy-time seed
 * uses. This re-seed always runs while the deploy-time roles still hold
 * (failover re-seeds BEFORE promotion; restore never swaps roles).
 *
 * @param {string} standbyIp - standby cluster master IP (kubectl target)
 * @param {string} sshKeyPath
 * @param {object} opts
 * @param {string} opts.standbyDbIp - standby DATABASE node public IP: REQUIRED as
 *   a precondition that the standby HA cluster is fully identified.
 * @param {string} opts.standbyDbPrivateIp - the standby database node's PRIVATE
 *   IP: the local repl-gateway relay endpoint the basebackup + primary_conninfo
 *   dial. REQUIRED (no provider-shaped fallback).
 * @param {string} opts.primaryIp - the primary cluster master IP (the source)
 * @param {string} opts.envName - the environment; its fresh config picks the target
 * @param {() => object|undefined} [opts.readEnvConfig] - the env's config read now
 * @param {(systemIdentifier: string) => (void|Promise<void>)} [opts.onSeeded]
 * @param {number} [opts.attachWatchPollMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @returns {Promise<'reseeded'|'skipped'>}
 */
export async function reseedStandbyFromPrimary(
  standbyIp,
  sshKeyPath,
  {
    standbyDbIp,
    standbyDbPrivateIp,
    primaryIp,
    envName,
    onSeeded,
    readEnvConfig = () => loadProjectConfig()?.environments?.[envName],
    attachWatchPollMs,
    sleep,
    now,
  } = {},
) {
  if (!standbyDbPrivateIp) {
    // A missing private IP signals a half-identified HA env (or a pre-M3
    // persisted config). Never assume an address: redeploy to persist it.
    throw new Error(
      're-seed aborted: standbyDbPrivateIp is required — the standby database ' +
        "node's private IP is a deploy output persisted in the environment config; " +
        'redeploy to persist it before re-seeding',
    );
  }
  if (!standbyDbIp) {
    throw new Error(
      're-seed aborted: standby database node IP is unknown; the standby HA ' +
        'cluster is not fully identified. Cannot safely re-seed; redeploy to ' +
        'persist the standby database IP.',
    );
  }
  assertReseedTarget({ envName, standbyIp, primaryIp, envConfig: readEnvConfig() });

  const replPassword = await getReplPasswordFromSecret(standbyIp, sshKeyPath);
  if (!replPassword) {
    throw new Error(
      're-seed aborted: REPL_PASSWORD not found in the vibecarbon-infra-secrets Secret. ' +
        'Cannot re-seed the standby from the primary, refusing to act on a ' +
        'possibly-stale standby. Verify the standby cluster was deployed with `vibecarbon deploy -mode k8s-ha`.',
    );
  }

  const kubectl = (argv, opts) => sshKubectl(standbyIp, sshKeyPath, argv, opts);
  const primaryKubectl = (argv, opts) => sshKubectl(primaryIp, sshKeyPath, argv, opts);
  // Stage a verified basebackup into $PGDATA/.vc-reseed while the standby
  // postgres runs. The script is piped over stdin (PGPASSWORD embedded), never
  // argv. It dials the LOCAL relay and pins the explicit streaming conninfo,
  // byte-identical to the deploy-time seed's buildPrimaryConninfo output.
  const stageScript = (attempt, { basebackupDeadlineS, intent }) =>
    buildInPlaceReseedStageScript({
      intent,
      replPassword,
      relayHost: standbyDbPrivateIp,
      // One probe, like the single-shot pre-check this replaces: failover
      // already found the primary ready, and restore just restored it.
      probeAttempts: 1,
      label: 'reseed',
      attempt,
      basebackupDeadlineS,
    });
  const result = await reseedStandbyInPlace({
    kubectl,
    stageScript,
    envName,
    attachWatchPollMs,
    sleep,
    now,
    beforeStage: () => prepareReseedSource(primaryKubectl, { envName }),
  });
  if (result !== 'reseeded') return result;

  // Record what was seeded: failover's replica proof (R1) compares the
  // standby's system identifier against this value. Read on the standby, which
  // pg_basebackup just gave the primary's identity.
  if (onSeeded) {
    const sysid = String(
      await kubectl(dbExecArgv(['psql', '-U', 'postgres', '-tAc', SYSTEM_IDENTIFIER_SQL]), {
        timeout: 30_000,
      }),
    ).trim();
    if (!/^\d+$/.test(sysid)) {
      throw new Error(
        `standby re-seed finished but its system identifier could not be read ` +
          `(got: ${sysid.slice(0, 80) || 'empty'}), so the seed cannot be recorded.`,
      );
    }
    await onSeeded(sysid);
  }
  return 'reseeded';
}

/**
 * The in-place stage every k8s standby reseed runs (the cold deploy, failover
 * and restore alike): probe the primary through the standby's LOCAL
 * repl-gateway relay (its own database node's private IP), stage a verified
 * pg_basebackup into IN_PLACE_RESEED_DIR with the explicit streaming conninfo
 * written in, and arm it for db-guard.sh. Piped over stdin (the password is
 * in it), never argv.
 *
 * @param {object} o
 * @param {string} o.replPassword
 * @param {string} o.relayHost the standby database node's private IP
 * @param {string} o.attempt the in-place attempt id
 * @param {number} o.basebackupDeadlineS reseedStageBoundsS().remoteS
 * @param {number} o.probeAttempts
 * @param {number} [o.probeDelayS=10]
 * @param {string} o.label
 * @param {string} o.intent the role intent the guard read from the
 *   vibecarbon-db-role ConfigMap (reseedStandbyInPlace passes it); must be 'standby'
 * @returns {string}
 */
export function buildInPlaceReseedStageScript({
  replPassword,
  relayHost,
  attempt,
  basebackupDeadlineS,
  probeAttempts,
  probeDelayS = 10,
  label,
  intent,
}) {
  return buildStagedBasebackupScript({
    replPassword,
    primaryHost: relayHost,
    primaryPort: String(REPL_GATEWAY_PORT),
    probeFirst: true,
    probeAttempts,
    probeDelayS,
    swap: false,
    stagingDir: IN_PLACE_RESEED_DIR,
    primaryConninfo: buildPrimaryConninfo({
      primaryHost: relayHost,
      replPassword,
      port: REPL_GATEWAY_PORT,
    }),
    label,
    inPlaceAttempt: attempt,
    basebackupDeadlineS,
    intent,
  });
}

/**
 * The longest the stage's probe can run before its transfer starts: every
 * attempt's pg_isready (-t 5) plus the delays between them.
 *
 * @param {number} probeAttempts
 * @param {number} probeDelayS
 * @returns {number}
 */
export function inPlaceProbeBudgetS(probeAttempts, probeDelayS) {
  return probeAttempts * 5 + Math.max(0, probeAttempts - 1) * probeDelayS;
}

/**
 * Pure. The reseed wipes the cluster at `standbyIp` and copies the one at
 * `primaryIp`: both must be what the environment's config names right now.
 * The live-pod guard only reads the target pod's own intent and mounts, so a
 * stale snapshot (a failover that swapped the roles since) would otherwise aim
 * the reseed at the wrong cluster.
 *
 * @param {{envName?: string, standbyIp: string, primaryIp?: string, envConfig?: object}} o
 */
export function assertReseedTarget({ envName, standbyIp, primaryIp, envConfig }) {
  if (!envName) {
    throw new Error('reseed refused: no envName; the reseed reads its target from the env config');
  }
  const configured = {
    standby: envConfig?.ha?.standby?.masterIp,
    primary: envConfig?.ha?.primary?.masterIp,
  };
  if (!configured.standby || !configured.primary) {
    throw new Error(
      `reseed refused: .vibecarbon.json names no k8s-ha primary and standby for ${envName}; nothing was touched`,
    );
  }
  if (standbyIp !== configured.standby || primaryIp !== configured.primary) {
    throw new Error(
      `reseed refused: the target (standby ${standbyIp}, primary ${primaryIp ?? '<none>'}) is not what ` +
        `${envName}'s config names now (standby ${configured.standby}, primary ${configured.primary}); ` +
        'nothing was touched. Rerun the command so it reads the current roles',
    );
  }
  if (configured.standby === configured.primary) {
    throw new Error(
      `reseed refused: ${envName}'s config names ${configured.standby} as both primary and standby; nothing was touched`,
    );
  }
}

/** `kubectl` argv reading the vibecarbon-db-role intent ('' when absent). */
const DB_ROLE_INTENT_READ = Object.freeze([
  '-n',
  'vibecarbon',
  'get',
  'configmap',
  DB_ROLE_CONFIGMAP,
  '--ignore-not-found',
  '-o',
  `jsonpath={.data.${DB_ROLE_INTENT_KEY}}`,
]);

/**
 * Drops the source primary's `.vc-discard` (garbage by D9 and by restore:
 * a reseed's or a proven restore's old cluster) so pg_basebackup never ships
 * it. Prints VC_DISCARD_GONE once it is gone; one sh -c token.
 */
export const SOURCE_DISCARD_DROP = Object.freeze([
  'sh',
  '-c',
  `rm -rf ${PGDATA_DIR}/.vc-discard; if [ -e ${PGDATA_DIR}/.vc-discard ] || [ -L ${PGDATA_DIR}/.vc-discard ]; then echo VC_DISCARD_LEFT; exit 1; fi; echo VC_DISCARD_GONE`,
]);

/**
 * The source primary, right before the stage: its cluster must report the
 * primary intent (the config and the clusters agree on who is who), and its
 * `.vc-discard` must be gone. A refusal stages nothing and stops nothing.
 *
 * @param {(argv: string[], opts?: object) => Promise<string>} primaryKubectl
 * @param {{envName?: string}} o
 */
export async function prepareReseedSource(primaryKubectl, { envName } = {}) {
  const intent = String(
    (await primaryKubectl([...DB_ROLE_INTENT_READ], { timeout: 30_000 })) ?? '',
  ).trim();
  if (intent !== 'primary') {
    throw new Error(
      `reseed refused: the configured primary's cluster reports the ${intent || '<none>'} intent, ` +
        `not primary; the clusters disagree with ${envName || 'the'} config. Nothing was staged`,
    );
  }
  let out = '';
  try {
    out = await primaryKubectl(dbExecArgv(SOURCE_DISCARD_DROP), { timeout: 300_000 });
  } catch (error) {
    out = error?.stdout ?? '';
  }
  if (!hasSentinelLine(out, 'VC_DISCARD_GONE')) {
    throw new Error(
      `reseed refused: could not remove ${PGDATA_DIR}/.vc-discard on the primary (pg_basebackup would ` +
        'copy it into the standby). Nothing was staged',
    );
  }
  // What the basebackup will move: it bounds the stage (reseedStageBoundsS).
  // The same read carries the primary's lineage (system identifier, timeline)
  // for a caller that compares it with the target's (the cold deploy).
  let row = '';
  try {
    row = String(
      await primaryKubectl(dbExecArgv(['psql', '-U', 'postgres', '-tAc', DB_SOURCE_SQL]), {
        timeout: 30_000,
      }),
    ).trim();
  } catch (error) {
    row = `unreadable: ${error?.message ?? error}`;
  }
  const [size, ...identity] = row.split('|');
  if (!/^\d+$/.test(size)) {
    throw new Error(
      `reseed refused: could not read the primary's database size (${row.slice(0, 120) || 'empty'}), ` +
        'so the stage cannot be bounded. Nothing was staged',
    );
  }
  return { sizeBytes: Number(size), ...parseDbIdentity(identity.join('|')) };
}

/**
 * Every database's size on the primary (what pg_basebackup moves, about),
 * then its lineage (DB_IDENTITY_SQL's columns): `<bytes>|<sysid>|<timeline>`.
 */
const DB_SOURCE_SQL =
  'SELECT (SELECT sum(pg_database_size(datname)) FROM pg_database), system_identifier, ' +
  'CASE WHEN pg_is_in_recovery() THEN NULL ELSE substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8) END ' +
  'FROM pg_control_system()';

/** Bytes as MiB or GiB, for messages. */
function formatBytes(n) {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
}

/**
 * Disarms this attempt's staged tree: under the PGDATA lock (the stage's,
 * restore's and db-guard.sh's), and only while no swap is under way and the
 * ready marker names `attempt`, the marker goes first (durably), then the
 * tree. Prints RESEED_DISARMED, or `RESEED_DISARM_REFUSED <why>` with exit 1.
 * One sh -c token.
 *
 * @param {string} attempt
 * @returns {readonly string[]}
 */
export function reseedDisarmArgv(attempt) {
  if (typeof attempt !== 'string' || !IN_PLACE_ATTEMPT_RE.test(attempt)) {
    throw new Error(
      `reseedDisarmArgv: ${JSON.stringify(attempt)} is not an in-place reseed attempt id`,
    );
  }
  const d = PGDATA_DIR;
  return Object.freeze([
    'sh',
    '-c',
    `if [ -L ${d}/.vc-restore.lock ]; then echo 'RESEED_DISARM_REFUSED the lock is a symlink'; exit 1; fi; ` +
      `exec 9>${d}/.vc-restore.lock; flock -n 9 || { echo 'RESEED_DISARM_REFUSED busy'; exit 1; }; ` +
      `if [ -e ${d}/.vc-reseed-in-progress ] || [ -L ${d}/.vc-reseed-in-progress ]; then echo 'RESEED_DISARM_REFUSED a swap is in progress'; exit 1; fi; ` +
      `if [ -e ${d}/.vc-reseed-ready ] && [ "$(cat ${d}/.vc-reseed-ready)" != ${attempt} ]; then echo 'RESEED_DISARM_REFUSED the armed tree is another attempt'; exit 1; fi; ` +
      `rm -f ${d}/.vc-reseed-ready ${d}/.vc-reseed-ready.tmp; sync; rm -rf ${d}/.vc-reseed; echo RESEED_DISARMED`,
  ]);
}

/**
 * After a failed restart: disarm this attempt's tree so no later container
 * start swaps it in. Returns the sentence the error ends with.
 */
async function disarmStagedReseed(kubectl, attempt) {
  let out = '';
  try {
    out = await kubectl(dbExecArgv(reseedDisarmArgv(attempt)), { timeout: 300_000 });
  } catch (error) {
    out = error?.stdout ?? '';
  }
  if (hasSentinelLine(out, 'RESEED_DISARMED')) {
    return 'The staged tree was disarmed; the standby keeps its data directory';
  }
  const why = sentinelLinePayload(out, 'RESEED_DISARM_REFUSED') ?? 'the disarm did not run';
  return (
    `A staged tree (attempt ${attempt}) is still armed in ${IN_PLACE_RESEED_DIR} and will swap in on ` +
    `the db container's next restart (${why}); to drop it, remove ${PGDATA_DIR}/.vc-reseed-ready in ${DB_POD}`
  );
}

/** A fresh in-place reseed attempt id (IN_PLACE_ATTEMPT_RE). */
function newReseedAttempt() {
  return `r${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Guard → stage (in the running standby db) → restart in place → prove the
 * swap (.vc-reseeded-from === attempt) → recovery wait → remove .vc-discard.
 * Zero attach transitions on the happy path.
 *
 * Order is load-bearing: the guard first (a refusal moves nothing and runs no
 * basebackup), then `beforeStage`, then the stage over stdin (password never
 * in argv), then the one stop.
 *
 * @param {object} o
 * @param {(argv: string[], opts?: {input?: string, timeout?: number}) => Promise<string>} o.kubectl  standby cluster
 * @param {(attempt: string, bounds: {basebackupDeadlineS: number}) => string} o.stageScript  buildStagedBasebackupScript({... inPlaceAttempt: attempt, basebackupDeadlineS})
 * @param {string} o.envName
 * @param {() => Promise<{sizeBytes?: number}|void>} [o.beforeStage] runs after the guard, before the stage; the size it returns bounds the stage
 * @param {boolean} [o.requireRecovery=true] false only for the cold deploy's
 *   seed: its standby runs as its own primary until the swap (the guard and
 *   the stop then skip the recovery proof; DB_IN_PLACE_STOP_UNSEEDED)
 * @param {(guard: {inRecovery: string}) => void} [o.onGuard] sees the passed guard's verdict
 * @param {number} [o.stageProbeS=0] the stage's own probe budget before the
 *   transfer starts; added to the client bound so it never cuts a stage short
 * @param {number} [o.attachWatchPollMs]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 * @returns {Promise<'reseeded'|'skipped'>}  'skipped' only when the stage printed RESEED_SKIPPED
 */
export async function reseedStandbyInPlace({
  kubectl,
  stageScript,
  envName,
  beforeStage,
  requireRecovery = true,
  onGuard,
  stageProbeS = 0,
  attachWatchPollMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const guard = await assertLiveDbGuardSupportsReseed(kubectl, { envName, requireRecovery });
  onGuard?.(guard);
  const source = beforeStage ? await beforeStage() : undefined;
  const sizeBytes = Number(source?.sizeBytes) || 0;
  const bounds = reseedStageBoundsS(sizeBytes);
  const remoteS = bounds.remoteS;
  const clientS = bounds.clientS + Math.max(0, Math.ceil(Number(stageProbeS) || 0));

  const attempt = newReseedAttempt();
  const script = stageScript(attempt, { basebackupDeadlineS: remoteS, intent: guard.intent });
  // runInPlaceStage reads the stage's stdout (an exec error carries it):
  // busy is terminal, never retried here or by a caller. The client bound
  // sits above the stage's own deadline, so it never abandons a live stage.
  let stage;
  try {
    stage = await runInPlaceStage(
      () =>
        kubectl(['-n', 'vibecarbon', 'exec', '-i', DB_POD, '-c', DB_CONTAINER, '--', 'sh'], {
          input: script,
          timeout: clientS * 1000,
        }),
      { attempt },
    );
  } catch (error) {
    if (error instanceof ReseedStageTimeoutError) {
      throw new ReseedStageTimeoutError(
        `reseed stage timed out: pg_basebackup of the primary's ${formatBytes(sizeBytes)} did not finish ` +
          `within ${remoteS}s (sized at ${formatBytes(RESEED_BASEBACKUP_FLOOR_BYTES_PER_S)}/s; client bound ${clientS}s) ` +
          'and was stopped. Nothing was staged and nothing stopped; the standby keeps its data directory. ' +
          'Check the replication link between the clusters, then rerun',
        { deadlineS: remoteS },
      );
    }
    throw error;
  }
  if ('skipped' in stage) return 'skipped';

  try {
    await restartDbContainerInPlace(kubectl, {
      guard,
      requireRecovery,
      recreatedWait: () =>
        k8sDbRolloutWait({
          kubectl: (_ip, argv, opts) => kubectl(argv, opts),
          ip: '',
          pollMs: attachWatchPollMs,
        }),
      sleep,
      now,
    });
  } catch (error) {
    const said = String(error?.message ?? error);
    // The restart can fail AFTER the swap (the db did not come back Ready,
    // the recreated pod's rollout failed): then the standby holds the new
    // tree and there is nothing to disarm.
    let swappedFrom = null;
    try {
      swappedFrom = String(
        await kubectl(dbExecArgv(RESEEDED_FROM_READ), { timeout: 30_000 }),
      ).trim();
    } catch {
      swappedFrom = null; // unreadable: the disarm below decides
    }
    if (swappedFrom === attempt) {
      throw swappedError(
        `${said}. The swap ran (${PGDATA_DIR}/.vc-reseeded-from is ${attempt}): the standby holds the ` +
          'reseeded data directory, but its db did not come back. See why: ' +
          `kubectl -n vibecarbon logs ${DB_POD} -c ${DB_CONTAINER}`,
        error,
      );
    }
    // Not swapped: the tree is staged and marked ready, and without a disarm
    // the next container start (any restart, any time) would swap it in.
    const outcome = await disarmStagedReseed(kubectl, attempt);
    const unread = swappedFrom === null ? ' (whether the swap already ran could not be read)' : '';
    throw new Error(`${said}. ${outcome}${unread}`, { cause: error });
  }

  const from = String(await kubectl(dbExecArgv(RESEEDED_FROM_READ), { timeout: 30_000 })).trim();
  if (from !== attempt) {
    throw new Error(
      `the swap did not run; the standby booted its previous data directory ` +
        `(${PGDATA_DIR}/.vc-reseeded-from is ${from || 'absent'}, staged attempt ${attempt}). ` +
        `See why: kubectl -n vibecarbon logs ${DB_POD} -c ${DB_CONTAINER} --previous`,
    );
  }

  try {
    await waitForStandbyRecovery({
      exec: () =>
        kubectl(dbExecArgv(['psql', '-U', 'postgres', '-tAc', 'SELECT pg_is_in_recovery()']), {
          timeout: 30_000,
        }),
      sleep,
      now,
    });
  } catch (error) {
    throw swappedError(String(error?.message ?? error), error);
  }

  // The old tree (D9): garbage once the standby is proven in recovery. Best
  // effort; any later swap or restore removes it first.
  await kubectl(dbExecArgv(['rm', '-rf', `${PGDATA_DIR}/.vc-discard`]), {
    timeout: 300_000,
  }).catch(() => {});
  return 'reseeded';
}

/**
 * An error raised after the swap ran: the standby's old data directory is
 * gone (moved to .vc-discard), so whatever it held, replication slots
 * included, went with it. `reseedSwapped` lets a caller tell it apart.
 */
function swappedError(message, cause) {
  return Object.assign(new Error(message, { cause }), { reseedSwapped: true });
}

/** Reads the swap record db-guard.sh leaves ('' when there is none). */
const RESEEDED_FROM_READ = Object.freeze([
  'sh',
  '-c',
  `cat ${PGDATA_DIR}/.vc-reseeded-from 2>/dev/null || true`,
]);

/**
 * Wait (deadline-bounded) for a reseeded standby to answer
 * pg_is_in_recovery() = t. A standby that never does is serving as its own
 * primary: fail loudly. "Hot standby mode is disabled" is a CONFIG error, not
 * timing, and fails at once.
 *
 * @param {object} o
 * @param {() => Promise<string>} o.exec runs `SELECT pg_is_in_recovery()`
 * @param {number} [o.deadlineMs]
 * @param {number} [o.pollMs]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 */
export async function waitForStandbyRecovery({
  exec,
  deadlineMs = DB_STS_BOOT_TIMEOUT_S * 1000,
  pollMs = 4000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const deadline = now() + deadlineMs;
  let lastErr = '';
  for (;;) {
    try {
      if (String(await exec()).trim() === 't') return;
    } catch (err) {
      // Booting / applying initial WAL. The failure text carries psql's FATAL
      // detail (runCommandAsync folds it into the message).
      lastErr = err?.message || String(err);
      if (lastErr.includes('Hot standby mode is disabled')) {
        throw new Error(
          'standby re-seed: the standby is streaming but refusing read-only connections ' +
            '("Hot standby mode is disabled") — hot_standby is OFF in its effective config ' +
            '(the staged postgresql.auto.conf must pin hot_standby = on, and it did not take). ' +
            'Config error, not a timing issue.',
        );
      }
    }
    if (now() >= deadline) {
      throw new Error(
        'standby re-seed swapped in a fresh basebackup but the standby never entered ' +
          'recovery mode within the budget; the reseeded PGDATA is not replaying from ' +
          `the primary (check the standby db logs)${lastErr ? `; last error: ${lastErr.slice(0, 200)}` : ''}.`,
      );
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// In-place reseed: the live-pod guard, the stage verdict, and the one
// sanctioned in-pod postmaster stop.
//
// The reseed never detaches the db volume: the stage script builds a verified
// tree in $PGDATA/.vc-reseed inside the running standby, postgres stops, the
// kubelet restarts the container in the same pod, and db-guard.sh swaps the
// tree in before postgres starts. Stopping postgres in a pod that does NOT run
// that wrapper would boot the old data directory, so the stop sits behind a
// guard that reads the RUNNING pod (never the StatefulSet template, which is a
// false positive during a pending roll).
// ---------------------------------------------------------------------------

// The protocol marker and the wrapper command live in db-workload.js (a leaf
// the scaffold preflight imports too); re-exported for the reseed's callers.
export { DB_GUARD_COMMAND, DB_GUARD_PROTOCOL_MARKER };

/** Where the wrapper is mounted (subPath of the vibecarbon-wal-archive ConfigMap). */
const DB_GUARD_PATH = '/usr/local/bin/db-guard.sh';

/** The live pod lacks the wrapper, its mounts, or its protocol: redeploy first (D1). */
export class DbGuardMissingError extends Error {
  /** @param {string} message @param {{reason?: string}} [o] the guard's verdict, unworded */
  constructor(message, { reason } = {}) {
    super(message);
    this.name = 'DbGuardMissingError';
    this.reason = reason;
  }
}

/**
 * How long the guard exec waits for postgres to accept connections before it
 * reads recovery, slots and lineage (pg_isready, once a second). The exec's
 * client bound (DB_GUARD_EXEC_TIMEOUT_MS) sits above it.
 */
export const DB_GUARD_READY_WAIT_S = 60;
const DB_GUARD_EXEC_TIMEOUT_MS = (DB_GUARD_READY_WAIT_S + 60) * 1000;

/** The replication slots a db holds (a retired old primary's keep WAL). */
const REPLICATION_SLOT_COUNT_SQL = 'SELECT count(*) FROM pg_replication_slots';

/**
 * A db's lineage: `<system identifier>|<timeline, 8 hex>` from psql -tA. The
 * timeline is the current WAL file's, read only outside recovery (a server in
 * recovery has no current WAL LSN; it prints `<sysid>|`). No quotes, so it
 * sits inside a single-quoted shell word.
 */
const DB_IDENTITY_SQL =
  'SELECT system_identifier, CASE WHEN pg_is_in_recovery() THEN NULL ELSE ' +
  'substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8) END FROM pg_control_system()';

/**
 * Pure. `<sysid>|<timeline hex>` (DB_IDENTITY_SQL's columns) as
 * {systemIdentifier, timeline}; a part that does not parse is null.
 *
 * @param {string} text
 * @returns {{systemIdentifier: string|null, timeline: number|null}}
 */
export function parseDbIdentity(text) {
  const [sysid = '', tli = ''] = String(text ?? '')
    .trim()
    .split('|')
    .map((x) => x.trim());
  return {
    systemIdentifier: /^\d+$/.test(sysid) ? sysid : null,
    timeline: /^[0-9A-Fa-f]{8}$/.test(tli) ? Number.parseInt(tli, 16) : null,
  };
}

/** `pg_is_in_recovery()` read inside the db container ('' when psql fails). */
const IN_RECOVERY_SH = `"$(psql -U postgres -tAc 'SELECT pg_is_in_recovery()' 2>/dev/null)"`;

/**
 * The guard's exec; one `sh -c` token, no newlines. It greps the MOUNTED
 * wrapper (a subPath ConfigMap mount never changes for the life of the pod, so
 * this is the exact file the next container start runs; a missing file prints
 * no count), then prints `in_recovery=<t|f|>` from the same container, so a
 * ConfigMap that says standby over a real primary still refuses.
 */
export const DB_GUARD_MARKER_GREP = Object.freeze([
  'sh',
  '-c',
  `grep -c '^${DB_GUARD_PROTOCOL_MARKER}$' /usr/local/bin/db-guard.sh || true; ` +
    // One bounded wait for postgres to accept connections (a db the deploy's
    // self-heal just started may still be starting up), so the reads below
    // are not empty for lack of a moment. Over TCP (-h): a first-boot db's
    // temporary init server is socket-only, so only the real server passes.
    // A condition poll with a deadline, never a retry of anything else; a
    // running db passes at once.
    `vc_ready=0; vc_i=0; while [ "$vc_i" -lt ${DB_GUARD_READY_WAIT_S} ]; do if pg_isready -q -h 127.0.0.1 -U postgres; then vc_ready=1; break; fi; vc_i=$((vc_i + 1)); sleep 1; done; printf 'ready=%s\\n' "$vc_ready"; ` +
    `printf 'in_recovery=%s\\n' ${IN_RECOVERY_SH}; ` +
    // What the data directory says, for when psql cannot (crash recovery).
    `if [ -f "\${PGDATA:-/var/lib/postgresql/data}/standby.signal" ]; then echo standby_signal=1; else echo standby_signal=0; fi; ` +
    `printf 'slots=%s\\n' "$(psql -U postgres -tAc '${REPLICATION_SLOT_COUNT_SQL}' 2>/dev/null)"; ` +
    `printf 'ident=%s\\n' "$(psql -U postgres -tAc '${DB_IDENTITY_SQL}' 2>/dev/null)"`,
]);

/** What the stop prints (stdout, exit STOP_REFUSED_STATUS) when it refuses to signal. */
const STOP_REFUSED = 'RESEED_STOP_REFUSED';
const STOP_REFUSED_STATUS = 3;

/**
 * The sanctioned in-pod stop; one `sh -c` token, no newlines. Self-guarding:
 * the container that receives the signal proves, in the same exec, that its
 * mounted wrapper speaks the reseed protocol and that postgres is in recovery,
 * and only then sends SIGINT to PID 1 (the postmaster: fast shutdown).
 */
export const DB_IN_PLACE_STOP = Object.freeze([
  'sh',
  '-c',
  `grep -q '^${DB_GUARD_PROTOCOL_MARKER}$' /usr/local/bin/db-guard.sh || { echo '${STOP_REFUSED} the mounted db-guard.sh does not speak the reseed protocol'; exit ${STOP_REFUSED_STATUS}; }; ` +
    // psql silent (a standby in crash recovery refuses every connection, which
    // is what a primary restored onto a new timeline does to it): the data
    // directory decides. standby.signal is what makes postgres start as a
    // standby; pg_promote removes it, so a primary never has one. A live
    // answer always wins over the file.
    `r=${IN_RECOVERY_SH}; ` +
    `if [ -z "$r" ]; then [ -f "\${PGDATA:-/var/lib/postgresql/data}/standby.signal" ] && r=t || { echo '${STOP_REFUSED} could not confirm the db is in recovery (psql did not answer and PGDATA has no standby.signal)'; exit ${STOP_REFUSED_STATUS}; }; fi; ` +
    `[ "$r" = t ] || { echo "${STOP_REFUSED} postgres is not in recovery (pg_is_in_recovery: $r)"; exit ${STOP_REFUSED_STATUS}; }; ` +
    'kill -INT 1',
]);

/**
 * The cold deploy's in-pod stop (requireRecovery: false); one `sh -c` token.
 * The deploy seeds a standby that runs as its own independent primary (a
 * fresh cluster's initdb, or a retired old primary), so recovery is no
 * precondition there: the container still proves its mounted wrapper speaks
 * the reseed protocol before PID 1 gets SIGINT. The deploy's own preflight
 * stands in for the recovery proof: both clusters report the intent the
 * config gives them (the guard's standby intent, prepareReseedSource's
 * primary one).
 */
export const DB_IN_PLACE_STOP_UNSEEDED = Object.freeze([
  'sh',
  '-c',
  `grep -q '^${DB_GUARD_PROTOCOL_MARKER}$' /usr/local/bin/db-guard.sh || { echo '${STOP_REFUSED} the mounted db-guard.sh does not speak the reseed protocol'; exit ${STOP_REFUSED_STATUS}; }; ` +
    'kill -INT 1',
]);

/**
 * Fail fast: a stop that takes shows within this (the readiness probe fails
 * within about 15s of the postmaster refusing connections).
 */
export const DB_IN_PLACE_STOP_BEGIN_TIMEOUT_S = 120;

const DB_POD_GET_ARGV = ['-n', 'vibecarbon', 'get', 'pod', DB_POD, '-o', 'json'];
const dbExecArgv = (argv) => [
  '-n',
  'vibecarbon',
  'exec',
  DB_POD,
  '-c',
  DB_CONTAINER,
  '--',
  ...argv,
];

/** The db container's spec and status from a parsed pod, or nulls. */
function dbContainerOf(pod) {
  const containers = pod?.spec?.containers;
  const statuses = pod?.status?.containerStatuses;
  return {
    spec: Array.isArray(containers) ? containers.find((c) => c?.name === DB_CONTAINER) : null,
    status: Array.isArray(statuses) ? statuses.find((c) => c?.name === DB_CONTAINER) : null,
  };
}

/** A short description of a container status's state, for refusals and deadlines. */
function describeContainerState(status) {
  if (!status) return 'no db container status';
  const state = status.state ?? {};
  const name = Object.keys(state)[0] ?? 'unknown';
  const reason = state[name]?.reason;
  return `${reason ?? name}, restartCount ${status.restartCount ?? '?'}, ready ${status.ready === true}`;
}

/**
 * The pod half of the guard: the wrapper command, its mount, the role mount,
 * and a running db container to restart.
 *
 * @returns {{ok: true, uid: string, restartCount: number, containerID: string} | {ok: false, reason: string, missing?: true}}
 */
function evaluateDbGuardPod(podJson) {
  let pod;
  try {
    pod = typeof podJson === 'string' ? JSON.parse(podJson) : podJson;
  } catch {
    return { ok: false, reason: 'the db pod JSON is unreadable' };
  }
  const { spec, status } = dbContainerOf(pod);
  const uid = pod?.metadata?.uid;
  if (!spec || typeof uid !== 'string' || !uid) {
    return { ok: false, reason: `no ${DB_CONTAINER} container in ${DB_POD}` };
  }
  const command = Array.isArray(spec.command) ? spec.command : [];
  if (
    command.length !== DB_GUARD_COMMAND.length ||
    command.some((token, i) => token !== DB_GUARD_COMMAND[i])
  ) {
    return {
      ok: false,
      missing: true,
      reason: `the running db container's command is ${JSON.stringify(spec.command ?? null)}, not ${JSON.stringify(DB_GUARD_COMMAND)}`,
    };
  }
  const mounts = Array.isArray(spec.volumeMounts) ? spec.volumeMounts : [];
  if (!mounts.some((m) => m?.mountPath === DB_GUARD_PATH)) {
    return {
      ok: false,
      missing: true,
      reason: `the running db container does not mount ${DB_GUARD_PATH}`,
    };
  }
  if (!podMountsWalgRoleDir(pod)) {
    return {
      ok: false,
      missing: true,
      reason: `the running db container has no wal-g role mount (${WALG_ROLE_DIR})`,
    };
  }
  const env = Array.isArray(spec.env) ? spec.env : [];
  const intentRef = env.find((e) => e?.name === DB_ROLE_INTENT_KEY)?.valueFrom?.configMapKeyRef;
  if (intentRef?.name !== DB_ROLE_CONFIGMAP || intentRef?.key !== DB_ROLE_INTENT_KEY) {
    return {
      ok: false,
      missing: true,
      reason: `the running db container does not take ${DB_ROLE_INTENT_KEY} from ConfigMap ${DB_ROLE_CONFIGMAP}`,
    };
  }
  if (
    !status?.state?.running ||
    typeof status.containerID !== 'string' ||
    !status.containerID ||
    !Number.isInteger(status.restartCount)
  ) {
    return {
      ok: false,
      notRunning: true,
      reason: `the db container is not running (${describeContainerState(status)})`,
    };
  }
  return { ok: true, uid, restartCount: status.restartCount, containerID: status.containerID };
}

/**
 * Pure. From the RUNNING pod JSON, the marker grep output and the intent read.
 * `missing: true` marks a pod that predates the in-place reseed (redeploy).
 *
 * @param {string|object} podJson `kubectl get pod db-0 -o json`
 * @param {string} markerGrepOut DB_GUARD_MARKER_GREP's stdout: the count line, then `in_recovery=<t|f|>`
 * @param {string} intent the vibecarbon-db-role ConfigMap's VC_WALG_ROLE_INTENT ('' when absent)
 * @param {{requireRecovery?: boolean}} [o] false only for the cold deploy's
 *   seed, whose standby runs as its own primary until the swap
 * @returns {{ok: true, uid: string, restartCount: number, containerID: string, inRecovery: string} | {ok: false, reason: string, missing?: true}}
 */
export function evaluateDbGuardSupport(
  podJson,
  markerGrepOut,
  intent,
  { requireRecovery = true } = {},
) {
  const verdict = evaluateDbGuardPod(podJson);
  if (!verdict.ok) return verdict;
  const out = String(markerGrepOut ?? '');
  const count = /^(\d+)$/m.exec(out)?.[1];
  if (!count || !/^[1-9]\d*$/.test(count)) {
    return {
      ok: false,
      missing: true,
      reason: `the mounted ${DB_GUARD_PATH} does not speak the reseed protocol (${DB_GUARD_PROTOCOL_MARKER})`,
    };
  }
  const word = String(intent ?? '').trim();
  if (word !== 'standby') {
    return { ok: false, reason: `the role intent is ${word || '<none>'}, not standby` };
  }
  const recovery = /^in_recovery=(.*)$/m.exec(out)?.[1]?.trim() ?? '';
  const slots = /^slots=(.*)$/m.exec(out)?.[1]?.trim() ?? '';
  const ready = /^ready=(.*)$/m.exec(out)?.[1]?.trim();
  const readings = {
    dbReady: ready === '1' ? true : ready === '0' ? false : null,
    inRecovery: recovery,
    slotCount: /^\d+$/.test(slots) ? Number(slots) : null,
    ...parseDbIdentity(/^ident=(.*)$/m.exec(out)?.[1] ?? ''),
  };
  if (!requireRecovery) return { ...verdict, ...readings };
  if (!recovery) {
    // psql did not answer. A standby in crash recovery refuses every
    // connection (a primary restored onto a new timeline does this to it), and
    // that standby is exactly the one a reseed is for: its data directory still
    // says what it is. standby.signal makes postgres start as a standby and
    // pg_promote removes it, so a primary never has one. DB_IN_PLACE_STOP
    // re-checks the same way in the stopping container.
    if (/^standby_signal=1$/m.test(out)) return { ...verdict, ...readings, standbySignal: true };
    // No answer and no file (postgres down or still starting): no verdict.
    return {
      ok: false,
      reason: `could not confirm the db is in recovery: psql in ${DB_POD} did not answer pg_is_in_recovery()`,
    };
  }
  if (recovery !== 't') {
    return {
      ok: false,
      reason: `postgres in ${DB_POD} is not in recovery (pg_is_in_recovery: ${recovery}); a standby intent over a primary`,
    };
  }
  return { ...verdict, ...readings };
}

/**
 * Refuse unless the RUNNING db pod will swap a staged tree on its next
 * container start: the wrapper command and mounts, the role mount, the
 * protocol marker in the mounted wrapper, and a `standby` intent (a
 * non-standby intent makes the wrapper refuse the swap). Reads in that order;
 * any refusal issues no further call.
 *
 * @param {(argv: string[], opts?: object) => Promise<string>} kubectl
 * @param {{envName?: string, requireRecovery?: boolean}} o requireRecovery
 *   false only for the cold deploy's seed (DB_IN_PLACE_STOP_UNSEEDED)
 * @returns {Promise<{ok: true, uid: string, restartCount: number, containerID: string, inRecovery: string}>}
 */
export async function assertLiveDbGuardSupportsReseed(
  kubectl,
  { envName, requireRecovery = true } = {},
) {
  const refuse = (verdict) => {
    if (verdict.missing) {
      return new DbGuardMissingError(
        `this cluster's db predates in-place reseeds; run \`vibecarbon deploy ${envName || '<env>'}\` once (one db restart), then retry (${verdict.reason})`,
        { reason: verdict.reason },
      );
    }
    // A db that is not running is named as such, so the cold deploy can add
    // the rebuild procedure (coldReseedError); failover and restore cannot.
    return Object.assign(new Error(`reseed refused: ${verdict.reason}`), {
      dbNotRunning: verdict.notRunning === true,
    });
  };
  const podJson = await kubectl(DB_POD_GET_ARGV, { timeout: 30_000 });
  const podVerdict = evaluateDbGuardPod(podJson);
  if (!podVerdict.ok) throw refuse(podVerdict);

  const intent = String(
    (await kubectl([...DB_ROLE_INTENT_READ], { timeout: 30_000 })) ?? '',
  ).trim();
  if (intent !== 'standby') {
    throw new Error(`reseed refused: role intent is ${intent || '<none>'}`);
  }

  const marker = await kubectl(dbExecArgv(DB_GUARD_MARKER_GREP), {
    timeout: DB_GUARD_EXEC_TIMEOUT_MS,
  });
  const verdict = evaluateDbGuardSupport(podJson, marker, intent, { requireRecovery });
  if (!verdict.ok) throw refuse(verdict);
  // The intent read here is the one the next container start resolves; the
  // in-place stage builds only for it (buildStagedBasebackupScript).
  return { ...verdict, intent };
}

/** An earlier in-place stage still holds the PGDATA lock: report, never retry. */
export class ReseedStageBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReseedStageBusyError';
  }
}

/** The stage's transfer ran past its remote deadline and was stopped: nothing staged. */
export class ReseedStageTimeoutError extends Error {
  /** @param {string} message @param {{deadlineS: number}} o */
  constructor(message, { deadlineS }) {
    super(message);
    this.name = 'ReseedStageTimeoutError';
    this.deadlineS = deadlineS;
  }
}

/**
 * Run the in-place stage script once and read its verdict. `RESEED_REFUSED
 * busy` (an earlier stage, maybe one whose client dropped, still holds
 * .vc-restore.lock) is terminal: a ReseedStageBusyError telling the operator
 * to wait and rerun. Never retried here, never by a caller. Any other failure
 * is rethrown as is; success must name this attempt (`RESEED_STAGED <id>`).
 * `RESEED_SKIPPED` (the probe never reached the primary) resolves `{skipped: true}`.
 *
 * @param {() => Promise<string>} exec runs the stage once, resolves its stdout,
 *   rejects with an error carrying `stdout` on a non-zero exit
 * @param {{attempt: string}} o
 * @returns {Promise<{staged: string} | {skipped: true}>}
 */
export async function runInPlaceStage(exec, { attempt }) {
  let out;
  try {
    out = await exec();
  } catch (error) {
    // The stage's own refusal only: a stdout line under its exit 1, never the
    // message (it can quote the script) and never stderr.
    const timedOut = refusalFromError(error, 'RESEED_TIMEOUT', { status: 1 });
    if (timedOut !== null && /^\d+$/.test(timedOut)) {
      throw new ReseedStageTimeoutError(
        `reseed stage timed out: pg_basebackup did not finish within ${timedOut}s and was stopped; nothing was staged`,
        { deadlineS: Number(timedOut) },
      );
    }
    if (refusalFromError(error, 'RESEED_REFUSED', { status: 1 }) === 'busy') {
      throw new ReseedStageBusyError(
        'reseed refused: an earlier reseed stage is still running on the standby (it holds ' +
          'the data directory lock). Nothing was staged. Wait for it to finish, then rerun the reseed.',
      );
    }
    throw error;
  }
  // The probe never reached the primary: nothing was staged, nothing to swap.
  if (hasSentinelLine(out, 'RESEED_SKIPPED')) return { skipped: true };
  const staged = sentinelLinePayload(out, 'RESEED_STAGED');
  if (staged !== attempt) {
    throw new Error(
      `reseed stage finished without staging attempt ${attempt} (saw ${staged === null ? 'no RESEED_STAGED line' : `RESEED_STAGED ${staged}`}); nothing will be swapped`,
    );
  }
  return { staged };
}

/**
 * The ONE sanctioned in-pod postmaster stop: DB_IN_PLACE_STOP, then a bounded
 * wait (DB_STS_BOOT_TIMEOUT_S, covers kubelet's 300s max backoff) for the SAME
 * pod uid with restartCount > before, a new containerID and Ready. A changed uid
 * is reported and handed to `recreatedWait`, never retried.
 *
 * The guard is minutes old by now (a base backup ran in between), so the pod
 * is read again right before the stop: the same uid, the same running
 * container (restartCount and containerID) the guard saw, or no stop is sent.
 * That read is the baseline. A guard reused after its restart refuses here
 * too. The stop itself re-proves the wrapper and recovery in the container it
 * signals, and a refusal there is reported, never waited on.
 *
 * Otherwise the exec's own result is no evidence: SIGINT to PID 1 stops the
 * container the exec runs in, so the exec can die with it. The container's
 * state decides. A pod read that fails (the pod mid-recreate) is no evidence
 * either; the deadlines bound the wait. A stop that never takes (the
 * container still running and Ready, unchanged) fails after
 * DB_IN_PLACE_STOP_BEGIN_TIMEOUT_S rather than the whole budget.
 *
 * @param {(argv: string[], opts?: object) => Promise<string>} kubectl
 * @param {object} o
 * @param {{ok: true, uid: string, restartCount: number, containerID: string}} o.guard assertLiveDbGuardSupportsReseed's result
 * @param {() => Promise<unknown>} o.recreatedWait the attach-watched rollout wait (k8sDbRolloutWait)
 * @param {boolean} [o.requireRecovery=true] false sends DB_IN_PLACE_STOP_UNSEEDED (the cold deploy's seed, whose guard ran with requireRecovery: false)
 * @param {number} [o.timeoutS]
 * @param {number} [o.pollMs]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<{inPlace: boolean, uid: string}>}
 */
export async function restartDbContainerInPlace(
  kubectl,
  {
    guard,
    recreatedWait,
    requireRecovery = true,
    timeoutS = DB_STS_BOOT_TIMEOUT_S,
    pollMs = 3000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
    log = (m) => console.error(m),
  } = {},
) {
  if (guard?.ok !== true || typeof guard.uid !== 'string' || !guard.uid) {
    throw new Error(
      'restartDbContainerInPlace: no live-pod guard; assertLiveDbGuardSupportsReseed must pass first',
    );
  }
  if (typeof recreatedWait !== 'function') {
    throw new Error('restartDbContainerInPlace: recreatedWait is required');
  }
  const pre = evaluateDbGuardPod(await kubectl(DB_POD_GET_ARGV, { timeout: 30_000 }));
  if (!pre.ok) {
    throw new Error(`reseed refused: ${pre.reason}; nothing was stopped`);
  }
  if (
    pre.uid !== guard.uid ||
    pre.restartCount !== guard.restartCount ||
    pre.containerID !== guard.containerID
  ) {
    throw new Error(
      `reseed refused: ${DB_POD} changed since the guard (uid ${guard.uid} -> ${pre.uid}, ` +
        `restartCount ${guard.restartCount} -> ${pre.restartCount}, container ${guard.containerID} -> ${pre.containerID}); ` +
        'nothing was stopped. Rerun the reseed',
    );
  }
  const baseline = pre;
  const started = now();
  const deadline = started + timeoutS * 1000;
  const beginDeadline = started + Math.min(timeoutS, DB_IN_PLACE_STOP_BEGIN_TIMEOUT_S) * 1000;
  try {
    await kubectl(dbExecArgv(requireRecovery ? DB_IN_PLACE_STOP : DB_IN_PLACE_STOP_UNSEEDED), {
      timeout: 30_000,
    });
  } catch (error) {
    // Only the script's own refusal: its stdout line under exit 3. The
    // message quotes the script (sentinel included), so it is never read.
    const refused = refusalFromError(error, STOP_REFUSED, { status: STOP_REFUSED_STATUS });
    if (refused !== null) {
      throw new Error(`reseed refused in ${DB_POD}: ${refused}; nothing was stopped`);
    }
    log(
      `[reseed] the stop exec ended with: ${error?.message ?? error} (the container state decides)`,
    );
  }
  let began = false;
  let last = 'no db pod read yet';
  for (;;) {
    let recreatedUid = null;
    try {
      const pod = JSON.parse(String(await kubectl(DB_POD_GET_ARGV, { timeout: 30_000 })));
      const uid = pod?.metadata?.uid;
      if (typeof uid === 'string' && uid && uid !== baseline.uid) {
        recreatedUid = uid;
      } else {
        const { status } = dbContainerOf(pod);
        last = describeContainerState(status);
        const restarted =
          Number.isInteger(status?.restartCount) &&
          status.restartCount > baseline.restartCount &&
          typeof status.containerID === 'string' &&
          status.containerID &&
          status.containerID !== baseline.containerID;
        if (uid === baseline.uid && restarted && status.ready === true) {
          return { inPlace: true, uid };
        }
        if (
          restarted ||
          status?.ready !== true ||
          !status?.state?.running ||
          status?.containerID !== baseline.containerID
        ) {
          began = true;
        }
      }
    } catch (error) {
      last = `unreadable: ${error?.message ?? error}`;
    }
    // Outside the read's catch: the recreated pod's rollout wait runs once,
    // and its failure (a stale volume attachment, a timeout) is the verdict,
    // never a reason to poll and wait again.
    if (recreatedUid !== null) {
      log(
        `[reseed] ${DB_POD} was recreated (uid ${baseline.uid} -> ${recreatedUid}), not restarted in place; ` +
          'waiting on its rollout under the attach watch',
      );
      await recreatedWait();
      return { inPlace: false, uid: recreatedUid };
    }
    if (!began && now() >= beginDeadline) {
      throw new Error(
        `the stop did not take: ${DB_POD}'s db container is still running unchanged ` +
          `${Math.min(timeoutS, DB_IN_PLACE_STOP_BEGIN_TIMEOUT_S)}s after it (last state: ${last}); ` +
          'no second stop was sent',
      );
    }
    if (now() >= deadline) {
      throw new Error(
        `${DB_POD}'s db container did not come back Ready in place within ${timeoutS}s ` +
          `after the stop (last state: ${last}); no second stop was sent`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Wall-clock budget for a promotion to show up as "out of recovery". A deadline,
 * not a poll count: the verdict below is what keeps failover correct, and this
 * number only bounds RTO (R3, M3).
 */
export const PROMOTE_DEADLINE_MS = 120_000;

/**
 * A psql runner for the k8s db pod: `exec(sql, { readWrite }) -> Promise<string>`,
 * the shape failover-guard's readReplicaState takes. `readWrite` opens the
 * session read-write on a write-fenced server (the un-fence).
 *
 * @param {string} ip - cluster master IP (kubectl target)
 * @param {string} sshKeyPath
 * @returns {(sql: string) => Promise<string>}
 */
export function k8sPsqlRunner(ip, sshKeyPath) {
  return async (sql, { readWrite = false } = {}) => {
    const pod = await getPostgresPod(ip, sshKeyPath);
    const out = await sshKubectl(ip, sshKeyPath, [
      'exec',
      '-n',
      'vibecarbon',
      pod,
      '--',
      ...(readWrite ? ['env', `PGOPTIONS=${READ_WRITE_PGOPTIONS}`] : []),
      'psql',
      '-U',
      'postgres',
      '-tAc',
      sql,
    ]);
    return typeof out === 'string' ? out : '';
  };
}

/**
 * How long a planned failover waits for a streaming standby to replay the
 * fenced primary's final WAL. A deadline, not a poll count (R3): the poll
 * interval only paces the reads.
 */
export const CATCH_UP_DEADLINE_MS = 60_000;

const LSN_RE = /^[0-9A-Fa-f]+\/[0-9A-Fa-f]+$/;

/** How long the write fence (or its removal) may take to read back applied. */
export const WRITE_FENCE_DEADLINE_MS = 15_000;

/**
 * The backends a write fence terminates: client sessions, plus pg_cron job
 * workers when cron.use_background_workers is on (with it off, pg_cron jobs
 * already run as client backends). Never a walsender, checkpointer, bgwriter,
 * walwriter, autovacuum launcher, archiver, startup, the logical replication
 * launcher, the pg_cron launcher, or the fencing session itself. OFFSET 0 keeps
 * the planner from evaluating pg_terminate_backend before the filter.
 */
export const TERMINATE_CLIENT_BACKENDS_SQL =
  "SELECT coalesce(string_agg(pid::text || '=' || ok::text, ','), '') FROM (" +
  'SELECT pid, pg_terminate_backend(pid, 5000) AS ok FROM (' +
  'SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() ' +
  "AND backend_type IN ('client backend', 'pg_cron', 'pg_cron worker') OFFSET 0) c) t";

const readSetting = async (exec) => {
  const out = await exec(`SELECT current_setting('${WRITE_FENCE_SETTING}')`);
  return (typeof out === 'string' ? out : '').trim();
};

/** Poll a fresh session's view of the fence setting until it reads `want`, or the deadline. */
async function waitForSetting(exec, want, { deadlineMs, pollMs, sleep, now }) {
  const deadline = now() + deadlineMs;
  let last = '';
  for (;;) {
    try {
      last = await readSetting(exec);
    } catch (err) {
      last = String(err?.message ?? err).split('\n')[0];
    }
    if (last === want) return { ok: true, last };
    if (now() >= deadline) return { ok: false, last };
    await sleep(pollMs);
  }
}

/**
 * Fence writes on the old primary at the database, the guarantee behind a
 * planned failover's RPO 0 (stopping the app is only the outward signal):
 *   1. ALTER SYSTEM SET default_transaction_read_only = on, pg_reload_conf();
 *   2. read it back as `on` from a fresh session (the reload is a signal);
 *   3. terminate every client backend (and pg_cron job worker), waiting up to
 *      5 s each, so no session opened before the fence keeps a read-write
 *      transaction; then prove none of them is left.
 * Only after this is the primary's WAL position stable, so the caller captures
 * the LSN next. Throws a one-line cause when any step cannot be proven.
 *
 * @param {object} opts
 * @param {(sql: string) => Promise<string>} opts.exec - psql on the old primary
 * @returns {Promise<{ terminated: number }>}
 */
export async function fenceDatabaseWrites({
  exec,
  deadlineMs = WRITE_FENCE_DEADLINE_MS,
  pollMs = 500,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  if (typeof exec !== 'function') throw new TypeError('fenceDatabaseWrites: exec is required');
  // Separate statements: ALTER SYSTEM cannot run inside a transaction block,
  // and one multi-statement -c string is one implicit transaction.
  await exec(`ALTER SYSTEM SET ${WRITE_FENCE_SETTING} = on`);
  await exec('SELECT pg_reload_conf()');
  const applied = await waitForSetting(exec, 'on', { deadlineMs, pollMs, sleep, now });
  if (!applied.ok) {
    throw new Error(
      `write fence: the old primary did not read back ${WRITE_FENCE_SETTING} = on ` +
        `(last read: ${applied.last || 'none'}), so its writes are not fenced`,
    );
  }

  const out = await exec(TERMINATE_CLIENT_BACKENDS_SQL);
  const text = (typeof out === 'string' ? out : '').trim();
  if (text !== '' && !/^\d+=[tf](,\d+=[tf])*$/.test(text)) {
    throw new Error(
      `write fence: could not terminate the old primary's client sessions ` +
        `(got: ${text.slice(0, 80)})`,
    );
  }
  const pids = text === '' ? [] : text.split(',').map((x) => x.split('=')[0]);
  if (pids.length > 0) {
    const left = await exec(
      `SELECT count(*) FROM pg_stat_activity WHERE pid IN (${pids.join(', ')})`,
    );
    if ((typeof left === 'string' ? left : '').trim() !== '0') {
      throw new Error(
        `write fence: ${String(left).trim() || 'an unknown number of'} client session(s) on ` +
          `the old primary outlived pg_terminate_backend, so its writes are not fenced`,
      );
    }
  }
  return { terminated: pids.length };
}

/**
 * Lift the write fence (an aborted failover that promoted nothing): ALTER
 * SYSTEM RESET default_transaction_read_only, pg_reload_conf(), read back off.
 * Never throws: the caller reports the manual fix.
 *
 * @returns {Promise<boolean>} true when it reads back off
 */
export async function unfenceDatabaseWrites({
  exec,
  deadlineMs = WRITE_FENCE_DEADLINE_MS,
  pollMs = 500,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  try {
    // readWrite: the fenced server opens every session read-only, and the
    // docs list "all ALTER commands" as refused in a read-only transaction.
    await exec(`ALTER SYSTEM RESET ${WRITE_FENCE_SETTING}`, { readWrite: true });
    await exec('SELECT pg_reload_conf()');
    return (await waitForSetting(exec, 'off', { deadlineMs, pollMs, sleep, now })).ok;
  } catch {
    return false;
  }
}

/**
 * The manual un-fence, for a message when unfenceDatabaseWrites cannot prove it.
 * psql -c, one statement each (ALTER SYSTEM refuses a transaction block). Only
 * double quotes, so it nests inside the single-quoted ssh command it is shown in.
 */
export const UNFENCE_SQL_HINT =
  `env PGOPTIONS="-c ${WRITE_FENCE_SETTING}=off" psql -U postgres ` +
  `-c "ALTER SYSTEM RESET ${WRITE_FENCE_SETTING}" -c "SELECT pg_reload_conf()"`;

/** PGOPTIONS for a session that must write on a fenced server (the un-fence). */
export const READ_WRITE_PGOPTIONS = `-c ${WRITE_FENCE_SETTING}=off`;

/**
 * A reseeded standby must not carry the fence into its promote: a basebackup
 * of a fenced primary copies postgresql.auto.conf, and the staged-reseed script
 * strips the setting (buildStagedBasebackupScript). This proves it from the
 * files themselves (pg_file_settings reads them, in recovery too). Throws.
 *
 * @param {object} opts
 * @param {(sql: string) => Promise<string>} opts.exec - psql on the standby
 */
export async function assertStandbyNotWriteFenced({ exec }) {
  const out = await exec(
    `SELECT count(*) FROM pg_file_settings WHERE name = '${WRITE_FENCE_SETTING}'`,
  );
  const n = (typeof out === 'string' ? out : '').trim();
  if (n !== '0') {
    throw new Error(
      n === ''
        ? `could not read the reseeded standby's settings files, so it may carry the ` +
            `old primary's write fence and would promote read-only`
        : `the reseeded standby carries the old primary's write fence ` +
            `(${WRITE_FENCE_SETTING} in its settings files) and would promote read-only`,
    );
  }
}

/**
 * PLANNED-failover zero-data-loss gate, for any transport (R1d). Runs after the
 * old primary is fenced (no writer can commit) and before the promote.
 *
 * Captures the primary's `pg_current_wal_lsn()` once, which is stable for
 * customer writes once the primary is fenced, then reads the standby's replay
 * lag behind it until that lag is zero. Streaming is not caught up: the WAL
 * written just before the fence may still be in flight, and promoting then
 * silently drops it.
 *
 * - A streaming standby that reaches the LSN: `{ caughtUp: true, lagBytes: 0 }`.
 * - A streaming standby still behind at the deadline: THROWS, so the caller's
 *   abort path runs and a lagging standby is never promoted.
 * - A standby that is not streaming: `{ caughtUp: false, lagBytes: null }`. It
 *   cannot catch up, so the caller must reseed it from the fenced primary (a
 *   full copy) or refuse. It is never read as "the gate does not apply".
 *
 * `primaryLsn` is returned in every case: it is the failover journal's
 * `primaryLsn` (R2).
 *
 * @param {object} opts
 * @param {(sql: string) => Promise<string>} opts.primaryExec - psql on the primary
 * @param {(sql: string) => Promise<string>} opts.standbyExec - psql on the standby
 * @param {() => Promise<boolean>} opts.isStreaming - the standby's walreceiver streams
 * @param {number} [opts.deadlineMs]
 * @param {number} [opts.pollMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @returns {Promise<{ caughtUp: boolean, lagBytes: number|null, primaryLsn: string }>}
 */
export async function waitForStandbyCaughtUp({
  primaryExec,
  standbyExec,
  isStreaming,
  deadlineMs = CATCH_UP_DEADLINE_MS,
  pollMs = 2000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  for (const [name, fn] of Object.entries({ primaryExec, standbyExec, isStreaming })) {
    if (typeof fn !== 'function') {
      throw new TypeError(`waitForStandbyCaughtUp: ${name} is required`);
    }
  }
  const deadline = now() + deadlineMs;

  const raw = await primaryExec('SELECT pg_current_wal_lsn()');
  const primaryLsn = (typeof raw === 'string' ? raw : '').trim();
  if (!LSN_RE.test(primaryLsn)) {
    throw new Error(
      `zero-data-loss gate: could not read the primary's WAL position before the promote ` +
        `(got: ${primaryLsn.slice(0, 80) || 'empty'}), so the standby was not promoted`,
    );
  }

  if (!(await isStreaming())) return { caughtUp: false, lagBytes: null, primaryLsn };

  let lagBytes = null;
  let last = '';
  for (;;) {
    try {
      const out = await standbyExec(
        `SELECT pg_wal_lsn_diff('${primaryLsn}', pg_last_wal_replay_lsn())`,
      );
      const text = (typeof out === 'string' ? out : '').trim();
      const n = text === '' ? Number.NaN : Number(text);
      if (Number.isFinite(n)) {
        lagBytes = Math.max(0, n);
        if (lagBytes === 0) return { caughtUp: true, lagBytes: 0, primaryLsn };
      } else {
        last = text || 'no replay position';
      }
    } catch (err) {
      last = String(err?.message ?? err).split('\n')[0];
    }
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  throw new Error(
    `zero-data-loss gate: the standby did not replay the primary's final WAL (${primaryLsn}) ` +
      `within ${Math.round(deadlineMs / 1000)}s ` +
      `(${lagBytes === null ? `last read: ${last || 'none'}` : `${lagBytes} bytes behind`}), ` +
      `so it was not promoted`,
  );
}

/**
 * Issue a promote and prove it landed, for any transport. The verdict:
 *   - 'promoted': it was read IN recovery immediately before the promote was
 *     issued, then read out of it before the deadline;
 *   - 'not-issued': the reading right before the issue was not in recovery (or
 *     unreadable), so this call sent nothing. That proves nothing about an
 *     earlier run's promote: a caller may un-fence on it only when its run
 *     started with no failover journal;
 *   - 'unknown': everything after the issue that is not a proven promote: an
 *     issue that throws, and any deadline without a proven out-of-recovery
 *     reading. An issued promote cannot be taken back: postgres deletes
 *     promote.signal itself when it accepts the request and still reads in
 *     recovery while it finishes, so a late "still in recovery" proves nothing.
 *
 * On 'unknown' the caller keeps the old primary fenced and its journal set, and
 * the rerun finishes the job (R3).
 *
 * @param {object} opts
 * @param {() => Promise<{ inRecovery: boolean|null }>} opts.readState - the
 *   standby's failover-guard readReplicaState (required: the 't'/'f' parse
 *   lives there and nowhere else)
 * @param {() => Promise<unknown>} opts.issuePromote - sends the promote; its
 *   result is ignored (the reads decide)
 * @param {number} [opts.pollMs]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {number} [opts.deadlineMs] - measured from before the first read, so
 *   it bounds the whole promote window
 * @returns {Promise<'promoted'|'not-issued'|'unknown'>}
 */
export async function promoteWithProof({
  readState,
  issuePromote,
  deadlineMs = PROMOTE_DEADLINE_MS,
  pollMs = 2000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (typeof readState !== 'function') {
    throw new TypeError('promoteWithProof: readState is required');
  }
  if (typeof issuePromote !== 'function') {
    throw new TypeError('promoteWithProof: issuePromote is required');
  }
  const read = async () => {
    try {
      return (await readState())?.inRecovery ?? null;
    } catch {
      return null;
    }
  };

  const deadline = now() + deadlineMs;
  if ((await read()) !== true) return 'not-issued';

  try {
    await issuePromote();
  } catch {
    // It may have landed anyway (a promote can exit non-zero on success, an
    // ssh session can drop after the server accepted it): the reads decide.
  }

  // From here on a promote may land at any time: only a proven out-of-recovery
  // reading is an answer, and the deadline without one is 'unknown'.
  for (;;) {
    if ((await read()) === false) return 'promoted';
    if (now() >= deadline) return 'unknown';
    await sleep(pollMs);
  }
}

/**
 * Promote the standby database (k8s transport): `pg_ctl promote` in its db pod,
 * proven by promoteWithProof. A db pod that cannot be resolved is 'unknown' like
 * any other failed issue: the pod lookup is part of the issue.
 *
 * @param {string} standbyIp
 * @param {string} sshKeyPath
 * @param {object} opts - promoteWithProof's options, minus issuePromote
 * @returns {Promise<'promoted'|'not-issued'|'unknown'>}
 */
export async function promoteStandby(standbyIp, sshKeyPath, opts = {}) {
  if (typeof opts.readState !== 'function') {
    throw new TypeError('promoteStandby: readState is required');
  }
  return promoteWithProof({
    ...opts,
    issuePromote: async () => {
      const pod = await getPostgresPod(standbyIp, sshKeyPath);
      await sshKubectl(standbyIp, sshKeyPath, [
        'exec',
        '-n',
        'vibecarbon',
        pod,
        '--',
        'su',
        'postgres',
        '-c',
        'pg_ctl promote -D /var/lib/postgresql/data',
      ]);
    },
  });
}

/**
 * Is the standby ALREADY streaming, read from the STANDBY side (k8s transport)?
 *
 * Queries pg_stat_wal_receiver.status on the standby db pod — the standby's own
 * view of its walreceiver. Returns true only when status='streaming'. The
 * standby-side signal is preferred at failover time: failover often runs when
 * the PRIMARY is unhealthy/unreachable, and the standby can still report its own
 * receiver state (whereas the primary-side pg_stat_replication would be
 * unreadable). Non-throwing — any error (pod down, view empty, exec failure)
 * returns false so the caller falls back to a normal re-seed.
 *
 * @param {string} standbyIp - standby cluster master IP (kubectl target)
 * @param {string} sshKeyPath
 * @returns {Promise<boolean>}
 */
export async function isStandbyStreaming(standbyIp, sshKeyPath) {
  try {
    const pod = await getPostgresPod(standbyIp, sshKeyPath);
    const out = await sshKubectl(standbyIp, sshKeyPath, [
      'exec',
      '-n',
      'vibecarbon',
      pod,
      '--',
      'psql',
      '-U',
      'postgres',
      '-tAc',
      'SELECT status FROM pg_stat_wal_receiver',
    ]);
    return (typeof out === 'string' ? out : '').trim() === 'streaming';
  } catch {
    return false;
  }
}

/**
 * Read the standby's replication state as seen on the PRIMARY (k8s transport).
 * Returns pg_stat_replication.state ('streaming'/'catchup'/…) or '' when no
 * replica is connected. Suitable as the `readState` closure for verifyStreaming.
 *
 * @param {string} primaryIp
 * @param {string} sshKeyPath
 * @returns {Promise<string>}
 */
export async function readK8sReplicationState(primaryIp, sshKeyPath) {
  const pod = await getPostgresPod(primaryIp, sshKeyPath);
  const result = await sshKubectl(primaryIp, sshKeyPath, [
    'exec',
    '-n',
    'vibecarbon',
    pod,
    '--',
    'psql',
    '-U',
    'postgres',
    '-tAc',
    "SELECT state FROM pg_stat_replication ORDER BY (state = 'streaming') DESC LIMIT 1",
  ]);
  const out = (typeof result === 'string' ? result : '').trim();
  // `psql -tAc` yields exactly one token: a pg_stat_replication.state value, or
  // '' when no replica is connected. Anything else means the read itself failed —
  // an SSH/kubectl error banner (e.g. "banner exchange: Connection timed out")
  // leaked through as stdout. Throw so verifyStreaming RETRIES rather than letting
  // the error text masquerade as a replication state in the deploy-abort message.
  const VALID_STATES = new Set(['', 'startup', 'catchup', 'streaming', 'backup', 'stopping']);
  if (!VALID_STATES.has(out)) {
    throw new Error(`could not read pg_stat_replication (unexpected output: ${out.slice(0, 120)})`);
  }
  return out;
}

/**
 * Task 12 (pilot-light standby spec) — replication-lag visibility for
 * `vibecarbon status`. Spec rationale: "Insurance you cannot observe is not
 * trustworthy; silent lag growth is the main RPO risk of a minimal
 * standby." These three pure functions are the read-only queries + line
 * formatter `checkReplication` (src/status.js) drives; they are
 * deliberately separate from the pre-existing pg_wal_lsn_diff-based
 * streaming/DR-not-guaranteed check (byte lag) above — this is TIME lag
 * (seconds), which is what an operator actually compares against an RPO
 * target, and it is additive: the pre-existing check is untouched.
 *
 * PRIMARY's view: state + replay_lag, i.e. how far behind the standby's
 * REPLAY (not just receive) has fallen, as seen from the WAL sender.
 * `LIMIT 1` — status only ever has one standby to report on.
 * `COALESCE(...,0)` turns a NULL replay_lag (no lag sample recorded yet,
 * e.g. moments after connecting) into 0 rather than a blank field.
 *
 * @returns {string}
 */
export function buildPrimaryLagQuery() {
  return 'SELECT state, COALESCE(EXTRACT(EPOCH FROM replay_lag),0) FROM pg_stat_replication LIMIT 1';
}

/**
 * STANDBY's own self-view: whether it is actually in recovery (a standby
 * that is not is not functioning as a standby — DR is not guaranteed no
 * matter what the primary's view says), the last WAL position it replayed,
 * and how long ago (seconds) its last replayed transaction landed. This is
 * the view that matters precisely when the primary's view is missing — a
 * disconnected standby is invisible to pg_stat_replication, but can still
 * report on itself.
 *
 * @returns {string}
 */
export function buildStandbyReplayQuery() {
  return (
    'SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn(), ' +
    'COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())),0)'
  );
}

/**
 * Format the single replication-lag status line from the two read-only
 * views above, already parsed by the caller into:
 *   primaryRow: { state: string, lagSeconds: number } | null
 *   standbyRow: { inRecovery: boolean, lastWalReplayLsn: string, secondsSinceReplay: number } | null
 * `null` means the query could not be run or parsed (probe timeout,
 * ssh/kubectl failure, empty result) — distinct from a valid-but-zero row.
 *
 * Priority (most urgent first):
 *   1. The standby explicitly reports it is NOT in recovery — regardless of
 *      what the primary's view says, this env is not DR-guaranteed (the
 *      standby was promoted, or never entered recovery in the first
 *      place). Checked first and unconditionally.
 *   2. The primary's view is available — the normal, healthy path.
 *   3. Only the standby's self-view is available — the exact case the spec
 *      calls out: the primary's view is what goes missing when a standby
 *      disconnects, so the standby's own last-replay age is the only
 *      signal left, and it must not be hidden.
 *   4. Neither view is available.
 *
 * @param {{ primaryRow?: {state:string,lagSeconds:number}|null, standbyRow?: {inRecovery:boolean,lastWalReplayLsn:string,secondsSinceReplay:number}|null }} [o]
 * @returns {string}
 */
export function formatReplicationLagLine({ primaryRow, standbyRow } = {}) {
  if (standbyRow && standbyRow.inRecovery === false) {
    return 'Replication: standby not in recovery; DR NOT GUARANTEED';
  }
  if (primaryRow) {
    const secs = Number.isFinite(primaryRow.lagSeconds) ? primaryRow.lagSeconds : 0;
    const state = primaryRow.state || 'unknown';
    return `Replication lag: ${secs.toFixed(1)}s (${state})`;
  }
  if (standbyRow) {
    const secs = Math.round(
      Number.isFinite(standbyRow.secondsSinceReplay) ? standbyRow.secondsSinceReplay : 0,
    );
    return `Replication lag: unknown (primary view unavailable; standby last replay ${secs}s ago)`;
  }
  return 'Replication lag: unknown (no data available)';
}
