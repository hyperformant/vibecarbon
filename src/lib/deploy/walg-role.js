/**
 * The wal-g WRITE-GUARD role: `primary` archives, `standby` no-ops.
 *
 * WHY THIS EXISTS
 * ---------------
 * The role is set ONCE, at DEPLOY time, from the deploy's notion of which node
 * is which. Failover moves it WITHOUT redeploying: it promotes the standby,
 * flips DNS, and persists the swap in the project config. Before the role
 * moved with it, the promoted node kept the value it was DEPLOYED with,
 * `standby`, which short-circuits wal-archive.sh (no WAL archived) and the
 * base-backup path on both tiers. Total backup outage on the node now holding
 * the only live copy of the data, until the next deploy happened to rewrite
 * the roles, in the worst possible window: right after a failover, with one
 * node down and no second copy.
 *
 * ONE FILE, ONE PARSER, NO RESTART
 * --------------------------------
 * The role is a one-word file outside PGDATA, WALG_ROLE_FILE in the db
 * container, which every wal-g caller reads through the one parser
 * (WALG_ROLE_PARSE_SH) on each run. So a move is one write, with no pod or
 * container restart:
 *
 *   - k8s: the role subPath of the db volume, plus a durable intent ConfigMap
 *     that db-guard.sh applies on every container start. setK8sWalgRole
 *     applies the intent, then writes the live file and reads it back.
 *   - compose: the host directory `/opt/<project>/.vibecarbon-role`, bound
 *     read-only into the db container. writeComposeWalgRole writes it over
 *     SSH and reads it back. Nothing about the role is in `.env` any more.
 *
 * Failover arms the promoted side BEFORE pg_promote (D2), while it is still
 * in recovery (archive_command never runs there, so the write is inert until
 * the promote makes it true), and then PROVES it took by running the
 * deploy-time backup audit in `requirePrimary` mode against the promoted node
 * (src/lib/deploy/walg-audit.js).
 *
 * BOTH DIRECTIONS OF THE SWAP
 * ---------------------------
 * The old primary is demoted too, best-effort. After a failover its database
 * is still running, still out of recovery, and still reading `primary`, so it
 * would keep pushing WAL into the same canonical prefix the NEW primary now
 * writes: two writers in one backup stream. Demoting it is what makes the
 * swap symmetric. It is best-effort because an unreachable old primary is the
 * most common reason to fail over at all, and refusing to finish a failover
 * over it would be absurd.
 */

import { outputLines } from '../remote-sentinel.js';
import { shEscape } from '../shell.js';
import { sshRun } from '../ssh.js';
import { validateProjectName } from '../validators.js';
import { DB_CONTAINER, DB_POD } from './db-workload.js';
import { dropInactiveReplicationSlots, slotDropWarning } from './replication-slot.js';

/** In-container path, both tiers. */
export const WALG_ROLE_DIR = '/var/lib/vibecarbon/role';
export const WALG_ROLE_FILE = `${WALG_ROLE_DIR}/walg-role`;

/**
 * THE role parser (POSIX sh). Reads "$vc_walg_role_file"; sets VC_WALG_ROLE to
 * primary, standby or "". Never exits. Carried verbatim by walg-env.sh (both
 * copies) and tls-snapshot.sh; rendered by walgRoleReadFragment everywhere else.
 */
export const WALG_ROLE_PARSE_SH = [
  'VC_WALG_ROLE=""',
  'if [ -f "$vc_walg_role_file" ] && [ ! -L "$vc_walg_role_file" ]; then',
  '    case "$(cat "$vc_walg_role_file" 2>/dev/null)" in',
  '        primary) VC_WALG_ROLE=primary ;;',
  '        standby) VC_WALG_ROLE=standby ;;',
  '    esac',
  'fi',
].join('\n');

/**
 * `vc_walg_role_file=<path>` + the parser + `unset vc_walg_role_file`.
 *
 * @param {string} path the role file to read
 * @returns {string} POSIX sh that leaves VC_WALG_ROLE set (not exported)
 */
export function walgRoleReadFragment(path) {
  return `vc_walg_role_file=${shEscape(path)}\n${WALG_ROLE_PARSE_SH}\nunset vc_walg_role_file`;
}

/**
 * The tail of both failover role-mount refusals (k8s db-0 mount, compose db
 * bind). They run after the operator-IP firewall refresh (their probe needs
 * ssh) and the retirement-fence reconcile, so they cannot claim nothing
 * changed: they claim what is true, that no failover step ran.
 */
export const FAILOVER_NOT_STARTED =
  'The failover did not start: the databases, their wal-g roles and DNS are unchanged.';

/** The compose role directory on the host, relative to `/opt/<project>`. */
export const COMPOSE_WALG_ROLE_HOST_DIR = '.vibecarbon-role';

/** k8s: the CLI-owned ConfigMap holding the durable role intent. */
export const DB_ROLE_CONFIGMAP = 'vibecarbon-db-role';

/** Its one key, injected into the db container as an env var of the same name. */
export const DB_ROLE_INTENT_KEY = 'VC_WALG_ROLE_INTENT';

/**
 * The one role check every writer goes through: only the two literal words.
 *
 * @param {unknown} role
 * @returns {'primary'|'standby'}
 */
export function assertWalgRole(role) {
  if (role !== 'primary' && role !== 'standby') {
    throw new Error(`unknown wal-g role ${JSON.stringify(role) ?? String(role)}`);
  }
  return role;
}

/**
 * POSIX sh that prints `WALG_ROLE_FILE=<role>` for `<dir>/walg-role`, read
 * through the one parser. `<role>` is empty for a missing or unparseable file.
 * Never fails.
 *
 * @param {string} dir
 * @returns {string}
 */
export function walgRoleReadShell(dir) {
  return `${walgRoleReadFragment(`${dir}/walg-role`)}\nprintf 'WALG_ROLE_FILE=%s\\n' "$VC_WALG_ROLE"`;
}

/**
 * The one read-back of a walgRoleReadShell answer: the role its
 * `WALG_ROLE_FILE=<role>` line names (`primary`, `standby`, or '' for a
 * missing or unparseable file), or undefined when no such line came back (the
 * node did not answer). `false` (sshRun's failure value) reads as no answer.
 * Every caller reads the answer through this (census:
 * tests/unit/deploy/walg-role-source-census.test.ts).
 *
 * @param {unknown} out
 * @returns {string|undefined}
 */
export function parseWalgRoleReadBack(out) {
  const text = out === false || out == null ? '' : String(out);
  return /^WALG_ROLE_FILE=(.*)$/m.exec(text)?.[1]?.trim();
}

/**
 * The stderr line a failed role write prints. setK8sWalgRole matches it on
 * the error's stderr only: the thrown message carries the whole command,
 * script and this text included.
 */
const WALG_ROLE_WRITE_FAILED = '[walg-role] could not write the wal-g role in';

/**
 * POSIX sh that writes the role to `<dir>/walg-role` atomically, then prints
 * it read back through the one parser (walgRoleReadShell).
 *
 * The write happens inside `<dir>`, so the rename never crosses a filesystem:
 * remove any stale tmp (a planted symlink is removed, never followed), create
 * the tmp under noclobber (a name that reappears in between fails the write
 * instead of being followed), chmod 0644, sync (the tmp's bytes are durable
 * before the rename can expose them), `mv -f` over the role file, sync (the
 * rename itself is durable). Plain `sync`: busybox's older builds take no
 * file arguments.
 * A reader sees the old word or the new one, never a partial file. Any step
 * failing exits 1 before the read-back, so no role line is printed.
 *
 * @param {string} dir the role directory (must exist)
 * @param {'primary'|'standby'} role
 * @returns {string}
 */
export function walgRoleWriteShell(dir, role) {
  assertWalgRole(role);
  return [
    `( cd ${shEscape(dir)} && rm -f walg-role.tmp && (set -C && printf '%s\\n' ${role} > walg-role.tmp) && chmod 0644 walg-role.tmp && sync && mv -f walg-role.tmp walg-role && sync ) || { echo ${shEscape(`${WALG_ROLE_WRITE_FAILED} ${dir}`)} >&2; exit 1; }`,
    walgRoleReadShell(dir),
  ].join('\n');
}

/**
 * The k8s role intent ConfigMap. Applied with `kubectl apply -f -`, so a
 * cluster that predates it gets it created rather than a failed patch. Not in
 * k8s/base: Flux never sees it.
 *
 * @param {'primary'|'standby'} role
 * @returns {string} YAML
 */
export function dbRoleConfigMapManifest(role) {
  assertWalgRole(role);
  return [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    `  name: ${DB_ROLE_CONFIGMAP}`,
    '  namespace: vibecarbon',
    'data:',
    `  ${DB_ROLE_INTENT_KEY}: ${role}`,
    '',
  ].join('\n');
}

/**
 * kubectl argv (no leading `kubectl`) that applies dbRoleConfigMapManifest,
 * passed as the call's `input`.
 *
 * @returns {string[]}
 */
export function k8sWalgRoleIntentApplyArgv() {
  return ['-n', 'vibecarbon', 'apply', '-f', '-'];
}

/**
 * kubectl argv that writes the live role file in the db container. Every
 * token survives sshKubectl's per-token shEscape join, the script included.
 *
 * @param {'primary'|'standby'} role
 * @returns {string[]}
 */
export function k8sWalgRoleExecArgv(role) {
  return [
    '-n',
    'vibecarbon',
    'exec',
    DB_POD,
    '-c',
    DB_CONTAINER,
    '--',
    'sh',
    '-c',
    walgRoleWriteShell(WALG_ROLE_DIR, role),
  ];
}

/**
 * Does this db pod's db container mount WALG_ROLE_DIR? A pod from before the
 * role mount would take an exec write into its container overlay and read it
 * back as a false success, so the live write is gated on this.
 *
 * @param {string|object} podJson `kubectl get pod -o json` output, or its parse
 * @returns {boolean} false for anything unparseable
 */
export function podMountsWalgRoleDir(podJson) {
  let pod;
  try {
    pod = typeof podJson === 'string' ? JSON.parse(podJson) : podJson;
  } catch {
    return false;
  }
  const containers = pod?.spec?.containers;
  if (!Array.isArray(containers)) return false;
  const db = containers.find((c) => c?.name === DB_CONTAINER);
  const mounts = db?.volumeMounts;
  return Array.isArray(mounts) && mounts.some((m) => m?.mountPath === WALG_ROLE_DIR);
}

/**
 * Set the k8s wal-g role: the durable intent first (created if missing), then
 * the live file, but only on a pod whose spec mounts WALG_ROLE_DIR.
 *
 * A failed intent apply throws: without it a db start that the CLI could not
 * reach would come back with the wrong role. So a returned result always has
 * `intent: true`; the field stays so callers can log the whole result. The
 * live write never throws unless `requireLive` is set; the result says why it
 * did not land: `no-role-mount` (a pod from before the role mount),
 * `pod-unreachable` (get or exec could not reach the container),
 * `write-failed` (the write ran and failed: a read-only mount, a full disk),
 * `read-back-mismatch` (it ran but the parser does not read `role` back).
 *
 * @param {object} o
 * @param {string} o.ip
 * @param {(ip: string, argv: string[], opts?: {input?: string, timeout?: number}) => Promise<string>} o.kubectl
 * @param {'primary'|'standby'} o.role
 * @param {boolean} [o.requireLive] throw unless the live file now reads `role`
 * @param {string} [o.envName] named in the no-role-mount hint; `<env>` when absent
 * @returns {Promise<{intent: true, live: boolean, reason?: 'no-role-mount'|'pod-unreachable'|'write-failed'|'read-back-mismatch', error?: Error}>}
 */
export async function setK8sWalgRole({ ip, kubectl, role, requireLive = false, envName }) {
  assertWalgRole(role);
  await kubectl(ip, k8sWalgRoleIntentApplyArgv(), {
    input: dbRoleConfigMapManifest(role),
    timeout: 60_000,
  });

  /** @param {{intent: true, live: boolean, reason?: string, error?: Error}} result */
  const settle = (result) => {
    if (!requireLive || result.live) return result;
    if (result.reason === 'no-role-mount') {
      throw new Error(
        `this cluster's db predates the live wal-g role (no ${WALG_ROLE_DIR} mount on ${DB_POD}); ` +
          `run \`vibecarbon deploy ${envName || '<env>'}\` once (one db restart), then retry`,
      );
    }
    const detail = result.error ? `: ${result.error.message}` : '';
    throw new Error(
      `could not set the wal-g role to ${role} on ${DB_POD} (${result.reason})${detail}`,
    );
  };

  let pod;
  try {
    pod = await kubectl(ip, ['-n', 'vibecarbon', 'get', 'pod', DB_POD, '-o', 'json'], {
      timeout: 30_000,
    });
  } catch (error) {
    return settle({ intent: true, live: false, reason: 'pod-unreachable', error });
  }
  if (!podMountsWalgRoleDir(pod)) {
    return settle({ intent: true, live: false, reason: 'no-role-mount' });
  }

  let out;
  try {
    out = await kubectl(ip, k8sWalgRoleExecArgv(role), { timeout: 30_000 });
  } catch (error) {
    const wrote = outputLines(error?.stderr).some((l) => l.startsWith(WALG_ROLE_WRITE_FAILED));
    return settle({
      intent: true,
      live: false,
      reason: wrote ? 'write-failed' : 'pod-unreachable',
      error,
    });
  }
  const readBack = parseWalgRoleReadBack(out);
  if (readBack !== role) {
    return settle({ intent: true, live: false, reason: 'read-back-mismatch' });
  }
  return { intent: true, live: true };
}

/**
 * One SSH command for a compose host: write the role into
 * `/opt/<project>/.vibecarbon-role/walg-role` (bound read-only into the db
 * container). Runs on the host, so it works with db stopped.
 *
 * @param {string} projectName
 * @param {'primary'|'standby'} role
 * @returns {string}
 */
export function composeWalgRoleWriteShell(projectName, role) {
  const invalid = validateProjectName(projectName);
  if (invalid) throw new Error(`composeWalgRoleWriteShell: ${invalid}`);
  assertWalgRole(role);
  const projectDir = `/opt/${projectName}`;
  return [
    `cd ${projectDir} && mkdir -p ${COMPOSE_WALG_ROLE_HOST_DIR} && chmod 0755 ${COMPOSE_WALG_ROLE_HOST_DIR} || exit 1`,
    walgRoleWriteShell(`${projectDir}/${COMPOSE_WALG_ROLE_HOST_DIR}`, role),
  ].join('\n');
}

/**
 * Write a compose node's role file over SSH (composeWalgRoleWriteShell) and
 * prove it: the write's own read-back, through the one parser, must name the
 * role. Throws otherwise, so a deploy or scale never starts a stack whose db
 * would read a missing or stale role. The script runs as `sh -c <script>`,
 * one argv token, so the remote shell never word-splits it.
 *
 * @param {object} args
 * @param {string} args.ip
 * @param {string} args.sshKeyPath
 * @param {string} args.projectName
 * @param {'primary'|'standby'} args.role
 * @param {typeof sshRun} [args.run] ssh.js's sshRun (argv), injectable for tests
 * @returns {Promise<void>}
 */
export async function writeComposeWalgRole({ ip, sshKeyPath, projectName, role, run = sshRun }) {
  const script = composeWalgRoleWriteShell(projectName, role);
  let out;
  try {
    out = await run(ip, sshKeyPath, ['sh', '-c', script], { timeout: 30_000 });
  } catch (error) {
    // The message carries the whole command; quote stderr's last line only.
    const stderr = String(error?.stderr ?? '').trim();
    const detail = outputLines(stderr).some((l) => l.startsWith(WALG_ROLE_WRITE_FAILED))
      ? `the write failed in /opt/${projectName}/${COMPOSE_WALG_ROLE_HOST_DIR}`
      : stderr.split('\n').at(-1) || 'the ssh command failed';
    throw new Error(`could not write the wal-g role ${role} on ${ip}: ${detail}`);
  }
  const readBack = parseWalgRoleReadBack(out);
  if (readBack !== role) {
    throw new Error(
      `the wal-g role on ${ip} read back as ${JSON.stringify(readBack ?? '')} after writing ${role}`,
    );
  }
}

/**
 * One SSH command for a compose host: does the RUNNING db container
 * (`<project>-db`) bind WALG_ROLE_DIR? Prints `VC_ROLE_BIND=present` or
 * `VC_ROLE_BIND=absent`, or nothing when the container cannot be inspected.
 * The compose twin of podMountsWalgRoleDir: a container created before the
 * role bind keeps reading the old role env, so a host write never reaches it.
 *
 * @param {string} projectName
 * @returns {string}
 */
export function composeRoleBindProbeShell(projectName) {
  const invalid = validateProjectName(projectName);
  if (invalid) throw new Error(`composeRoleBindProbeShell: ${invalid}`);
  const format = shEscape('{{range .Mounts}}{{println .Destination}}{{end}}');
  return [
    `if m=$(docker inspect --type container -f ${format} ${shEscape(`${projectName}-db`)} 2>/dev/null); then`,
    `    if printf '%s\\n' "$m" | grep -qxF ${shEscape(WALG_ROLE_DIR)}; then echo VC_ROLE_BIND=present; else echo VC_ROLE_BIND=absent; fi`,
    'fi',
  ].join('\n');
}

/**
 * Run composeRoleBindProbeShell over SSH. true or false is what the running
 * container says; null is unknown (no container, ssh failed), which callers
 * leave to their own later checks rather than refuse on.
 *
 * @param {object} args
 * @param {string} args.ip
 * @param {string} args.sshKeyPath
 * @param {string} args.projectName
 * @param {typeof sshRun} [args.run] ssh.js's sshRun (argv), injectable for tests
 * @returns {Promise<boolean | null>}
 */
export async function composeDbMountsWalgRoleDir({ ip, sshKeyPath, projectName, run = sshRun }) {
  const script = composeRoleBindProbeShell(projectName);
  let out;
  try {
    out = await run(ip, sshKeyPath, ['sh', '-c', script], { timeout: 30_000 });
  } catch {
    return null;
  }
  const verdict = /^VC_ROLE_BIND=(present|absent)$/m.exec(String(out ?? ''))?.[1];
  return verdict === undefined ? null : verdict === 'present';
}

/**
 * Go template emitting one `<container-port>-><host-port>` token per PUBLISHED
 * port. Exposed-but-unpublished ports have a null mapping and `range` over nil
 * yields nothing, so only real publishes are compared, which is the property
 * that matters. Single-quoted at the use site so the remote shell does not
 * expand `$p` / `$c` as its own variables.
 */
export const PUBLISHED_PORTS_TEMPLATE =
  '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{$p}}->{{.HostPort}} {{end}}{{end}}';

/**
 * Demote a k8s cluster's db: set the standby wal-g role through setK8sWalgRole
 * (the intent ConfigMap, then the live role file), then drop its inactive
 * replication slots. The one k8s standby role write
 * (tests/unit/deploy/slot-drop-on-demotion-census.test.ts), shared by
 * failover's old-primary demotion, its abort and the retired fence.
 *
 * Nothing restarts. A db pod that is down or unreachable still gets the
 * intent, which db-guard.sh applies on its next container start, so the
 * result says whether the live file landed (`live`, and `reason` when not)
 * and the caller decides what that is worth. Nobody streams from the old
 * primary's slot after a failover, so it would only pin WAL on that node up
 * to the slot cap. A failed drop still demotes and warns once, unless the
 * intent apply fails too, which throws and is the caller's one report.
 *
 * @param {object} args
 * @param {string} args.ip - the cluster's master (kubectl target)
 * @param {(ip: string, argv: string[], opts?: object) => Promise<string>} args.kubectl
 * @param {(msg: string) => void} args.warn
 * @returns {Promise<{slotsDropped: boolean, intent: true, live: boolean, reason?: string, error?: Error}>}
 */
export async function demoteK8sWalgRole({ ip, kubectl, warn }) {
  // DEMOTION_ORDER (both tiers; demoteComposeWalgRole matches): the role
  // first, then the slots. The role is the write-guard: until it reads
  // standby, this node may still push WAL into the prefix the new primary
  // owns, so it goes first and nothing waits in front of it. The slot drop
  // only frees this node's own disk (a slot pins WAL up to the slot cap), so
  // it can come second; a role write that throws skips it, and the reseed
  // that rebuilds the node as the standby wipes its slots anyway.
  // A throw here skips the drop: the caller's one report says the slots
  // remain (slotDropSkippedNote, as failover's demotion warning does).
  const role = await setK8sWalgRole({ ip, kubectl, role: 'standby' });
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
  if (!slots.ok) warn(slotDropWarning(ip, slots.error));
  return { slotsDropped: slots.ok, ...role };
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
 *   reconcile scales back to 0, when the promoted node's wal-g role file does
 *   not read primary (standby-scale.sh reads the same file)
 * @returns {string}
 */
export function walgRoleDegradedMessage({ path, envName, promotedIp, detail, heldAtZero = [] }) {
  const verify =
    path === 'compose'
      ? `ssh root@${promotedIp} 'cat /opt/<project>/${COMPOSE_WALG_ROLE_HOST_DIR}/walg-role'`
      : `ssh root@${promotedIp} 'kubectl -n vibecarbon exec ${DB_POD} -c ${DB_CONTAINER} -- cat ${WALG_ROLE_FILE}'`;
  return (
    `FAILOVER COMPLETED, BACKUPS DID NOT. The promoted node (${promotedIp}) is serving, DNS ` +
    `is flipped and the role swap is persisted; but this failover could not prove that ` +
    `wal-g is archiving from it. ${detail} Until this is fixed the new primary holds the ` +
    `ONLY live copy of your data and is accumulating no recoverable backups. Check the ` +
    `write-guard with \`${verify}\` (it must print \`primary\`), then re-run ` +
    `\`vibecarbon deploy ${envName}\`; a deploy writes the wal-g role from the now-swapped ` +
    `config and re-runs the same backup audit. There is also no base backup on the new ` +
    `timeline (a node reading standby skips the push): once the write-guard reads primary, ` +
    `run \`vibecarbon backup ${envName}\`.` +
    (heldAtZero.length > 0
      ? ` Until the new primary's wal-g role file reads primary, its next reconcile scales ` +
        `${heldAtZero.join(', ')} back to 0; that deploy writes it.`
      : '')
  );
}
