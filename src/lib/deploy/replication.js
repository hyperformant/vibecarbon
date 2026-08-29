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

import { pollUntil } from '../retry.js';
import { getPostgresPod, sshKubectl } from '../ssh.js';
import { REPL_GATEWAY_PORT } from './wireguard.js';

// The supabase-db StatefulSet name (helm release `supabase`, chart `supabase`,
// component `db` → `supabase-supabase-db`). Used by the k8s re-seed's
// scale-to-zero quiesce.
const DB_STATEFULSET = 'supabase-supabase-db';

/**
 * Shared budget for every db-StatefulSet boot/rollout wait (the deploy-side
 * reseed standbyBoot + dbHostPort recreate in k8s/ha/index.js, and the
 * failover/restore-side reseed wait below). 600s, raised from 300s
 * 2026-08-29: DigitalOcean CSI detach/attach settle pushed a HEALTHY
 * standby boot past 300s (run 33252884427 — the rollout wait timed out and
 * the failure diagnostics a minute later showed the pod Ready); Hetzner
 * CSI reattach was already documented as "minutes" beside those waits. Any
 * SSH client timeout wrapping a wait on this budget must exceed it, or the
 * transport kills kubectl before kubectl can name the stuck sts
 * (reseed-standby.test.ts pins that; db-sts-boot-timeout-census.test.ts
 * drafts new waits into this budget).
 */
export const DB_STS_BOOT_TIMEOUT_S = 600;

// Staging subdir INSIDE PGDATA for the swap:false re-seed — on the PVC
// filesystem so the node-side promotion is an atomic same-fs rename.
const RESEED_STAGING_DIR = '/var/lib/postgresql/data/.reseed_staging';

// The physical replication slot name is a project-wide constant — the primary
// creates it, the standby's pg_basebackup -S references it, and streaming uses
// it so the primary holds WAL for this standby specifically.
const REPLICATION_SLOT = 'vibecarbon_standby_slot';

// The single replication port for BOTH HA modes. compose publishes db:5432 →
// host:5433 (supavisor owns host 5432); k8s uses a hostPort 5433 → container
// 5432. One port keeps primary_conninfo / pg_basebackup byte-identical.
export const REPL_PORT = 5433;

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
 * @param {{primaryHost:string, replPassword?:string, applicationName?:string, port?:string|number, passwordExpr?:string|null}} o
 * @returns {string}
 */
export function buildPrimaryConninfo({
  primaryHost,
  replPassword,
  applicationName = 'standby',
  port = REPL_PORT,
  // When set, rendered VERBATIM instead of replPassword — lets a script that
  // must stay secret-free (ConfigMap-delivered seed init) expand the password
  // from its environment at runtime: passwordExpr: '$REPL_PASSWORD'.
  passwordExpr = null,
}) {
  return (
    `host=${primaryHost} port=${port} user=replicator ` +
    `password=${passwordExpr ?? replPassword} sslmode=disable ` +
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
 *      without PG_VERSION; the supabase-db entrypoint then runs initdb on next
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
 * supabase-db pod the postmaster is PID 1, so an in-pod `pg_ctl stop` (which
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
 * @param {number} [opts.basebackupAttempts=1] - bounded retry budget for
 *   pg_basebackup itself (distinct from probeAttempts, which only gates
 *   pg_isready reachability before any destructive work). >1 wraps the
 *   staging + pg_basebackup + PG_VERSION check in a loop that wipes staging
 *   between attempts, so a ConfigMap-delivered init container can keep
 *   retrying until the primary becomes replication-ready. Default 1
 *   reproduces the old single-shot behavior byte-for-byte.
 * @param {number} [opts.basebackupDelayS=15] - seconds between basebackup
 *   attempts (only relevant when basebackupAttempts > 1).
 * @param {boolean} [opts.exhaustExitZero=false] - when the attempt budget is
 *   exhausted, exit 0 instead of 1 — the chart's own initdb boots the db
 *   independently and the serial reseed path still covers replication later,
 *   so a bounded-wait init container should not be treated as a hard failure.
 * @param {boolean} [opts.passwordFromEnv=false] - source PGPASSWORD from the
 *   `$REPL_PASSWORD` environment variable at runtime instead of embedding the
 *   literal password in the script — lets the script live in a secret-free
 *   ConfigMap.
 * @param {number|null} [opts.connectTimeoutS=null] - when set, the script's
 *   preamble exports `PGCONNECT_TIMEOUT=<n>` (libpq honors it for
 *   pg_basebackup's connection phase). Without it, an absent transport (e.g.
 *   a missing NetworkPolicy silently dropping SYNs) hangs EACH attempt at the
 *   OS TCP connect timeout (~127s on Linux) — turning a bounded retry budget
 *   like 24×15s≈6min into 50+ minutes wall-clock. Default null → nothing
 *   emitted, byte-compat with every existing caller.
 * @param {number|null} [opts.deadlineSeconds=null] - when set (only
 *   meaningful with basebackupAttempts > 1), the retry loop also breaks once
 *   bash's builtin `$SECONDS` reaches this value, regardless of how many
 *   attempts remain in the budget — a second, wall-clock-based bound that
 *   holds even if connectTimeoutS is unset or an attempt hangs for some other
 *   reason. On break, the normal exhaustion path runs (same seed_ok check →
 *   exhaustExitZero handling). `$SECONDS` requires bash (not plain POSIX sh);
 *   every caller of this script (the k8s-ha standby seed init container, the
 *   helper-pod swap) invokes it as `bash -c`/`exec bash <script>`, so bash is
 *   guaranteed. Default null → nothing emitted, byte-compat.
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
  basebackupAttempts = 1,
  basebackupDelayS = 15,
  exhaustExitZero = false,
  passwordFromEnv = false,
  connectTimeoutS = null,
  deadlineSeconds = null,
}) {
  // libpq honors PGCONNECT_TIMEOUT for pg_basebackup's connection phase — see
  // opts.connectTimeoutS above for why this matters (transport-absent hangs).
  const connectTimeoutBlock =
    connectTimeoutS != null
      ? `
export PGCONNECT_TIMEOUT=${connectTimeoutS}
`
      : '';

  // Wall-clock guard injected at the top of the retry loop body (only used
  // when basebackupAttempts > 1) — see opts.deadlineSeconds above.
  const deadlineGuardBlock =
    deadlineSeconds != null
      ? `  if [ "\${SECONDS}" -ge ${deadlineSeconds} ]; then
    echo "[${label}] wall-clock deadline (${deadlineSeconds}s) reached before pg_basebackup succeeded, aborting the retry loop" >&2
    break
  fi
`
      : '';

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
# succeed (live RCA 2026-07-06: probe OK, then pg_basebackup FATAL
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
  echo "[${label}] primary postgres at ${primaryHost}:${primaryPort} not reachable from standby after ${probeAttempts} attempts, skipping pg_basebackup. Standby keeps its independent postgres; failover serves the app but data does not sync from primary." >&2
  exit 0
fi
`
    : '';

  // Explicit primary_conninfo (last entry in postgresql.auto.conf wins). Written
  // into the STAGING dir so it survives the node-side swap. Heredoc-quoted so the
  // interpolated value (already a literal) is not re-expanded by the shell —
  // EXCEPT when passwordFromEnv is true: primaryConninfo then embeds a runtime
  // expression (e.g. `password=$REPL_PASSWORD`, from buildPrimaryConninfo's
  // passwordExpr) that must actually expand, so the delimiter is left
  // unquoted to let the shell interpolate it while writing the heredoc body.
  const conninfoHeredocEof = passwordFromEnv ? 'REPL_CONNINFO_EOF' : "'REPL_CONNINFO_EOF'";
  const conninfoBlock = primaryConninfo
    ? `
cat >> ${stagingDir}/postgresql.auto.conf <<${conninfoHeredocEof}
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
  const swapBlock = swap
    ? `
find ${pgdataDir} -mindepth 1 -delete
find ${stagingDir} -mindepth 1 -maxdepth 1 -exec mv -t ${pgdataDir}/ {} +
rmdir ${stagingDir}
chown -R postgres:postgres ${pgdataDir}
`
    : `
# swap=false: leave the verified basebackup in ${stagingDir}. The caller scales
# the pod to zero and performs the atomic PGDATA swap node-side (in-pod pg_ctl
# stop would kill the container — the postmaster is PID 1).
`;

  // pg_basebackup slot policy: default (basebackupSlot=null) omits `-S`, so the
  // `-Xs` WAL receiver spins up a TEMPORARY slot for the duration of the backup.
  // The persistent slot (slotName) is reserved for post-swap streaming
  // (primary_slot_name, below) — attaching the basebackup to it would collide
  // with an already-streaming standby's live walreceiver ("slot is active").
  const basebackupSlotFlag = basebackupSlot ? ` -S ${basebackupSlot}` : '';

  const pgpassword = passwordFromEnv
    ? `PGPASSWORD="$REPL_PASSWORD"`
    : `PGPASSWORD='${replPassword}'`;

  // basebackupAttempts<=1 (the default) reproduces the original single-shot
  // block byte-for-byte, so every existing caller is unaffected. >1 wraps it
  // in a bounded retry loop that wipes staging between attempts (a partial
  // fetch must never poison the next attempt or a fallback initdb).
  const basebackupBlock =
    basebackupAttempts <= 1
      ? `
# Stage into a tmp dir; atomic swap only after basebackup verifies good.
rm -rf ${stagingDir}
mkdir -p ${stagingDir}
chown postgres:postgres ${stagingDir}

${pgpassword} pg_basebackup \\
  -h ${primaryHost} -p ${primaryPort} \\
  -U replicator -D ${stagingDir} \\
  -Fp -Xs -R -c fast${basebackupSlotFlag}

# A successful pg_basebackup always writes PG_VERSION (and standby.signal via -R).
if [ ! -f ${stagingDir}/PG_VERSION ]; then
  echo "[${label}] pg_basebackup produced no PG_VERSION, refusing to swap" >&2
  rm -rf ${stagingDir}
  exit 1
fi`
      : (() => {
          const exhaustBlock = exhaustExitZero
            ? `echo "[${label}] pg_basebackup budget exhausted (${basebackupAttempts} attempts) — exiting UNSEEDED; the chart's initdb boots the db independent and the serial reseed path covers replication." >&2; exit 0`
            : `echo "[${label}] pg_basebackup failed after ${basebackupAttempts} attempt(s)" >&2
  exit 1`;
          return `
seed_ok=0
for seed_attempt in $(seq 1 ${basebackupAttempts}); do
${deadlineGuardBlock}  rm -rf ${stagingDir}
  mkdir -p ${stagingDir}
  chown postgres:postgres ${stagingDir}
  if ${pgpassword} pg_basebackup \\
      -h ${primaryHost} -p ${primaryPort} \\
      -U replicator -D ${stagingDir} \\
      -Fp -Xs -R -c fast${basebackupSlotFlag} && [ -f ${stagingDir}/PG_VERSION ]; then
    seed_ok=1
    break
  fi
  echo "[${label}] pg_basebackup attempt \${seed_attempt}/${basebackupAttempts} failed, primary not replication-ready yet" >&2
  if [ "\${seed_attempt}" -lt ${basebackupAttempts} ]; then
    sleep ${basebackupDelayS}
  fi
done
if [ "\${seed_ok}" != "1" ]; then
  rm -rf ${stagingDir}
  ${exhaustBlock}
fi`;
        })();

  return `
set -e -o pipefail
${connectTimeoutBlock}${probeBlock}${basebackupBlock}
# -R should already have created standby.signal; touch belt-and-suspenders.
touch ${stagingDir}/standby.signal
echo "primary_slot_name = '${slotName}'" >> ${stagingDir}/postgresql.auto.conf
# hot_standby MUST be forced on: the supabase/postgres image ships
# /etc/postgresql-custom/wal-g.conf with 'hot_standby = off' (postgresql.conf
# leaves it commented, so the included wal-g.conf wins) — the reseeded standby
# then streams fine but REFUSES read-only connections ("FATAL: the database
# system is not accepting connections / DETAIL: Hot standby mode is disabled"),
# failing every pg_is_in_recovery() check. postgresql.auto.conf is read LAST,
# so this wins over the include. Harmless after promotion (ignored outside
# recovery). Live RCA 2026-07-06 e4 rig; k8s + compose ship the same image
# family, so this applies to BOTH staging paths.
echo "hot_standby = on" >> ${stagingDir}/postgresql.auto.conf
${conninfoBlock}chown -R postgres:postgres ${stagingDir}
${swapBlock}`.trim();
}

/**
 * Standby seed init-container script (spec: standby-init-seeding-design).
 *
 * WIRED for the pilot-light standby (spec: pilot-light-standby-design): the
 * standby installs with every app-tier Deployment at replicas 0, so the
 * Ecto write-lock incompatibility that forced the original unwire (f5b0ea8)
 * no longer applies — nothing app-tier boots against the read-only replica.
 *
 * Runs on EVERY db pod boot on every tier; the gates make it a no-op
 * everywhere except the k8s-ha standby's FIRST boot:
 *   - WALG_ROLE != standby            → exit 0 (primary + single-cluster k8s)
 *   - PGDATA/PG_VERSION exists        → exit 0 (any later boot: restarts,
 *                                        scale events, post-swap boots)
 *   - RESTORE_TARGET set              → exit 0 (belt: restore wins; the
 *                                        standby always deploys restore:null)
 * When active it retries pg_basebackup through the local repl-gateway relay
 * for up to 6 minutes (24 × 15s — the basebackup attempt IS the readiness
 * probe; pg_isready cannot see pg_hba/wal_level state), staging into a
 * sibling dir on the raw volume mount and swapping in-script (no running
 * postmaster exists yet, so the in-place swap is safe here, unlike the
 * failover/restore paths). On exhaustion it exits 0 UNSEEDED — the chart's
 * initdb then boots the db independent and setupReplication's serial swap
 * path covers replication (bounded wait + fallback, decision #2).
 *
 * Env contract (injected by the seed-standby init container in
 * carbon/k8s/values/supabase.values.yaml): WALG_ROLE, RESTORE_TARGET
 * (optional), REPL_PASSWORD (secretKeyRef), SEED_PRIMARY_HOST,
 * SEED_PRIMARY_PORT. Mount contract: db PVC mounted RAW (no subPath) at
 * /seed-volume; PGDATA lives at /seed-volume/postgres-data.
 *
 * SECURITY: delivered via ConfigMap — the generated text must contain no
 * secret values; the password is expanded from env at runtime only.
 */
export function buildStandbySeedInitScript() {
  const conninfo = buildPrimaryConninfo({
    primaryHost: '$SEED_PRIMARY_HOST',
    port: '$SEED_PRIMARY_PORT',
    passwordExpr: '$REPL_PASSWORD',
    applicationName: 'standby',
  });
  const core = buildStagedBasebackupScript({
    passwordFromEnv: true,
    primaryHost: '$SEED_PRIMARY_HOST',
    primaryPort: '$SEED_PRIMARY_PORT',
    basebackupAttempts: 24,
    basebackupDelayS: 15,
    exhaustExitZero: true,
    swap: true,
    stagingDir: '/seed-volume/.seed_staging',
    pgdataDir: '/seed-volume/postgres-data',
    primaryConninfo: conninfo,
    label: 'seed-standby',
    // Binding contract: this init container gives up and exits 0 UNSEEDED
    // within ~6 minutes wall-clock NO MATTER WHAT, so a missing transport
    // (e.g. netpol gap dropping SYNs) can never turn a bounded seed attempt
    // into a 50+ minute hang that blows the standby's `helm --wait --timeout
    // 15m`. connectTimeoutS bounds each individual pg_basebackup connection
    // attempt; deadlineSeconds bounds the loop's TOTAL wall-clock time as a
    // second, independent backstop (24×15s≈6min already approximates this,
    // but only if every attempt fails fast — the deadline holds even if one
    // doesn't).
    connectTimeoutS: 10,
    deadlineSeconds: 360,
  });
  return `
if [ "\${WALG_ROLE:-primary}" != "standby" ]; then
  echo "[seed-standby] WALG_ROLE=\${WALG_ROLE:-primary}, not a standby, skipping seed"
  exit 0
fi
if [ -f /seed-volume/postgres-data/PG_VERSION ]; then
  echo "[seed-standby] PGDATA already initialized, not a first boot, skipping seed"
  exit 0
fi
if [ -n "\${RESTORE_TARGET:-}" ]; then
  echo "[seed-standby] RESTORE_TARGET set, restore wins, skipping seed"
  exit 0
fi
mkdir -p /seed-volume/postgres-data
echo "[seed-standby] first boot of a standby, seeding PGDATA from the primary via $SEED_PRIMARY_HOST:$SEED_PRIMARY_PORT"
${core}
echo "[seed-standby] SEEDED, postgres will boot directly into recovery as a streaming replica"
`.trim();
}

/**
 * Build the atomic PGDATA swap script for the HA standby re-seeds.
 *
 * Runs AFTER the db has been stopped from outside (never inside the db
 * container, whose PID 1 is the postmaster), against the PVC/volume filesystem —
 * NOT the db container's namespace:
 *   - k8s: inside a short-lived HELPER POD that mounts the same PVC (no subPath)
 *     at a plain path, so `pgdataDir` is `<mountRoot>/<subPath>`. A helper pod is
 *     used (not a node-side ssh) because the swap must work uniformly for BOTH
 *     local-path AND csi.hetzner.cloud PVCs — a CSI volume has no node hostPath
 *     and DETACHES from the node on scale-to-zero, so a node-filesystem swap is
 *     structurally impossible (live RCA 2026-07-07 e4 rig). See
 *     swapPgdataViaHelperPod.
 *   - compose: on the HOST via ssh (`pgdataDir` is the db volume's host
 *     Mountpoint) after `docker compose stop db`.
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

// The short-lived helper pod that mounts the standby's PVC and runs the atomic
// PGDATA swap. One name (deleted+recreated per reseed) and one mount root shared
// by the deploy-time seed and the failover/restore reseed.
export const PGDATA_SWAP_POD = 'vibecarbon-pgdata-swap';
const PGDATA_SWAP_MOUNT_ROOT = '/pgdata-vol';

/**
 * Parse the supabase-db pod JSON into everything the helper-pod swap needs:
 *   - claimName: the PVC to mount into the swap pod (same volume the db uses),
 *   - subPath:   the db's volumeMount subPath (the chart mounts the PVC at
 *     /var/lib/postgresql/data via subPath `postgres-data`), so PGDATA on the
 *     raw volume is `<volume-root>/<subPath>`,
 *   - image:     the db container's image — reused for the swap pod so it is
 *     ALREADY pulled on the node (no pull latency/failure) and ships bash +
 *     coreutils.
 *
 * Pure so both k8s reseed transports (raw-ssh deploy seed, sshKubectl
 * failover/restore) can fetch the pod JSON with their own exec backend and share
 * one parser. MUST be called while the pod still exists (the volume→PVC chain is
 * unreadable after scale-to-zero).
 *
 * @param {string|object} podJson
 * @returns {{claimName:string, subPath:string, image:string}}
 */
export function parsePgdataClaimFromPodJson(podJson) {
  const pod = typeof podJson === 'string' ? JSON.parse(podJson) : podJson;
  let volName;
  let subPath = '';
  let image;
  for (const c of pod?.spec?.containers ?? []) {
    const m = (c.volumeMounts ?? []).find((v) => v.mountPath === '/var/lib/postgresql/data');
    if (m) {
      volName = m.name;
      subPath = m.subPath ?? '';
      image = c.image;
      break;
    }
  }
  const vol = (pod?.spec?.volumes ?? []).find((v) => v.name === volName);
  const claimName = vol?.persistentVolumeClaim?.claimName;
  if (!claimName) {
    throw new Error('no persistentVolumeClaim mounted at /var/lib/postgresql/data');
  }
  if (!image) {
    throw new Error('could not resolve the supabase-db container image for the swap pod');
  }
  return { claimName, subPath, image };
}

/**
 * Resolve the swap-pod inputs from the standby's live db pod (k8s sshKubectl
 * transport). Thin fetch-then-parse wrapper over parsePgdataClaimFromPodJson.
 *
 * @param {string} ip - the cluster's master IP (kubectl target)
 * @param {string} sshKeyPath
 * @param {string} pod - the supabase-db pod name
 * @returns {Promise<{claimName:string, subPath:string, image:string}>}
 */
async function resolvePgdataClaim(ip, sshKeyPath, pod) {
  const podRaw = await sshKubectl(ip, sshKeyPath, [
    'get',
    'pod',
    pod,
    '-n',
    'vibecarbon',
    '-o',
    'json',
  ]);
  return parsePgdataClaimFromPodJson(podRaw);
}

/**
 * Build the helper-pod manifest (JSON — kubectl apply -f - accepts it, and it
 * sidesteps YAML-escaping the bash swap script). The pod mounts the WHOLE PVC
 * (no subPath) at `mountRoot` so PGDATA (`<mountRoot>/<subPath>`) is a regular
 * subdir whose SIBLINGS are writable — the atomic swap renames PGDATA aside,
 * which is impossible when the subPath itself is the (bind) mountpoint. Runs as
 * root so the same-filesystem renames succeed regardless of the volume root's
 * ownership; buildNodePgdataSwapScript preserves the staged tree's numeric
 * ownership (no chown), so the reseeded PGDATA keeps the in-container postgres
 * uid. restartPolicy Never — a one-shot job. Pinned to the dedicated supabase
 * node (same nodeSelector as the db StatefulSet): a detached csi.hetzner.cloud
 * volume carries only ZONAL topology, so without the pin the scheduler is free
 * to place the pod on a worker that never ran the db — which then pulls the
 * multi-GB wal-g postgres image cold and blows the 180s swap budget while the
 * pod sits in ContainerCreating (RCA 2026-07-16, gate run 29504041478). The
 * pin also keeps the CSI re-attach node-local (the volume just detached from
 * that node) and guarantees the image is cached (the db ran there minutes
 * earlier). local-path PVs force the same node via PV node-affinity anyway.
 *
 * @param {object} o
 * @param {string} o.claimName
 * @param {string} o.image
 * @param {string} o.swapScript - buildNodePgdataSwapScript output
 * @param {string} [o.podName=PGDATA_SWAP_POD]
 * @param {string} [o.mountRoot=PGDATA_SWAP_MOUNT_ROOT]
 * @returns {string} JSON manifest
 */
export function buildPgdataSwapPodManifest({
  claimName,
  image,
  swapScript,
  podName = PGDATA_SWAP_POD,
  mountRoot = PGDATA_SWAP_MOUNT_ROOT,
}) {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: podName, namespace: 'vibecarbon' },
    spec: {
      restartPolicy: 'Never',
      securityContext: { runAsUser: 0, runAsGroup: 0, fsGroup: 0 },
      // Same placement contract as the db StatefulSet (supabase.values.yaml):
      // the selector ATTRACTS the pod to the dedicated supabase node (see the
      // doc comment — CSI zonal topology does not), and the toleration lets it
      // pass the node's dedicated=supabase:NoSchedule taint (live-hit
      // 2026-07-07: without it the pod sat Unschedulable forever).
      nodeSelector: { dedicated: 'supabase' },
      tolerations: [
        { key: 'dedicated', operator: 'Equal', value: 'supabase', effect: 'NoSchedule' },
      ],
      containers: [
        {
          name: 'swap',
          image,
          command: ['bash', '-c', swapScript],
          volumeMounts: [{ name: 'pgdata', mountPath: mountRoot }],
        },
      ],
      volumes: [{ name: 'pgdata', persistentVolumeClaim: { claimName } }],
    },
  });
}

/**
 * Run the atomic PGDATA swap in a short-lived helper pod (k8s), uniform for
 * local-path AND CSI PVCs. The db StatefulSet MUST already be scaled to zero
 * (pod gone → RWO PVC released) before calling this. Sequence:
 *   1. delete any stale swap pod (prior failed reseed reuses the name),
 *   2. apply the helper pod mounting the same PVC (no subPath) at mountRoot,
 *   3. poll until it reaches Succeeded/Failed (budget 300s — CSI detach from
 *      the db pod + re-attach here ran the poll to within seconds of the old
 *      180s budget on the restore path of gate run 29514516887; the swap
 *      itself is mv-only, so the budget is all scheduling + attach slack),
 *   4. capture its logs (RESEED_SWAPPED / RESEED_SKIPPED sentinel, or the
 *      failure detail) — folded into the thrown error on a non-Succeeded phase,
 *   5. ALWAYS delete the pod (finally).
 *
 * Returns the pod's logs so the caller classifies the sentinel exactly as the
 * old node-side `sshRun` swap output was classified (SWAPPED = promoted,
 * SKIPPED = staging vanished/absent). `kubectl` is an injected exec closure
 * `(argv, opts?) => Promise<string>` so both reseed transports share this.
 *
 * @param {(argv:string[], opts?:{input?:string}) => Promise<string>} kubectl
 * @param {object} o
 * @param {string} o.claimName
 * @param {string} o.subPath
 * @param {string} o.image
 * @param {string} [o.mountRoot=PGDATA_SWAP_MOUNT_ROOT]
 * @param {string} [o.podName=PGDATA_SWAP_POD]
 * @param {number} [o.budgetMs=300000]
 * @returns {Promise<string>} the swap pod's logs
 */
export async function swapPgdataViaHelperPod(
  kubectl,
  {
    claimName,
    subPath,
    image,
    mountRoot = PGDATA_SWAP_MOUNT_ROOT,
    podName = PGDATA_SWAP_POD,
    budgetMs = 300_000,
  },
) {
  const pgdataDir = subPath ? `${mountRoot.replace(/\/+$/, '')}/${subPath}` : mountRoot;
  const swapScript = buildNodePgdataSwapScript({ pgdataDir });
  const manifest = buildPgdataSwapPodManifest({ claimName, image, swapScript, podName, mountRoot });

  // Clear any stale swap pod from a prior failed reseed (same name), then apply.
  await kubectl([
    'delete',
    'pod',
    podName,
    '-n',
    'vibecarbon',
    '--ignore-not-found',
    '--wait=true',
  ]).catch(() => {});
  await kubectl(['apply', '-f', '-'], { input: manifest });

  try {
    let phase;
    try {
      phase = await pollUntil(
        async () => {
          // -o json + JS parsing, NOT a jsonpath with |/?() — the k8s transport
          // joins argv into a remote shell string, and unquoted jsonpath
          // metacharacters are a bash syntax error (live-hit 2026-07-07: every
          // poll died on `syntax error near unexpected token` until the budget
          // lapsed).
          const out = (
            await kubectl(['get', 'pod', podName, '-n', 'vibecarbon', '-o', 'json'])
          ).trim();
          const status = JSON.parse(out).status || {};
          const p = status.phase;
          const sched = (status.conditions || []).find((c) => c.type === 'PodScheduled') || {};
          const schedReason = sched.reason;
          const schedMessage = sched.message;
          // Unschedulable is terminal for our purposes: waiting out the budget
          // can't fix a taint/affinity mismatch, and the scheduler message names
          // the exact conflict — return it as a (truthy) terminal result so the
          // poll exits immediately (pollUntil retries on throw, so we must NOT
          // throw from inside the probe).
          if (p === 'Pending' && schedReason === 'Unschedulable') {
            return `Unschedulable: ${schedMessage || '(no scheduler message)'}`;
          }
          return p === 'Succeeded' || p === 'Failed' ? p : null;
        },
        {
          budgetMs,
          initialDelayMs: 2000,
          maxDelayMs: 10_000,
          description: `pgdata swap pod ${podName} to finish`,
        },
      );
    } catch (pollErr) {
      // Budget lapsed without a terminal phase. Capture the pod's actual
      // state and events BEFORE the finally-delete destroys the evidence —
      // a bare "Timed out after 180000ms" cannot distinguish a cold image
      // pull from a stuck attach from a pod that never existed (RCA
      // 2026-07-16, gate run 29504041478: zero forensic state survived).
      const podRaw = await kubectl(['get', 'pod', podName, '-n', 'vibecarbon', '-o', 'json']).catch(
        (e) => `(get pod failed: ${e?.message || e})`,
      );
      let podSummary = typeof podRaw === 'string' ? podRaw.trim() : '';
      try {
        const pod = JSON.parse(podRaw);
        const waiting = (pod.status?.containerStatuses || [])
          .map(
            (c) =>
              c.state?.waiting && `${c.state.waiting.reason}: ${c.state.waiting.message || ''}`,
          )
          .filter(Boolean)
          .join('; ');
        podSummary =
          `phase=${pod.status?.phase || '?'} node=${pod.spec?.nodeName || '(unscheduled)'}` +
          (waiting ? ` waiting=[${waiting}]` : '');
      } catch {
        // keep the raw kubectl output (already in podSummary)
      }
      const events =
        (await kubectl([
          'get',
          'events',
          '-n',
          'vibecarbon',
          '--field-selector',
          `involvedObject.name=${podName}`,
          '--sort-by=.lastTimestamp',
        ]).catch((e) => `(get events failed: ${e?.message || e})`)) || '';
      pollErr.message +=
        `\n--- swap pod state at timeout ---\n${podSummary || '(empty)'}` +
        `\n--- swap pod events ---\n${events.trim() || '(none)'}`;
      throw pollErr;
    }
    if (phase.startsWith('Unschedulable:')) {
      throw new Error(
        `pgdata swap pod ${podName} could not be scheduled; the standby keeps its previous ` +
          `PGDATA. Scheduler said: ${phase.slice('Unschedulable:'.length).trim()}`,
      );
    }
    const logs = (await kubectl(['logs', podName, '-n', 'vibecarbon']).catch(() => '')) || '';
    if (phase !== 'Succeeded') {
      throw new Error(
        `pgdata swap pod ${podName} did not succeed (phase=${phase}); the standby keeps its ` +
          `previous PGDATA.\n--- swap pod logs ---\n${logs.trim() || '(no logs)'}`,
      );
    }
    return logs;
  } finally {
    await kubectl(['delete', 'pod', podName, '-n', 'vibecarbon', '--ignore-not-found']).catch(
      () => {},
    );
  }
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
 * PersistentVolume names bound to the db StatefulSet's claims
 * (`<template>-<sts>-0` naming). Fail-open: unreadable/unparseable output →
 * empty list, so every caller degrades to "nothing to wait for / repair"
 * rather than failing a reseed over a diagnostic read.
 *
 * @param {(argv: string[], opts?: object) => Promise<string>} kubectl
 * @returns {Promise<string[]>}
 */
export async function listDbPvNames(kubectl) {
  try {
    const raw = await kubectl(['get', 'pvc', '-n', 'vibecarbon', '-o', 'json']);
    const items = JSON.parse(String(raw))?.items ?? [];
    return items
      .filter((c) => String(c?.metadata?.name ?? '').endsWith(`-${DB_STATEFULSET}-0`))
      .map((c) => c?.spec?.volumeName)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Wait until no VolumeAttachment references the given PVs.
 *
 * WHY (d4 run 6 RCA): the k8s re-seed puts the SAME volume through four
 * attach/detach transitions in ~2 minutes (db scale-to-zero → helper-pod
 * attach → helper delete → db scale-up). On DigitalOcean's CSI an attach
 * issued while the previous detach is still settling can be recorded as
 * attached without ever holding at the provider — the stale-attachment state
 * documented on STALE_ATTACH_EVENT_PATTERN. Waiting for the attachment
 * objects to actually clear between transitions removes the overlap the race
 * needs. Hetzner's CSI tolerates the overlap; the wait is a no-op cost there
 * (attachments clear in seconds).
 *
 * Best-effort BY CONTRACT: budget lapse or unreadable listings resolve
 * `{detached: false}` with a log line, never throw — the recovery branch in
 * reseedStandbyFromPrimary backstops the residual, and a reseed must not die
 * on a diagnostic read. Local-path clusters have no attachments at all and
 * resolve on the first poll.
 *
 * @param {(argv: string[], opts?: object) => Promise<string>} kubectl
 * @param {object} opts
 * @param {string[]} opts.pvNames
 * @param {number} [opts.budgetMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{detached: boolean}>}
 */
export async function waitForPvDetach(
  kubectl,
  {
    pvNames,
    budgetMs = 120_000,
    // Provider read-after-write settle, applied ONLY when this wait actually
    // observed an attachment clear (no churn = nothing to settle). d4 run 8,
    // csi-do-controller transcript: controller_unpublish completed at
    // :36, controller_publish called the SAME second, and the driver's
    // stale state read answered "volume is already attached" — publish
    // returned success WITHOUT issuing an attach while DO's API showed the
    // volume attached to nothing. VolumeAttachment-object-gone is therefore
    // NOT provider-state-settled; a publish issued inside DO's volume-state
    // read-after-write window recreates the stale attachment every time
    // (the run-8 repair loop reproduced it back-to-back). The condition is
    // not observable through kubectl — this floor is the honest stand-in,
    // and the signature-gated repair backstops the residual.
    settleMs = 25_000,
    // Callers that KNOW churn just happened (the repair deletes attachments
    // itself before waiting) set this so the settle applies even when the
    // first poll already reads clear.
    forceSettle = false,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  } = {},
) {
  if (!pvNames?.length) return { detached: true };
  const emit = log ?? ((m) => console.error(m));
  const started = Date.now();
  const wanted = new Set(pvNames);
  let sawAttachment = forceSettle;
  while (Date.now() - started < budgetMs) {
    let held = [];
    try {
      const raw = await kubectl(['get', 'volumeattachment', '-o', 'json']);
      const items = JSON.parse(String(raw))?.items ?? [];
      held = items.filter((a) => wanted.has(a?.spec?.source?.persistentVolumeName));
    } catch {
      // Unreadable listing — treat as clear (fail-open; see contract above).
      return { detached: true };
    }
    if (held.length === 0) {
      if (sawAttachment && settleMs > 0) {
        emit(
          `[reseed] attachments cleared; settling ${Math.round(settleMs / 1000)}s for the ` +
            `provider's volume-state read-after-write window before the next attach.`,
        );
        await sleep(settleMs);
      }
      return { detached: true };
    }
    sawAttachment = true;
    await sleep(3000);
  }
  emit(
    `[reseed] volume attachments for ${pvNames.join(', ')} did not clear within ` +
      `${Math.round(budgetMs / 1000)}s — continuing; the stale-attachment recovery ` +
      `backstops a wedged reattach.`,
  );
  return { detached: false };
}

/**
 * One-shot repair for the stale-VolumeAttachment state: delete every
 * attachment referencing the db PVs so the attach/detach controller re-issues
 * a REAL provider attach. Returns the names it deleted (possibly empty).
 * Fail-open like the reads above.
 *
 * @param {(argv: string[], opts?: object) => Promise<string>} kubectl
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {Promise<string[]>}
 */
export async function deleteStaleDbVolumeAttachments(kubectl, { log } = {}) {
  const emit = log ?? ((m) => console.error(m));
  const pvNames = await listDbPvNames(kubectl);
  if (pvNames.length === 0) return [];
  let stale = [];
  try {
    const raw = await kubectl(['get', 'volumeattachment', '-o', 'json']);
    const items = JSON.parse(String(raw))?.items ?? [];
    stale = items
      .filter((a) => pvNames.includes(a?.spec?.source?.persistentVolumeName))
      .map((a) => a?.metadata?.name)
      .filter(Boolean);
  } catch {
    return [];
  }
  const deleted = [];
  for (const name of stale) {
    try {
      await kubectl(['delete', 'volumeattachment', name, '--ignore-not-found']);
      deleted.push(name);
      emit(`[reseed] deleted stale VolumeAttachment ${name} to force a real provider attach`);
    } catch {
      // Best-effort — the retried rollout wait is the verdict either way.
    }
  }
  return deleted;
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
 * Read REPL_PASSWORD from the `vibecarbon-secrets` k8s Secret — the SAME source
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
    'vibecarbon-secrets',
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
 * re-seed — the same IF-NOT-EXISTS DO-block primary-init.sql (and the compose-HA
 * re-seed) uses, so all three sites create the identical slot.
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
  const sql = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = '${slotName}'
  ) THEN
    PERFORM pg_create_physical_replication_slot('${slotName}');
  END IF;
END
$$;
`;
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
      'supabase_admin',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql },
  );
}

/**
 * Re-seed the standby Postgres from the primary via pg_basebackup (k8s transport).
 * Closes the drift window that opens when streaming silently falls behind or the
 * standby pod restarted and missed WAL. Used by BOTH failover (before promotion)
 * and restore (post-restore standby resync).
 *
 * Sequence (2026-07-06 fix — the previous in-pod `pg_ctl stop` KILLED the pod:
 * the postmaster is the container's PID 1, so stopping it terminated the
 * container, kubelet restarted it as a fresh independent primary, and the swap
 * ran against the wrong process — the same RCA as the deploy-time seed):
 *   1. Stage a verified pg_basebackup into a subdir of PGDATA while the standby
 *      postgres is still running (buildStagedBasebackupScript swap:false — the
 *      staging lands on the PVC filesystem for an atomic rename;
 *      pg_basebackup -R writes standby.signal + primary_conninfo into staging).
 *   2. Resolve the PVC claim name + subPath + db image (resolvePgdataClaim —
 *      while the pod exists), scale the StatefulSet to 0 and wait for the pod to
 *      be fully gone (kubelet-sanctioned quiesce; the RWO PVC releases).
 *   3. Atomic PGDATA swap in a short-lived HELPER POD that mounts the released
 *      PVC (swapPgdataViaHelperPod → buildNodePgdataSwapScript, same script as
 *      the deploy-time seed). A helper pod (not a node-side ssh) is used so the
 *      swap works uniformly for local-path AND csi.hetzner.cloud PVCs — a CSI
 *      PV has no node hostPath and detaches on scale-to-zero (RCA 2026-07-07).
 *   4. Scale back to 1, wait rollout, and confirm the standby ENTERED RECOVERY
 *      (fail loudly if not — a reseeded standby that boots as a primary is the
 *      exact regression this fix closes).
 *
 * Safety contract (unchanged):
 *   - REPL_PASSWORD is read from the `vibecarbon-secrets` Secret. If it is not
 *     found we CANNOT safely re-seed → throw a HARD ERROR so the caller aborts
 *     rather than acting on a stale standby. Distinct from "primary unreachable".
 *   - Reachability is probed from inside the standby pod BEFORE any destructive
 *     work. If the primary is not reachable we return 'skipped' WITHOUT touching
 *     PGDATA.
 *   - The basebackup stages + verifies (PG_VERSION) BEFORE the standby is ever
 *     taken down — a failed backup throws while the standby is still serving,
 *     and the helper-pod swap refuses to promote an unverified staging.
 *   - On any failure after scale-to-zero the StatefulSet is scaled back to 1
 *     (best-effort) so the standby is never left down; its original PGDATA is
 *     untouched until the atomic swap succeeds.
 *
 * Transport: the standby dials its OWN supabase node's private IP on the
 * repl-gateway relay port (REPL_GATEWAY_PORT) — the standby gateway relays
 * through the WireGuard tunnel to the primary gateway, which forwards to the
 * primary postgres hostPort. This is the EXACT path the deploy-time seed uses;
 * the old direct `primarySupabaseIp:5432` dial is dead post-WireGuard (the
 * firewall admits only UDP 51821, and the primary db's hostPort 5433 is
 * localhost-relayed). The gateway relay directions were configured at deploy
 * for the CURRENT roles, and this re-seed always runs while those roles still
 * hold (failover re-seeds BEFORE promotion; restore never swaps roles), so no
 * gateway re-render is needed here. The post-failover REVERSE re-seed is
 * `vibecarbon deploy`'s job — it re-renders the gateways + tunnel with swapped
 * endpoints (all idempotent).
 *
 * @param {string} standbyIp - standby cluster master IP (kubectl target)
 * @param {string} sshKeyPath
 * @param {object} opts
 * @param {string} opts.standbySupabaseIp - standby SUPABASE node public IP.
 *   No longer a swap target (the swap runs in a cluster-side helper pod), but
 *   still REQUIRED as a precondition that the standby HA cluster is fully
 *   identified — a re-seed must not run against a half-identified env.
 * @param {string} opts.standbySupabasePrivateIp - the standby supabase
 *   node's PRIVATE IP: the local repl-gateway relay endpoint the basebackup +
 *   primary_conninfo dial. REQUIRED — a real IaC output on every provider
 *   (Hetzner pins it statically; DO exports the Pulumi-assigned VPC address),
 *   persisted under envConfig.ha.*.supabasePrivateIp at deploy time. A
 *   Hetzner-shaped fallback here would make the re-seed's reachability probe
 *   fail closed into 'skipped' on other providers — promotion without
 *   re-seed.
 * @returns {Promise<'reseeded'|'skipped'>} 'reseeded' on success, 'skipped' when
 *   the primary is unreachable. Throws on password-missing or a real failure —
 *   NEVER silently returns as if skipped.
 */
export async function reseedStandbyFromPrimary(
  standbyIp,
  sshKeyPath,
  { standbySupabaseIp, standbySupabasePrivateIp, detachSettleMs = 25_000 } = {},
) {
  if (!standbySupabasePrivateIp) {
    // Same precondition class as the standbySupabaseIp check below: a
    // missing private IP signals a half-identified HA env (or a pre-M3
    // persisted config). Never assume an address — redeploy to persist it.
    throw new Error(
      're-seed aborted: standbySupabasePrivateIp is required — the standby supabase ' +
        "node's private IP is a deploy output persisted in the environment config; " +
        'redeploy to persist it before re-seeding',
    );
  }
  if (!standbySupabaseIp) {
    // Precondition: a fully-identified HA standby cluster. The PGDATA swap runs
    // in a cluster-side helper pod now (not a node-side ssh), so this IP is no
    // longer a swap target — but a missing supabase node still signals a
    // half-identified env we must NOT run a destructive re-seed against.
    throw new Error(
      're-seed aborted: standby supabase node IP is unknown; the standby HA ' +
        'cluster is not fully identified. Cannot safely re-seed; redeploy to ' +
        'persist the standby supabase IP.',
    );
  }

  const replPassword = await getReplPasswordFromSecret(standbyIp, sshKeyPath);
  if (!replPassword) {
    throw new Error(
      're-seed aborted: REPL_PASSWORD not found in the vibecarbon-secrets Secret. ' +
        'Cannot re-seed the standby from the primary, refusing to act on a ' +
        'possibly-stale standby. Verify the standby cluster was deployed with `vibecarbon deploy --ha`.',
    );
  }

  const pod = await getPostgresPod(standbyIp, sshKeyPath);

  // Connectivity pre-check FROM THE STANDBY POD, before any destructive work —
  // through the SAME relay path the basebackup uses (local gateway → WireGuard
  // tunnel → primary gateway → primary postgres), so a green probe means the
  // whole chain is up, not just a firewall accident. pg_isready exits non-zero
  // when the primary is not accepting connections; sshKubectl throws on
  // non-zero → treat as "unreachable" and skip cleanly.
  let reachable = false;
  try {
    await sshKubectl(standbyIp, sshKeyPath, [
      'exec',
      '-n',
      'vibecarbon',
      pod,
      '--',
      'pg_isready',
      '-h',
      standbySupabasePrivateIp,
      '-p',
      String(REPL_GATEWAY_PORT),
      '-t',
      '5',
      '-U',
      'replicator',
      '-d',
      'postgres',
    ]);
    reachable = true;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    return 'skipped';
  }

  // Resolve the swap-pod inputs (PVC claim name, subPath, db image) while the
  // pod still exists — the pod → PVC chain is unreadable after scale-to-zero.
  // The swap runs in a helper pod that mounts this PVC, so it works uniformly
  // for local-path AND csi.hetzner.cloud volumes (a CSI PV has no node hostPath
  // and detaches on scale-to-zero, making a node-filesystem swap impossible).
  let claimName;
  let subPath;
  let image;
  try {
    ({ claimName, subPath, image } = await resolvePgdataClaim(standbyIp, sshKeyPath, pod));
  } catch (err) {
    throw new Error(
      `re-seed aborted before any destructive work: could not resolve the standby ` +
        `PGDATA PVC/image (needed for the scale-to-zero + helper-pod swap): ${err.message}`,
    );
  }

  // Stage a verified basebackup into a subdir of PGDATA while the standby
  // postgres is STILL RUNNING (basebackup only needs the primary reachable).
  // swap:false — no in-pod pg_ctl stop / in-place swap: the postmaster is the
  // container's PID 1, so stopping it in-pod kills the pod. The script is piped
  // over stdin (PGPASSWORD embedded), never argv. A failure here throws while
  // the standby is still serving — nothing has been taken down yet.
  // Dial the LOCAL relay (standby node private IP : gateway port) and pin the
  // explicit streaming conninfo into the staging — byte-identical to the
  // deploy-time seed's buildPrimaryConninfo output, so the reseeded standby
  // streams through the same path it was seeded through. Plaintext
  // (sslmode=disable) — WireGuard encrypts the wire.
  const script = buildStagedBasebackupScript({
    replPassword,
    primaryHost: standbySupabasePrivateIp,
    primaryPort: String(REPL_GATEWAY_PORT),
    probeFirst: false,
    swap: false,
    stagingDir: RESEED_STAGING_DIR,
    primaryConninfo: buildPrimaryConninfo({
      primaryHost: standbySupabasePrivateIp,
      replPassword,
      port: REPL_GATEWAY_PORT,
    }),
    label: 'reseed',
  });
  await sshKubectl(standbyIp, sshKeyPath, ['exec', '-i', '-n', 'vibecarbon', pod, '--', 'bash'], {
    input: script,
  });

  // Quiesce via the StatefulSet controller (kubelet-sanctioned; RWO PVC
  // releases), swap via a helper pod that mounts the released PVC, then scale
  // back up. The finally-scale-up keeps the standby from being left down on any
  // failure — its original PGDATA is intact until the atomic swap succeeds.
  let swapped = false;
  try {
    await sshKubectl(standbyIp, sshKeyPath, [
      'scale',
      'statefulset',
      DB_STATEFULSET,
      '-n',
      'vibecarbon',
      '--replicas=0',
    ]);
    let podGone = false;
    for (let i = 0; i < 60; i++) {
      let out;
      try {
        out = await sshKubectl(standbyIp, sshKeyPath, [
          'get',
          'pod',
          pod,
          '-n',
          'vibecarbon',
          '--ignore-not-found',
          '-o',
          'name',
        ]);
      } catch {
        out = 'unreadable'; // transient kubectl/ssh failure — keep polling
      }
      if (!out?.trim()) {
        podGone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 2000));
    }
    if (!podGone) {
      throw new Error(
        'standby supabase-db pod did not terminate within budget after scale-to-zero, ' +
          'refusing the helper-pod PGDATA swap while the pod may still hold the PVC.',
      );
    }

    // Atomic swap in a helper pod mounting the released PVC (uniform for
    // local-path AND CSI). No secrets in the swap script (the conninfo password
    // is already inside the staged postgresql.auto.conf, written in-pod).
    const kubectl = (argv, opts) => sshKubectl(standbyIp, sshKeyPath, argv, opts);
    // Let the scaled-to-zero db pod's volume DETACH actually finish before the
    // helper pod re-attaches the claim — an attach overlapping the previous
    // detach is the DO-CSI stale-attachment trigger (d4 run 6; see
    // waitForPvDetach). Pod-gone (above) is not detach-done.
    await waitForPvDetach(kubectl, {
      pvNames: await listDbPvNames(kubectl),
      settleMs: detachSettleMs,
    });
    const swapOut = await swapPgdataViaHelperPod(kubectl, { claimName, subPath, image });
    swapped = swapOut.includes('RESEED_SWAPPED');
    if (!swapped) {
      // The stage step above verified the staging (PG_VERSION) and threw on
      // failure, so a SKIPPED here means the staging vanished between steps —
      // a real failure, not a benign probe-skip.
      throw new Error(
        'helper-pod PGDATA swap found no verified staging to promote: the staged ' +
          'basebackup disappeared between staging and swap. The standby keeps its ' +
          'previous PGDATA.',
      );
    }
  } finally {
    // Let the helper pod's volume DETACH settle before the StatefulSet
    // re-attaches the same claim — the second half of the churn window the
    // DO-CSI stale-attachment race needs (d4 run 6). Best-effort like
    // everything else in this finally.
    await (async () => {
      const kubectl = (argv, opts) => sshKubectl(standbyIp, sshKeyPath, argv, opts);
      await waitForPvDetach(kubectl, { pvNames: await listDbPvNames(kubectl) });
    })().catch(() => {});
    // Always bring the StatefulSet back (even on failure — the old PGDATA is
    // intact and boots the previous standby state). Best-effort: the throw in
    // flight is the actionable signal.
    await sshKubectl(standbyIp, sshKeyPath, [
      'scale',
      'statefulset',
      DB_STATEFULSET,
      '-n',
      'vibecarbon',
      '--replicas=1',
    ]).catch(() => {});
  }

  // 300s server-side inside a 310s client cap, matching the deploy path's
  // post-swap boot budget (setupReplication's reseed.standbyBoot). The prior
  // 120s was survivorship bias — "all green runs fit" only until one didn't:
  // perf slice data (run 29378289779, 2026-07-15) measured the identical
  // post-swap boot at 165.8s on a healthy rig (CSI volume reattach + init
  // containers; ~5 min observed live 2026-07-07), so 120s intermittently
  // fails healthy reseeds. The explicit client cap keeps kubectl's own
  // timeout error (naming the stuck sts) as the surfaced failure.
  //
  // ONE stale-attachment repair on timeout (d4 run 6, mitigations.yml
  // `do-csi-stale-volumeattachment`): when the wait dies AND the db pod's
  // events carry the mkfs-on-missing-device signature, the attachment record
  // is provably stale (provider shows the volume attached to nothing; a pod
  // bounce does NOT heal it) — delete the attachments to force a real
  // provider attach and run the SAME wait once more. A timeout WITHOUT the
  // signature rethrows untouched: this is a targeted repair for one
  // evidenced state, not a blind retry.
  const rolloutWait = () =>
    sshKubectl(
      standbyIp,
      sshKeyPath,
      [
        'rollout',
        'status',
        `statefulset/${DB_STATEFULSET}`,
        '-n',
        'vibecarbon',
        `--timeout=${DB_STS_BOOT_TIMEOUT_S}s`,
      ],
      { timeout: (DB_STS_BOOT_TIMEOUT_S + 10) * 1000 },
    );
  try {
    await rolloutWait();
  } catch (rolloutErr) {
    const kubectl = (argv, opts) => sshKubectl(standbyIp, sshKeyPath, argv, opts);
    let events = '';
    try {
      events = String(
        await kubectl([
          'get',
          'events',
          '-n',
          'vibecarbon',
          '--field-selector',
          `involvedObject.name=${pod}`,
          '-o',
          'json',
        ]),
      );
    } catch {
      // Unreadable events — no evidence, no repair.
    }
    if (!STALE_ATTACH_EVENT_PATTERN.test(events)) throw rolloutErr;
    console.error(
      '[reseed] db rollout timed out with the stale-VolumeAttachment signature ' +
        '(MountDevice mkfs on a missing device) — scaling to zero, deleting the ' +
        'stale attachments, settling past the provider read-after-write window, ' +
        'and waiting once more.',
    );
    // ORDER MATTERS (run 8: the naive delete-VA-and-rewait repair reproduced
    // the race back-to-back — the controller processed unpublish and publish
    // in the SAME second and the driver's stale state read answered "already
    // attached" without attaching). Scale to zero FIRST so no pod wants the
    // volume and no publish can fire inside the detach's read-after-write
    // window; then clear the attachments, settle, and only then let the
    // StatefulSet re-attach.
    await kubectl([
      'scale',
      'statefulset',
      DB_STATEFULSET,
      '-n',
      'vibecarbon',
      '--replicas=0',
    ]).catch(() => {});
    const deleted = await deleteStaleDbVolumeAttachments(kubectl);
    if (deleted.length === 0) {
      // No stale attachment to clear after all — restore replicas and
      // surface the original timeout untouched.
      await kubectl([
        'scale',
        'statefulset',
        DB_STATEFULSET,
        '-n',
        'vibecarbon',
        '--replicas=1',
      ]).catch(() => {});
      throw rolloutErr;
    }
    await waitForPvDetach(kubectl, {
      pvNames: await listDbPvNames(kubectl),
      forceSettle: true,
      settleMs: detachSettleMs,
    });
    await kubectl(['scale', 'statefulset', DB_STATEFULSET, '-n', 'vibecarbon', '--replicas=1']);
    await rolloutWait();
  }

  // The swap went in — the standby MUST boot into recovery (standby.signal +
  // primary_conninfo were verified in staging). If it never does, fail loudly
  // NOW: a reseeded standby serving as its own primary is the exact regression
  // the scale-to-zero flow closes. Callers depend on this state (failover
  // promotes it out of recovery next; restore verifies streaming next).
  // Budget: ~10 min — on csi.hetzner.cloud PVCs the scale-up costs minutes
  // (volume reattach + init containers + backup recovery; ~5 min observed
  // live 2026-07-07) before the read-only probe can succeed.
  let inRecovery = false;
  let lastRecoveryErr = '';
  for (let i = 0; i < 150; i++) {
    try {
      const r = await sshKubectl(standbyIp, sshKeyPath, [
        'exec',
        '-n',
        'vibecarbon',
        pod,
        '--',
        'psql',
        '-U',
        'supabase_admin',
        '-tAc',
        'SELECT pg_is_in_recovery()',
      ]);
      if (r.trim() === 't') {
        inRecovery = true;
        break;
      }
    } catch (err) {
      // Pod still booting / applying initial WAL — retry. Record the failure
      // text (runCommandAsync folds psql's FATAL detail into the error message)
      // so the budget-exhausted throw can classify config errors distinctly.
      lastRecoveryErr = err?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, i < 5 ? 500 : 4000));
  }
  if (!inRecovery) {
    // "Hot standby mode is disabled" is a CONFIG error (hot_standby=off won —
    // the image's wal-g.conf ships it off and the staged auto.conf override
    // did not take), NOT a timing issue: waiting longer can never fix it.
    if (lastRecoveryErr.includes('Hot standby mode is disabled')) {
      throw new Error(
        'standby re-seed: the standby is streaming but refusing read-only connections ' +
          '("Hot standby mode is disabled") — hot_standby is OFF in its effective config ' +
          "(the image's wal-g.conf ships hot_standby=off; the staged postgresql.auto.conf " +
          'must override it with hot_standby = on). Config error, not a timing issue.',
      );
    }
    throw new Error(
      'standby re-seed swapped in a fresh basebackup but the standby never entered ' +
        'recovery mode within the budget; the reseeded PGDATA is not replaying from ' +
        'the primary (check the standby supabase-db logs).',
    );
  }
  return 'reseeded';
}

/**
 * Promote the standby database to primary (k8s transport) and confirm it exited
 * recovery. Returns true only when pg_is_in_recovery() flips to 'f' — the caller
 * MUST abort the failover on false rather than flip DNS onto a read-only standby.
 *
 * @param {string} standbyIp
 * @param {string} sshKeyPath
 * @returns {Promise<boolean>}
 */
export async function promoteStandby(standbyIp, sshKeyPath) {
  const pod = await getPostgresPod(standbyIp, sshKeyPath);

  // Promote PostgreSQL on standby. pg_ctl promote may return non-zero even on
  // success, so we confirm via the pg_is_in_recovery() poll below.
  try {
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
  } catch {
    // pg_ctl promote may return non-zero even on success — confirm via poll.
  }

  for (let i = 0; i < 30; i++) {
    try {
      const result = await sshKubectl(standbyIp, sshKeyPath, [
        'exec',
        '-n',
        'vibecarbon',
        pod,
        '--',
        'psql',
        '-U',
        'supabase_admin',
        '-tAc',
        'SELECT pg_is_in_recovery()',
      ]);
      if (result.trim() === 'f') return true;
    } catch {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  return false;
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
      'supabase_admin',
      '-tAc',
      'SELECT status FROM pg_stat_wal_receiver',
    ]);
    return (typeof out === 'string' ? out : '').trim() === 'streaming';
  } catch {
    return false;
  }
}

/**
 * Has the standby ALREADY exited recovery (i.e. been promoted to primary)?
 *
 * Queries pg_is_in_recovery() on the standby db pod. Returns true ONLY when the
 * result is 'f' (out of recovery = promoted). Non-throwing — any error (pod
 * down, exec failure, unreadable output) returns false so the caller falls back
 * to the normal re-seed + promote path.
 *
 * The failover flow checks this FIRST: on a convergent rerun after a mid-flow
 * crash the standby is already promoted, and a blind re-seed would pg_basebackup
 * OVER a promoted (and possibly already-serving) database. Mirrors the
 * non-throwing shape of isStandbyStreaming above.
 *
 * @param {string} standbyIp - standby cluster master IP (kubectl target)
 * @param {string} sshKeyPath
 * @returns {Promise<boolean>}
 */
export async function isStandbyPromoted(standbyIp, sshKeyPath) {
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
      'supabase_admin',
      '-tAc',
      'SELECT pg_is_in_recovery()',
    ]);
    return (typeof out === 'string' ? out : '').trim() === 'f';
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
    'supabase_admin',
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
