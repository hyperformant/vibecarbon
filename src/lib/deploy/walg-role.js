/**
 * Post-failover wal-g WRITE-GUARD role reconciliation.
 *
 * WHY THIS EXISTS
 * ---------------
 * `WALG_ROLE` is the wal-g write-guard: `primary` archives, `standby` no-ops.
 * It is rendered ONCE, at DEPLOY time, from the deploy's notion of which node is
 * which — compose writes it into each node's `.env` (haMergeWalgRoleStep, before
 * the stack starts) and k8s renders it into the db container env
 * (`{{WALG_ROLE}}` in k8s/base/db/statefulset.yaml).
 *
 * Failover moves the role WITHOUT redeploying. It promotes the standby, flips
 * DNS, and persists the swap in the project config — but nothing re-rendered
 * `WALG_ROLE`, so the promoted node kept the value it was DEPLOYED with:
 *
 *   - compose: the new primary carried `WALG_ROLE=standby`, which short-circuits
 *     BOTH wal-archive.sh (no WAL archived) and compose-backup.sh (no base
 *     backups). Total backup outage on the node now holding the only live copy
 *     of the data, until the next deploy happened to rewrite the roles.
 *   - k8s: the backup CronJob `kubectl exec`s into the db pod and inherits its
 *     env, so base backups were skipped for the same reason. (WAL archiving
 *     survived only because the k8s copy of wal-archive.sh had drifted and lost
 *     the guard entirely — which is its own bug, fixed in the same change.)
 *
 * Either way the window is the worst possible one: right after a failover, with
 * one node down and no second copy.
 *
 * THE MOVE HAS TO REACH THE RUNNING PROCESS
 * -----------------------------------------
 * `WALG_ROLE` is CONTAINER ENVIRONMENT on both tiers, and container environment
 * is fixed at container-create time. Writing `.env` does nothing on its own —
 * `docker compose restart` re-runs the SAME container with the SAME env — and
 * neither does patching a StatefulSet without letting the pod roll. So both
 * paths here end in a recreate, and both then PROVE the new value took by
 * running the deploy-time backup audit in `requirePrimary` mode against the
 * promoted node (src/lib/deploy/walg-audit.js): if the env did not actually
 * change, the probe still reports `WALG_ROLE=standby` and the audit fails.
 * A config file updated but never read is not a fix.
 *
 * BOTH DIRECTIONS OF THE SWAP
 * ---------------------------
 * The old primary is demoted too, best-effort. After a failover its database is
 * still running, still out of recovery, and still `WALG_ROLE=primary`, so with
 * the write-guard in place on both tiers it would keep pushing WAL into the same
 * canonical prefix the NEW primary now writes — two writers in one backup
 * stream. Demoting it is what makes the swap symmetric. It is best-effort
 * because an unreachable old primary is the most common reason to fail over at
 * all, and refusing to finish a failover over it would be absurd.
 */

import { VC_COMPOSE } from './compose/command.js';
import { DB_CONTAINER, DB_POD, DB_STATEFULSET } from './db-workload.js';
import { DB_STS_BOOT_TIMEOUT_S, watchDbAttach } from './replication.js';
import { dropInactiveReplicationSlots, slotDropWarning } from './replication-slot.js';

/** The env var both tiers read as the wal-g write-guard. */
export const WALG_ROLE_ENV = 'WALG_ROLE';

/**
 * The compose node-role env, written wherever a compose node's role is.
 *
 * `WALG_ROLE` is the wal-g write-guard (see the module docblock). Every
 * compose-side role write (deploy's haMergeWalgRole, failover's
 * restoreComposeWalgRole / demoteComposeWalgRole) goes through here, so the
 * role is validated in one place: an unknown role throws instead of silently
 * arming (or disarming) archiving. compose-role-env-census.test.ts enforces it.
 *
 * Values are strings because the destination is a dotenv file.
 *
 * @param {'primary'|'standby'} role
 * @returns {Record<string, string>}
 */
export function composeRoleEnv(role) {
  if (role !== 'primary' && role !== 'standby') {
    throw new Error(`composeRoleEnv: unknown role ${role}`);
  }
  return { [WALG_ROLE_ENV]: role };
}

/**
 * Go template emitting one `<container-port>-><host-port>` token per PUBLISHED
 * port. Exposed-but-unpublished ports have a null mapping and `range` over nil
 * yields nothing, so only real publishes are compared — which is the property
 * that matters. Single-quoted at the use site so the remote shell does not
 * expand `$p` / `$c` as its own variables.
 */
export const PUBLISHED_PORTS_TEMPLATE =
  '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{$p}}->{{.HostPort}} {{end}}{{end}}';

/**
 * Bash that RECREATES the compose `db` service so it picks up the `WALG_ROLE`
 * just merged into `.env`, verifies the recreate did not silently lose anything,
 * then waits for postgres to accept connections again.
 *
 * WHY THE `-f` SET IS THE WHOLE PROBLEM
 * ------------------------------------
 * A bare `docker compose up -d --no-deps db` resolves ONLY `docker-compose.yml`.
 * It recreates the database with the DEV config (no `docker-compose.prod.yml`),
 * and on a compose-ha node it DROPS the replication overlay's `5433:5432`
 * publish that the repl-gateway socat relay dials. Measured, not theorised:
 * against a three-file project, a bare `up -d --no-deps db` reported
 * `Container … Started` and left `.NetworkSettings.Ports` as `{}`. Everything
 * looks healthy and replication transport is gone: the same shape as the
 * subnet-pin incident, where a recreate with the wrong file set wedged
 * production for two days.
 *
 * Failover does not have the deploy's feature options, and does not need
 * them: it runs vc-compose (compose/command.js), the script the deploy's
 * bundle rendered with the node's own `-f` set, which adds the replication
 * overlay when the node has it. So this recreate renders db exactly as the
 * next reconcile will.
 *
 * AND THEN IT CHECKS, rather than trusting it. The set of published ports is
 * captured before and compared after: anything that disappeared fails the step
 * loudly. A DR event is the worst possible place to discover that a recreate
 * quietly un-published the replication port.
 *
 * `--no-deps` keeps this to the one service: nothing else on the node is
 * touched, and in particular the app tier is not restarted out from under the
 * caller (compose failover restarts it itself, right after this, so it
 * reconnects to the recreated database).
 *
 * @param {string} remoteDir e.g. `/opt/<project>`
 * @returns {string} a bash script, run as one SSH command
 */
export function composeDbRecreateShell(remoteDir) {
  return [
    'set -e',
    `cd ${remoteDir}`,
    // `head -n1`: db is never scaled, but a stray second id would corrupt every
    // inspect below.
    `CID="$(${VC_COMPOSE} ps -q db | head -n1)"`,
    'if [ -z "$CID" ]; then',
    `  echo "[walg-role] no db container is running in ${remoteDir}, refusing to recreate blind" >&2`,
    '  exit 1',
    'fi',
    `PORTS_BEFORE="$(docker inspect -f '${PUBLISHED_PORTS_TEMPLATE}' "$CID" 2>/dev/null || true)"`,
    `echo "[walg-role] recreating db: ${VC_COMPOSE} up -d --no-deps db"`,
    `${VC_COMPOSE} up -d --no-deps db`,
    // Verify the recreate kept everything the deployed container had. Ports are
    // the signal that matters here (5433 → replication transport) and the one a
    // wrong -f set destroys silently.
    `CID_NEW="$(${VC_COMPOSE} ps -q db | head -n1)"`,
    `PORTS_AFTER="$(docker inspect -f '${PUBLISHED_PORTS_TEMPLATE}' "$CID_NEW" 2>/dev/null || true)"`,
    'MISSING=""',
    'for p in $PORTS_BEFORE; do',
    '  case " $PORTS_AFTER " in',
    '    *" $p "*) ;;',
    '    *) MISSING="$MISSING $p" ;;',
    '  esac',
    'done',
    'if [ -n "$MISSING" ]; then',
    // Loud, and honest about the state it is leaving behind. The db is UP (the
    // recreate succeeded, it just lost a publish), so the failover can and does
    // carry on: this exit only marks the step failed, which the caller turns
    // into the terminal non-zero exit. `vibecarbon deploy` re-ups the whole
    // stack through vc-compose, which restores the publish; that is the same
    // remediation the degraded-failover message gives.
    '  echo "[walg-role] db recreate DROPPED published port(s):$MISSING" >&2',
    '  echo "[walg-role] the database is RUNNING but lost a published port; on a compose-ha node that port is the replication transport. Nothing is lost. Re-run \\`vibecarbon deploy <env>\\` to reconcile the node from its full file set. Refusing to report this step as success." >&2',
    '  exit 1',
    'fi',
    // The recreate returns as soon as the container is CREATED. Everything after
    // this (the audit, the app-tier restart) needs a database that answers.
    'for i in $(seq 1 45); do',
    `  if ${VC_COMPOSE} exec -T db pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then`,
    `    echo "[walg-role] db accepting connections; ${WALG_ROLE_ENV}=$(${VC_COMPOSE} exec -T db printenv ${WALG_ROLE_ENV} 2>/dev/null | tr -d "[:space:]"); published:$PORTS_AFTER"`,
    '    exit 0',
    '  fi',
    '  sleep 2',
    'done',
    'echo "[walg-role] db did not accept connections within 90s of the recreate" >&2',
    'exit 1',
  ].join('\n');
}

/**
 * `kubectl` argv (no leading `kubectl`) that sets `WALG_ROLE` on the db
 * StatefulSet. The template change is what rolls the pod, which is what makes
 * the new value visible to postgres' `archive_command` and to the backup
 * CronJob's `kubectl exec` (it inherits the db container's env — the CronJob has
 * no `WALG_ROLE` of its own).
 *
 * No `--containers` selector: the default `*` covers the db pod's single app
 * container and stays correct if the chart renames it. `kubectl set env` does
 * not touch initContainers, and none of them reads WALG_ROLE.
 *
 * @param {'primary'|'standby'} role
 * @returns {string[]}
 */
export function k8sSetWalgRoleArgv(role) {
  return [
    '-n',
    'vibecarbon',
    'set',
    'env',
    `statefulset/${DB_STATEFULSET}`,
    `${WALG_ROLE_ENV}=${role}`,
  ];
}

/**
 * Demote a k8s cluster's db: drop its inactive replication slots, then set
 * `WALG_ROLE=standby` on the db StatefulSet. The one k8s standby role write
 * (tests/unit/deploy/slot-drop-on-demotion-census.test.ts), shared by
 * failover's old-primary demotion and the retired fence.
 *
 * The drop goes first because the role write rolls the db pod and nothing
 * here waits for the roll. Nobody streams from the old primary's slot after a
 * failover, so it would only pin WAL on that node up to the slot cap. A failed
 * drop still demotes and warns once, unless the role write fails too, which
 * throws and is the caller's one report.
 *
 * @param {object} args
 * @param {string} args.ip - the cluster's master (kubectl target)
 * @param {(ip: string, argv: string[], opts?: object) => Promise<unknown>} args.kubectl
 * @param {(msg: string) => void} args.warn
 * @returns {Promise<{slotsDropped: boolean}>}
 */
export async function demoteK8sWalgRole({ ip, kubectl, warn }) {
  const slots = await dropInactiveReplicationSlots((sql) =>
    kubectl(
      ip,
      [
        '-n',
        'vibecarbon',
        'exec',
        DB_POD,
        '-c',
        DB_CONTAINER,
        '--',
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-tAc',
        sql,
      ],
      { timeout: 30_000 },
    ),
  );
  await kubectl(ip, k8sSetWalgRoleArgv('standby'), { timeout: 60_000 });
  if (!slots.ok) warn(slotDropWarning(ip, slots.error));
  return { slotsDropped: slots.ok };
}

/**
 * `kubectl` argv that blocks until the db StatefulSet has finished rolling the
 * pod that `k8sSetWalgRoleArgv` triggered. Load-bearing on the PROMOTED node:
 * the audit that follows reads the env of the RUNNING pod, so auditing before
 * the roll would read the old container and pass on a lie.
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
 * Wait for the db StatefulSet to roll on a remote cluster, under
 * watchDbAttach: every WALG_ROLE roll recreates db-0 on the same node, which
 * detaches and re-attaches its volume (the do-csi-stale-volumeattachment
 * trigger), so a stale attachment stops the wait early with
 * StaleVolumeAttachmentError instead of burning the budget. The ssh budget
 * sits 30s above the kubectl --timeout so kubectl reports a rollout failure
 * itself. The one way the failover paths wait on a db roll
 * (db-rollout-wait-census in tests/unit/deploy/db-attach-watch.test.ts).
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
 * The operator-facing message for a failover whose backup reconciliation did not
 * land. Deliberately states the CURRENT state of the world (the failover itself
 * completed — the site is up on the new primary) before the problem, because
 * this is read mid-incident and the first question is always "am I serving?".
 * It also names the base backup the failover did not push on the new timeline
 * (pushBaseBackupAfterPromote is not attempted on a node still reading
 * standby): one error, not two.
 *
 * @param {object} args
 * @param {'compose'|'k8s'} args.path
 * @param {string} args.envName
 * @param {string} args.promotedIp
 * @param {string} args.detail underlying failure text
 * @param {string[]} [args.heldAtZero] compose: the primary-only add-ons the next
 *   reconcile scales back to 0, when the failover never wrote WALG_ROLE=primary
 *   into the promoted node's .env (it still reads standby)
 * @returns {string}
 */
export function walgRoleDegradedMessage({ path, envName, promotedIp, detail, heldAtZero = [] }) {
  const verify =
    path === 'compose'
      ? `ssh root@${promotedIp} 'cd /opt/<project> && ${VC_COMPOSE} exec -T db printenv WALG_ROLE'`
      : `ssh root@${promotedIp} 'kubectl -n vibecarbon exec ${DB_POD} -- printenv WALG_ROLE'`;
  return (
    `FAILOVER COMPLETED, BACKUPS DID NOT. The promoted node (${promotedIp}) is serving, DNS ` +
    `is flipped and the role swap is persisted; but this failover could not prove that ` +
    `wal-g is archiving from it. ${detail} Until this is fixed the new primary holds the ` +
    `ONLY live copy of your data and is accumulating no recoverable backups. Check the ` +
    `write-guard with \`${verify}\` (it must print \`primary\`), then re-run ` +
    `\`vibecarbon deploy ${envName}\`; a deploy re-renders WALG_ROLE from the now-swapped ` +
    `config and re-runs the same backup audit. There is also no base backup on the new ` +
    `timeline (a node reading standby skips the push): once the write-guard reads primary, ` +
    `run \`vibecarbon backup ${envName}\`.` +
    (heldAtZero.length > 0
      ? ` Until WALG_ROLE=primary is in the new primary's .env, its next reconcile scales ` +
        `${heldAtZero.join(', ')} back to 0; that deploy writes it.`
      : '')
  );
}
