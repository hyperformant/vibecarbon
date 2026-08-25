/**
 * Docker Compose Production Deployment Module
 *
 * Deploys Vibecarbon projects to a single VPS using Docker Compose.
 *
 * Provisioning is Hetzner (automated): the HetznerProvider API creates the VPS.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressLog, spinner } from '../../cli/progress.js';
import { runCommandAsync } from '../../command.js';
import { buildHostKeyOpts, SSH_TUNNEL_NO_MUX_OPTS } from '../../host-keys.js';
import { perfAsync, perfTimer } from '../../perf.js';
import { pollUntil } from '../../retry.js';
import { parseDotenv, shEscape } from '../../shell.js';
import {
  isDnsNotSettledSshCommandError,
  isTransientSshCommandError,
  runWithTransportRetry,
  sshRunScript,
} from '../../ssh.js';
import { postAdminUser, waitForGotrueHealth } from '../admin-user.js';
// DNS_NOT_SETTLED_RETRY_DELAYS_MS: shared with remote-build.js's own
// DNS-not-settled ladder so the two can't drift apart — see that file's
// docstring on the constant for the sizing rationale.
import { DNS_NOT_SETTLED_RETRY_DELAYS_MS } from '../remote-build.js';
import { composeRlsAuditShell } from '../rls-audit.js';
import {
  assertWalgBackupsWorking,
  composeWalgAuditShell,
  WALG_AUDIT_PROBE_TIMEOUT_MS,
} from '../walg-audit.js';
import { withWalgStaleStorageRetry } from '../walg-staleness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the cloud-init YAML shipped with the CLI package. Referenced from
// carbon/cloud-init/ (one level up from src/ in the installed tree).
const CLOUD_INIT_PATH = join(__dirname, '../../../../carbon/cloud-init/docker-ce-setup.yaml');

/**
 * Read the cloud-init user-data YAML that runs at VPS boot to front-load
 * ufw + unattended-upgrades installation. Callers pass the returned string
 * as `userData` to HetznerProvider.createServer().
 *
 * Kept as a thin wrapper so tests can stub the read and so `vibecarbon
 * upgrade` has a single place to notice layout changes.
 */
export function loadCloudInitScript() {
  return readFileSync(CLOUD_INIT_PATH, 'utf-8');
}

/**
 * The compose deploy path's SSH `-o` option tokens. Thin alias for the shared
 * buildHostKeyOpts (lib/host-keys.js) — the single source of truth for
 * host-key pinning + BatchMode=yes + keepalive hardening, shared with
 * lib/ssh.js#sshHostKeyOpts so the two SSH stacks cannot drift.
 *
 * @param {string} sshKeyPath
 * @returns {string[]} argv `-o` tokens
 */
function composeSshOpts(sshKeyPath) {
  return buildHostKeyOpts(sshKeyPath);
}

/**
 * The same opts as a shell-safe space-joined string for the string-command
 * runners / raw `ssh ...` interpolations below. The known_hosts path is
 * shEscaped so a project dir with spaces can't split the argument.
 *
 * @param {string} sshKeyPath
 * @returns {string}
 */
function composeSshOptsString(sshKeyPath) {
  // Every non-`-o` token is shEscaped, not just UserKnownHostsFile: the
  // shared opts now carry ControlPath=<home>/.vibecarbon/ssh-mux/%C, and any
  // path-valued option splits the same way under a home dir with spaces.
  // Quoting a plain token (BatchMode=yes) is harmless in bash.
  return composeSshOpts(sshKeyPath)
    .map((tok) => (tok === '-o' ? tok : shEscape(tok)))
    .join(' ');
}

/**
 * Run a command on a remote server via SSH.
 *
 * Shared with compose/ha.js (imported, not re-copied) so both halves of the
 * compose path use identical, single-sourced SSH options.
 *
 * NOTE: a second, unrelated `sshRun(ip, key, argv: string[])` exists in
 * lib/ssh.js for backup/restore/scale/failover — it takes an argv ARRAY,
 * shEscapes every token, and throws on remote failure. This one takes a raw
 * command string (compose commands are internally generated) and returns
 * `false` on failure — ha.js retry loops depend on false-not-throw. Same
 * name, different contract; check which one you're importing.
 */
export async function sshRun(ip, sshKeyPath, command, options = {}) {
  const { timeout = 120_000, ...rest } = options;
  try {
    return await runCommandAsync(
      // shell-safety-ignore: composeSshOpts() bakes in BatchMode=yes (validated in its definition)
      ['ssh', ...composeSshOpts(sshKeyPath), '-i', sshKeyPath, `root@${ip}`, command],
      { silent: true, timeout, ...rest },
    );
  } catch {
    // Preserve the legacy stdio:'pipe' contract: this runner returned `false`
    // on remote non-zero exit (silent was unset, so runCommand never threw).
    // ha.js callers + retry loops depend on false-not-throw — keep it identical.
    return false;
  }
}

/**
 * `sshRun` for commands that MUST succeed.
 *
 * sshRun never throws — it answers `false`. That is deliberate and load-bearing
 * for the retry loops in ha.js, which use `false` as "not ready yet". But it
 * also meant a plain `await sshRun(...)` silently discarded every failure, and
 * a `try { await sshRun(...) } catch {}` wrapped a catch block that can never
 * run. Both shapes were live in the HA replication and failover paths: a failed
 * CREATE ROLE surfaced minutes later as `role "replicator" does not exist`, and
 * failover's anti-split-brain "stop the old primary" step printed success
 * whether or not the old primary was reachable — i.e. exactly when it was not.
 *
 * Use this wherever a failure should abort. Keep plain `sshRun` where `false`
 * is a meaningful answer (probes and poll loops).
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string} command
 * @param {object} [options] - Same options as sshRun, plus `what` for the message.
 * @param {string} [options.what] - Human description used in the thrown error.
 * @param {Function} [options.runImpl] - DI seam for tests, so the throw-on-false
 *   contract is assertable without mocking this module (the same reason #238
 *   moved the port-forward diagnostics onto spawnImpl/fetchImpl).
 * @returns {Promise<string|true>} sshRun's output on success
 */
export async function sshRunChecked(ip, sshKeyPath, command, options = {}) {
  const { what, runImpl, ...rest } = options;
  const result = await (runImpl ?? sshRun)(ip, sshKeyPath, command, rest);
  if (result === false) {
    throw new Error(
      `${what || 'remote command'} failed on ${ip}` +
        // The command can carry base64 blobs; keep the message readable.
        (command.length > 120 ? '' : `: ${command}`),
    );
  }
  return result;
}

/**
 * Re-exports, so existing importers of this module keep working. Neither
 * symbol is declared here any more:
 *
 * - DNS_NOT_SETTLED_RETRY_DELAYS_MS — the DNS-not-settled ladder: one extra
 *   attempt beyond the default transport ladder, with longer waits (10s + 15s
 *   + 20s = 45s cumulative deliberate wait before the final attempt).
 *   Declared in remote-build.js so the two ladders — retrying the same
 *   underlying fresh-server condition on different commands — can't drift
 *   apart; see that file's docstring on the constant for the ~30s
 *   fresh-server-network-settle sizing rationale and the caveat that it's the
 *   same ORDER OF MAGNITUDE as the documented private-NIC dhcpcd race, not a
 *   confirmed identical mechanism.
 *
 * - isTransientSshCommandError / isDnsNotSettledSshCommandError — moved to
 *   lib/ssh.js on 2026-08-11 so the scp retry ladder there can share the
 *   classification. They cannot live here: lib/ssh.js would have to import
 *   this module, which already imports lib/ssh.js — a cycle. The three
 *   retryable classes and their rationale are documented at the definitions.
 */
export {
  DNS_NOT_SETTLED_RETRY_DELAYS_MS,
  isDnsNotSettledSshCommandError,
  isTransientSshCommandError,
};

/**
 * Async SSH runner — uses spawn (non-blocking) so spinners can animate.
 * Retries on transient SSH connection errors (common on freshly provisioned servers
 * where cloud-init may restart sshd).
 *
 * Ladder selection: starts on the default transport ladder (`retries`
 * attempts, 5s apart — caller-controlled, unchanged). Locked in on the
 * FIRST failure's classification: if it's DNS-not-settled AND the caller
 * hasn't opted out of retries entirely (`retries > 1`), switches to
 * DNS_NOT_SETTLED_RETRY_DELAYS_MS for the rest of this call's retries. A
 * `retries: 1` caller (e.g. compose/ha.js's restoreComposeWalgRole /
 * demoteComposeWalgRole DR fast-fail path) targets an ALREADY-established
 * server, not a freshly-provisioned one, so the DNS-not-settled window
 * doesn't apply there and the opt-out is respected as-is.
 */
export async function sshRunAsync(ip, sshKeyPath, command, options = {}) {
  const { timeout = 120_000, retries = 3, ignoreError, ...rest } = options;
  const sshArgs = ['ssh', ...composeSshOpts(sshKeyPath), '-i', sshKeyPath, `root@${ip}`, command];
  // Strip ignoreError from inner call so connection errors always throw and
  // the retry loop can catch them. We apply ignoreError ourselves after retries.
  const runOpts = { silent: true, timeout, ...rest };

  // Default (transport/timeout) ladder: caller-controlled via `retries`
  // (attempts = retries; delays = retries-1 entries of 5s each) — unchanged
  // from before the DNS-branch fix.
  const transportDelaysMs = Array.from({ length: Math.max(0, retries - 1) }, () => 5000);

  let delaysMs = transportDelaysMs;
  let ladderLocked = false;
  let attempt = 0;

  try {
    for (;;) {
      try {
        return await runCommandAsync(sshArgs, runOpts);
      } catch (err) {
        if (!isTransientSshCommandError(err)) throw err;
        if (!ladderLocked) {
          ladderLocked = true;
          if (retries > 1 && isDnsNotSettledSshCommandError(err)) {
            delaysMs = DNS_NOT_SETTLED_RETRY_DELAYS_MS;
          }
        }
        if (attempt >= delaysMs.length) throw err;
        attempt += 1;
        const waitMs = delaysMs[attempt - 1];
        const msg = err.message || '';
        // Route through progressLog, not raw console.error: this retry line can
        // fire mid-`docker compose up` / bundle upload while a clack spinner is
        // animating, and a raw write shreds that single cursor-controlled line
        // (the "spinners aren't working" reports on flaky links). progressLog
        // updates the active spinner's message instead — or falls back to
        // console.error verbatim when no spinner is up.
        progressLog(
          `[retry] ssh ${ip}: attempt ${attempt}/${delaysMs.length + 1} failed (${msg.slice(0, 80).split('\n')[0]}); retrying in ${waitMs / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  } catch (err) {
    // All retries exhausted (or the error was non-transient) — respect
    // ignoreError if set.
    if (ignoreError) return null;
    throw err;
  }
}

/**
 * Wait for SSH to become available on a newly provisioned server.
 *
 * Hetzner VPS typically accepts SSH ~20–35s after the create API returns.
 * Early attempts use a 2s interval so we catch the edge quickly; after
 * 10 tries (~20s) we fall back to 5s so we're not hammering the sshd
 * during slow boots.
 */
export async function waitForSSH(host, sshKeyPath, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // silent:true makes runCommandAsync REJECT on a non-zero/connection
      // failure, so the catch below actually engages the retry loop. (The old
      // sync runCommand with stdio:'pipe' returned false without throwing, so
      // this returned true on the very first probe regardless of SSH state.)
      await runCommandAsync(
        [
          // shell-safety-ignore: composeSshOpts() bakes in BatchMode=yes (validated in its definition)
          'ssh',
          ...composeSshOpts(sshKeyPath),
          '-i',
          sshKeyPath,
          '-o',
          'ConnectTimeout=5',
          `root@${host}`,
          'echo',
          'ok',
        ],
        { silent: true, timeout: 10_000 },
      );
      return true;
    } catch {
      if (i === maxAttempts - 1) return false;
      // Tighter than the previous [2s ×10, 5s ×20]: SSH is usually live by
      // attempt 3-5, so the fast leg pays off most often. Tail keeps 5s
      // pacing for the genuinely slow boots.
      const interval = i < 5 ? 1000 : i < 10 ? 2000 : 5000;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  return false;
}

/**
 * Wait for the boot-time cloud-init script to finish.
 *
 * The Hetzner VPS is created with `user_data` that installs ufw + unattended-
 * upgrades and touches `/var/lib/vibecarbon/ready`. `waitForSSH` only tells us
 * sshd is accepting connections — cloud-init may still be mid-way through its
 * runcmd list. Polling for the marker keeps deploy's critical path tight:
 * by the time SSH is up, cloud-init is usually 10-30s away from finishing, and
 * this returns without any apt-get work on our side.
 *
 * If cloud-init fails (marker never appears within the deadline), dump the
 * tail of /var/log/cloud-init-output.log into the error so diagnosis is a
 * one-line log grep for the operator.
 */
/**
 * Build the setupServer failure error, distinguishing an SSH-connectivity
 * failure (we never reached the box at all) from a genuine cloud-init stall
 * (SSH worked, but the ready marker never appeared). Blaming cloud-init when
 * the real problem is connectivity — a flaky/cell-modem uplink, an outbound
 * port-22 block, a local firewall, or a mismatched SSH key — sends the operator
 * to the wrong place (`cloud-init-output.log` they can't even reach).
 *
 * @param {string} ip
 * @param {boolean} everConnected - did any SSH probe reach the server?
 * @param {string} tail - last lines of cloud-init-output.log (only meaningful when everConnected)
 * @param {number} [timeoutMs=180_000] - the actual budget that was used
 *   (provider-owned — see BaseProvider.CLOUD_INIT_READY_TIMEOUT_MS), so the
 *   message never claims a Hetzner-calibrated "180s" for a provider (e.g.
 *   DigitalOcean) that was actually given longer.
 * @returns {Error}
 */
export function buildSetupServerError(ip, everConnected, tail, timeoutMs = 180_000) {
  const budgetS = Math.round(timeoutMs / 1000);
  if (!everConnected) {
    return new Error(
      `Could not SSH to ${ip} within ${budgetS}s; the server was created, but no SSH ` +
        `connection ever succeeded, so cloud-init readiness could not be checked. ` +
        `This is almost always a connectivity problem on your side, NOT a cloud-init ` +
        `failure: a flaky or cell-modem uplink, an outbound port 22 block by your ` +
        `network/carrier, a local firewall, or an SSH key that doesn't match the ` +
        `server. Retry from a stable connection; if it persists, verify outbound ` +
        `port 22 to ${ip} is reachable.`,
    );
  }
  return new Error(
    `cloud-init never reached the ready marker on ${ip} within ${budgetS}s.\n` +
      `--- last 50 lines of /var/log/cloud-init-output.log ---\n${(tail || '').trim()}\n` +
      '--- end cloud-init tail ---',
  );
}

/**
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {number} [timeoutMs=180_000] - provider-owned readiness budget (see
 *   BaseProvider.CLOUD_INIT_READY_TIMEOUT_MS). Callers that don't pass one
 *   get the Hetzner-compatible 180s default.
 */
export async function setupServer(ip, sshKeyPath, timeoutMs = 180_000) {
  // A real spinner over the whole wait: without it the CLI sat on a stalled
  // cursor for up to the full budget. Progress is reported via s.message() so
  // a slow boot (or a flaky uplink) reads as "still working", not "hung".
  const s = spinner();
  s.start(`Waiting for ${ip} to finish booting (cloud-init)...`);
  // Deliberately NOT lib/retry.js#pollUntil: this loop's two-phase cadence
  // (750ms × 15 fast probes, then flat 5s) isn't expressible in pollUntil's
  // exponential backoff, and the fast phase saves ~10s on every deploy.
  const start = Date.now();
  // Provider-owned (see BaseProvider.CLOUD_INIT_READY_TIMEOUT_MS): 180s is a
  // generous ceiling vs Hetzner's typical ~20-40s (Docker preinstalled), but
  // a provider that installs Docker inside cloud-init (e.g. DigitalOcean)
  // passes a materially larger timeoutMs.
  const deadline = start + timeoutMs;
  let attempt = 0;
  let everConnected = false;
  while (Date.now() < deadline) {
    // retries:1 — the poll loop IS the retry, so each tick is a SINGLE ssh
    // attempt. That keeps the wait quiet: no inner `[retry] ssh …` lines
    // printing raw over the spinner (the corruption a flaky connection used to
    // trigger). The spinner message carries progress instead.
    const result = await sshRunAsync(
      ip,
      sshKeyPath,
      'test -f /var/lib/vibecarbon/ready && echo READY || echo NOT_READY',
      { timeout: 10_000, ignoreError: true, retries: 1 },
    );
    if (result != null) everConnected = true; // any output means SSH connected
    if (result?.trim()?.endsWith('READY') && !result.includes('NOT_READY')) {
      s.stop(`Server ${ip} ready (cloud-init complete)`);
      return;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    s.message(
      everConnected
        ? `Waiting for cloud-init to finish on ${ip} (${elapsed}s)...`
        : `Waiting for SSH to reach ${ip} (${elapsed}s)...`,
    );
    const interval = attempt < 15 ? 750 : 5000;
    attempt++;
    await new Promise((r) => setTimeout(r, interval));
  }

  s.stop(
    everConnected ? `cloud-init did not finish on ${ip}` : `Could not reach ${ip} over SSH`,
    1,
  );

  // Only fetch the cloud-init tail when SSH actually worked — otherwise the
  // fetch just fails again and returns nothing (the misleading empty tail).
  let tail = '';
  if (everConnected) {
    try {
      tail =
        (await sshRunAsync(
          ip,
          sshKeyPath,
          'tail -n 50 /var/log/cloud-init-output.log 2>/dev/null || echo "(cloud-init log unavailable)"',
          { timeout: 15_000, ignoreError: true, retries: 1 },
        )) || '';
    } catch {
      // Best effort — don't mask the outer failure.
    }
  }
  throw buildSetupServerError(ip, everConnected, tail, timeoutMs);
}

/**
 * Authenticate with a container registry on a remote server.
 *
 * Writes credentials directly into `/root/.docker/config.json` rather than
 * invoking `docker login --password-stdin`. `docker login` has two moving
 * parts that have caused silent failures in e2e:
 *
 *   1. SSH stdin-input race — on a freshly-booted VM, the shell can start
 *      reading `docker login`'s prompt before our piped token arrives,
 *      causing docker to hang 30s then exit non-zero.
 *   2. Any `credsStore` / `credsHelpers` entry in `/root/.docker/config.json`
 *      makes `docker login` try to delegate to a helper binary that doesn't
 *      exist on a bare Hetzner VM — login exits 0 but config.json never
 *      gets the new auth entry.
 *
 * The `auths` entry we write here is exactly what `docker login` produces
 * internally (base64 of `username:token`, no encryption). Docker reads it
 * on every pull/manifest-HEAD.
 *
 * Fails loud: if the write fails (unreachable server, permission denied,
 * malformed JSON) we throw. A silent fallback here has burned us on
 * standby GHCR 401s — a loud failure during login is much easier to debug
 * than an `unauthorized` 20 minutes into reconcile.
 */
export async function dockerLoginOnServer(ip, sshKeyPath, creds) {
  if (!creds?.username || !creds?.token) return;
  const { username, token, registry } = creds;
  const registryHost = registry || 'https://index.docker.io/v1/';
  const authB64 = Buffer.from(`${username}:${token}`).toString('base64');

  // Merge into any existing config.json via jq (preserves other registries'
  // auth when we log in to multiple). jq is guaranteed on Hetzner docker-ce
  // images; if not present we fall back to writing a minimal file.
  // Bash here-doc writes a minimal config.json directly. No jq dependency:
  // bare Hetzner images don't ship with it, and installing via apt-get races
  // cloud-init's unattended-upgrades apt lock (observed 04:08 UTC —
  // "Could not get lock /var/lib/apt/lists/lock").
  //
  // Python3 is preinstalled on Ubuntu's docker-ce cloud image, so we use
  // it to merge cleanly into any existing config.json (preserves other
  // registries' auth when logging into Docker Hub + GHCR sequentially).
  // Falls back to overwriting config.json if python3 is absent.
  const script = `
set -e
mkdir -p /root/.docker
cfg=/root/.docker/config.json
if [ ! -s "$cfg" ]; then echo '{}' > "$cfg"; fi

if command -v python3 >/dev/null 2>&1; then
  HOST=${shEscape(registryHost)} AUTH=${shEscape(authB64)} python3 - <<'PY'
import json, os
cfg_path = '/root/.docker/config.json'
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except Exception:
    cfg = {}
if not isinstance(cfg, dict):
    cfg = {}
cfg.setdefault('auths', {})[os.environ['HOST']] = {'auth': os.environ['AUTH']}
cfg.pop('credsStore', None)
cfg.pop('credHelpers', None)
with open(cfg_path, 'w') as f:
    json.dump(cfg, f)
PY
else
  # Minimal fallback: overwrite with single-registry config. Acceptable
  # for bare images where we're the only thing writing this file.
  printf '{"auths":{"%s":{"auth":"%s"}}}' ${shEscape(registryHost)} ${shEscape(authB64)} > "$cfg"
fi

chmod 600 "$cfg"
# Verify the auth entry landed. Deploys that silently lose auth here
# surface as 401 during reconcile 15+ min later — this grep catches it
# at login time so the failure is actionable.
if ! grep -q ${shEscape(authB64)} "$cfg"; then
  echo "docker auth write verification failed: config.json:" >&2
  cat "$cfg" >&2
  exit 1
fi
`;
  await sshRunAsync(ip, sshKeyPath, `/bin/bash -s`, {
    silent: true,
    timeout: 30_000,
    input: script,
  });
}

/**
 * Collect deploy files and sync them to the server.
 * Supports pre-rendered bundlePath (Phase 1 Optimization).
 */
export async function setupServerFiles(ip, sshKeyPath, projectName, options = {}) {
  const remoteDir = `/opt/${projectName}`;
  const stageDir = options.bundlePath || mkdtempSync(join(tmpdir(), 'vc-deploy-'));

  try {
    // If not using a pre-rendered bundle, perform ad-hoc rendering (legacy path)
    if (!options.bundlePath) {
      // ... (rest of the manual rendering logic if needed, but we now use bundle.js)
      // Actually, to keep it clean, we just import renderBundle if bundlePath is missing
      const { renderBundle } = await import('../bundle.js');
      const adhocBundle = renderBundle(projectName, options);
      // Copy from adhoc to stageDir or just use adhoc
      // For simplicity, let's just use the renderBundle result
      options.bundlePath = adhocBundle;
    }

    // -- Single tar + SSH pipe to extract on server --
    // Per-arm filename. HA-scale and HA-deploy fan two arms in parallel
    // through this function, both with the same projectName. A shared
    // /tmp path was racing — Arm A's stream of the bundle could mid-flight
    // read a file Arm B had already begun overwriting, surfacing on the
    // remote side as "gzip: stdin: unexpected end of file". The ip + pid +
    // random suffix gives each arm its own file so the cleanup rmSync below
    // can't yank Arm A's stream out from under it.
    const safeIp = ip.replace(/[^0-9a-zA-Z]/g, '_');
    const tarPath = join(
      tmpdir(),
      `vc-deploy-${projectName}-${safeIp}-${process.pid}-${randomBytes(6).toString('hex')}.tar.gz`,
    );
    // Inner pack vs upload+extract split — pack is local CPU-bound, upload
    // is bandwidth-bound. Splitting them isolates whether a slow deploy is
    // dev-laptop or network/server side. Clack spinners replace the older
    // `console.log('[sync] ...')` triplet so the operator sees animation
    // during the perfAsync wait instead of dead silence.
    const packSpinner = spinner();
    packSpinner.start(`Packing bundle from ${options.bundlePath}`);
    try {
      await perfAsync('deploy.bundle.tarPack', () =>
        runCommandAsync(['tar', '-czf', tarPath, '-C', options.bundlePath, '.'], {
          silent: true,
          timeout: 30_000,
        }),
      );
      packSpinner.stop('Bundle packed');
    } catch (err) {
      packSpinner.stop('Bundle pack failed', 1);
      throw err;
    }

    const uploadSpinner = spinner();
    uploadSpinner.start(`Uploading + extracting bundle on ${ip}`);
    try {
      // Transport hardening (RCA 2026-08-16, run 31961619204 compose-ha
      // scale): this pipeline predated the shared-opts chokepoint — its
      // hand-rolled argv had no ConnectTimeout/ServerAlive keepalives (the
      // banner-exchange-hang protections) and no transport retry, and a
      // fresh replacement server reset it mid-kex after a 140s hang.
      // composeSshOptsString carries the full shared opts (host-key pinning
      // included, every path token shEscaped), and runWithTransportRetry
      // retries ONLY provably-never-started transport drops — the remote
      // command (mkdir/tar/cp/daemon-reload) is idempotent anyway.
      const uploadScript =
        // shell-safety-ignore: opts from composeSshOptsString (shEscaped); data flows via positionals
        `cat "$1" | ssh ${composeSshOptsString(sshKeyPath)} -i "$2" "root@$3" "mkdir -p $4/backups && tar --no-xattrs --no-same-owner -xzf - -C $4 && cp $4/$5.service /etc/systemd/system/ && systemctl daemon-reload"`;
      await perfAsync('deploy.bundle.extract', () =>
        runWithTransportRetry(() =>
          runCommandAsync(
            ['bash', '-c', uploadScript, '--', tarPath, sshKeyPath, ip, remoteDir, projectName],
            { silent: true, timeout: 300_000 },
          ),
        ),
      );
      uploadSpinner.stop('Bundle synced');
    } catch (err) {
      uploadSpinner.stop('Bundle upload failed', 1);
      throw err;
    }

    // Clean up local tar
    try {
      rmSync(tarPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  } finally {
    // Clean up staging dir only if we created it (adhoc)
    if (!options.bundlePath) {
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Heuristic: does this image tag refer to a registry path or a local-only tag?
 *
 * A registry path always contains either a `/` (e.g. `ghcr.io/owner/repo:tag`,
 * `library/postgres`) or a host:port prefix. Local tags built by direct mode
 * are bare names like `<project>-app:local`. Distinguishing the two lets
 * callers decide whether to ship the image to peer servers (local-only)
 * or rely on `docker pull` (registry path).
 */
export function isLocalOnlyImageTag(imageRef) {
  if (!imageRef || typeof imageRef !== 'string') return false;
  const [namePart] = imageRef.split(':');
  // A '/' anywhere in the name part means the tag carries a registry path
  // (e.g. ghcr.io/owner/repo or owner/repo). Local docker tags built via
  // `docker build -t <project>-app:local` have no slash.
  return !namePart.includes('/');
}

/**
 * Distribute a locally-built Docker image from one server's daemon to another
 * via an SSH-piped `docker save | docker load`.
 *
 * Direct-mode deploys build the image into a single server's local Docker
 * daemon (via `DOCKER_HOST=ssh://<source>`). Multi-server scenarios (HA
 * standby, compose-scale's blue-green new VM) need that image on the other
 * servers before reconcile.sh runs `docker compose up -d` — otherwise compose
 * tries to `docker pull <local-tag>`, which is not a registry path, and fails
 * with `pull access denied`.
 *
 * The pure SSH-pipe approach avoids any temp-file or scp intermediate: stdout
 * of `docker save` on the source streams directly into `docker load` on the
 * destination. For a 600MB image across hel1↔nbg1 this typically lands in
 * 30-60s; we budget 10 minutes (large images + slow inter-DC links).
 *
 * No-op (returns without erroring) when imageRef looks like a registry path,
 * since `docker compose pull` will already handle those.
 *
 * @param {string} sourceIp - Server that already has the image in its daemon
 * @param {string} destIp   - Server that needs the image
 * @param {string} sshKeyPath
 * @param {string} imageRef - Tag to transfer (e.g. `<project>-app:local`)
 * @returns {Promise<void>}
 */
export async function transferImageBetweenServers(sourceIp, destIp, sshKeyPath, imageRef) {
  if (!isLocalOnlyImageTag(imageRef)) {
    // Registry-path image — let `docker compose pull` handle it.
    return;
  }
  if (sourceIp === destIp) return;
  // shEscape the imageRef so a future tag with shell metacharacters (':',
  // '@', '/' are all fine; we still escape for defense-in-depth) can't
  // break out of `docker save`. The other tokens (ip, sshKeyPath) are
  // controlled by the deploy code, not user input.
  // gzip on the wire — same trick as sideloadCompose / sideloadK3s. Node
  // images compress 3-5x; without gzip a ~600MB save streams uncompressed
  // across two regions on top of the operator's residential upload, which
  // risks tripping the 600s timeout under load.
  const sshOpts = composeSshOptsString(sshKeyPath);
  const saveCmd = `ssh ${sshOpts} -i ${shEscape(sshKeyPath)} root@${sourceIp} docker save ${shEscape(imageRef)}`;
  const loadCmd = `ssh ${sshOpts} -i ${shEscape(sshKeyPath)} root@${destIp} 'gunzip | docker load'`;
  await runCommandAsync(['bash', '-c', `set -o pipefail && ${saveCmd} | gzip -1 | ${loadCmd}`], {
    silent: true,
    timeout: 600_000,
  });
}

/**
 * Wait for Docker daemon to be ready on a remote server.
 *
 * On Hetzner docker-ce VPSes Docker is already running once cloud-init
 * releases the dpkg lock, so the first check usually succeeds immediately.
 * Short initial interval keeps the latency tight on the rare miss.
 */
export async function waitForDockerReady(ip, sshKeyPath, maxAttempts = 12) {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await sshRunAsync(ip, sshKeyPath, 'docker info >/dev/null 2>&1 && echo READY', {
      timeout: 10_000,
      ignoreError: true,
    });
    if (result?.trim() === 'READY') return true;
    if (i < maxAttempts - 1) {
      const interval = i < 3 ? 1500 : 5000;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  return false;
}

/**
 * Build the compose files flags string for a given set of service options.
 */
function composeFileFlags(options = {}) {
  const files = ['-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml'];
  if (options.observability) {
    files.push('-f', 'docker-compose.observability.yml');
    files.push('-f', 'docker-compose.observability.prod.yml');
  }
  if (options.n8n) {
    files.push('-f', 'docker-compose.n8n.yml', '-f', 'docker-compose.n8n.prod.yml');
  }
  if (options.metabase) {
    files.push('-f', 'docker-compose.metabase.yml', '-f', 'docker-compose.metabase.prod.yml');
  }
  if (options.redis) {
    files.push('-f', 'docker-compose.redis.yml', '-f', 'docker-compose.redis.prod.yml');
  }
  return files.join(' ');
}

/**
 * Start the Docker Compose stack on the remote server
 */
export async function startComposeStack(ip, sshKeyPath, projectName, _options = {}) {
  const remoteDir = `/opt/${projectName}`;
  // Spinner over the long silent compose.up — typical 60-130s warm, longer
  // cold while Supabase services pull. Replaces the previous
  // `console.log('[reconcile] Running...')` + silence + `Reconcile
  // complete.` pair.
  const reconcileSpinner = spinner();
  reconcileSpinner.start(`Reconciling stack on ${ip} (docker compose up)`);
  try {
    // reconcile.sh combines `docker compose pull` + `docker compose up -d`
    // on the server. The orchestrator-level `deploy.reconcile.run` wraps the
    // outer call; this inner timer captures the SSH-side cost separately so
    // we can attribute slow deploys to the remote-bash phase vs. the SSH
    // round-trip overhead.
    //
    // 1800s (30 min) timeout: iter-banner 2026-05-02 had compose-ha standby
    // reconcile run past the previous 900s budget while Docker Hub / Hetzner
    // egress was slow — SSH was making progress (cluster came up healthy
    // after the wrapper timed out) but the timer ate the run. 30 min covers
    // a slow-pull cold start on any of the three S3 regions plus margin
    // without masking a true regression (a real hang would still surface
    // via the 60s ServerAlive keepalives in lib/ssh.js + composeSshOpts).
    await perfAsync('deploy.compose.up', () =>
      sshRunAsync(ip, sshKeyPath, `/bin/bash ${remoteDir}/reconcile.sh`, { timeout: 1_800_000 }),
    );
    reconcileSpinner.stop('Stack reconciled');
  } catch (err) {
    reconcileSpinner.stop('Stack reconcile failed', 1);
    const stdout = err.stdout?.trim?.();
    if (stdout) {
      const lines = stdout.split('\n');
      const tail = lines.slice(-30).join('\n');
      err.message = `${err.message}\n--- reconcile output (last 30 lines) ---\n${tail}`;
    }
    // Capture the db container's actual stderr — `docker compose up` only
    // surfaces "container is unhealthy" / "Error", not the postgres exit
    // reason. Without these logs, debugging a failed re-deploy means
    // "guess and re-run". Mirrors what compose/ha.js already does on
    // failover. Best-effort — we re-throw the original failure regardless.
    try {
      const dbLogs = await sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose logs db --tail=60 2>&1 || true`,
        { timeout: 30_000 },
      );
      if (typeof dbLogs === 'string' && dbLogs.trim()) {
        err.message = `${err.message}\n--- db container logs (last 60 lines) ---\n${dbLogs.trim()}`;
      }
    } catch (logErr) {
      err.message = `${err.message}\n(failed to capture db logs: ${logErr.message})`;
    }
    throw err;
  }
}

/**
 * Wait for all compose services with healthchecks to reach "healthy".
 *
 * `docker compose up -d` returns as soon as containers are *created*, not
 * when their healthchecks pass. For Supabase, auth/storage/rest all need
 * 10-60s after container-start to become healthy — verify-deploy's
 * storage_upload / rest_api checks 502 when they run against a starting
 * service. Polls every 5s up to 3min; returns early once every service
 * with a declared healthcheck reports "healthy".
 *
 * Non-critical — on timeout or error we log but don't fail, since the
 * caller's primary gate is the app-container probe which already passed.
 */
async function waitForServicesHealthy(ip, sshKeyPath, projectName, maxWaitMs = 180_000) {
  const remoteDir = `/opt/${projectName}`;
  const cmd = `cd ${remoteDir} && docker compose ps --format '{{.Service}} {{.Health}}' 2>&1`;
  let lastState = '';
  try {
    await pollUntil(
      async () => {
        const out = await sshRunAsync(ip, sshKeyPath, cmd, {
          timeout: 15_000,
          ignoreError: true,
        });
        const lines = (out || '')
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        // Partition by health state. Services without a declared healthcheck
        // report empty/no-health — skip those, they don't block readiness.
        const stillWarming = lines.filter(
          (l) => l.endsWith(' starting') || l.endsWith(' unhealthy'),
        );
        lastState = stillWarming.join(', ') || 'all healthy';
        return stillWarming.length === 0;
      },
      // Flat 5s cadence (factor 1) matches the historical loop.
      {
        budgetMs: maxWaitMs,
        initialDelayMs: 5000,
        maxDelayMs: 5000,
        backoffFactor: 1,
        description: 'compose services healthy',
      },
    );
    return true;
  } catch {
    // Best-effort; don't fail the deploy here — the app probe already passed.
    console.error(
      `[verifyAppHealth] services still warming after ${maxWaitMs / 1000}s: ${lastState}`,
    );
    return false;
  }
}

/**
 * App-health probe backoff ramp (F4).
 *
 * verifyAppHealth runs LAST (after migrations + admin-user), so the app is
 * usually already serving and the very first probe passes. When it isn't, the
 * app typically binds :3000 within ~10-30s — probe fast (2s) for the first
 * few gaps so a fast-converging app is detected within ~2s instead of waiting
 * a full flat 10s, then back off to 10s for the long tail.
 *
 * `attempt` is the loop index; the gap is applied BEFORE probe `attempt` (only
 * when attempt > 0).
 *
 * @param {number} attempt
 * @returns {number} ms to wait before this probe
 */
export function healthProbeDelayMs(attempt) {
  return attempt <= 5 ? 2000 : 10000;
}

/**
 * Verify the deployed app is actually serving requests.
 *
 * Probes `http://localhost/api/health` on the server itself with a Host header
 * (if a domain is configured), bypassing public DNS and TLS to isolate app
 * health from DNS propagation / cert issuance races. Polls up to `attempts`
 * times with 3s between attempts.
 *
 * On failure, captures `docker compose ps` + the last 40 lines of the `app`
 * container log so operators see WHY the probe failed, not just THAT it did.
 *
 * Returns `{ healthy, status, details }`:
 *   - healthy  — true iff the probe returned HTTP 2xx within the budget
 *   - status   — HTTP status of the last probe ('none' if we never got one)
 *   - details  — diagnostic string (empty when healthy)
 */
export async function verifyAppHealth(ip, sshKeyPath, projectName, options = {}) {
  // Probe the app container directly on its internal port (3000), bypassing
  // Traefik + TLS. Traefik's port 80 listener redirects to HTTPS (301) and
  // HTTPS requires a valid cert which may still be issuing on a fresh
  // deploy. Hitting the container directly tests app-layer health without
  // entangling the ingress path — the e2e harness's own
  // waitForHealthy check (which hits the public URL) verifies end-to-end.
  //
  // First-boot route registration takes longer than the initial `docker
  // compose up -d` return: the app has to start + bind port 3000.
  // Empirically 10-30s. 3 min tolerates worst-case cold starts.
  const { path = '/api/health', attempts = 18, delayMs } = options;
  // Ramp by default (fast-early, F4); honor an explicit flat delayMs override.
  const delayFor = (i) => delayMs ?? healthProbeDelayMs(i);
  const remoteDir = `/opt/${projectName}`;
  // Use `node` for the probe — the app's runtime image is guaranteed to have
  // it (it runs the server), whereas curl/wget may not be present in slim
  // node base images. One-liner: HEAD the local port 3000 path; exit 0 on
  // 2xx, 1 otherwise. The outer shell echoes "2xx" or "fail" so the caller
  // sees a deterministic token on stdout regardless of node's exit code.
  const nodeScript = `const r=require('http').request({host:'localhost',port:3000,path:${JSON.stringify(path)},method:'GET',timeout:4000},res=>{process.exit(res.statusCode<300?0:1)});r.on('error',()=>process.exit(2));r.on('timeout',()=>process.exit(3));r.end();`;
  const nodeScriptB64 = Buffer.from(nodeScript).toString('base64');
  const probeCmd = `cd ${remoteDir} && (echo ${nodeScriptB64} | base64 -d | docker compose exec -T app node - && echo 2xx || echo fail) 2>&1`;

  let lastStatus = 'none';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayFor(i)));
    try {
      const result = await sshRunAsync(ip, sshKeyPath, probeCmd, {
        timeout: 15_000,
        ignoreError: true,
      });
      const out = (result || '').trim();
      lastStatus = out.slice(-8) || 'none';
      if (out.endsWith('2xx')) {
        // App is serving, but Supabase services may still be warming up
        // their healthchecks. The e2e harness's verify-deploy probes
        // auth/storage/rest endpoints immediately after deploy returns —
        // a 502 from storage that takes 60s to become healthy would fail
        // otherwise-valid deploys. Wait for all compose-managed services
        // with healthchecks to reach "healthy". Bounded: 3 min budget
        // (wasn't spent during the app probe since that succeeded quickly).
        await waitForServicesHealthy(ip, sshKeyPath, projectName);
        return { healthy: true, status: '200', details: '' };
      }
    } catch (err) {
      lastStatus = err.message?.slice(0, 80) || 'ssh-error';
    }
  }

  // Unhealthy — collect diagnostics.
  let ps = '';
  let logs = '';
  try {
    ps =
      (await sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose ps --format '{{.Name}}\\t{{.State}}\\t{{.Status}}' 2>&1 | head -20`,
        { timeout: 15_000, ignoreError: true },
      )) || '';
  } catch {
    /* best effort */
  }
  try {
    logs =
      (await sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose logs --tail=40 app 2>&1 | tail -40`,
        { timeout: 15_000, ignoreError: true },
      )) || '';
  } catch {
    /* best effort */
  }
  const details =
    `Health probe failed after ${attempts} attempts (last status: ${lastStatus})\n` +
    `--- docker compose ps ---\n${ps.trim()}\n` +
    `--- app container log tail ---\n${logs.trim()}`;
  return { healthy: false, status: lastStatus, details };
}

/**
 * Pull container images on the remote server. Runs in parallel with the
 * image build to overlap I/O.
 *
 * LOUD ON FAILURE, deliberately. This used to be silenced four layers deep
 * (three `||` fallbacks ending `|| true`, plus `ignoreError: true`), on the
 * theory that `docker compose up` would pull whatever was missing anyway.
 * 2026-08-23 (runs 32614839037 / 32620565774, linode compose-ha) showed
 * where that theory dies: the pull failed silently on a fresh node, and the
 * deploy surfaced two steps later as a wall of daemon `No such image`
 * errors from `up` — with the pull's actual stderr (the only evidence of
 * WHY: rate limit vs DNS vs timeout) discarded. A failed pull now rejects
 * with that stderr attached, so the step that broke is the step that fails.
 *
 * `--ignore-buildable` stays: db/app carry `build:` sections and local-only
 * tags — they are built or sideloaded, never pulled, and pulling them 401s.
 * `--policy missing` stays: warm nodes must not re-download ~2GB.
 * Pinned by tests/unit/deploy/pull-images-loud.test.ts.
 */
export async function pullComposeImages(ip, sshKeyPath, projectName, options = {}) {
  const remoteDir = `/opt/${projectName}`;
  const flags = composeFileFlags(options);
  // The app service must be EXCLUDED from the pre-pull. prod.yml resets its
  // `build:` (`build: !reset null`), so `--ignore-buildable` does NOT skip it
  // — and its image is a local-only tag that no registry serves. The first
  // loud run (linode 32640636398) showed what that does to a plain
  // `compose pull`: `pull access denied for <project>-app` ABORTS the whole
  // command and every sibling image logs `Interrupted` — fifteen of them.
  // The old silencers had been eating exactly this on every compose-ha
  // deploy, leaving nodes to pull ad-hoc during `up` — the missing-images
  // family's true origin. Pulling the service LIST minus `app` keeps the
  // pull loud for real failures while never asking a registry for an image
  // that only exists in a docker daemon.
  await perfAsync('deploy.compose.imagesPull', () =>
    sshRunAsync(
      ip,
      sshKeyPath,
      `cd ${remoteDir} && docker compose ${flags} config --services | grep -vx app | ` +
        `xargs -r docker compose ${flags} pull --policy missing --ignore-buildable 2>&1`,
      { timeout: 600_000 },
    ),
  );
}

/**
 * Run database migrations on the remote server, then the two deploy-time
 * ground-truth audits that gate success: RLS (src/lib/deploy/rls-audit.js) and
 * wal-g backups (src/lib/deploy/walg-audit.js). Either one failing throws and
 * fails the deploy. Shared by the single-compose run-migrations effect and
 * compose-ha's, which invokes it against the PRIMARY.
 */
export async function runMigrations(ip, sshKeyPath, projectName) {
  const remoteDir = `/opt/${projectName}`;

  // On a fresh volume, supabase/postgres runs its own first-boot initdb scripts
  // (creating the supabase_admin role + auth/storage/realtime schemas) before
  // our app migrations can apply. `pg_isready` flips true as soon as PG accepts
  // connections — which can be *during* that init, before supabase_admin
  // exists. Running migrations then errors (missing role/extension). Previously
  // those errors were piped to /dev/null with `|| true`, so a fully-failed
  // migration was indistinguishable from success and an empty schema shipped to
  // prod (RCA prod-1 2026-05-26: 0 public tables, every DB feature 500'd).
  //
  // Gate on supabase_admin actually being able to run a query (not just
  // pg_isready), polling up to ~3 min.
  await sshRunAsync(
    ip,
    sshKeyPath,
    `cd ${remoteDir} && ` +
      `for i in $(seq 1 60); do ` +
      `docker compose exec -T db psql -U supabase_admin -d postgres -c 'SELECT 1' >/dev/null 2>&1 && exit 0; ` +
      `echo "[migrate] waiting for supabase_admin to accept queries (attempt $i/60)"; sleep 3; ` +
      `done; echo "[migrate] supabase_admin never became ready" >&2; exit 1`,
    { timeout: 240_000 },
  );

  // Also wait for the storage service to finish ITS first-boot migrations
  // before applying app migrations. supabase-storage adds columns to the
  // `storage` schema on startup (notably storage.buckets.public); our
  // 00001_init.sql seeds buckets referencing them. Racing ahead fails with
  // `column "public" of relation "buckets" does not exist`, which aborts the
  // whole migration — the core public.* tables get created first, but the
  // deploy still fails (deployComposeHA only ever masked this by swallowing the
  // error in a try/catch). The supabase_admin gate above is insufficient: that
  // role exists before storage has migrated. Gate on storage.buckets.public
  // being queryable as the proxy for "storage migrations done", polling ~3 min.
  await sshRunAsync(
    ip,
    sshKeyPath,
    `cd ${remoteDir} && ` +
      `for i in $(seq 1 60); do ` +
      `docker compose exec -T db psql -U supabase_admin -d postgres -c 'SELECT public FROM storage.buckets LIMIT 0' >/dev/null 2>&1 && exit 0; ` +
      `echo "[migrate] waiting for storage schema (buckets.public) to be ready (attempt $i/60)"; sleep 3; ` +
      `done; echo "[migrate] storage schema never became ready" >&2; exit 1`,
    { timeout: 240_000 },
  );

  // Apply each migration with ON_ERROR_STOP=1 and abort on the first failure.
  // A failed migration MUST fail the deploy — silently shipping an empty schema
  // is far worse than a deploy the operator can see failed and retry. Errors
  // propagate (no 2>/dev/null, no `|| true`); sshRunAsync throws on non-zero.
  // --single-transaction: each FILE is atomic, so a mid-file failure leaves no
  // partial schema (2026-08-25 vibecarbon.com: 00008 failed at cron.schedule
  // AFTER its tables had already been created — see docs/rca/).
  await sshRunAsync(
    ip,
    sshKeyPath,
    `cd ${remoteDir} && ` +
      `for f in $(ls supabase/migrations/ 2>/dev/null | sort); do ` +
      `echo "[migrate] applying $f"; ` +
      `cat "supabase/migrations/$f" | docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction || ` +
      `{ echo "[migrate] FAILED applying $f" >&2; exit 1; }; ` +
      `done`,
    { timeout: 300_000 },
  );

  // Ground-truth RLS audit: refuse to finish the deploy if any public table
  // reached the live schema without row-level security (see rls-audit.js).
  // Runs against the actual catalog, so it catches tables added by any path —
  // a migration that forgot RLS, a hand edit in Studio, a dependency. sshRun
  // throws on the non-zero exit, aborting the deploy.
  await sshRunAsync(ip, sshKeyPath, `cd ${remoteDir} && ${composeRlsAuditShell()}`, {
    timeout: 60_000,
  });

  // Ground-truth BACKUP audit (see src/lib/deploy/walg-audit.js): prove wal-g
  // can actually reach the configured bucket from inside the db container.
  // archive_mode=on is hardcoded in docker-compose.yml and the build proves the
  // binary runs, but neither says the credentials/bucket/network line up — a
  // deploy can be green and archiving nothing. Runs here (post-migration, same
  // slot as the RLS audit) so BOTH compose plans get it: the single-compose
  // run-migrations step and compose-ha's, which calls this against the PRIMARY.
  // The probe skips itself on an unconfigured or standby node; anything else
  // that isn't a clean pass throws and fails the deploy.
  await assertWalgBackupsWorking({
    path: 'compose',
    probe: async () => {
      const out = await sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && ${composeWalgAuditShell()}`,
        { timeout: WALG_AUDIT_PROBE_TIMEOUT_MS },
      );
      return typeof out === 'string' ? out : '';
    },
  });

  // Reload PostgREST schema cache so it sees newly created tables. The old
  // `docker compose exec rest kill -s SIGUSR1 1` never worked — the
  // postgrest/postgrest image has no `kill` binary ("exec: kill: executable
  // file not found in $PATH"), so the reload silently no-op'd and fresh tables
  // stayed invisible (PGRST205) until rest happened to restart. RCA prod-1
  // 2026-05-26. Use the canonical SQL NOTIFY on the pgrst channel instead
  // (db-channel-enabled defaults on); fall back to restarting rest if NOTIFY
  // doesn't land. Best-effort: a missed reload self-heals on the next deploy.
  // Lives here so every caller — the compose and compose-ha migration effects
  // (effects/index.js, effects/compose-ha.js) — gets a queryable schema
  // instead of PGRST205.
  await sshRunAsync(
    ip,
    sshKeyPath,
    `cd ${remoteDir} && ` +
      `docker compose exec -T db psql -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema'" 2>/dev/null || ` +
      `docker compose restart rest 2>/dev/null || true`,
  );
}

/**
 * Destroy a Docker Compose deployment
 */
export async function destroyCompose(ip, sshKeyPath, projectName) {
  const remoteDir = `/opt/${projectName}`;

  // Stop and remove containers + volumes
  await sshRun(
    ip,
    sshKeyPath,
    `cd ${remoteDir} && docker compose down -v --remove-orphans 2>/dev/null; rm -rf ${remoteDir}`,
    {
      timeout: 120_000,
    },
  );
}

/**
 * Build the shell command that runs the wal-g base backup on a Compose VPS.
 *
 * `carbon/backup/compose-backup.sh` is the SINGLE source of truth for the
 * backup logic (guard + PGUSER=supabase_admin + wal-g backup-push + delete
 * retain, plus a flock and set -e). This builder is a thin, quote-safe
 * wrapper so the on-demand path and the cron path run byte-identical commands.
 *
 * The `RETAIN=<n>` prefix binds to `bash` (a real command, so the assignment
 * is exported into the script's environment) — NOT to `cd` (a builtin, where
 * it would be discarded). The script reads it via `${RETAIN:-7}`.
 *
 * Invoking via `bash backup/compose-backup.sh` (relative to remoteDir, which
 * we cd into) means the script's exec bit is irrelevant — same lesson as
 * wal-archive.sh. The bundle ships it to `${remoteDir}/backup/`.
 *
 * @param {string} remoteDir  Absolute path to the project directory on the VPS
 *                            (e.g. /opt/myapp)
 * @param {number} [retain=7]  Number of full base backups to keep. Validated
 *                             to a positive integer (injection-safe + sane).
 * @returns {string}
 */
export function composeBackupCmd(remoteDir, retain = 7) {
  const r = Number.isInteger(retain) && retain > 0 ? retain : 7;
  return `cd ${remoteDir} && RETAIN=${r} bash backup/compose-backup.sh`;
}

/**
 * Trigger a wal-g base backup on a Compose VPS via compose-backup.sh.
 *
 * wal-g pushes the backup directly to S3 from inside the db container —
 * there is no local archive to scp or upload. Success = exit 0.
 *
 * FAILURE MUST PROPAGATE. This used the string-command `sshRun` above, which
 * returns `false` instead of throwing — so a failed `backup-push` resolved as
 * a SUCCESS. That silently broke a documented invariant: scale.js awaits this
 * promise specifically so "a backup failure still aborts scale there (before
 * any restore/destroy)", and `vibecarbon backup` has a catch that could never
 * fire. Worse, on the scale path a swallowed push means the following
 * `restoreCompose` fetches an OLDER base backup and the old server is then
 * destroyed — silent data loss dressed as a clean scale. `sshRunAsync` throws
 * on remote non-zero and carries its own SSH-transport retry, so the transient
 * SSH failures the old runner absorbed are still absorbed.
 *
 * The push is wrapped in the object-storage staleness retry for the same
 * reason the restore's fetch is: `wal-g backup-push` LISTs the prefix before
 * writing and `wal-g delete retain` LISTs it again immediately after — a
 * read-after-write against a bucket that may have been created minutes ago.
 * See src/lib/deploy/walg-staleness.js.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string} projectName
 * @param {object} [options]
 * @param {number} [options.retain]  Full base backups to keep (default 7).
 * @param {number[]} [options.staleRetryDelaysMs]  Test seam for the staleness
 *   retry ladder; production callers omit it.
 */
export async function backupCompose(ip, sshKeyPath, projectName, options = {}) {
  const remoteDir = `/opt/${projectName}`;
  const t = perfTimer('backup.walgPush');
  await withWalgStaleStorageRetry(
    () =>
      sshRunAsync(ip, sshKeyPath, composeBackupCmd(remoteDir, options.retain ?? 7), {
        timeout: 900_000,
      }),
    'backup-push',
    { delaysMs: options.staleRetryDelaysMs },
  );
  t.end();
}

/**
 * Set up the automated wal-g backup cron on the VPS.
 *
 * Installs a crontab entry that runs compose-backup.sh on the configured
 * schedule — the SAME builder the on-demand path uses, so there is exactly
 * one quoting/invocation path. No awscli required — wal-g already has S3
 * credentials via env vars in docker-compose.yml.
 *
 * The cron line contains no single quotes (the builder is plain
 * `cd … && RETAIN=N bash …`), so it is installed quote-safely by piping the
 * new crontab through stdin (heredoc) rather than wrapping it in `echo '…'`.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string} projectName
 * @param {object} [backupConfig]
 * @param {string} [backupConfig.schedule]
 * @param {number} [backupConfig.retentionDays]
 * @param {object} [opts]
 * @param {(ip: string, key: string, script: string, o: object) => unknown} [opts.runScript=sshRunScript]
 *   Injectable script runner — defaults to the real SSH runner; overridden in unit tests.
 */
export async function setupComposeBackupCron(ip, sshKeyPath, projectName, backupConfig, opts = {}) {
  const { runScript = sshRunScript } = opts;
  const remoteDir = `/opt/${projectName}`;
  const schedule = backupConfig?.schedule || '0 2 * * *';
  const retain =
    Number.isInteger(backupConfig?.retentionDays) && backupConfig.retentionDays > 0
      ? backupConfig.retentionDays
      : 7;

  const cronLine = `${schedule} ${composeBackupCmd(remoteDir, retain)} >> ${remoteDir}/backups/backup.log 2>&1`;

  // Install quote-safely: build the next crontab on the server (existing minus
  // any prior compose-backup.sh line, plus our line) and pipe via stdin. The
  // cron line is fed to `cat` through a heredoc so no shell quoting can mangle
  // it — there are no single quotes in it to collide with anyway.
  const installScript = [
    'set -e',
    `mkdir -p ${remoteDir}/backups`,
    'TMP_CRON=$(mktemp)',
    'crontab -l 2>/dev/null | grep -v \'compose-backup.sh\' > "$TMP_CRON" || true',
    'cat >> "$TMP_CRON" <<\'VC_CRON_EOF\'',
    cronLine,
    'VC_CRON_EOF',
    'crontab "$TMP_CRON"',
    'rm -f "$TMP_CRON"',
  ].join('\n');

  await runScript(ip, sshKeyPath, installScript, { timeout: 60_000 });
}

// ISO-8601 datetime: YYYY-MM-DDTHH:MM:SS followed by Z or ±HH:MM
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

/**
 * Build the shell script that fetches a wal-g base backup and writes the
 * archive-recovery configuration so postgres replays WAL from S3 and
 * promotes to read-write on completion (or at a PITR target).
 *
 * This is a pure function (no I/O) so it can be unit-tested without SSH.
 * The script is SCP'd to the server and bind-mounted into the db container
 * via `docker compose run --rm -v …:/restore.sh:ro db bash /restore.sh`,
 * which avoids the quoting collision that would arise from embedding
 * single-quoted postgres config values in a deeply-nested ssh command.
 *
 * Mirrors the k8s walg-restore init container in carbon/k8s/values/supabase.values.yaml.
 *
 * @param {'latest' | string} target  'latest' for the most-recent base backup,
 *   or an ISO-8601 datetime string for point-in-time recovery.
 * @returns {string} The bash script body.
 */
export function composeRestoreScript(target) {
  if (target !== 'latest' && !ISO_DATETIME_RE.test(target)) {
    throw new Error(
      `Invalid target ${JSON.stringify(target)}: must be "latest" or an ISO-8601 datetime (e.g. 2026-05-31T12:00:00Z)`,
    );
  }

  // pitrLine goes inside the { ... } block — no separate redirect needed
  const pitrLine = target !== 'latest' ? `  echo "recovery_target_time = '${target}'"` : null;

  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'PGDATA=/var/lib/postgresql/data',
    '',
    '# Empty PGDATA, wal-g backup-fetch requires an empty target dir. We are',
    '# inside the db container, which mounts the real <project>_db_data volume',
    '# at $PGDATA, so this clears the correct data (unlike a `docker compose run',
    "# -v db_data:/data` flag, which bypasses Compose's project-volume naming).",
    'if [ -f "$PGDATA/PG_VERSION" ]; then',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${PGDATA:?} is a deliberate bash "fail if unset" guard, not a JS template placeholder
    '  rm -rf "${PGDATA:?}/"* "${PGDATA:?}/".* 2>/dev/null || true',
    'fi',
    '',
    '# Fetch the base backup from S3 (wal-g reads S3 credentials from container env)',
    `wal-g backup-fetch "$PGDATA" LATEST`,
    '',
    '# Remove any recovery settings left in postgresql.auto.conf by a previous',
    "# restore so they don't accumulate across cycles (postgres takes the last",
    '# value, but stale duplicates are confusing).',
    'if [ -f "$PGDATA/postgresql.auto.conf" ]; then',
    '  sed -i "/^restore_command =/d; /^recovery_target_action =/d; /^recovery_target_time =/d; /^recovery_target_timeline =/d" "$PGDATA/postgresql.auto.conf"',
    'fi',
    '',
    '# Write archive-recovery config so postgres replays WAL segments from S3',
    '# and promotes to read-write on end-of-WAL (or at the PITR target).',
    '# Uses >> so any existing postgresql.auto.conf settings are preserved.',
    '{',
    `  echo "restore_command = 'wal-g wal-fetch \\"%f\\" \\"%p\\"'"`,
    `  echo "recovery_target_action = 'promote'"`,
    // Pin recovery to the FETCHED base backup's own timeline. Default is
    // 'latest', which makes postgres chase the newest timeline it can find a
    // .history file for. In HA, repeated restore→promote cycles accumulate
    // DIVERGENT timelines in the shared wal-g S3 prefix, and 'latest' picks one
    // that forked off BEFORE this base backup's checkpoint — postgres then
    // crash-loops "requested timeline N is not a child of this server's history"
    // / wal-g "Archive '0000000N.history' does not exist". 'current' recovers
    // along the base backup's timeline to end-of-WAL, then promotes fresh.
    // (RCA 2026-06-01: compose-ha kept-rig restore.)
    `  echo "recovery_target_timeline = 'current'"`,
    pitrLine,
    '} >> "$PGDATA/postgresql.auto.conf"',
    '',
    '# Signal file that tells postgres to enter archive recovery mode (PG 12+)',
    'touch "$PGDATA/recovery.signal"',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Poll interval for the post-restore promotion wait. Tightened from a flat 5s
 * to 2s: the loop already early-exits the instant pg_is_in_recovery() flips to
 * false, so a shorter interval just detects promotion ~sooner on the common
 * fast path without adding load (one lightweight psql exec per poll).
 */
export const RESTORE_PROMOTE_POLL_MS = 2000;

/**
 * Restore from a wal-g base backup via Docker Compose with full archive
 * recovery. Postgres replays WAL segments from S3 via restore_command and
 * promotes to read-write on reaching end-of-WAL or the PITR target.
 *
 * S3 credentials are read from the db container's environment (sourced from
 * the project .env file) — DO NOT pass them as -e overrides; the container
 * already has WALG_S3_PREFIX + AWS_* set by carbon/docker-compose.yml.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string} projectName
 * @param {'latest' | string} [target='latest']  'latest' or ISO-8601 PITR timestamp.
 * @param {object} [options]
 * @param {number[]} [options.staleRetryDelaysMs]  Test seam for the
 *   object-storage staleness retry ladder; production callers omit it.
 */
export async function restoreCompose(ip, sshKeyPath, projectName, target = 'latest', options = {}) {
  const remoteDir = `/opt/${projectName}`;

  // Build and validate the restore script early — fail before touching the
  // running server if the target is malformed.
  const scriptBody = composeRestoreScript(target);

  // 1. Stop app to prevent connections during restore
  await sshRunAsync(
    ip,
    sshKeyPath,
    `cd ${remoteDir} && docker compose stop app 2>/dev/null || true`,
  );

  // 2. Stop the DB. The restore container (step 4) clears PGDATA *itself*
  //    from inside the db container — where the real ${project}_db_data volume
  //    is mounted at $PGDATA — so there is no separate volume-clearing step.
  //    (A `docker compose run --rm -v db_data:/data alpine` would clear a
  //    literal `db_data` volume, NOT the project-prefixed one Compose uses.)
  await sshRunAsync(ip, sshKeyPath, `cd ${remoteDir} && docker compose stop db`);

  // 3. Write the restore script to the server (heredoc — no quoting risk) and
  //    bind-mount it into the db container. The script body contains single
  //    quotes (restore_command = 'wal-g wal-fetch ...') so it MUST go via a
  //    file rather than a nested bash -c '...' invocation. The script clears
  //    PGDATA, runs wal-g backup-fetch, and writes the archive-recovery config.
  await sshRunScript(
    ip,
    sshKeyPath,
    [
      'set -e',
      `cat > ${remoteDir}/restore-walg.sh <<'VC_RESTORE_EOF'`,
      scriptBody,
      'VC_RESTORE_EOF',
      `chmod +x ${remoteDir}/restore-walg.sh`,
    ].join('\n'),
    { timeout: 30_000 },
  );

  // THE wal-g FETCH. Wrapped in the object-storage staleness retry: this exec
  // is where a compose scale died on 2026-07-31 — the old server's base-backup
  // push had succeeded seconds earlier, and the new server's first read of the
  // same prefix hit a Hetzner frontend that had not caught up and answered
  // `NoSuchBucket: status code: 404`. Re-running the WHOLE script is the right
  // unit of retry: it is self-contained and, for this failure, idempotent — the
  // staleness lands on the initial S3 LIST ("Selecting the latest backup"),
  // before a single byte is fetched, so attempt 2 re-clears a $PGDATA that is
  // already empty and fetches from scratch against a stopped db. (A 404 landing
  // MID-fetch instead would leave partial files behind, and composeRestoreScript
  // only re-clears when a complete cluster is present — that retry then fails on
  // wal-g's own non-empty-target error, i.e. no worse than today's single-shot
  // failure, with a message that names the real state.) Non-staleness failures
  // fail on attempt 1 unchanged, and a bucket that really is missing still fails
  // once the budget is spent. See src/lib/deploy/walg-staleness.js.
  await withWalgStaleStorageRetry(
    () =>
      sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose run --rm -v ${remoteDir}/restore-walg.sh:/restore.sh:ro db bash /restore.sh`,
        { timeout: 900_000 },
      ),
    'backup-fetch (restore)',
    { delaysMs: options.staleRetryDelaysMs },
  );

  // 4. Start the DB — postgres enters archive recovery, replays WAL, promotes
  await sshRunAsync(ip, sshKeyPath, `cd ${remoteDir} && docker compose start db`);

  // 5. Poll until postgres has promoted (pg_isready + pg_is_in_recovery() = f).
  //    WAL replay can take 1-2 minutes; deadline is 300s. Poll early-exits the
  //    instant pg_is_in_recovery() flips false (RESTORE_PROMOTE_POLL_MS cadence).
  const deadline = Date.now() + 300_000;
  let lastErr = '';
  for (;;) {
    try {
      // First check: postgres accepting connections
      await sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T db pg_isready -U postgres`,
        { timeout: 10_000 },
      );
      // Second check: promoted (no longer in recovery)
      const recovering = await sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T db psql -U postgres -At -c 'SELECT pg_is_in_recovery()'`,
        { timeout: 10_000 },
      );
      if (String(recovering).trim() === 'f') {
        break; // promoted — restore complete
      }
      lastErr = 'pg_is_in_recovery() still true';
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `restoreCompose: postgres did not promote within 300s after wal-g restore. ` +
          `Last error: ${lastErr}`,
      );
    }
    await new Promise((r) => setTimeout(r, RESTORE_PROMOTE_POLL_MS));
  }

  // 6. Bring the app back up
  await sshRunAsync(ip, sshKeyPath, `cd ${remoteDir} && docker compose start app`);
}

/**
 * Extract the admin credentials a deploy needs to provision the super-admin
 * out of a project `.env` file's text.
 *
 * `create` writes these via `escapeDotenv` (ADMIN_PASSWORD is POSIX
 * single-quoted) and double-quotes for the rest, so the on-disk shapes are a
 * mix of `'…'` and `"…"`. Decoding MUST go through `parseDotenv`/`unescapeDotenv`
 * — the inverse of `escapeDotenv` — or single-quote wrappers leak into the
 * value and GoTrue provisions a password the operator can never type.
 *
 * @param {string} envContent
 * @returns {{adminEmail?: string, adminPassword?: string, serviceRoleKey?: string}}
 */
export function readAdminCredentials(envContent) {
  const env = parseDotenv(envContent);
  return {
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

// ---------------------------------------------------------------------------
// createAdminUser Phase B: the `ssh -N -L <local>:localhost:8000` tunnel to
// Kong. Constants + helpers live at module scope so the tunnel's diagnostics
// are greppable from a deploy log and unit-testable through createAdminUser's
// injected `spawnImpl` seam.
// ---------------------------------------------------------------------------

/** Operator-side base port for the GoTrue admin tunnel. */
const ADMIN_TUNNEL_BASE_PORT = 19876;
/**
 * How many consecutive local ports the bind may walk before giving up. Ten
 * covers a full local e2e matrix several times over — the only producers of
 * concurrent compose admin tunnels on one machine.
 */
const ADMIN_TUNNEL_PORT_WALK = 10;
/** Bounded stderr tail kept per tunnel child. */
const ADMIN_TUNNEL_STDERR_TAIL_LINES = 10;
const ADMIN_TUNNEL_STDERR_TAIL_CHARS = 2000;
/** Grace for a dying ssh child's stderr to flush when 'close' never arrives. */
const ADMIN_TUNNEL_EXIT_FLUSH_MS = 500;
/** OpenSSH's own wording for a local-forward bind collision. */
const ADMIN_TUNNEL_BIND_CONFLICT =
  /address already in use|cannot listen to port|could not request local forwarding/i;

/**
 * Last-N-lines tail of an ssh child's stderr, bounded by chars first and then
 * lines so neither a chatty session nor one runaway line can paste a whole
 * log into a deploy error.
 *
 * @param {string} text
 * @returns {string}
 */
function tailStderr(text) {
  return text
    .slice(-ADMIN_TUNNEL_STDERR_TAIL_CHARS)
    .split('\n')
    .slice(-ADMIN_TUNNEL_STDERR_TAIL_LINES)
    .join('\n');
}

/**
 * Flatten a fetch rejection into one log-safe line.
 *
 * Node's fetch throws a bland `TypeError: fetch failed` and hides the part
 * that actually discriminates the failure (ECONNREFUSED = nothing listening
 * on the forwarded port, vs ETIMEDOUT / socket hang up = the tunnel is up but
 * Kong/GoTrue isn't answering) in `.cause`.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeFetchError(err) {
  if (!err) return 'no fetch error recorded';
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  const code = (cause instanceof Error ? /** @type {any} */ (cause).code : undefined) ?? err.code;
  let text = detail && detail !== err.message ? `${err.message} (${detail})` : err.message;
  if (code && !text.includes(code)) text += ` [${code}]`;
  return text;
}

/**
 * Open the Phase B admin tunnel, wrapped with the evidence its failure paths
 * need: a bounded stderr tail, the exit code/signal (or spawn error), and a
 * `settled` promise that resolves the moment the child dies.
 *
 * `ExitOnForwardFailure=yes` is what turns a local bind collision from a
 * SILENT failure into a classifiable one: a plain `ssh -N -L` whose bind
 * fails keeps the session alive with no forward, so the health poll below
 * just times out and the deploy blames an unreachable auth service (the
 * 2026-07-31 compose-ha warm-redeploy incident). stderr is PIPED for the same
 * reason — it is the only channel carrying ssh's own diagnosis, and the
 * previous `stdio: 'ignore'` discarded it.
 *
 * @param {object} args
 * @param {number} args.localPort
 * @param {string} args.serverIp
 * @param {string} args.sshKeyPath
 * @param {typeof spawn} args.spawnImpl
 */
function openAdminTunnel({ localPort, serverIp, sshKeyPath, spawnImpl }) {
  const child = spawnImpl(
    'ssh',
    [
      // BEFORE the shared opts: OpenSSH takes the FIRST value obtained for
      // each option (ssh_config(5)), so the opt-out must precede the shared
      // opts' ControlMaster=auto or it is inert — run 31927810430 proved the
      // appended form still muxed (a muxed -L tunnel races its forward
      // registration through the shared master; run 31921730114 — every
      // first attempt ECONNREFUSED).
      ...SSH_TUNNEL_NO_MUX_OPTS,
      // shell-safety-ignore: argv form (no shell); composeSshOpts() bakes in BatchMode=yes
      ...composeSshOpts(sshKeyPath),
      '-i',
      sshKeyPath,
      '-o',
      'ExitOnForwardFailure=yes',
      '-N',
      '-L',
      `${localPort}:localhost:8000`,
      `root@${serverIp}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  /** @type {{code: number|null, signal: string|null}|null} */
  let exitInfo = null;
  /** @type {Error|null} */
  let spawnError = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let flushTimer = null;
  let resolveSettled = () => {};
  const settled = new Promise((resolve) => {
    resolveSettled = resolve;
  });
  const finish = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    resolveSettled();
  };

  child.stderr?.on?.('data', (chunk) => {
    stderr = tailStderr(stderr + String(chunk));
  });
  // A spawn-level failure ('error', e.g. ENOENT) must not crash the deploy as
  // an unhandled ChildProcess event — it stays folded into the same retry
  // budget as any other reach failure, but now carries its message.
  child.on('error', (err) => {
    spawnError = err;
    finish();
  });
  // Settle on 'close' where possible (stderr is flushed by then); 'exit' can
  // fire with data still queued on the pipe. If 'close' never arrives, the
  // grace timer settles anyway so an attempt can't hang waiting for it.
  child.on('close', finish);
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    if (!flushTimer) flushTimer = setTimeout(finish, ADMIN_TUNNEL_EXIT_FLUSH_MS);
  });

  return {
    localPort,
    /** Resolves once the child has died (never, for a healthy tunnel). */
    settled,
    get dead() {
      return exitInfo !== null || spawnError !== null;
    },
    /** True when ssh's stderr names a local-forward bind collision. */
    get bindConflict() {
      return ADMIN_TUNNEL_BIND_CONFLICT.test(stderr);
    },
    /** One-line `ssh: …` clause for a deploy error / retry log line. */
    describe() {
      if (spawnError) return `ssh: spawn failed: ${spawnError.message}`;
      const tail = stderr.trim().replace(/\s*\n\s*/g, ' / ');
      let state;
      if (exitInfo === null) state = 'still running';
      else if (exitInfo.code === null || exitInfo.code === undefined)
        state = `killed by ${exitInfo.signal ?? 'an unknown signal'}`;
      else state = `exited ${exitInfo.code}${exitInfo.signal ? ` (${exitInfo.signal})` : ''}`;
      return tail ? `ssh: ${state}; ${tail}` : `ssh: ${state}, no stderr`;
    },
    /** Idempotent teardown — safe to call on every exit path. */
    close() {
      try {
        child.kill();
      } catch {
        // already gone
      }
      child.stderr?.destroy?.();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
    },
  };
}

/**
 * Create the admin user in production Supabase via the GoTrue admin API.
 *
 * The user created during `vibecarbon create` only exists in the local Docker
 * Compose Supabase. Production needs its own admin user. The API returns 422
 * if the user already exists, making this idempotent.
 *
 * Fast-follow to M3 Task 9h (mirrors k3s.js#provisionAdminUser's fix, adapted
 * to compose's mechanics): a transient failure here used to log a warning
 * ("Run `vibecarbon deploy` again to retry") and let the deploy report
 * SUCCESS with no admin.users row — the exact bug class 9h killed on the k8s
 * path, on the path that actually runs production (vibecarbon.com is
 * compose, not k8s).
 *
 * Unlike k8s, compose has no upstream gate equivalent to `helm upgrade
 * --wait` (which already confirms GoTrue Available before
 * provisionAdminUser ever runs there): `startComposeStack` only waits for
 * `docker compose up -d` to CREATE the containers, and `verifyAppHealth` (the
 * closest thing to a readiness gate) runs LAST, AFTER this step. So the
 * auth-readiness poll below (Phase A) is folded into the retried unit rather
 * than treated as an already-guaranteed precondition the way k8s's
 * port-forward retry can be.
 *
 * Credentials-missing (no ADMIN_EMAIL/ADMIN_PASSWORD/SUPABASE_SERVICE_ROLE_KEY
 * resolvable from the project's `.env`, including a missing `.env` file) is
 * NOT retryable (there's nothing to poll for) and is NOT a soft return:
 * `create` always writes these into `.env`, and they're also
 * GH-Environment-managed CI secrets (see github-environments.js) — a real
 * customer CI run with a missing/misnamed secret hits this exact branch and
 * would otherwise ship the identical half-configured stack. Throws.
 *
 * @param {string} serverIp - IP of the server running Supabase
 * @param {string} sshKeyPath - Path to SSH private key
 * @param {string} projectName - Project name (for remote dir)
 * @param {{spawnImpl?: typeof spawn, fetchImpl?: typeof fetch}} [opts]
 *   (The former `retryDelaysMs` reach-and-provision ladder is removed —
 *   band-aid removal 2026-08-16. One attempt: the pg_isready gate closes the
 *   db-driven GoTrue 500s the ladder absorbed, Phase A still polls auth's own
 *   health up to ~52.5s, and Phase B owns per-attempt tunnel teardown. A
 *   genuinely wedged auth container fails the deploy loudly with per-phase
 *   diagnostics.)
 *
 *   `spawnImpl` / `fetchImpl` — injection seams for the `ssh -L` tunnel child
 *   and the health-poll fetch (same DI convention as admin-user.js's
 *   `fetchImpl`). Production callers omit both; tests inject fakes so the
 *   tunnel's diagnostics can be asserted without mocking `node:child_process`
 *   (builtin-module mocks are not reliably scoped per file under the parallel
 *   unit run — see compose-admin-user-retry.test.ts's header).
 * @returns {Promise<{success: boolean, message: string}>} resolves only on
 *   success (admin created, or already exists — idempotent).
 * @throws {Error} if required admin credentials are missing from `.env`, or
 *   if GoTrue stays unreachable (or the admin-user POST keeps failing)
 *   through the whole retry budget.
 */
export async function createAdminUser(
  serverIp,
  sshKeyPath,
  projectName,
  { spawnImpl = spawn, fetchImpl = fetch } = {},
) {
  const envPath = join(process.cwd(), '.env');
  const envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const { adminEmail, adminPassword, serviceRoleKey } = readAdminCredentials(envContent);

  if (!adminEmail || !adminPassword || !serviceRoleKey) {
    const missing = [
      !adminEmail && 'ADMIN_EMAIL',
      !adminPassword && 'ADMIN_PASSWORD',
      !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean);
    throw new Error(
      `Admin credentials missing (${missing.join(', ')}) — admin login will not work. Expected ` +
        `as keys in the project's .env for a local deploy, or as the matching per-environment ` +
        `GitHub Environment secret(s) for a CI deploy.`,
    );
  }

  const remoteDir = `/opt/${projectName}`;
  // The retry ladder that lived here is REMOVED (band-aid removal,
  // 2026-08-16): its trigger — GoTrue answering /health but 500ing the admin
  // POST while its DB session pool was refused — is closed at the source by
  // the pg_isready gate below. One attempt; a failure is loud and carries the
  // per-phase cause.
  const attemptErrors = [];

  // One attempt: wait for auth to answer its own health check (Phase A),
  // then open a fresh SSH port-forward, wait for it to answer through Kong,
  // POST the admin user, and always tear the tunnel down (Phase B). Mirrors
  // k3s.js#provisionAdminUser's per-attempt tunnel lifecycle (open → use →
  // teardown in `finally`) so a wedged tunnel from a failed attempt can't
  // block the next attempt from re-opening the same localPort.
  // Phase A0: gate on the DATABASE accepting connections before touching the
  // app tier at all (mitigation-audit cluster 5, 2026-08-16). The GoTrue 500s
  // the retry ladder below absorbs are db-driven: auth can answer its /health
  // while its session pool is still refused by a mid-lifecycle Postgres.
  // pg_isready exits 0 only when the server would accept a connection — the
  // condition, polled once at the source instead of rediscovered per attempt.
  // Bounded and non-fatal on exhaustion: the health/attempt machinery below
  // remains the loud failure path with its richer diagnostics.
  for (let i = 0; i < 30; i++) {
    let ready = false;
    try {
      ready = Boolean(
        await sshRunAsync(
          serverIp,
          sshKeyPath,
          `cd ${remoteDir} && docker compose exec -T db pg_isready -U postgres -t 3`,
          { silent: true },
        ),
      );
    } catch {
      // A probe transport error is "not ready yet", never a hard failure:
      // Phase A below owns the loud diagnostics for a genuinely unreachable
      // host, with three distinguishable outcomes this gate must not preempt.
    }
    if (ready) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  const attemptOnce = async () => {
    // Phase A: poll the auth container's own health endpoint directly over
    // SSH exec (bypassing the tunnel) before spending a port on it. Short
    // initial interval catches the fast path (GoTrue is typically healthy
    // 15-25s after the stack starts); backs off after 5 tries so we're not
    // hammering `docker compose exec` during a slow boot.
    let authReady = false;
    // What the LAST probe actually produced. Three outcomes are worth telling
    // apart in the failure message: the SSH exec never ran (null — the hop
    // itself is broken, not the container), the container answered with
    // nothing (still booting / crash-looping), or something answered that
    // isn't GoTrue.
    let lastProbe = 'no probe ran';
    for (let i = 0; i < 30; i++) {
      const health = await sshRunAsync(
        serverIp,
        sshKeyPath,
        `cd ${remoteDir} && docker compose exec -T auth wget -qO- http://localhost:9999/health 2>/dev/null || true`,
        { timeout: 10_000, ignoreError: true },
      );
      if (health?.includes('GoTrue')) {
        authReady = true;
        break;
      }
      if (health === null || health === false) {
        lastProbe = 'the SSH health probe itself failed (see the [retry] ssh lines above)';
      } else {
        const out = String(health).trim();
        lastProbe = out
          ? `last probe output: ${out.slice(-200)}`
          : 'the auth container answered with nothing';
      }
      const interval = i < 5 ? 500 : 2000;
      await new Promise((r) => setTimeout(r, interval));
    }
    if (!authReady) {
      throw new Error(
        `Auth service not ready; the docker compose health check never reported GoTrue ` +
          `across 30 polls (${lastProbe})`,
      );
    }

    // Phase B: create admin user via GoTrue admin API through an SSH
    // port-forward. Uses native fetch to avoid shell escaping issues with
    // special chars in passwords.
    //
    // The local port is WALKED (19876 → 19885) rather than pinned. A leaked
    // tunnel from an earlier run — or a sibling compose deploy on the same
    // operator machine, which the local e2e matrix produces by running
    // compose and compose-ha concurrently — holds the base port, and every
    // attempt then fails identically for a reason that has nothing to do
    // with the server. Same bind-race resilience and same rationale as
    // registry-push.js#openTunnelOrWalk: "ssh bound it" is the only truthful
    // free-port signal, so probe-then-bind would just be a TOCTOU race.
    // (k3s.js#provisionAdminUser deliberately does NOT walk: there the HA
    // primary/standby pair provisions in parallel on adjacent fixed bases and
    // a walk could step one cluster's retry onto the other's. The compose
    // path has no such sibling — compose-ha provisions the admin on the
    // PRIMARY only, one tunnel at a time.)
    //
    // A squatting tunnel is walked PAST, never pkill'd: the only pattern that
    // would match it (`ssh.*-L.*<port>:localhost:8000`) matches a sibling
    // deploy's LIVE forward just as well. Same call as registry-push.js.
    const bindFailures = [];
    for (let probe = 0; probe < ADMIN_TUNNEL_PORT_WALK; probe++) {
      const localPort = ADMIN_TUNNEL_BASE_PORT + probe;
      const tunnel = openAdminTunnel({ localPort, serverIp, sshKeyPath, spawnImpl });
      try {
        // Record the last health-poll fetch error through waitForGotrueHealth's
        // existing `fetchImpl` seam. That helper returns a bare boolean by
        // design (k3s.js reads it the same way), so wrapping the fetch here
        // keeps the cause without changing a contract shared with the k8s path.
        let lastFetchError = null;
        const probeFetch = async (url, init) => {
          // The tunnel is already gone; fail fast instead of spending the rest
          // of the poll's budget fetching a closed port.
          if (tunnel.dead) throw new Error('ssh tunnel exited');
          try {
            const res = await fetchImpl(url, init);
            if (!res.ok) lastFetchError = new Error(`HTTP ${res.status} from ${url}`);
            return res;
          } catch (err) {
            lastFetchError = err;
            throw err;
          }
        };

        // Race the reach poll against the tunnel's own death so a bind
        // collision (or a rejected SSH connection) is classified immediately
        // instead of after the poll burns its full ~7.5s budget.
        const outcome = await Promise.race([
          waitForGotrueHealth(`http://localhost:${localPort}/auth/v1/health`, {
            attempts: 15,
            intervalMs: 500,
            fetchImpl: probeFetch,
          }).then((ok) => (ok ? 'healthy' : 'unreachable')),
          tunnel.settled.then(() => 'tunnel-died'),
        ]);

        if (outcome === 'tunnel-died' && tunnel.bindConflict) {
          bindFailures.push(`port ${localPort}: ${tunnel.describe()}`);
          progressLog(
            `[compose] admin tunnel: local port ${localPort} is already bound ` +
              `(${tunnel.describe()}), trying ${localPort + 1}.`,
          );
          continue;
        }
        if (outcome !== 'healthy') {
          // Everything the next RCA needs, on one line: which port, what the
          // last HTTP attempt actually said, and what ssh itself reported.
          throw new Error(
            `Could not reach auth service via SSH tunnel on localhost:${localPort} ` +
              `(last error: ${describeFetchError(lastFetchError)}; ${tunnel.describe()})`,
          );
        }

        // POST through Kong, which rewrites /auth/v1 → GoTrue's /.
        const result = await postAdminUser({
          adminUsersUrl: `http://localhost:${localPort}/auth/v1/admin/users`,
          serviceRoleKey,
          adminEmail,
          adminPassword,
        });
        if (!result.success) {
          throw new Error(result.message);
        }
        return result;
      } finally {
        // Every exit path — success, unreachable, POST failure, throw, and
        // the `continue` above — reaps this attempt's tunnel.
        tunnel.close();
      }
    }
    throw new Error(
      `Could not open an SSH tunnel to the GoTrue admin API on any local port in ` +
        `[${ADMIN_TUNNEL_BASE_PORT}, ${ADMIN_TUNNEL_BASE_PORT + ADMIN_TUNNEL_PORT_WALK - 1}], ` +
        `every candidate was already bound (a leaked tunnel from an earlier run, or a sibling ` +
        `deploy on this machine). Errors: ${bindFailures.join(' | ')}`,
    );
  };

  try {
    return await attemptOnce();
  } catch (err) {
    attemptErrors.push(err instanceof Error ? err.message : String(err));
    // Loud failure (fast-follow to M3 Task 9h): no warn-and-continue crutch.
    // States what failed, the consequence, and what was attempted so the
    // operator/CI log is actionable without re-running to discover it.
    // Numbered per-attempt, same shape as k3s.js#provisionAdminUser /
    // pushImageOverSshTunnel's exhausted-attempts errors.
    throw new Error(
      `GoTrue admin-user provisioning failed after ${attemptErrors.length} attempt${attemptErrors.length === 1 ? '' : 's'} — ` +
        `admin login will not work. Errors: ${attemptErrors.map((m, i) => `[#${i + 1}] ${m}`).join(' | ')}`,
    );
  }
}
