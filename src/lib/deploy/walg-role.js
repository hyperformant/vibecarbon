/**
 * Post-failover wal-g WRITE-GUARD role reconciliation.
 *
 * WHY THIS EXISTS
 * ---------------
 * `WALG_ROLE` is the wal-g write-guard: `primary` archives, `standby` no-ops.
 * It is rendered ONCE, at DEPLOY time, from the deploy's notion of which node is
 * which — compose writes it into each node's `.env` (haMergeWalgRoleStep, before
 * the stack starts) and k8s renders it into the supabase-db container env
 * (`{{WALG_ROLE}}` in k8s/values/supabase.values.yaml).
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

import { COMPOSE_BASE_FILES, COMPOSE_REPLICATION_OVERLAY } from './bundle.js';

/** The supabase-db StatefulSet (helm release `supabase`, chart component `db`). */
export const WALG_DB_STATEFULSET = 'supabase-supabase-db';

/** The env var both tiers read as the wal-g write-guard. */
export const WALG_ROLE_ENV = 'WALG_ROLE';

/**
 * The compose label that records the `-f` set a container was CREATED with.
 * Set by Compose v2+ on every container it creates, as comma-separated absolute
 * paths. Verified against Docker Compose v5.3.1. Exported for acme-role.js's
 * traefik recreate, which derives its `-f` set the same way.
 */
export const COMPOSE_CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';

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
 * It recreates the database with the DEV config — no `docker-compose.prod.yml` —
 * and on a compose-ha node it DROPS the replication overlay's `5433:5432`
 * publish that the repl-gateway socat relay dials. Measured, not theorised:
 * against a three-file project, a bare `up -d --no-deps db` reported
 * `Container … Started` and left `.NetworkSettings.Ports` as `{}`. Everything
 * looks healthy and replication transport is gone — the same shape as the
 * subnet-pin incident, where a recreate with the wrong file set wedged
 * production for two days.
 *
 * Failover does not have the deploy's feature options, so the set is recovered
 * from the node, two ways, in order of authority:
 *
 *   1. GROUND TRUTH — the `com.docker.compose.project.config_files` label on the
 *      RUNNING db container, which is literally the `-f` set that container was
 *      created with. Read BEFORE the recreate (the recreate overwrites it).
 *   2. FALLBACK — base + prod + the replication overlay when present. This is
 *      deliberately NOT "every overlay on the node": it mirrors, file for file,
 *      the ONLY other place that recreates `db` on a compose-ha node —
 *      `haWriteReplicationOverlay`'s `REPL_COMPOSE_FLAGS`
 *      (src/lib/deploy/compose/ha.js). Merging in an overlay the deploy never
 *      applied to `db` would be its own wrong-`-f` bug in the other direction,
 *      and the port assertion below could not catch it because it only detects
 *      REMOVALS: `docker-compose.n8n.yml` and `docker-compose.metabase.yml` both
 *      define a `db:` key. A unit test pins this list to REPL_COMPOSE_FLAGS.
 *
 * AND THEN IT CHECKS, rather than trusting either. The set of published ports is
 * captured before and compared after: anything that disappeared fails the step
 * loudly. A DR event is the worst possible place to discover that a recreate
 * quietly un-published the replication port, and this is the assertion that
 * makes both derivations above safe rather than merely careful. Note its limit —
 * it detects removals only, which is exactly why the fallback set above is
 * constrained rather than generous.
 *
 * `--no-deps` keeps this to the one service — nothing else on the node is
 * touched, and in particular the app tier is not restarted out from under the
 * caller (compose failover restarts it itself, right after this, so it reconnects
 * to the recreated database).
 *
 * @param {string} remoteDir e.g. `/opt/<project>`
 * @returns {string} a bash script, run as one SSH command
 */
export function composeDbRecreateShell(remoteDir) {
  const baseFlags = COMPOSE_BASE_FILES.map((f) => `-f ${f}`).join(' ');
  return [
    'set -e',
    `cd ${remoteDir}`,
    // `head -n1`: db is never scaled, but a stray second id would corrupt every
    // inspect below.
    'CID="$(docker compose ps -q db | head -n1)"',
    'if [ -z "$CID" ]; then',
    `  echo "[walg-role] no db container is running in ${remoteDir}, refusing to recreate blind" >&2`,
    '  exit 1',
    'fi',
    `FILES="$(docker inspect -f '{{ index .Config.Labels "${COMPOSE_CONFIG_FILES_LABEL}" }}' "$CID" 2>/dev/null || true)"`,
    `PORTS_BEFORE="$(docker inspect -f '${PUBLISHED_PORTS_TEMPLATE}' "$CID" 2>/dev/null || true)"`,
    'FLAGS=""',
    'if [ -n "$FILES" ]; then',
    '  OLD_IFS="$IFS"; IFS=,',
    // Skip empty fields — a trailing comma or an all-whitespace label would
    // otherwise contribute a bare `-f` with no argument.
    '  for f in $FILES; do',
    '    case "$f" in *[!\\ ]*) FLAGS="$FLAGS -f $f" ;; esac',
    '  done',
    '  IFS="$OLD_IFS"',
    'fi',
    // The label path is preferred but NEVER trusted to have produced something
    // usable. An empty -f set is the exact bug this whole function exists to
    // prevent (a bare `up` resolves docker-compose.yml alone), so anything that
    // does not look like a real file list degrades to the probe reconstruction
    // rather than to nothing. Covers: no label at all (a container created
    // before this change, or an older Compose), an empty label, and a label
    // that parsed to junk.
    'case "$FLAGS" in',
    '  *.yml*|*.yaml*)',
    '    echo "[walg-role] using the -f set the running db was created with" ;;',
    '  *)',
    `    FLAGS="${baseFlags}"`,
    // Exactly REPL_COMPOSE_FLAGS' set — base + prod + the replication overlay
    // when the node has one. NOT every overlay present: see the docblock.
    // `if` rather than `[ … ] && …` so a missing file cannot leave the branch
    // non-zero and, under `set -e`, abort the script before the up.
    `    if [ -f ${COMPOSE_REPLICATION_OVERLAY} ]; then FLAGS="$FLAGS -f ${COMPOSE_REPLICATION_OVERLAY}"; fi`,
    '    echo "[walg-role] no usable compose config_files label, rebuilt the -f set from the replication file set" ;;',
    'esac',
    'echo "[walg-role] recreating db: docker compose $FLAGS up -d --no-deps db"',
    // $FLAGS is deliberately UNQUOTED — it must word-split into separate `-f
    // <file>` arguments. Every element is a compose file path that docker itself
    // recorded or a literal filename from the list above; none is user input.
    'docker compose $FLAGS up -d --no-deps db',
    // Verify the recreate kept everything the deployed container had. Ports are
    // the signal that matters here (5433 → replication transport) and the one a
    // wrong -f set destroys silently.
    'CID_NEW="$(docker compose ps -q db | head -n1)"',
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
    // recreate succeeded, it just resolved the wrong file set), so the failover
    // can and does carry on — this exit only marks the step failed, which the
    // caller turns into the terminal non-zero exit. `vibecarbon deploy` re-ups
    // the whole stack from reconcile.sh's baked -f set, which restores the
    // publish; that is the same remediation the degraded-failover message gives.
    '  echo "[walg-role] db recreate DROPPED published port(s):$MISSING" >&2',
    '  echo "[walg-role] the database is RUNNING but was recreated from the wrong compose file set; on a compose-ha node that port is the replication transport. Nothing is lost — re-run \\`vibecarbon deploy <env>\\` to reconcile the node from its full file set. Refusing to report this step as success." >&2',
    '  exit 1',
    'fi',
    // The recreate returns as soon as the container is CREATED. Everything after
    // this (the audit, the app-tier restart) needs a database that answers.
    'for i in $(seq 1 45); do',
    '  if docker compose exec -T db pg_isready -h 127.0.0.1 -U supabase_admin >/dev/null 2>&1; then',
    `    echo "[walg-role] db accepting connections; ${WALG_ROLE_ENV}=$(docker compose exec -T db printenv ${WALG_ROLE_ENV} 2>/dev/null | tr -d "[:space:]"); published:$PORTS_AFTER"`,
    '    exit 0',
    '  fi',
    '  sleep 2',
    'done',
    'echo "[walg-role] db did not accept connections within 90s of the recreate" >&2',
    'exit 1',
  ].join('\n');
}

/**
 * `kubectl` argv (no leading `kubectl`) that sets `WALG_ROLE` on the supabase-db
 * StatefulSet. The template change is what rolls the pod, which is what makes
 * the new value visible to postgres' `archive_command` and to the backup
 * CronJob's `kubectl exec` (it inherits the db container's env — the CronJob has
 * no `WALG_ROLE` of its own).
 *
 * No `--containers` selector: the default `*` covers the db pod's single app
 * container and stays correct if the chart renames it. `kubectl set env` does
 * not touch initContainers, so the seed-standby init keeps its rendered value —
 * harmless, since it also self-gates on PGDATA being empty and the promoted
 * node's is not.
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
    `statefulset/${WALG_DB_STATEFULSET}`,
    `${WALG_ROLE_ENV}=${role}`,
  ];
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
export function k8sDbRolloutStatusArgv(timeoutSeconds = 300) {
  return [
    '-n',
    'vibecarbon',
    'rollout',
    'status',
    `statefulset/${WALG_DB_STATEFULSET}`,
    `--timeout=${timeoutSeconds}s`,
  ];
}

/**
 * The operator-facing message for a failover whose backup reconciliation did not
 * land. Deliberately states the CURRENT state of the world (the failover itself
 * completed — the site is up on the new primary) before the problem, because
 * this is read mid-incident and the first question is always "am I serving?".
 *
 * @param {object} args
 * @param {'compose'|'k8s'} args.path
 * @param {string} args.envName
 * @param {string} args.promotedIp
 * @param {string} args.detail underlying failure text
 * @returns {string}
 */
export function walgRoleDegradedMessage({ path, envName, promotedIp, detail }) {
  const verify =
    path === 'compose'
      ? `ssh root@${promotedIp} 'cd /opt/<project> && docker compose exec -T db printenv WALG_ROLE'`
      : `ssh root@${promotedIp} 'kubectl -n vibecarbon exec ${WALG_DB_STATEFULSET}-0 -- printenv WALG_ROLE'`;
  return (
    `FAILOVER COMPLETED, BACKUPS DID NOT. The promoted node (${promotedIp}) is serving, DNS ` +
    `is flipped and the role swap is persisted; but this failover could not prove that ` +
    `wal-g is archiving from it. ${detail} Until this is fixed the new primary holds the ` +
    `ONLY live copy of your data and is accumulating no recoverable backups. Check the ` +
    `write-guard with \`${verify}\` (it must print \`primary\`), then re-run ` +
    `\`vibecarbon deploy ${envName}\`; a deploy re-renders WALG_ROLE from the now-swapped ` +
    `config and re-runs the same backup audit.`
  );
}
