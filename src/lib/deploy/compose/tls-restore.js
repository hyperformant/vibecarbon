/**
 * Compose TLS certificate reuse: put the last issued certificate back into
 * Traefik's acme.json before Traefik starts, and save a fresh snapshot once
 * the domain serves a trusted one. Shared by the compose and compose-ha
 * deploy plans (restore-tls / snapshot-tls) and by compose-ha failover and
 * compose scale.
 *
 * The overwrite rule. A restore writes acme.json only when the server's own
 * file, inside the letsencrypt volume, holds no certificate whose "main" is
 * the apex domain (the file is missing, empty, or for other names). Whenever
 * an apex certificate is there, valid or not, it is left exactly as it is:
 * Traefik renews the certificates already in acme.json by itself, and
 * judging the live one here would mean reading its private key off the
 * server. The write script checks again inside the volume just before it
 * replaces the file, so a certificate Traefik issued meanwhile is kept too.
 *
 * Key handling. The snapshot is validated in full before anything is written
 * (inspectComposeAcme, for every certificate of the apex's resolver: key
 * matches certificate, the leaf's names cover the entry, issuing CA, at
 * least 7 days left, not self-signed, and for the prod CA a chain to a root
 * of the platform store; a bad apex entry refuses the file, a bad other entry is left out of what is written). It reaches the server on ssh stdin,
 * never on argv, and goes straight into the traefik service container, which
 * writes it with mode 600 as Traefik's own user. There is no temp file on the
 * operator or on the host; the only copy outside acme.json is a sibling in
 * the volume itself, created under umask 077 and removed on exit. A failed
 * command is reported by its exit status and a fixed phrase, never by its
 * output. Nothing here logs: callers print the one info line (tlsRestoreLine).
 */
import { sshRun } from '../../ssh.js';
import { RECONCILE_FLAGS_SED } from '../bundle.js';
import {
  DR_S3_CLIENT_OPTIONS,
  inspectComposeAcme,
  readTlsSnapshot,
  tlsSnapshotKey,
} from '../tls-snapshot.js';

/** The reason a restore leaves a live apex certificate alone. */
export const LIVE_CERTIFICATE_PRESENT = 'live certificate present';

/** The reason a restore gave up on a piece that outlived its bound. */
export const RESTORE_TIMED_OUT = 'restore timed out';

/**
 * The failover bounds, per piece (never a race around the whole call: an
 * abandoned write could land after the caller recreated Traefik). The
 * promoted standby already runs Traefik, so its image is local and the check
 * is quick; the S3 read makes one attempt.
 */
export const FAILOVER_TLS_BOUNDS = {
  checkTimeoutMs: 30_000,
  writeTimeoutMs: 60_000,
  s3ClientOptions: DR_S3_CLIENT_OPTIONS,
};

const SAFE_NAME_RE = /^[A-Za-z0-9.-]+$/;
const SAFE_PROJECT_RE = /^[A-Za-z0-9._-]+$/;

const CHECK_TIMEOUT_MS = 300_000; // a fresh server pulls the traefik image here
const WRITE_TIMEOUT_MS = 120_000;
const SNAPSHOT_TIMEOUT_MS = 180_000; // tls-snapshot.sh bounds its own upload at 120s

/** Exit status of a server with no project dir or no `-f` set in reconcile.sh. */
const NO_COMPOSE_FLAGS_EXIT = 20;

/** The ERE matching an acme.json certificate entry for the apex domain. */
function apexPattern(domain) {
  return `"main": ?"${domain.replace(/\./g, '\\.')}"`;
}

/**
 * Shell prelude: the project dir and reconcile.sh's own `-f` set, so `run`
 * renders the stack the way reconcile does. letsencrypt_data is declared in
 * docker-compose.prod.yml; with a guessed set the volume would differ. An
 * empty set refuses (NO_COMPOSE_FLAGS_EXIT) instead of guessing.
 */
function composePrelude(projectName) {
  return (
    `cd /opt/${projectName} || exit ${NO_COMPOSE_FLAGS_EXIT}\n` +
    `FLAGS=$(sed -n '${RECONCILE_FLAGS_SED}' reconcile.sh | tail -1)\n` +
    `[ -n "$FLAGS" ] || exit ${NO_COMPOSE_FLAGS_EXIT}\n`
  );
}

/** Prints `present` or `absent`: does the volume's acme.json hold the apex? */
function liveCheckScript(projectName, domain) {
  return (
    'set -uo pipefail\n' +
    composePrelude(projectName) +
    'docker compose $FLAGS run --rm --no-deps -T --entrypoint sh traefik -c ' +
    `'if grep -Eq "$1" /letsencrypt/acme.json 2>/dev/null; then echo present; else echo absent; fi' ` +
    `sh '${apexPattern(domain)}' </dev/null\n`
  );
}

/**
 * Reads the snapshot on stdin into the volume. Exit 3: an apex certificate
 * appeared since the check (kept). Exit 4: fewer bytes arrived than sent.
 * Exit 5: written, but the running Traefik did not restart. With `restart`
 * false the running Traefik is left alone: the caller recreates it.
 */
function writeScript(projectName, domain, bytes, restart) {
  const inner =
    'umask 077; f=/letsencrypt/acme.json; t=/letsencrypt/.acme.json.restore; ' +
    'trap "rm -f $t" EXIT; ' +
    'if grep -Eq "$1" "$f" 2>/dev/null; then exit 3; fi; ' +
    'cat > "$t"; ' +
    '[ "$(wc -c < "$t")" -eq "$2" ] || exit 4; ' +
    'chmod 600 "$t"; mv -f "$t" "$f"';
  return (
    'set -euo pipefail\n' +
    'umask 077\n' +
    composePrelude(projectName) +
    `docker compose $FLAGS run --rm --no-deps -T --entrypoint sh traefik -c '${inner}' ` +
    `sh '${apexPattern(domain)}' ${bytes}\n` +
    // A running Traefik read acme.json at start; restart it to load the file.
    // A stopped one loads it when start-compose-stack brings it up.
    (restart
      ? 'if [ -n "$(docker compose $FLAGS ps -q traefik 2>/dev/null)" ]; then\n' +
        '  docker compose $FLAGS restart traefik >/dev/null 2>&1 || exit 5\n' +
        'fi\n'
      : '')
  );
}

/**
 * Ask the server whether the acme.json in its letsencrypt volume holds a
 * certificate whose "main" is the apex domain. `unknown` carries the reason
 * the check could not answer. Never throws, never logs.
 *
 * @param {{ ip: string|null, sshKeyPath: string, projectName: string,
 *   domain: string|null, timeoutMs?: number, deps?: { ssh?: Function } }} args
 * @returns {Promise<{ state: 'present'|'absent'|'unknown', reason?: string, timedOut?: boolean }>}
 */
export async function readLiveApexCertificate({
  ip,
  sshKeyPath,
  projectName,
  domain,
  timeoutMs = CHECK_TIMEOUT_MS,
  deps = {},
}) {
  const ssh = deps.ssh ?? sshRun;
  const unknown = (reason) => ({ state: 'unknown', reason });
  if (!domain || !SAFE_NAME_RE.test(domain)) return unknown('no valid domain');
  if (!ip) return unknown('no server address');
  if (!SAFE_PROJECT_RE.test(String(projectName ?? ''))) return unknown('no valid project name');
  let live;
  try {
    const out = await ssh(ip, sshKeyPath, ['bash', '-c', liveCheckScript(projectName, domain)], {
      timeout: timeoutMs,
    });
    live = String(out ?? '')
      .trim()
      .split('\n')
      .pop();
  } catch (err) {
    if (err?.timedOut) return { state: 'unknown', reason: 'live check timed out', timedOut: true };
    return unknown(
      err?.status === NO_COMPOSE_FLAGS_EXIT
        ? 'reconcile.sh on the server has no compose files'
        : 'could not check the live certificate',
    );
  }
  if (live === 'present' || live === 'absent') return { state: live };
  return unknown('could not check the live certificate');
}

/**
 * Restore the last compose-acme snapshot into the server's acme.json when the
 * server has no apex certificate. Never throws, never logs.
 *
 * The snapshot is read and validated first, and the server is touched only
 * when one is worth restoring: with none (a first deploy) no ssh happens, so
 * a cold server does not pull Traefik just to learn it has no certificate.
 * The live check still runs before any write.
 *
 * Each piece has its own bound (`checkTimeoutMs`, `writeTimeoutMs`,
 * `s3ClientOptions` for the read); one that outlives it returns
 * RESTORE_TIMED_OUT. `restart: false` leaves a running Traefik alone.
 *
 * @param {{ ip: string|null, sshKeyPath: string, projectName: string,
 *   domain: string|null, envName: string, ca: 'prod'|'staging'|null,
 *   s3Config: object|null, checkTimeoutMs?: number, writeTimeoutMs?: number,
 *   s3ClientOptions?: object, restart?: boolean,
 *   deps?: { read?: Function, ssh?: Function, trustRoots?: readonly string[] } }} args
 * @returns {Promise<{ restored: boolean, reason: string, dropped?: number }>}
 */
export async function restoreComposeTls({
  ip,
  sshKeyPath,
  projectName,
  domain,
  envName,
  ca,
  s3Config,
  checkTimeoutMs = CHECK_TIMEOUT_MS,
  writeTimeoutMs = WRITE_TIMEOUT_MS,
  s3ClientOptions,
  restart = true,
  deps = {},
}) {
  const read = deps.read ?? readTlsSnapshot;
  const ssh = deps.ssh ?? sshRun;
  const skip = (reason) => ({ restored: false, reason });
  if (!s3Config?.bucket) return skip('no backup bucket');
  if (!s3Config.accessKey || !s3Config.secretKey) return skip('no backup credentials');
  if (!ca) return skip('no recorded CA');
  if (!domain || !SAFE_NAME_RE.test(domain)) return skip('no valid domain');
  if (!ip) return skip('no server address');
  if (!SAFE_PROJECT_RE.test(String(projectName ?? ''))) return skip('no valid project name');
  try {
    const key = tlsSnapshotKey({ projectName, envName, ca, format: 'compose-acme' });
    const { text, reason, timedOut } = s3ClientOptions
      ? await read(s3Config, key, { clientOptions: s3ClientOptions })
      : await read(s3Config, key);
    if (timedOut) return skip(RESTORE_TIMED_OUT);
    if (!text) return skip(reason ?? 'no snapshot');
    const verdict = inspectComposeAcme(text, {
      domain,
      ca,
      ...(deps.trustRoots ? { trustRoots: deps.trustRoots } : {}),
    });
    if (!verdict.ok) return skip(`snapshot refused: ${verdict.reason}`);
    // Stale non-apex entries are left out of what is written.
    const body = verdict.text;
    const droppedField = verdict.dropped ? { dropped: verdict.dropped } : {};

    // Only now, with a snapshot worth restoring in hand, touch the server: a
    // brand-new server has nothing to restore, and the check would pull Traefik.
    const live = await readLiveApexCertificate({
      ip,
      sshKeyPath,
      projectName,
      domain,
      timeoutMs: checkTimeoutMs,
      deps,
    });
    if (live.state === 'present') return skip(LIVE_CERTIFICATE_PRESENT);
    if (live.timedOut) return skip(RESTORE_TIMED_OUT);
    if (live.state !== 'absent') return skip(live.reason);

    try {
      await ssh(
        ip,
        sshKeyPath,
        ['bash', '-c', writeScript(projectName, domain, Buffer.byteLength(body), restart)],
        // No transport retry: a write whose connection dropped after it ran
        // would rerun and meet its own file (exit 3, misreported as a
        // certificate that appeared on the server).
        { timeout: writeTimeoutMs, input: body, transportRetry: false },
      );
    } catch (err) {
      if (err?.timedOut) return skip(RESTORE_TIMED_OUT);
      if (err?.status === 3) return skip('a certificate appeared on the server, kept');
      if (err?.status === 4) return skip('the snapshot arrived incomplete, nothing written');
      if (err?.status === 5)
        return { restored: true, reason: 'restored, traefik did not restart', ...droppedField };
      return skip(`could not write acme.json (exit ${err?.status ?? 'unknown'})`);
    }
    return { restored: true, reason: 'restored from the last snapshot', ...droppedField };
  } catch {
    return skip('restore errored');
  }
}

/**
 * Save a snapshot of the server's acme.json now (backup/tls-snapshot.sh,
 * which skips with exit 0 whenever the file is not worth keeping). Throws a
 * fixed message on failure, never the script's output.
 *
 * @param {{ ip: string, sshKeyPath: string, projectName: string, deps?: { ssh?: Function } }} args
 * @returns {Promise<void>}
 */
export async function snapshotComposeTlsNow({ ip, sshKeyPath, projectName, deps = {} }) {
  const ssh = deps.ssh ?? sshRun;
  if (!ip) throw new Error('no server address');
  if (!SAFE_PROJECT_RE.test(String(projectName ?? ''))) throw new Error('no valid project name');
  try {
    await ssh(
      ip,
      sshKeyPath,
      ['bash', '-c', `cd /opt/${projectName} && bash backup/tls-snapshot.sh`],
      {
        timeout: SNAPSHOT_TIMEOUT_MS,
      },
    );
  } catch (err) {
    throw new Error(`tls-snapshot.sh exited ${err?.status ?? 'abnormally'}`);
  }
}

/**
 * The one info line a caller prints for a restore result. A reason is one of
 * restoreComposeTls's fixed phrases, never command output.
 *
 * @param {{ restored: boolean, reason: string, dropped?: number }} result
 * @param {string|null} domain
 * @returns {string}
 */
export function tlsRestoreLine(result, domain) {
  if (result.reason === LIVE_CERTIFICATE_PRESENT) {
    return 'TLS certificate already on the server; nothing to restore.';
  }
  if (!result.restored) return `TLS certificate not restored (${result.reason}).`;
  const restartNote = /did not restart/.test(result.reason)
    ? ' Traefik did not restart, so it loads it on its next start.'
    : '';
  const droppedNote = result.dropped
    ? ` Left out ${result.dropped} stale certificate ${result.dropped === 1 ? 'entry' : 'entries'} that no longer passed the checks.`
    : '';
  return `TLS certificate for ${domain} restored from its last snapshot.${droppedNote}${restartNote}`;
}

/**
 * The restore a compose-ha failover runs on the promoted node, inside
 * armComposeAcme (before its traefik recreate, so the write never restarts
 * Traefik itself). The CA is the one the last deploy recorded
 * (envConfig.tls.ca), never a guess: with none, nothing is read and Traefik
 * issues a new certificate. The backup credentials come from the record and
 * the environment only; a failover never prompts. Each piece is bounded
 * (FAILOVER_TLS_BOUNDS). Never throws and never logs: the result carries
 * the one info line for the caller to print once its spinner stops.
 *
 * @param {{ envName: string, envConfig: object, projectName: string,
 *   ip: string, sshKeyPath: string,
 *   deps?: { resolveS3?: Function, restore?: Function } }} args
 * @returns {Promise<{ restored: boolean, reason: string, line: string }>}
 */
export async function restoreFailoverTls({
  envName,
  envConfig,
  projectName,
  ip,
  sshKeyPath,
  deps = {},
}) {
  const restore = deps.restore ?? restoreComposeTls;
  const domain = envConfig?.domain ?? null;
  let result;
  try {
    const ca = envConfig?.tls?.ca ?? null;
    if (!ca) {
      result = { restored: false, reason: 'no recorded CA' };
    } else {
      const resolveS3 =
        deps.resolveS3 ?? (await import('../../walg/restore-base.js')).resolveS3Config;
      const s3Config = await resolveS3({
        isCompose: true,
        envName,
        projectName,
        envConfig,
        skipPrompts: true,
      });
      result = await restore({
        ip,
        sshKeyPath,
        projectName,
        domain,
        envName,
        ca,
        s3Config,
        restart: false,
        ...FAILOVER_TLS_BOUNDS,
      });
    }
  } catch {
    result = { restored: false, reason: 'restore errored' };
  }
  return { ...result, line: tlsRestoreLine(result, domain) };
}
