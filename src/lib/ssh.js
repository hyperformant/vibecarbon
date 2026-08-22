/**
 * Shared SSH/SCP/kubectl helpers.
 *
 * All helpers use argv (spawn) form via runCommand — no local shell
 * interpolation. The remote shell still parses whatever reaches it, so
 * callers that build commands from dynamic data should either:
 *   1. Use sshRun with an argv array (preferred — no remote shell parsing
 *      of dynamic tokens), or
 *   2. Use sshRunScript to execute a bash script SCP'd as a file.
 *
 * Host-key checking: EVERY call pins against a per-environment known_hosts
 * file — there is no /dev/null + StrictHostKeyChecking=no bypass. When a
 * caller passes an explicit `env`, first-provision callers pass
 * { firstConnect: true } to accept-new (TOFU) once and strict-check ('yes')
 * thereafter. Callers that only have `(ip, sshKeyPath)` get the per-env
 * known_hosts derived from the key path (knownHostsPathForKey) with
 * StrictHostKeyChecking=accept-new — which still REJECTS a changed key for an
 * already-pinned host (MITM on an established env fails) while TOFU-ing a fresh
 * or recycled IP. The operator's ~/.ssh/known_hosts is never touched.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { progressLog } from './cli/progress.js';
import { runCommandAsync } from './command.js';
import { buildHostKeyOpts, knownHostsPath, SSH_CONNECTION_OPTS } from './host-keys.js';
import { runWithRetry } from './retry.js';
import { shEscape } from './shell.js';

// k3s writes its kubeconfig here; kubectl doesn't find it by default in SSH sessions.
const K3S_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';

/**
 * Resolve the SSH key path for an environment.
 * HA deployments store a shared SSH key under the base env name
 * (e.g., deploy_key_prod). Internal cluster names use -primary / -standby
 * suffixes for filesystem resources.
 *
 * K8s single-cluster deploys use a different filename convention
 * (`ssh-<env>` — see deployK3s in src/lib/deploy/k8s/k3s.js). We probe
 * that path too so backup/restore/scale/failover work for k8s
 * single-cluster without changing the deploy-side filename. (Compose,
 * compose-HA, and k8s-HA all use `deploy_key_<env>`.)
 */
export function getSSHKeyPath(environment) {
  const baseEnv = environment.replace(/-(primary|standby)$/, '');
  const candidates = [
    join(process.cwd(), '.vibecarbon', `deploy_key_${baseEnv}`),
    join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`),
    join(process.cwd(), '.vibecarbon', `ssh-${baseEnv}`),
    join(process.cwd(), '.vibecarbon', `ssh-${environment}`),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  // Nothing exists — fall back to the literal env-name path so caller
  // error messages name what they asked for. Matches pre-fallback
  // semantics for HA-suffixed environments.
  return join(process.cwd(), '.vibecarbon', `deploy_key_${environment}`);
}

/**
 * Build the SSH `-o` option args for host-key checking. Always pins against a
 * per-environment known_hosts file under .vibecarbon/ — never /dev/null.
 * GlobalKnownHostsFile=/dev/null ignores the system-wide file; the operator's
 * ~/.ssh/known_hosts is never read or polluted (Hetzner recycles public IPs,
 * and a stale entry there would reject an unrelated reconnect).
 *
 * - With explicit `env`: pin to .vibecarbon/known_hosts_<env>,
 *   StrictHostKeyChecking=yes (or accept-new when firstConnect=true, used
 *   during first provision).
 *
 * - With only `sshKeyPath` (backup/restore/scale/failover only receive the key
 *   path, not an env): derive .vibecarbon/known_hosts_<env> from the key path
 *   (knownHostsPathForKey) and use StrictHostKeyChecking=accept-new. accept-new
 *   bootstraps an empty pin and TOFU's a fresh/recycled IP, but REJECTS a
 *   changed key for an already-pinned host — so a MITM against an established
 *   env fails, while destroy→redeploy (same IP, new key, re-seeded on
 *   provision) does not spuriously hard-fail.
 */
function sshHostKeyOpts(env, { firstConnect = false, sshKeyPath } = {}) {
  if (!env) {
    if (!sshKeyPath) {
      throw new Error('sshHostKeyOpts requires either `env` or `sshKeyPath` for host-key pinning');
    }
    return buildHostKeyOpts(sshKeyPath);
  }
  // BatchMode / ConnectTimeout / ServerAlive rationale lives with
  // SSH_CONNECTION_OPTS in host-keys.js (banner-exchange-hang RCA).
  return [
    '-o',
    `UserKnownHostsFile=${knownHostsPath(env)}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    `StrictHostKeyChecking=${firstConnect ? 'accept-new' : 'yes'}`,
    ...SSH_CONNECTION_OPTS,
  ];
}

/**
 * Pre-exec SSH transport failures: connection/protocol errors OpenSSH itself
 * detects before it can exec anything on the far end, so the remote command
 * PROVABLY never started. OpenSSH reserves exit code 255 for its own
 * failures — never the remote command's exit status (`man ssh`, EXIT
 * STATUS) — so requiring BOTH the 255 sentinel AND one of these
 * wire-protocol strings rules out a remote command that ran, printed
 * something coincidentally similar (e.g. `psql: ... Connection refused`),
 * and exited non-zero on its own; that case must never be retried here
 * since a command that actually executed has unknown idempotency.
 *
 * Live evidence (d2 run 2, [step:configure-replication]): a CPU-starved
 * sshd on a 2-vCPU droplet (concurrent compose reconcile) missed the SSH
 * banner deadline — `Connection timed out during banner exchange` — while
 * the droplet itself was healthy and reachable again 60s later.
 */
export const SSH_TRANSPORT_NEVER_STARTED_RE =
  /timed out during banner exchange|Connection timed out|Connection refused|kex_exchange_identification|Connection reset by peer/i;

export function isNeverStartedSshTransportFailure(err) {
  if (err?.status !== 255) return false;
  return SSH_TRANSPORT_NEVER_STARTED_RE.test(`${err.stderr || ''}\n${err.message || ''}`);
}

/**
 * Is a failed SSH-run command's output an in-container DNS-not-settled
 * failure on a freshly-provisioned server, as opposed to an SSH transport
 * drop or a wrapper timeout? Split out from isTransientSshCommandError
 * (below) as its own predicate because sshRunAsync's retry ladder needs to
 * know WHICH sub-class it is worth widening for (see
 * DNS_NOT_SETTLED_RETRY_DELAYS_MS in deploy/remote-build.js).
 *
 * sshRunAsync runs arbitrary remote commands (dockerLoginOnServer,
 * reconcile.sh's `docker compose pull`, ...) whose own stderr lands in
 * `err.message` on a non-zero exit — the same DNS/temporary-failure
 * wordings isDnsNotSettledBuildError classifies for remote-build.js's
 * docker build (apk's `DNS: transient error`, apt's `Temporary failure
 * resolving`, glibc/musl's `Temporary failure in name resolution`, Node's
 * `getaddrinfo EAI_AGAIN`) reach here too. reconcile.sh in particular is an
 * idempotent, re-runnable-by-design reconciler (see renderReconcileScript
 * in bundle.js), so retrying the whole invocation on a DNS blip is safe.
 *
 * Lives here rather than in deploy/compose/index.js (its home until
 * 2026-08-11) so the scp ladder below can share the classification without
 * lib/ssh.js importing the compose module, which already imports this file —
 * that would be a cycle. compose/index.js re-exports both predicates, so its
 * existing importers are unaffected.
 *
 * @param {Error} err
 * @returns {boolean}
 */
export function isDnsNotSettledSshCommandError(err) {
  const msg = err?.message || '';
  return /dns: transient error|temporary failure resolving|temporary failure in name resolution|eai_again/i.test(
    msg,
  );
}

/**
 * Is a failed SSH-run command (transport OR remote command output) worth
 * retrying? Covers three classes:
 *
 * 1. SSH connection-level drops (common on freshly provisioned servers where
 *    cloud-init may restart sshd): connection reset/refused/closed, a failed
 *    key exchange, no route to host.
 *
 * 2. Wrapper/SSH timeouts. `err.timedOut === true` is THE wrapper-timeout
 *    signal: runCommandAsync builds its message as `Command failed: <argv>\n
 *    <stderr>` and SIGTERMs the child, which prints nothing — the old execa
 *    wordings ('Command was killed with SIGTERM', bare 'timed out') never
 *    appear in it, so this branch was DEAD from the async-exec migration
 *    until 2026-08-07 (the iter-validate4 dockerLogin double-timeout case it
 *    was written for would still not have retried). The message match stays
 *    for timeout text that arrives via ssh itself — OpenSSH's keepalive death
 *    is capital-T `Timeout, server … not responding`, hence case-insensitive.
 *    A freshly-provisioned Hetzner VPS can have unattended-upgrades chewing
 *    CPU/disk in the background after cloud-init's marker file lands — SSH
 *    responds, but each command takes longer.
 *
 * 3. In-container DNS-not-settled on a freshly-provisioned server — see
 *    isDnsNotSettledSshCommandError above for the wordings and rationale.
 *
 * The retry budget (attempts × delay) is small by default so real hangs
 * still surface fast — see sshRunAsync for how the ladder is sized and
 * widened for class 3, and scpWithRetry for why the scp ladder stays
 * transport-only. The DR path's `retries: 1` opt-out (compose/ha.js's
 * restoreComposeWalgRole / demoteComposeWalgRole) caps ATTEMPTS, not
 * classification.
 *
 * Contrast with isNeverStartedSshTransportFailure above, which additionally
 * demands OpenSSH's 255 exit sentinel before it will retry. That gate exists
 * because sshRun carries an ARBITRARY remote command: if the command really
 * executed and coincidentally printed connection wording of its own (`psql:
 * ... Connection refused`), re-running it could repeat a non-idempotent side
 * effect. This classifier deliberately drops the sentinel because its
 * consumers don't have that hazard — sshRunAsync's compose commands are
 * internally generated and re-runnable, and an scp is a whole-file copy.
 *
 * @param {Error & {timedOut?: boolean}} err
 * @returns {boolean}
 */
export function isTransientSshCommandError(err) {
  const msg = err?.message || '';
  const isConnectionError =
    msg.includes('Connection reset') ||
    msg.includes('Connection refused') ||
    msg.includes('Connection closed') ||
    msg.includes('kex_exchange_identification') ||
    msg.includes('ssh_exchange_identification') ||
    msg.includes('No route to host');
  const isTimeout =
    err?.timedOut === true || /timed out|timeout/i.test(msg) || msg.includes('ETIMEDOUT');
  return isConnectionError || isTimeout || isDnsNotSettledSshCommandError(err);
}

// 3 attempts total (delaysMs.length + 1): initial try + 5s backoff + 15s backoff.
const TRANSPORT_RETRY_DELAYS_MS = [5000, 15000];
const TRANSPORT_RETRY_TOTAL_ATTEMPTS = TRANSPORT_RETRY_DELAYS_MS.length + 1;

function logTransportRetry(err, attempt) {
  const delaySec = TRANSPORT_RETRY_DELAYS_MS[attempt - 1] / 1000;
  const firstLine = `${err.stderr || err.message || ''}`.trim().split('\n')[0];
  progressLog(
    `[ssh] transport failure (attempt ${attempt}/${TRANSPORT_RETRY_TOTAL_ATTEMPTS}), retrying in ${delaySec}s: ${firstLine}`,
  );
}

/**
 * Run `fn` with the standard never-started-transport retry policy: retry only
 * failures OpenSSH provably reported before the remote command could start
 * (isNeverStartedSshTransportFailure), on the shared 5s/15s ladder, with the
 * shared `[ssh]` retry log line.
 *
 * Exported so ssh-bearing call sites OUTSIDE this module's runners (the
 * compose bundle upload's `cat | ssh` pipeline — run 31961619204's compose-ha
 * kex reset) reuse the exact policy sshRun applies, instead of growing their
 * own drifting copies.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runWithTransportRetry(fn) {
  return runWithRetry(fn, {
    delaysMs: TRANSPORT_RETRY_DELAYS_MS,
    isTransient: isNeverStartedSshTransportFailure,
    onRetry: logTransportRetry,
  });
}

/**
 * Execute a command on a remote server via SSH using argv form.
 *
 * NOTE: a second, unrelated `sshRun(ip, key, command: string)` exists in
 * lib/deploy/compose/index.js for the compose deploy path — it takes a raw
 * command STRING (internally generated, no per-token escaping) and returns
 * `false` on remote failure instead of throwing. Same name, different
 * contract; check which one you're importing.
 *
 * OpenSSH joins every post-hostname argv element with a single space before
 * sending one command string to the remote shell — it does NOT re-quote. If
 * we spread argv directly into ssh's invocation, any token containing a space,
 * a pipe, parentheses, or another shell metacharacter would be word-split by
 * the remote shell and parsed as separate tokens. For `sh -c 'gunzip | psql'`
 * that means remote sh gets `-c gunzip` (script = "gunzip") and the pipe runs
 * in the outer shell — silently wrong.
 *
 * We POSIX-quote each argv element and join them into a single command string
 * here. The remote shell word-splits that string once, sees the quotes, and
 * reconstructs exactly the argv we intended. The local side still uses
 * spawn/argv (no local shell), so nothing on our end interprets the contents.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string[]} argv - remote command + args (e.g. ['docker', 'ps'])
 * @param {object} [options]
 * @param {string} [options.env] - project env for host-key pinning
 * @param {boolean} [options.firstConnect=false]
 * @param {number} [options.timeout=120000]
 * @param {boolean} [options.silent=true]
 * @param {string} [options.input] - stdin piped to the remote command
 * @returns {Promise<string>} - trimmed stdout
 *
 * Transport retry: a never-started connection/protocol failure (see
 * isNeverStartedSshTransportFailure) is retried up to 3 attempts total
 * (5s then 15s backoff) — internal to this function, on by default, no
 * caller opt-in needed. A command that reached the remote and exited
 * non-zero is NEVER retried here (idempotency unknown to this layer).
 */
export async function sshRun(ip, sshKeyPath, argv, options = {}) {
  const { env, firstConnect = false, timeout = 120_000, silent = true, input } = options;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('sshRun requires a non-empty argv array');
  }
  const remoteCmd = argv.map(shEscape).join(' ');
  const cmd = [
    'ssh',
    '-i',
    sshKeyPath,
    ...sshHostKeyOpts(env, { firstConnect, sshKeyPath }),
    '--',
    `root@${ip}`,
    remoteCmd,
  ];
  const out = await runWithTransportRetry(() =>
    runCommandAsync(cmd, { silent, timeout, returnOutput: true, input }),
  );
  return typeof out === 'string' ? out.trim() : '';
}

/**
 * Run a multi-line bash script on a remote server.
 * The script is SCP'd to /tmp/vb-script-<uuid>.sh (mode 0700), executed
 * via bash, then removed. Use for pipelines that genuinely need shell
 * features; never interpolate untrusted values into the script string.
 */
export async function sshRunScript(ip, sshKeyPath, bashScript, options = {}) {
  const localTmp = mkdtempSync(join(tmpdir(), 'vb-sshscript-'));
  const localPath = join(localTmp, 'script.sh');
  const remotePath = `/tmp/vb-script-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.sh`;
  try {
    writeFileSync(localPath, bashScript, { mode: 0o700 });
    await scpUpload(ip, sshKeyPath, localPath, remotePath, options);
    return await sshRun(ip, sshKeyPath, ['bash', remotePath], options);
  } finally {
    try {
      await sshRun(ip, sshKeyPath, ['rm', '-f', remotePath], {
        ...options,
        silent: true,
        timeout: 15_000,
      });
    } catch {
      // best-effort cleanup
    }
    rmSync(localTmp, { recursive: true, force: true });
  }
}

/** One rung of the scp transport ladder. Mirrors sshRunAsync's flat 5s. */
const SCP_RETRY_DELAY_MS = 5000;

/**
 * Run `scp` with the shared transient-transport retry ladder. THE single
 * place in src/ that spawns scp — every copy in the deploy path routes here,
 * pinned by tests/unit/lib/scp-call-site-census.test.ts.
 *
 * Why this exists: scp call sites used to hand a bare scp argv to
 * runCommandAsync while the `ssh` calls interleaved between them retried
 * transport blips via sshRunAsync. On 2026-08-11 a compose-ha warm deploy died
 * at merge-walg-role on a single `Connection timed out during banner exchange` —
 * SSH to the same host worked seconds before and after, so one retry would
 * have saved the run.
 *
 * Ladder: 3 attempts, 5s apart, matching sshRunAsync's TRANSPORT ladder.
 * Callers may narrow it with `retries` (retries:1 = deliberate single-attempt
 * fast-fail, used by DR paths where backoff is RTO).
 *
 * Transport-only on purpose — this ladder is NOT widened to
 * DNS_NOT_SETTLED_RETRY_DELAYS_MS the way sshRunAsync's is. The shared
 * classifier does carry a DNS-not-settled branch, but that branch exists for
 * sshRunAsync, which runs arbitrary REMOTE commands whose in-container stderr
 * (apk/apt/glibc resolver wordings) lands in err.message. An scp runs no
 * remote command: its far end is sftp-server, so container-resolver wordings
 * can never reach it and there is no ~30s fresh-server network-settle window
 * to wait out here. The one DNS wording scp could produce is a LOCAL failure
 * resolving the target hostname — and every call site in this repo passes an
 * IP for a server we provisioned and already reached earlier in the same
 * deploy, so that is a dead branch in practice; if it ever fired, absorbing it
 * on the 5s transport ladder is the right response anyway. Widening here would
 * only add 45s to a genuinely dead host.
 *
 * Retrying is safe because scp is a whole-file copy: a second attempt re-sends
 * the entire file over whatever a partial transfer left behind.
 *
 * @param {string[]} args - scp argv AFTER the executable (options, src, dest).
 *   Callers must include host-key/BatchMode opts (buildHostKeyOpts and
 *   friends); scripts/check-shell-safety.js enforces that at each call site.
 * @param {object} [options] - runCommandAsync options, plus:
 * @param {number} [options.retries=3] - TOTAL attempts, not extra attempts.
 * @param {boolean} [options.ignoreError] - swallow the failure AFTER the
 *   ladder is exhausted (see below).
 * @param {string} [options.what] - label for the retry log; defaults to the
 *   destination argument.
 * @returns {Promise<string|boolean|null>} runCommandAsync's result, or null
 *   when ignoreError swallowed an exhausted ladder.
 */
export async function scpWithRetry(args, options = {}) {
  const { retries = 3, ignoreError, what, ...rest } = options;
  const delaysMs = Array.from({ length: Math.max(0, retries - 1) }, () => SCP_RETRY_DELAY_MS);
  const totalAttempts = delaysMs.length + 1;
  const label = what || args[args.length - 1] || 'remote';

  try {
    return await runWithRetry(
      // `silent: true` is load-bearing, not cosmetic, and is forced LAST so a
      // caller cannot unset it: runCommandAsync only REJECTS on failure while
      // silent is set — otherwise it resolves(false), which runWithRetry can
      // never see. Same reason `ignoreError` is stripped from the inner call
      // (it would resolve(null) on the first blip and the ladder would never
      // engage); it is applied by hand below once the ladder is spent.
      //
      // shell-safety-ignore: -o options come from CALLERS; BatchMode is enforced per call site by Pattern 5b in check-shell-safety.js
      () => runCommandAsync(['scp', ...args], { ...rest, silent: true }),
      {
        delaysMs,
        isTransient: isTransientSshCommandError,
        onRetry: (err, attempt) => {
          // stderr first, like logTransportRetry: runCommandAsync's message
          // opens with `Command failed: <argv>`, so the diagnosis ('Connection
          // timed out during banner exchange') is on the NEXT line.
          const firstLine = `${err.stderr || err.message || ''}`
            .trim()
            .split('\n')[0]
            .slice(0, 100);
          // progressLog, not console.error: these fire mid-deploy while a
          // clack spinner owns the line (see sshRunAsync's identical note).
          progressLog(
            `[retry] scp ${label}: attempt ${attempt}/${totalAttempts} failed (${firstLine}); retrying in ${SCP_RETRY_DELAY_MS / 1000}s`,
          );
        },
      },
    );
  } catch (err) {
    if (ignoreError) return null;
    throw err;
  }
}

/**
 * Download a file from a remote server via SCP. Argv form.
 */
export async function scpDownload(ip, sshKeyPath, remotePath, localPath, options = {}) {
  const { env, firstConnect = false, timeout = 300_000, retries } = options;
  await scpWithRetry(
    [
      '-i',
      sshKeyPath,
      ...sshHostKeyOpts(env, { firstConnect, sshKeyPath }),
      '--',
      `root@${ip}:${remotePath}`,
      localPath,
    ],
    { timeout, retries, what: `${ip}:${remotePath}` },
  );
}

/**
 * Upload a file to a remote server via SCP. Argv form.
 */
export async function scpUpload(ip, sshKeyPath, localPath, remotePath, options = {}) {
  const { env, firstConnect = false, timeout = 300_000, retries } = options;
  await scpWithRetry(
    [
      '-i',
      sshKeyPath,
      ...sshHostKeyOpts(env, { firstConnect, sshKeyPath }),
      '--',
      localPath,
      `root@${ip}:${remotePath}`,
    ],
    { timeout, retries, what: `${ip}:${remotePath}` },
  );
}

/**
 * Execute a kubectl command on a remote k3s server via SSH.
 * Takes a kubectl argv array (WITHOUT the leading 'kubectl' token — sshKubectl
 * prepends it). The KUBECONFIG env var is injected via `env VAR=VAL`.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string[]} kubectlArgv - kubectl subcommand + args (e.g. ['get', 'pods', '-n', 'vibecarbon'])
 * @param {object} [options]
 * @returns {Promise<string>} trimmed stdout
 */
export async function sshKubectl(ip, sshKeyPath, kubectlArgv, options = {}) {
  if (!Array.isArray(kubectlArgv) || kubectlArgv.length === 0) {
    throw new Error('sshKubectl requires a non-empty argv array (without leading "kubectl")');
  }
  return await sshRun(
    ip,
    sshKeyPath,
    ['env', `KUBECONFIG=${K3S_KUBECONFIG}`, 'kubectl', ...kubectlArgv],
    options,
  );
}

/**
 * Get the name of the PostgreSQL pod in the vibecarbon namespace.
 */
export async function getPostgresPod(ip, sshKeyPath) {
  return await sshKubectl(ip, sshKeyPath, [
    'get',
    'pods',
    '-n',
    'vibecarbon',
    '-l',
    'app.kubernetes.io/name=supabase-db',
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]);
}
