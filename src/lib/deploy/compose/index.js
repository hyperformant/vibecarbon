/**
 * Docker Compose Production Deployment Module
 *
 * Deploys Vibecarbon projects to a single VPS using Docker Compose.
 *
 * Provisioning is Hetzner (automated): the HetznerProvider API creates the VPS.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBackupSettings } from '../../../../carbon/scripts/render-backup-settings.mjs';
import { progressLog, spinner } from '../../cli/progress.js';
import { runCommandAsync } from '../../command.js';
import { buildHostKeyOpts } from '../../host-keys.js';
import { K8S_MIRROR_ORG, mirroredPackageNames } from '../../images.js';
import { perfAsync, perfTimer } from '../../perf.js';
import { redactCredentials } from '../../redact-credentials.js';
import { pollUntil } from '../../retry.js';
import { ADDON_SERVICES_SCRIPT } from '../../services/addon-start.js';
import { shEscape } from '../../shell.js';
import {
  isDnsNotSettledSshCommandError,
  isTransientSshCommandError,
  runWithTransportRetry,
  sshRunScript,
} from '../../ssh.js';
import { validateDomain } from '../../validators.js';
import { hasBackupResult, parseBackupResult } from '../../walg/backup-result.js';
import {
  assertRestoreFits,
  BACKUP_NAME_RE,
  LINEAGE_RE,
  PGDATA_PATH,
  PREVIOUS_PGDATA_PATH,
  PROVEN_WRITABLE_STATES,
  REMOVE_DISCARD_SH,
  RESTORE_ATTEMPT_RE,
  RESTORE_LAYOUT,
  RETIRE_PREVIOUS_SH,
  restoreFetchTimeoutS,
  WAL_GAP_RECORDS,
  WALG_ENV_SOURCE,
} from '../../walg/restore-layout.js';
import {
  ADMIN_PROBE_EXIT,
  adminNotReadyHint,
  adminReadyProbeScript,
  describeAdminProbeExit,
  isAdminProbeExit,
  isTerminalAdminProbeExit,
} from '../admin-ready.js';
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
  // cold while the images pull. Replaces the previous
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
    // A failed migration fails app-migrate, which keeps the app from
    // starting; its log has the one-line cause.
    try {
      const migrateLogs = await sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose logs app-migrate --tail=30 2>&1 || true`,
        { timeout: 30_000 },
      );
      if (typeof migrateLogs === 'string' && migrateLogs.trim()) {
        err.message = `${err.message}\n--- app-migrate logs (last 30 lines) ---\n${migrateLogs.trim()}`;
      }
    } catch (logErr) {
      err.message = `${err.message}\n(failed to capture app-migrate logs: ${logErr.message})`;
    }
    throw err;
  }
}

/**
 * Wait for all compose services with healthchecks to reach "healthy".
 *
 * `docker compose up -d` returns as soon as containers are *created*, not
 * when their healthchecks pass. A service probed while it is still starting
 * (an add-on such as n8n or metabase, or traefik) can 502 the first
 * post-deploy checks. Polls every 5s up to 3min; returns early once every
 * service with a declared healthcheck reports "healthy".
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
 * verifyAppHealth runs LAST (after wait-admin-ready + audit-database), so the app is
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
        // App is serving, but other services (traefik, add-ons) may still
        // be warming up their healthchecks. The e2e harness's verify-deploy
        // probes the public endpoints immediately after deploy returns, and a
        // 502 from a service still 60s from healthy would fail otherwise-valid
        // deploys. Wait for all compose-managed services
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
        `cd ${remoteDir} && docker compose ps -a --format '{{.Name}}\\t{{.State}}\\t{{.Status}}' 2>&1 | head -20`,
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
        // app-migrate too: a failed migration stops the app from starting.
        `cd ${remoteDir} && docker compose logs --tail=40 app-migrate app 2>&1 | tail -60`,
        { timeout: 15_000, ignoreError: true },
      )) || '';
  } catch {
    /* best effort */
  }
  const details =
    `Health probe failed after ${attempts} attempts (last status: ${lastStatus})\n` +
    `--- docker compose ps ---\n${ps.trim()}\n` +
    `--- app-migrate and app log tail ---\n${logs.trim()}`;
  return { healthy: false, status: lastStatus, details };
}

/**
 * Wait until the app reports its migrations applied and its super admin
 * ready (`migrationStatus: 'applied'` and `adminReady: true` on its own
 * /api/health, one probe). The app-migrate step applies db/migrations before
 * the app starts; the app checks the ledger, then creates the admin from
 * ADMIN_EMAIL / ADMIN_PASSWORD, which reach the container through the
 * bundled `app.env` (env_file); the prod overlay refuses to start without them,
 * and deploy's required-env preflight checks them before anything is
 * provisioned. The probe runs inside the app container with its own `node`
 * (see src/lib/deploy/admin-ready.js), so no tunnel or published port is
 * involved.
 *
 * Polls with the shared pollUntil (2 s doubling to 10 s, 150 s budget): the
 * app starts with the stack, migrates, and creates the admin a few seconds
 * after the schema lands. Stops at once when the app reports a terminal
 * status (a failed migration; admin refused, skipped, failed), and throws,
 * with the reason and the app's log tail, if it is not ready: a deploy whose
 * schema is not in place, or that the operator cannot sign in to, is not a
 * successful deploy.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string} projectName
 * @param {{budgetMs?: number, initialDelayMs?: number, maxDelayMs?: number, sshRun?: typeof sshRunAsync, poll?: typeof pollUntil}} [options]
 *   `sshRun` / `poll` are test seams.
 * @returns {Promise<{message: string}>}
 */
export async function waitForAdminReady(ip, sshKeyPath, projectName, options = {}) {
  const {
    budgetMs = 150_000,
    initialDelayMs = 2000,
    maxDelayMs = 10_000,
    sshRun = sshRunAsync,
    poll = pollUntil,
  } = options;
  const remoteDir = `/opt/${projectName}`;
  const scriptB64 = Buffer.from(adminReadyProbeScript()).toString('base64');
  // `echo exit=$?` so the probe's own exit code reaches us as text whatever
  // docker compose exec does with it; 2>&1 keeps docker's own stderr (an
  // exec that never reached node) for the error below.
  const probeCmd = `cd ${remoteDir} && echo ${scriptB64} | base64 -d | docker compose exec -T app node - 2>&1; echo "exit=$?"`;

  let lastCode = null;
  let lastOutput = '';
  const probe = async () => {
    const out =
      (await sshRun(ip, sshKeyPath, probeCmd, { timeout: 15_000, ignoreError: true })) || '';
    const m = /exit=(\d+)\s*$/.exec(out.trim());
    lastCode = m ? Number(m[1]) : null;
    lastOutput = out
      .trim()
      .replace(/exit=\d+\s*$/, '')
      .trim();
    // Ready, or a terminal status waiting cannot change: stop polling.
    return lastCode === ADMIN_PROBE_EXIT.READY || isTerminalAdminProbeExit(lastCode);
  };
  try {
    await poll(probe, {
      budgetMs,
      initialDelayMs,
      maxDelayMs,
      description: 'the app to report its super admin ready',
    });
  } catch {
    // Budget spent; the error below says what the last probe saw.
  }
  if (lastCode === ADMIN_PROBE_EXIT.READY) return { message: 'Super admin ready' };

  let logs = '';
  try {
    logs =
      (await sshRun(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose logs --tail=40 app 2>&1 | tail -40`,
        { timeout: 15_000, ignoreError: true },
      )) || '';
  } catch {
    /* best effort */
  }
  const known = isAdminProbeExit(lastCode);
  const headline = isTerminalAdminProbeExit(lastCode)
    ? lastCode === ADMIN_PROBE_EXIT.MIGRATIONS_FAILED
      ? `The app's database migrations failed: ${describeAdminProbeExit(lastCode)}.`
      : `The app's super admin is not ready: ${describeAdminProbeExit(lastCode)}.`
    : `The app did not report its migrations applied and its super admin ready within ${Math.round(budgetMs / 1000)}s ` +
      `(last: ${describeAdminProbeExit(lastCode)}).`;
  throw new Error(
    `${headline}\n` +
      // docker compose exec's own failure (no app container, daemon error).
      (!known && lastOutput ? `--- probe output ---\n${lastOutput.slice(-1000)}\n` : '') +
      `${adminNotReadyHint(`ssh in, then: cd ${remoteDir} && docker compose logs app`)}\n` +
      `--- app container log tail ---\n${logs.trim()}`,
  );
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
 * `--ignore-buildable` stays for any service that carries a `build:` section
 * and a local-only tag (built or sideloaded, never pulled; pulling 401s). The
 * db is not one of them: it is the published image and is pulled here.
 * `--policy missing` stays: warm nodes must not re-download ~2GB.
 * Pinned by tests/unit/deploy/pull-images-loud.test.ts.
 */
/**
 * The remote stack pull: every service EXCEPT those that run the app's image.
 * prod.yml resets the app's `build:` (`build: !reset null`), so
 * `--ignore-buildable` does NOT skip it, and `compose pull` ignores
 * `pull_policy: never`; its image is a local-only tag no registry serves. The
 * first loud run (linode 32640636398) showed what that does to a plain
 * `compose pull`: `pull access denied for <project>-app` ABORTS the whole
 * command and every sibling image logs `Interrupted`. Excluding by NAME broke
 * again when app-migrate (#234) began running the same image (every compose-ha
 * deploy, DO e2e 2026-10-31), so the filter is by IMAGE: a service whose
 * `config --images` equals app's is never pulled, whatever it is called.
 * The add-ons the background job starts (addon-services.sh, see
 * services/addon-start.js) are skipped too: the job pulls their images after
 * the core stack is up, off the deploy's critical path.
 * Exported for tests/unit/deploy/pull-images-loud.test.ts, which runs it.
 */
export function stackPullCommand(remoteDir, flags) {
  return (
    `cd ${remoteDir} && app_image=$(docker compose ${flags} config --images app) && ` +
    `deferred=$(if [ -f ${ADDON_SERVICES_SCRIPT} ]; then sh ${ADDON_SERVICES_SCRIPT}; fi) && ` +
    `docker compose ${flags} config --services | while read -r svc; do ` +
    `[ "$(docker compose ${flags} config --images "$svc")" = "$app_image" ] && continue; ` +
    `printf '%s\n' "$deferred" | grep -qxF "$svc" && continue; echo "$svc"; done | ` +
    `xargs -r docker compose ${flags} pull --policy missing --ignore-buildable 2>&1`
  );
}

export async function pullComposeImages(ip, sshKeyPath, projectName, options = {}) {
  const remoteDir = `/opt/${projectName}`;
  const flags = composeFileFlags(options);
  await perfAsync('deploy.compose.imagesPull', () =>
    sshRunAsync(ip, sshKeyPath, stackPullCommand(remoteDir, flags), { timeout: 600_000 }),
  ).catch((err) => {
    throw stackPullError(ip, err);
  });
}

/** How much of the pull's output a failure quotes: enough for the failing images and docker's reason. */
const PULL_OUTPUT_TAIL_LINES = 20;

/**
 * The pull's own words, not the ssh command line. The remote command ends in
 * `2>&1`, so docker's output (which image, and why: rate limit, denied, DNS)
 * is in the error's stdout while its message is only `Command failed: ssh …`.
 * Quotes the last lines, credential-shaped values masked, with the next step.
 */
function stackPullError(ip, err) {
  const tail = String(err?.stdout ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-PULL_OUTPUT_TAIL_LINES)
    .map(redactCredentials);
  const detail = tail.length ? tail.join('\n') : String(err?.message ?? err);
  return new Error(
    `stack image pull failed on ${ip}:\n${detail}\n` +
      'The images above failed to pull; set Docker Hub credentials (dockerhub-login) or retry. ' +
      `If one is a ${K8S_MIRROR_ORG} mirror, its package may still be private: servers pull ` +
      `mirrors without credentials, so these packages must be public: ${mirroredPackageNames().join(', ')}.`,
    { cause: err },
  );
}

/**
 * The two deploy-time ground-truth audits that gate success, against the
 * live database: RLS (src/lib/deploy/rls-audit.js) and wal-g backups
 * (src/lib/deploy/walg-audit.js). Either one failing throws and fails the
 * deploy. Runs after waitForAdminReady, which waits for the app to report
 * its migrations applied (the app applies db/migrations itself at startup,
 * carbon/src/server/db/migrate.ts), so the audits see the final schema.
 * Shared by the single-compose audit-database effect and compose-ha's, which
 * invokes it against the PRIMARY.
 */
export async function runDatabaseAudits(ip, sshKeyPath, projectName) {
  const remoteDir = `/opt/${projectName}`;

  // Ground-truth RLS audit: refuse to finish the deploy if any public table
  // reached the live schema without row-level security (see rls-audit.js).
  // Runs against the actual catalog, so it catches tables added by any path —
  // a migration that forgot RLS, a hand edit over `vibecarbon shell`, a dependency. sshRun
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
  // audit-database step and compose-ha's, which calls this against the PRIMARY.
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
 * backup logic (guard + PGUSER=postgres + wal-g backup-push + delete
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
 * @param {number} [retain=7]  Days of base backups to keep. Validated
 *                             to a positive integer (injection-safe + sane).
 * @param {{ lockWaitS?: number }} [opts]  lockWaitS: seconds the script waits
 *   for another run's lock before it skips (LOCK_WAIT); omitted, it skips at
 *   once (cron). Validated to a positive integer.
 * @returns {string}
 */
export function composeBackupCmd(remoteDir, retain = 7, { lockWaitS } = {}) {
  const r = Number.isInteger(retain) && retain > 0 ? retain : 7;
  const wait = Number.isInteger(lockWaitS) && lockWaitS > 0 ? `LOCK_WAIT=${lockWaitS} ` : '';
  return `cd ${remoteDir} && ${wait}RETAIN=${r} bash backup/compose-backup.sh`;
}

/**
 * Trigger a wal-g base backup on a Compose VPS via compose-backup.sh, and
 * report what it did.
 *
 * wal-g pushes the backup directly to S3 from inside the db container —
 * there is no local archive to scp or upload. The script prints one
 * result marker (src/lib/walg/backup-result.js), and the return value
 * is that marker: `{ result: 'pushed', name }` or `{ result: 'skipped',
 * reason }`. A skip (no S3 target, a standby, a db in recovery, another
 * backup holding the lock: exit 75) is NOT a backup; callers read `.result`
 * (census: tests/unit/backup/backup-result-consumed-census.test.ts).
 *
 * A retention failure after a good push exits 1 with the pushed marker
 * already printed. The base IS in the bucket, so this returns `pushed` with
 * `retentionError` (the script's one-line cause) instead of throwing: a pushed
 * base must never read as "no backup" to scale or destroy, and
 * `vibecarbon backup` fails the command on it. It is not retried either: a
 * retry would push a second base.
 *
 * FAILURE MUST PROPAGATE. A failed push, a refusal (retired node, backup
 * fence) or a run with no marker throws. This used the string-command
 * `sshRun` once, which returns `false` instead of throwing — so a failed
 * `backup-push` resolved as a SUCCESS, and a scale went on to restore an
 * OLDER base and destroy the old server. `sshRunAsync` throws on remote
 * non-zero.
 *
 * SSH RETRY: only a connection that provably never started the remote command
 * (runWithTransportRetry: exit 255 plus a pre-exec wording). sshRunAsync's own
 * ladder is switched off (`retries: 1`) here: it retries on
 * /timed out|timeout/ anywhere in the message, which carries the REMOTE
 * stderr, so a wal-g "i/o timeout" during retention (after a pushed base)
 * re-ran the whole script and pushed a second base.
 *
 * The push is wrapped in the object-storage staleness retry for the same
 * reason the restore's fetch is: `wal-g backup-push` LISTs the prefix before
 * writing — a read-after-write against a bucket that may have been created
 * minutes ago. See src/lib/deploy/walg-staleness.js. Only a run that printed
 * no marker is retried.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string} projectName
 * @param {object} [options]
 * @param {number} [options.retain]  Days of base backups to keep (default 7).
 * @param {number} [options.lockWaitS]  Seconds to wait for another backup run's
 *   lock before skipping (LOCK_WAIT); added to the ssh timeout. Omitted: skip
 *   at once (today's behaviour).
 * @param {number[]} [options.staleRetryDelaysMs]  Test seam for the staleness
 *   retry ladder; production callers omit it.
 * @returns {Promise<{result: 'pushed', name: string, retentionError?: string} | {result: 'skipped', reason: string}>}
 */
export async function backupCompose(ip, sshKeyPath, projectName, options = {}) {
  const remoteDir = `/opt/${projectName}`;
  const lockWaitMs =
    Number.isInteger(options.lockWaitS) && options.lockWaitS > 0 ? options.lockWaitS * 1000 : 0;
  const t = perfTimer('backup.walgPush');
  const run = await withWalgStaleStorageRetry(
    async () => {
      try {
        const stdout = await runWithTransportRetry(() =>
          sshRunAsync(
            ip,
            sshKeyPath,
            composeBackupCmd(remoteDir, options.retain ?? 7, { lockWaitS: options.lockWaitS }),
            {
              // The lock wait comes on top of the push's own budget.
              timeout: 900_000 + lockWaitMs,
              retries: 1,
            },
          ),
        );
        return { stdout: String(stdout ?? '') };
      } catch (err) {
        // A marker means the script got past the push decision: the lock skip
        // (exit 75) or a retention failure after a pushed base (exit 3).
        // Neither is a stale-storage read to retry.
        const stdout = String(err?.stdout ?? '');
        if (hasBackupResult(stdout)) return { stdout, err };
        throw err;
      }
    },
    'backup-push',
    { delaysMs: options.staleRetryDelaysMs },
  );
  t.end();
  const outcome = parseBackupResult(run.stdout);
  if (!run.err) return outcome;
  if (outcome.result === 'skipped') return outcome;
  const stderr = String(run.err.stderr ?? '');
  const cause =
    stderr.match(/^retention failed.*$/m)?.[0] ||
    stderr.trim().split('\n').pop() ||
    run.err.message;
  return { ...outcome, retentionError: cause };
}

/**
 * Set up the automated wal-g backup cron, and the TLS retry cron, on the VPS.
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
 * @param {string|null} [opts.domain] the env's apex: the tls-retry line is
 *   installed only with one (no domain, no TLS to retry), validated with the
 *   CLI's hostname rule before it goes into the crontab.
 * @param {(ip: string, key: string, script: string, o: object) => unknown} [opts.runScript=sshRunScript]
 *   Injectable script runner — defaults to the real SSH runner; overridden in unit tests.
 */
export async function setupComposeBackupCron(ip, sshKeyPath, projectName, backupConfig, opts = {}) {
  const { runScript = sshRunScript, domain = null } = opts;
  if (domain) {
    const problem = validateDomain(domain);
    if (problem)
      throw new Error(
        `tls-retry cron: ${JSON.stringify(domain)} is not a valid domain (${problem})`,
      );
  }
  const remoteDir = `/opt/${projectName}`;
  // The same defaults and validation as the k8s side (one resolver): a retention
  // of 0 or NaN throws instead of becoming some other number.
  const { schedule, retentionDays: retain } = resolveBackupSettings(backupConfig);

  const cronLine = `${schedule} ${composeBackupCmd(remoteDir, retain)} >> ${remoteDir}/backups/backup.log 2>&1`;
  // TLS issuance scheduling (carbon/backup/tls-retry.sh): Traefik never
  // retries a failed first issuance, so a deploy that finished with TLS
  // pending relies on this to restart it, every 30 minutes (see the script
  // header for the rate-limit reasoning). The script waits while the apex
  // does not point at the host, skips a Traefik younger than 15 minutes and
  // gives up after 48 restarts.
  const tlsRetryLine = domain
    ? `*/30 * * * * cd ${remoteDir} && bash backup/tls-retry.sh ${domain} >> ${remoteDir}/backups/tls-retry.log 2>&1`
    : null;

  // Install quote-safely: build the next crontab on the server (existing minus
  // any prior compose-backup.sh or tls-retry.sh line, plus ours) and pipe via
  // stdin. The cron lines are fed to `cat` through a heredoc so no shell
  // quoting can mangle them; there are no single quotes in them anyway.
  // A deploy re-arms the retry budget: the give-up counter and the last
  // logged state are cleared, so a redeploy after fixing the cause gets a
  // fresh 48 restarts and logs its first state again.
  const installScript = [
    'set -e',
    `mkdir -p ${remoteDir}/backups`,
    `rm -f ${remoteDir}/backups/tls-retry.count ${remoteDir}/backups/tls-retry.state`,
    'TMP_CRON=$(mktemp)',
    "crontab -l 2>/dev/null | grep -v -e 'compose-backup.sh' -e 'tls-retry.sh' > \"$TMP_CRON\" || true",
    'cat >> "$TMP_CRON" <<\'VC_CRON_EOF\'',
    cronLine,
    ...(tlsRetryLine ? [tlsRetryLine] : []),
    'VC_CRON_EOF',
    'crontab "$TMP_CRON"',
    'rm -f "$TMP_CRON"',
  ].join('\n');

  await runScript(ip, sshKeyPath, installScript, { timeout: 60_000 });
}

/**
 * Build the script that restores one NAMED wal-g base backup into a compose
 * db volume without destroying the live cluster before the backup is proven
 * (H2a, C1). It runs inside a throwaway db container (`docker compose run
 * --rm ... db bash /restore.sh`), which mounts the real <project>_db_data
 * volume at $PGDATA.
 *
 *   1. Take `$PGDATA/.vc-restore.lock` (flock): one restore at a time.
 *   2. `wal-g backup-fetch` the named backup into `$PGDATA/.vc-restore`. The
 *      only thing removed before it is that staging dir; no cluster entry
 *      moves. A failed fetch clears staging and exits non-zero.
 *   3. Prove the staged tree (PG_VERSION), drop any `.vc-*` entry it carries
 *      (a base pushed while a restore's dirs sat in PGDATA), write the
 *      recovery config and recovery.signal into it.
 *   4. Settle and swap under `.vc-restore-in-progress`. What PGDATA holds
 *      decides where its entries go:
 *        - a marker reading "in", or a `.vc-prev` with no marker: PGDATA holds
 *          an UNPROVEN copy (the CLI renames a proven restore's `.vc-prev` to
 *          `.vc-discard` before anything else, so a surviving `.vc-prev` always
 *          means its restore never proved itself); the copy goes to
 *          `.vc-discard`, `.vc-prev` (the database from before) is kept;
 *        - a marker reading anything else: the live cluster was half moved
 *          into `.vc-prev`; finish that;
 *        - otherwise: the live cluster moves to `.vc-prev` (not created when
 *          PGDATA holds nothing, as on a fresh cluster).
 *      Then the staged entries move into PGDATA, the marker goes, and
 *      `.vc-discard` is removed. A boot that finds the marker with no restore
 *      running refuses (carbon/volumes/db/db-guard.sh).
 *
 * PGDATA is the volume's mount point, so it cannot be renamed: staging, the
 * previous cluster and the discard live inside it, and the swap moves
 * entries. Nothing here removes `.vc-prev`; the CLI does, once the restored
 * database promoted and proved writable. The k8s walg-restore init container
 * in carbon/k8s/base/db/statefulset.yaml runs the same prelude, staged and
 * swap steps (tests/unit/deploy/restore-destroy-before-verify-census.test.ts,
 * tests/unit/walg/restore-script-states.test.ts).
 *
 * Pure (no I/O) so it can be tested without SSH.
 *
 * @param {{ backup: string, recoveryConf: string, lineage: string }} args  `backup`
 *   is a wal-g backup name resolved by the CLI (never LATEST), `recoveryConf`
 *   the text from renderRecoveryConf (src/lib/walg/recovery-config.js),
 *   `lineage` the system identifier whose archive folder holds the backup
 *   (RESTORE_LINEAGE for walg-env.sh: PGDATA does not hold that database yet).
 * @returns {string} The bash script body.
 */
export function composeRestoreScript(
  { backup, recoveryConf, lineage, attempt = randomUUID() } = /** @type {any} */ ({}),
) {
  if (!BACKUP_NAME_RE.test(String(backup))) {
    throw new Error(
      `composeRestoreScript: ${JSON.stringify(backup)} is not a wal-g backup name; the CLI resolves one before any restore`,
    );
  }
  if (!recoveryConf || /^VC_RECOVERY_CONF_EOF$/m.test(recoveryConf)) {
    throw new Error('composeRestoreScript: recoveryConf (renderRecoveryConf) is required');
  }
  if (!RESTORE_ATTEMPT_RE.test(String(attempt))) {
    throw new Error(`composeRestoreScript: ${JSON.stringify(attempt)} is not a restore attempt id`);
  }
  if (!LINEAGE_RE.test(String(lineage ?? ''))) {
    throw new Error(
      `composeRestoreScript: ${JSON.stringify(lineage)} is not a database lineage (system identifier); the CLI resolves one before any restore`,
    );
  }
  const { staging } = RESTORE_LAYOUT;
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    `PGDATA=${PGDATA_PATH}`,
    `RESTORE_BACKUP='${backup}'`,
    // The shared swap block records `<backup> <attempt>`; compose never reads
    // it back (its script runs once per restore), the k8s init does.
    `RESTORE_ATTEMPT='${attempt}'`,
    // The archive folder of the lineage the backup came from (walg-env.sh).
    `export RESTORE_LINEAGE='${lineage}'`,
    WALG_ENV_SOURCE,
    'VC_RECOVERY_CONF_FILE=/tmp/vc-recovery.conf',
    'cat > "$VC_RECOVERY_CONF_FILE" <<\'VC_RECOVERY_CONF_EOF\'',
    recoveryConf,
    'VC_RECOVERY_CONF_EOF',
    '',
    ...restorePreludeLines(),
    '',
    '# 2. Fetch the named base backup into staging. The live cluster is untouched.',
    `rm -rf "$PGDATA/${staging}"`,
    `mkdir -p "$PGDATA/${staging}"`,
    `if ! wal-g backup-fetch "$PGDATA/${staging}" "$RESTORE_BACKUP"; then`,
    `  rm -rf "$PGDATA/${staging}"`,
    '  echo "restore: wal-g backup-fetch $RESTORE_BACKUP failed; nothing was moved" >&2',
    '  exit 1',
    'fi',
    ...restoreStagedAndSwapLines(),
  ].join('\n');
}

/**
 * Step 1 of both restore scripts, shared text (the k8s init carries the same
 * lines; the census compares them).
 */
function restorePreludeLines() {
  const { inProgress, lock } = RESTORE_LAYOUT;
  return [
    '# --- prelude ---',
    `VC_MARKER="$PGDATA/${inProgress}"`,
    '# 1. One restore at a time on this volume. This runs as root in the postgres',
    "#    user's PGDATA: the files it writes are never opened through a symlink.",
    `if [ -L "$PGDATA/${lock}" ]; then`,
    `  echo "restore: $PGDATA/${lock} is a symlink; refusing" >&2`,
    '  exit 1',
    'fi',
    `exec 9>"$PGDATA/${lock}"`,
    'if ! flock -n 9; then',
    `  echo "restore: another restore holds $PGDATA/${lock}; refusing" >&2`,
    '  exit 75',
    'fi',
    '# The marker is only ever replaced by rename, so a crash mid-write leaves',
    '# the previous state, never a torn one.',
    'vc_mark() {',
    '  rm -f "$VC_MARKER.tmp"',
    '  printf \'%s\' "$1" > "$VC_MARKER.tmp"',
    '  mv -f "$VC_MARKER.tmp" "$VC_MARKER"',
    '}',
    "# The cluster's own entries in PGDATA: everything but the restore's .vc-*.",
    'vc_cluster_entries() {',
    `  find "$PGDATA" -mindepth 1 -maxdepth 1 ! -name '.vc-*'`,
    '}',
    '# --- end prelude ---',
  ];
}

/** Steps 3 and 4 of both restore scripts, shared text. */
function restoreStagedAndSwapLines() {
  const { staging, previous, discard, inProgress, lock, restoredFrom } = RESTORE_LAYOUT;
  const stagedVc = [
    staging,
    previous,
    discard,
    inProgress,
    `${inProgress}.tmp`,
    lock,
    restoredFrom,
    `${restoredFrom}.tmp`,
    ...WAL_GAP_RECORDS,
  ]
    .map((name) => `"$PGDATA/${staging}/${name}"`)
    .join(' ');
  return [
    '# --- staged ---',
    `if [ ! -f "$PGDATA/${staging}/PG_VERSION" ]; then`,
    `  rm -rf "$PGDATA/${staging}"`,
    '  echo "restore: $RESTORE_BACKUP fetched no PG_VERSION; nothing was moved" >&2',
    '  exit 1',
    'fi',
    '# 3. A base pushed while a restore left its dirs in PGDATA carries them:',
    '#    drop them from the staged tree so they cannot wedge the swap. The',
    "#    source database's WAL gap record goes too: the restored one has its own.",
    `rm -rf ${stagedVc}`,
    '# Recovery config into staging: strip the settings it rewrites, append the',
    '# new ones (rendered by the CLI, the same text on both tiers).',
    `VC_AUTO_CONF="$PGDATA/${staging}/postgresql.auto.conf"`,
    '# These writes run as root inside a tree fetched from the bucket: a',
    '# symlink the base carries at either path is removed, never followed.',
    '[ -L "$VC_AUTO_CONF" ] && rm -f "$VC_AUTO_CONF"',
    'touch "$VC_AUTO_CONF"',
    'while IFS= read -r vc_line; do',
    '  case "$vc_line" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${vc_line#-} is bash prefix removal, not a JS placeholder
    '    -*) sed -i "/^[[:space:]]*${vc_line#-}[[:space:]]*=/d" "$VC_AUTO_CONF" ;;',
    '    ?*) printf \'%s\\n\' "$vc_line" >> "$VC_AUTO_CONF" ;;',
    '  esac',
    'done < "$VC_RECOVERY_CONF_FILE"',
    `[ -L "$PGDATA/${staging}/recovery.signal" ] && rm -f "$PGDATA/${staging}/recovery.signal"`,
    `touch "$PGDATA/${staging}/recovery.signal"`,
    `chown -R postgres:postgres "$PGDATA/${staging}"`,
    '',
    '# --- swap ---',
    '# 4. Settle what PGDATA holds, then swap under the in-progress marker.',
    "#    .vc-discard is only ever an unproven copy or a proven restore's old",
    '#    cluster the CLI was removing: garbage.',
    `rm -rf "$PGDATA/${discard}"`,
    'if [ -f "$VC_MARKER" ] && [ "$(cat "$VC_MARKER")" = in ]; then',
    '  vc_root=unproven',
    'elif [ -f "$VC_MARKER" ]; then',
    '  vc_root=half-out',
    `elif [ -d "$PGDATA/${previous}" ]; then`,
    '  vc_root=unproven',
    'else',
    '  vc_root=live',
    'fi',
    'case "$vc_root" in',
    '  unproven)',
    `    # .vc-prev holds the database from before; PGDATA an unproven copy.`,
    '    vc_mark in',
    `    mkdir -p "$PGDATA/${discard}"`,
    `    vc_cluster_entries | while IFS= read -r vc_entry; do mv "$vc_entry" "$PGDATA/${discard}/"; done`,
    '    ;;',
    '  half-out)',
    `    mkdir -p "$PGDATA/${previous}"`,
    `    vc_cluster_entries | while IFS= read -r vc_entry; do mv "$vc_entry" "$PGDATA/${previous}/"; done`,
    '    vc_mark in',
    '    ;;',
    '  live)',
    '    if [ -n "$(vc_cluster_entries)" ]; then',
    '      vc_mark out',
    `      mkdir -p "$PGDATA/${previous}"`,
    `      vc_cluster_entries | while IFS= read -r vc_entry; do mv "$vc_entry" "$PGDATA/${previous}/"; done`,
    '    fi',
    '    vc_mark in',
    '    ;;',
    'esac',
    `find "$PGDATA/${staging}" -mindepth 1 -maxdepth 1 | while IFS= read -r vc_entry; do mv "$vc_entry" "$PGDATA/"; done`,
    `rmdir "$PGDATA/${staging}"`,
    '# The slow removal goes before the marker: once the marker is gone, the',
    '# only thing in PGDATA that says "swapped, not proven" is recovery.signal,',
    '# and nothing slow may follow.',
    `rm -rf "$PGDATA/${discard}"`,
    '# Record the attempt PGDATA now holds (renamed in, never torn), before the',
    '# marker goes: a k8s pod start during this same attempt boots it instead of',
    '# restoring it again.',
    `rm -f "$PGDATA/${restoredFrom}.tmp"`,
    `printf '%s %s' "$RESTORE_BACKUP" "\${RESTORE_ATTEMPT:-}" > "$PGDATA/${restoredFrom}.tmp"`,
    `mv -f "$PGDATA/${restoredFrom}.tmp" "$PGDATA/${restoredFrom}"`,
    'rm -f "$VC_MARKER"',
    'echo "restore: $RESTORE_BACKUP staged and swapped in"',
    '# --- end swap ---',
  ];
}

/**
 * Poll interval for the post-restore promotion wait. Tightened from a flat 5s
 * to 2s: the loop already early-exits the instant pg_is_in_recovery() flips to
 * false, so a shorter interval just detects promotion ~sooner on the common
 * fast path without adding load (one lightweight psql exec per poll).
 */
export const RESTORE_PROMOTE_POLL_MS = 2000;

/**
 * Free bytes on the filesystem holding the compose db volume, or null when
 * unreadable. Read on the host (the db may be the thing being restored, so it
 * need not be running).
 */
async function composeVolumeFreeBytes(ip, sshKeyPath) {
  try {
    const out = await sshRunAsync(
      ip,
      sshKeyPath,
      `df -Pk "$(docker info -f '{{.DockerRootDir}}')" | awk 'NR==2 {print $4}'`,
      { timeout: 30_000 },
    );
    const kb = Number.parseInt(String(out ?? '').trim(), 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Restore one named wal-g base backup via Docker Compose, with full archive
 * recovery. Postgres replays WAL from S3 via restore_command and promotes to
 * read-write at the end of WAL or the PITR target.
 *
 * Order: free-space check (when the size is known), stop app + db, staged
 * fetch and swap (composeRestoreScript), start db, wait for promotion, prove
 * it writable (`assertWritable`), remove the previous cluster, ANALYZE, rerun
 * app-migrate, start the app. A fetch that fails leaves the live cluster in
 * place, and the db and app are started again before the error propagates.
 *
 * S3 credentials are read from the db container's environment (sourced from
 * the project .env file); the container already has WALG_S3_PREFIX_BASE +
 * AWS_*, and the script sources walg-env.sh with RESTORE_LINEAGE.
 *
 * @param {string} ip
 * @param {string} sshKeyPath
 * @param {string} projectName
 * @param {{ backup: string, lineage: string, target: 'latest' | string, recoveryConf: string, requiredBytes?: number, assertWritable: () => Promise<'writable' | 'lifted' | 'unknown'> }} restore
 *   `backup`: the resolved base backup name. `lineage`: the system identifier
 *   whose archive folder holds it. `target`: 'latest' or the
 *   ISO-8601 PITR instant, for messages. `recoveryConf`: renderRecoveryConf's
 *   text. `requiredBytes`: the backup's uncompressed size, for the free-space
 *   check. `assertWritable`: the proof that runs before `.vc-prev` goes.
 * @param {object} [options]
 * @param {number[]} [options.staleRetryDelaysMs]  Test seam for the
 *   object-storage staleness retry ladder; production callers omit it.
 */
export async function restoreCompose(ip, sshKeyPath, projectName, restore, options = {}) {
  const remoteDir = `/opt/${projectName}`;
  const { backup, lineage, recoveryConf, requiredBytes, assertWritable } = restore ?? {};
  // The command that finishes or redoes this restore, for the failure messages.
  const rerun = restore?.rerun ?? 'vibecarbon restore';
  if (typeof assertWritable !== 'function') {
    throw new Error('restoreCompose: assertWritable is required (the proof before .vc-prev goes)');
  }

  // Build and validate the restore script early: fail before touching the
  // running server if the backup name or the config is malformed.
  const scriptBody = composeRestoreScript({ backup, recoveryConf, lineage });

  if (requiredBytes) {
    assertRestoreFits({
      requiredBytes,
      freeBytes: await composeVolumeFreeBytes(ip, sshKeyPath),
      where: `${ip}'s docker volume filesystem`,
      warn: (msg) => console.warn(`[restore] ${msg}`),
    });
  }

  // 1. Write this run's restore script to the server (heredoc, no quoting
  //    risk) and bind-mount it into the db container. The script body contains
  //    single quotes (restore_command = 'wal-g wal-fetch ...') so it MUST go via
  //    a file rather than a nested bash -c '...' invocation. One file per run,
  //    never rewritten in place: an orphaned earlier run's bash may still be
  //    reading its own.
  const scriptPath = `${remoteDir}/restore-walg.${randomBytes(6).toString('hex')}.sh`;
  await sshRunScript(
    ip,
    sshKeyPath,
    [
      'set -e',
      `cat > ${scriptPath} <<'VC_RESTORE_EOF'`,
      scriptBody,
      'VC_RESTORE_EOF',
      `chmod +x ${scriptPath}`,
    ].join('\n'),
    { timeout: 30_000 },
  );

  // An earlier restore whose ssh dropped can leave its run container behind
  // (still running, or stopped and not removed): `run --name` would refuse
  // the name. Remove that one container, by its exact name, and say so. Its
  // swap, if it began one, is settled by this run's script. Both steps run
  // before anything is stopped: a failure here leaves the database serving.
  const runContainer = `${projectName}-db-restore`;
  const orphan = await sshRunAsync(
    ip,
    sshKeyPath,
    `docker ps -aq --filter name=^/${runContainer}$`,
    { timeout: 30_000 },
  );
  if (String(orphan ?? '').trim()) {
    console.warn(
      `[restore] an earlier restore's container ${runContainer} was still there; stopped and removed it`,
    );
    await sshRunAsync(ip, sshKeyPath, `docker rm -f ${runContainer}`, { timeout: 60_000 });
  }

  // 2. Stop the app (no connections during the restore), then the DB. The
  //    restore container stages and swaps PGDATA from inside a db container,
  //    where the real ${project}_db_data volume is mounted at $PGDATA. (A `docker compose run --rm -v db_data:/data alpine`
  //    would mount a literal `db_data` volume, NOT the project-prefixed one.)
  try {
    await sshRunAsync(
      ip,
      sshKeyPath,
      `cd ${remoteDir} && docker compose stop app 2>/dev/null || true`,
    );
    await sshRunAsync(ip, sshKeyPath, `cd ${remoteDir} && docker compose stop db`);
  } catch (err) {
    await sshRunAsync(ip, sshKeyPath, `rm -f ${scriptPath}`, { ignoreError: true });
    throw new Error(
      `restoreCompose: stopping the app and db for the restore of ${backup} failed, so nothing was ` +
        `restored, and the app may be stopped (${err instanceof Error ? err.message : String(err)}). ` +
        `Check them on ${ip}:\n` +
        `  ssh root@${ip} 'cd ${remoteDir} && docker compose ps'`,
    );
  }

  // THE wal-g FETCH. Wrapped in the object-storage staleness retry (quarantined
  // in docs/mitigations.yml): this exec is where a compose scale died on
  // 2026-07-31 — a Hetzner frontend that had not caught up with a push seconds
  // earlier answered `NoSuchBucket: status code: 404`. Re-running the whole
  // script is the unit of that retry: each run clears staging before it fetches
  // and never touches the live cluster until a fetch completed. RESTORE_BACKUP
  // in the container env lets the run past db-guard.sh's interrupted-restore
  // check.
  //
  // One writer (I2): `retries: 1`, so an ssh transport error never re-runs a
  // restore that may still be running on the server, and the script's flock
  // refuses a second one outright. The timeout grows with the backup, like the
  // k8s rollout wait. The run container is named so the failure path can make
  // sure it is gone. See src/lib/deploy/walg-staleness.js.
  const fetchTimeoutS = restoreFetchTimeoutS(requiredBytes);
  try {
    try {
      await withWalgStaleStorageRetry(
        () =>
          sshRunAsync(
            ip,
            sshKeyPath,
            `cd ${remoteDir} && docker compose run --rm --name ${runContainer} -e RESTORE_BACKUP=${backup} -v ${scriptPath}:/restore.sh:ro db bash /restore.sh`,
            { timeout: fetchTimeoutS * 1000, retries: 1 },
          ),
        'backup-fetch (restore)',
        { delaysMs: options.staleRetryDelaysMs },
      );
    } finally {
      await sshRunAsync(ip, sshKeyPath, `rm -f ${scriptPath}`, { ignoreError: true });
    }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    // An ssh timeout leaves the run container going on the server: stop that
    // one container (and only it) before reading what it left.
    await sshRunAsync(ip, sshKeyPath, `docker rm -f ${runContainer} 2>/dev/null || true`, {
      ignoreError: true,
    });
    // What the run left, read with the entrypoint bypassed (db-guard.sh would
    // refuse a marker): the marker means the swap is half done; no marker but
    // recovery.signal means it swapped and was never proven; neither means
    // nothing was moved.
    const probe = await sshRunAsync(
      ip,
      sshKeyPath,
      `cd ${remoteDir} && docker compose run --rm --no-deps --entrypoint sh db -c ` +
        `'if [ -e ${PGDATA_PATH}/${RESTORE_LAYOUT.inProgress} ]; then echo VC_MARKER_PRESENT; ` +
        `elif [ -e ${PGDATA_PATH}/recovery.signal ] && [ -d ${PREVIOUS_PGDATA_PATH} ]; then echo VC_SWAPPED_PREV; ` +
        `elif [ -e ${PGDATA_PATH}/recovery.signal ]; then echo VC_SWAPPED_EMPTY; else echo VC_MARKER_ABSENT; fi'`,
      { ignoreError: true, retries: 1 },
    );
    const state = String(probe ?? '');
    if (state.includes('VC_MARKER_ABSENT')) {
      // No swap began: the database from before the restore is untouched.
      await sshRunAsync(
        ip,
        sshKeyPath,
        `cd ${remoteDir} && docker compose start db && docker compose start app`,
        { ignoreError: true },
      );
      throw new Error(
        `restoreCompose: the restore of ${backup} did not complete and nothing was moved, so the database ` +
          `from before it was started again: ${cause}`,
      );
    }
    if (state.includes('VC_MARKER_PRESENT')) {
      throw new Error(
        [
          `restoreCompose: the restore of ${backup} was interrupted mid-swap (${cause}). The db stays down ` +
            `(db-guard.sh refuses to boot it) and the database from before the restore is in ` +
            `${PREVIOUS_PGDATA_PATH}. To finish or redo the swap, rerun:`,
          `  ${rerun}`,
        ].join('\n'),
      );
    }
    if (state.includes('VC_SWAPPED_PREV')) {
      throw new Error(
        [
          `restoreCompose: the restore of ${backup} swapped in but was not proven (${cause}). The db stays ` +
            `down, the app too, and the database from before the restore is in ${PREVIOUS_PGDATA_PATH}. ` +
            'Rerunning the restore keeps that database and redoes the swap:',
          `  ${rerun}`,
        ].join('\n'),
      );
    }
    if (state.includes('VC_SWAPPED_EMPTY')) {
      // The volume held no database before (a fresh server): no .vc-prev.
      throw new Error(
        [
          `restoreCompose: the restore of ${backup} swapped in but was not proven (${cause}). The db stays ` +
            'down, the app too. The volume held no database before this restore, so there is nothing ' +
            'to keep; rerunning it redoes the swap:',
          `  ${rerun}`,
        ].join('\n'),
      );
    }
    throw new Error(
      [
        `restoreCompose: the restore of ${backup} did not complete (${cause}), and whether a swap began could ` +
          `not be read. The db and app are left stopped. Check the db log on ${ip}:`,
        `  ssh root@${ip} 'cd ${remoteDir} && docker compose logs db'`,
        'Then rerun:',
        `  ${rerun}`,
      ].join('\n'),
    );
  }

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
        `cd ${remoteDir} && docker compose exec -T db pg_isready -h 127.0.0.1 -U postgres`,
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
          `Last error: ${lastErr}. The database from before the restore is kept in ${PREVIOUS_PGDATA_PATH}.`,
      );
    }
    await new Promise((r) => setTimeout(r, RESTORE_PROMOTE_POLL_MS));
  }

  // 6. Prove the restored database takes writes, then drop the previous
  //    cluster. Never the other way round: until this proof the previous
  //    cluster is the only copy of the database from before the restore.
  //    An unreadable fence is not a proof (I4): the previous cluster stays.
  const proof = await assertWritable();
  if (!PROVEN_WRITABLE_STATES.includes(proof)) {
    throw new Error(
      [
        `restoreCompose: could not prove the restored database writable (write fence ${proof ?? 'unread'}), ` +
          `so it kept the database from before the restore in ${PREVIOUS_PGDATA_PATH} and left the app ` +
          'stopped. Check it by hand (expect off):',
        `  ssh root@${ip} 'cd ${remoteDir} && docker compose exec -T db psql -U postgres -At -c "SHOW default_transaction_read_only"'`,
        'Then finish what the restore owed:',
        `  ssh root@${ip} 'cd ${remoteDir} && docker compose exec -T db sh -c "${RETIRE_PREVIOUS_SH}" ` +
          `&& docker compose exec -T db sh -c "${REMOVE_DISCARD_SH}" ` +
          '&& docker compose run --rm --no-deps app-migrate ' +
          "&& docker compose exec -T db psql -U postgres -q -c ANALYZE && docker compose start app'",
      ].join('\n'),
    );
  }
  //    Rename first, then remove: a crash mid-delete leaves .vc-discard
  //    (garbage), never a .vc-prev that the next restore would read as the
  //    database from before an unproven restore.
  await sshRunAsync(
    ip,
    sshKeyPath,
    `cd ${remoteDir} && docker compose exec -T db sh -c '${RETIRE_PREVIOUS_SH}'`,
    { timeout: 60_000 },
  );
  await sshRunAsync(
    ip,
    sshKeyPath,
    `cd ${remoteDir} && docker compose exec -T db ${REMOVE_DISCARD_SH}`,
    { timeout: 300_000 },
  );

  // 7. Rebuild planner statistics. A base backup carries none: until
  //    autovacuum runs, `pg_stat_user_tables.n_live_tup` reads 0 for every
  //    table and the first queries plan blind — which looks exactly like data
  //    loss to whoever is verifying the restore (vibecarbon-web prod move,
  //    2026-09-15: every n_live_tup was 0; every COUNT(*) was intact).
  //    Best-effort: a failure here must not fail a restore that has already
  //    promoted, so it is logged and the app still comes back.
  try {
    await sshRunAsync(
      ip,
      sshKeyPath,
      `cd ${remoteDir} && docker compose exec -T db psql -U postgres -q -c 'ANALYZE'`,
      { timeout: 300_000 },
    );
  } catch (err) {
    console.warn(
      `[restore] ANALYZE after restore failed (${err instanceof Error ? err.message : String(err)}); ` +
        'planner statistics will rebuild on the next autovacuum.',
    );
  }

  // 8. Rerun the migrate step before the app: the app no longer migrates at
  //    boot, so a restore to a point before a deployed migration would leave
  //    it 503, and a backup older than the last APP_DB_PASSWORD carries the
  //    old app_service password. app-migrate applies the ledger and resets
  //    the role from .env. Foreground, so its exit code is the verdict.
  try {
    await sshRunAsync(
      ip,
      sshKeyPath,
      `cd ${remoteDir} && docker compose run --rm --no-deps app-migrate`,
      // One attempt: a timed-out migration is never relaunched blind.
      { timeout: 600_000, retries: 1 },
    );
  } catch (err) {
    throw new Error(
      `restoreCompose: app-migrate failed after the restore, so the app stays stopped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 9. Bring the app back up
  await sshRunAsync(ip, sshKeyPath, `cd ${remoteDir} && docker compose start app`);
}
