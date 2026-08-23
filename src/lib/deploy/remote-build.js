/**
 * Remote Build Logic
 * Uses native Docker via SSH contexts to build images directly on target architecture.
 * Bypasses local QEMU and remote registries for maximum speed.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { progressLog, spinner } from '../cli/progress.js';
import { runCommand, runCommandAsync } from '../command.js';
import { knownHostsPathForKey } from '../host-keys.js';
import { perfTimer } from '../perf.js';
import { PLATFORM_BUILD_FLAG } from './platform.js';

/**
 * Trimmed SSH-probe backoff ladder for buildRemote (F5).
 *
 * Every caller (compose single-direct, the compose-ha node fan) has already
 * run waitForSSH + waitForDockerReady before we get here, so SSH is proven
 * live and the first probe below succeeds immediately. This short ladder only
 * exists to absorb a one-off blip; a genuine SSH-down after dockerReady is an
 * anomaly, not a slow boot, so there is no reason to re-walk the old 15-step
 * ~76s ladder.
 */
export const SSH_PROBE_DELAYS_MS = [1000, 2000, 3000];

/**
 * Is a failed `docker build` output an in-container DNS-not-settled failure
 * on a freshly-provisioned server, as opposed to a BuildKit/SSH transport
 * drop? Split out from isTransientBuildError (below) as its own predicate
 * because the two sub-classes need DIFFERENT retry ladders (see
 * TRANSPORT_DROP_RETRY_DELAYS_MS / DNS_NOT_SETTLED_RETRY_DELAYS_MS) — a
 * transport blip is a rare anomaly worth a quick retry, but a DNS-not-
 * settled resolver needs real wall-clock time to come up.
 *
 * apk's `DNS: transient error (try again later)`, apt's `Temporary failure
 * resolving`, glibc/musl's `Temporary failure in name resolution`, and
 * Node's `getaddrinfo EAI_AGAIN` are the wordings observed for a RUN step
 * (`apk add`, `apt-get update`, `curl`, `npm install`, ...) that lands
 * before the fresh server's resolver has settled. "unable to select
 * packages" (apk's generic missing-package tail) must NOT trip this on its
 * own — only the DNS/temporary-failure wording above that tail line does;
 * a genuinely missing package fails identically on every attempt.
 *
 * @param {string} output  Combined stderr+stdout of the failed build.
 * @returns {boolean}
 */
export function isDnsNotSettledBuildError(output) {
  return /dns: transient error|temporary failure resolving|temporary failure in name resolution|eai_again/i.test(
    output || '',
  );
}

/**
 * Is a failed `docker build` output a TRANSIENT drop (worth a retry) rather
 * than a genuine build failure (fail fast)? (F6) Covers two classes:
 *
 * 1. BuildKit-over-SSH transport drops. BuildKit holds a long-lived SSH
 *    session for the remote build; on a congested or cross-region link the
 *    session helper intermittently drops mid-build with `http2: server:
 *    error reading preface ... file already closed` / an SSH reset.
 *
 * 2. In-container DNS-not-settled on a freshly-provisioned server — see
 *    isDnsNotSettledBuildError above for the wordings and rationale.
 *
 * Each retry re-establishes a fresh session/resolver state and BuildKit's
 * cache makes it cheap. A Dockerfile/RUN error unrelated to either class, by
 * contrast, will fail identically on every attempt — retrying it burns time
 * before surfacing the same error, so we must NOT retry it.
 *
 * @param {string} output  Combined stderr+stdout of the failed build.
 * @returns {boolean}
 * 2026-08-23 addition: the docker CLI reports its OWN ssh helper dying as
 *   `command [ssh ... docker system dial-stdio] has exited with exit status 255`
 * around the daemon /_ping — the exact linode shape (runs 32614839037 /
 * 32620565774). Bare, it matched NONE of the patterns below and fell through
 * to fail-fast; overnight retries only fired when BuildKit happened to emit an
 * additional matching line alongside it. Bounded (`.{0,60}`) so a random
 * '255' elsewhere cannot ride in — the classify-failure lesson (ab55384a).
 */
export function isTransientBuildError(output) {
  return (
    /dial-stdio.{0,60}exit status 255|http2|preface|connection reset|connection closed|file already closed|banner exchange|kex_exchange_identification|ssh_exchange_identification|broken pipe|no route to host|unexpected eof/i.test(
      output || '',
    ) || isDnsNotSettledBuildError(output)
  );
}

/**
 * Fast ladder for transport-blip retries (BuildKit/SSH drops, wrapper
 * timeouts): attempt 1 waits 3s, attempt 2 waits 6s (3 attempts total, 9s
 * cumulative deliberate wait). Unchanged from before the DNS-branch fix — a
 * genuine SSH-down after dockerReady is an anomaly, not a slow boot (see
 * SSH_PROBE_DELAYS_MS above), so the common case must NOT be slowed down.
 */
export const TRANSPORT_DROP_RETRY_DELAYS_MS = [3000, 6000];

/**
 * DNS-not-settled ladder: one extra attempt (4 total) with longer waits —
 * 10s + 15s + 20s = 45s cumulative deliberate wait before the final attempt.
 *
 * Sized against the one hard data point in the project record for a fresh-
 * Hetzner-boot network race self-healing: the private-NIC (enp7s0) dhcpcd
 * race, whose init-script recovery retriggers the DHCP lease after 30s of
 * no IP. Tonight's failure was PUBLIC DNS resolution (apk fetching
 * dl-cdn.alpinelinux.org) — a different interface/subsystem than that
 * record covers, not confirmed to be the identical mechanism — but the same
 * fresh-server-network-still-settling family, so the same ~30s order of
 * magnitude applies, with margin, until a dedicated RCA pins the exact
 * resolver-settle timing.
 *
 * SHARED with compose/index.js's sshRunAsync, which imports this constant
 * (rather than declaring its own copy) so the two ladders can't drift apart
 * — both are retrying the same underlying fresh-server condition, just on
 * different commands (a native `docker build` here vs. an arbitrary SSH'd
 * remote command there). This file is the natural home: compose/index.js
 * already imports several other `../*.js` siblings under src/lib/deploy/
 * (admin-user.js, rls-audit.js, walg-staleness.js), and remote-build.js has
 * no existing dependency in the other direction.
 */
export const DNS_NOT_SETTLED_RETRY_DELAYS_MS = [10000, 15000, 20000];

/**
 * Execute a remote build using native Docker over SSH
 * @param {string} ip - Remote host IP
 * @param {string} sshKeyPath - Path to the SSH private key
 * @param {string} imageTag - The tag to apply to the built image
 * @param {string} cwd - The build context directory (usually project root)
 * @param {Record<string, string>} buildArgs - Key/value pairs for --build-arg
 * @returns {Promise<boolean>} Success
 */
export async function buildRemote(ip, sshKeyPath, imageTag, cwd, buildArgs = {}) {
  const s = spinner();
  s.start(`Building image natively on ${ip}...`);

  const dockerHost = `ssh://root@${ip}`;

  // Create a temporary directory for our SSH wrapper
  const tempBinDir = mkdtempSync(join(tmpdir(), 'vc-bin-'));
  const sshWrapperPath = join(tempBinDir, 'ssh');

  // Create an SSH wrapper script that forces our options. Docker uses the
  // system 'ssh' command found in PATH — we prepend a temp dir containing
  // this wrapper so Docker's SSH transport picks it up instead. Pass the
  // key path via env var rather than string-interpolating into the script
  // to keep shell-escaping concerns out of the picture (paths with spaces
  // or quotes would otherwise break the wrapper).
  // ServerAliveInterval/CountMax: BuildKit holds a long-lived SSH session for
  // the build; on a congested/cross-region link it can stall and the http2
  // session helper drops with "error reading preface ... file already closed".
  // Keepalives let ssh detect a dead peer (~60s) and fail the attempt cleanly
  // so the retry below can re-establish, instead of hanging to the build timeout.
  // Host-key pinned against the per-env known_hosts (passed via env var so no
  // shell-quoting concern), NOT /dev/null + no. accept-new TOFU's an
  // ephemeral/recycled Hetzner IP but rejects a changed key for an already-
  // pinned host (MITM on an established env fails); GlobalKnownHostsFile=
  // /dev/null ignores the system file and never touches ~/.ssh/known_hosts.
  const sshWrapper = `#!/bin/bash
exec /usr/bin/ssh -i "$VIBECARBON_SSH_KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$VIBECARBON_KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ControlMaster=auto -o ControlPath="$VIBECARBON_SSH_MUX/%C" -o ControlPersist=60s "$@"
`;
  writeFileSync(sshWrapperPath, sshWrapper, { mode: 0o755 });

  const env = {
    ...process.env,
    DOCKER_HOST: dockerHost,
    DOCKER_BUILDKIT: '1',
    PATH: `${tempBinDir}:${process.env.PATH}`, // Prepend our wrapper
    VIBECARBON_SSH_KEY: sshKeyPath,
    VIBECARBON_KNOWN_HOSTS: knownHostsPathForKey(sshKeyPath),
    // Multiplex every ssh the build spawns over ONE master connection.
    // BuildKit dials several concurrent sessions (dial-stdio per stream,
    // worker listing) on top of our probe — a burst of unauthenticated
    // connects that a fresh sshd's MaxStartups (default 10:30:100) starts
    // dropping, exactly the captured failure: `kex_exchange_identification:
    // read: Connection reset by peer` (linode 32640636398, taken by the
    // exhaustion diagnostics). With a mux, the burst authenticates once.
    // Scoped to tempBinDir so cleanup removes the socket with the wrapper.
    VIBECARBON_SSH_MUX: tempBinDir,
  };

  try {
    // 1. Ensure the host is reachable and sshd is ready. Caller has usually
    // already gone through setupServer/waitForDockerReady, so SSH is live by
    // attempt 0; the fast leg [1, 1, 2, 2] catches that path quickly. Tail
    // keeps 5s pacing for the rare genuinely slow-coming-up case.
    // Gated under perfTimer because the SSH-probe wait is invisible to the
    // outer `deploy.image.remoteBuild` timer (which only covers the docker
    // build subprocess) — and analysis of iter-reliab3 showed the wrapper
    // running 71s longer than the longest child timer, suggesting this
    // probe loop is sometimes burning serious time we couldn't attribute.
    const sshProbeT = perfTimer('deploy.image.remoteBuild.sshProbe');
    // Probe once immediately (SSH is already proven live by the caller's
    // waitForSSH/waitForDockerReady), then walk the trimmed SSH_PROBE_DELAYS_MS
    // ladder only to absorb a one-off blip (F5).
    let sshReady = false;
    for (let i = 0; i <= SSH_PROBE_DELAYS_MS.length; i++) {
      try {
        // Bare `ssh` resolves through PATH to the wrapper script written
        // above (sshWrapper) which adds -i + -o BatchMode=yes etc.; the
        // wrapper is the only `ssh` on PATH for this child process.
        // shell-safety-ignore: ssh is the PATH-prepended wrapper, not system ssh
        runCommand(['ssh', `root@${ip}`, 'echo', 'ready'], { silent: true, env });
        sshReady = true;
        break;
      } catch {
        if (i < SSH_PROBE_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, SSH_PROBE_DELAYS_MS[i]));
        }
      }
    }
    sshProbeT.end();

    if (!sshReady) {
      s.stop('Remote SSH not reachable');
      return false;
    }

    // 2. Run the build directly on the remote host via DOCKER_HOST=ssh://...
    //
    // The platform pin is redundant TODAY — this build runs on the target VPS
    // and every server type we provision is amd64 (ARM SKUs are rejected at
    // every entry point; see BaseProvider.assertAmd64ServerType). It stays
    // because it costs nothing and makes the invariant explicit at the build
    // itself: if a server ever isn't amd64, this build fails loudly instead of
    // producing an image the rest of the fleet can't run. Same flag as the
    // operator-side builds (image.js, orchestrator.js) so all three agree.
    const args = ['docker', 'build', PLATFORM_BUILD_FLAG, '-t', imageTag, '.'];

    for (const [key, value] of Object.entries(buildArgs)) {
      args.push('--build-arg', `${key}=${value}`);
    }

    // The build itself is the dominant cost on direct-mode deploys; gate it
    // behind a perfTimer so cold (first-build, ~2-5min) vs warm (cached
    // BuildKit, 1-3s) is attributable in the trace.
    //
    // runCommand without silent:true returns `false` on non-zero exit instead
    // of throwing (see lib/command.js:135). Without this check, a failed
    // remote build silently proceeded to `s.stop('Image built natively')`,
    // returning true to the HA fan; the missing image then surfaced ~3 min
    // later as `pull access denied for <project>-app` during compose up
    // (compose-ha 2026-05-09T00:38 e2 failure). Treat the false return as a
    // hard failure so the error path captures + reports it.
    const buildT = perfTimer('deploy.image.remoteBuild');
    // BuildKit-over-SSH is flaky on first connect to a freshly-booted (often
    // cross-region) VPS: the session helper intermittently drops mid-build with
    // `http2: server: error reading preface ... file already closed` / an SSH
    // reset. Retry ONLY those transient drops — each attempt re-establishes a
    // fresh SSH/BuildKit session and BuildKit's cache makes retries cheap.
    //
    // F6: a genuine Dockerfile / RUN failure fails IDENTICALLY on every attempt,
    // so retrying it just burns time before surfacing the same error — gate
    // the retry on isTransientBuildError() and fail fast otherwise. Run silent
    // (capturing) so we HAVE the stderr to classify + surface (the old
    // stdio:'inherit' returned a bare `false` with no captured output, making
    // both the classification and the failure message impossible); the
    // "Building image natively" spinner still animates during the async build.
    //
    // Ladder selection: locked in on the FIRST failure's classification and
    // held for the rest of this build's retries (a DNS-not-settled resolver
    // and a transport blip don't realistically alternate attempt-to-attempt
    // for the same command). Starts on the fast transport ladder; a
    // DNS-not-settled first failure switches to the longer one for the
    // whole sequence — see TRANSPORT_DROP_RETRY_DELAYS_MS /
    // DNS_NOT_SETTLED_RETRY_DELAYS_MS above.
    let delaysMs = TRANSPORT_DROP_RETRY_DELAYS_MS;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await runCommandAsync(args, { cwd, env, timeout: 600000, silent: true });
        break;
      } catch (err) {
        const lastOutput = `${err.stderr || ''}${err.stdout || ''}`.trim();
        const dnsNotSettled = isDnsNotSettledBuildError(lastOutput);
        const transient = !!err.timedOut || dnsNotSettled || isTransientBuildError(lastOutput);
        if (!transient) {
          // Genuine build failure — do not retry.
          buildT.end();
          throw new Error(
            `docker build failed on ${ip} for tag ${imageTag} (non-transient — not retried):\n${lastOutput
              .split('\n')
              .slice(-40)
              .join('\n')}`,
          );
        }
        if (attempt === 1 && dnsNotSettled) {
          delaysMs = DNS_NOT_SETTLED_RETRY_DELAYS_MS;
        }
        const totalAttempts = delaysMs.length + 1;
        if (attempt >= totalAttempts) {
          buildT.end();
          // EVIDENCE CAPTURE before giving up. Three transport drops in one
          // night (2026-08-23, linode: dial-stdio exit 255 at the daemon
          // _ping) exhausted this ladder with nothing recorded about WHY the
          // wrapper's ssh died — while the plain probe ssh, seconds earlier,
          // succeeded. One verbose probe through the SAME wrapper turns the
          // next occurrence into a diagnosis (kex? banner? mux? peer reset?)
          // instead of another "transient". Diagnostics must never mask the
          // real failure, so this is best-effort and the throw is unchanged.
          let sshDiag = '';
          try {
            runCommand(
              // BatchMode explicitly even though the PATH wrapper adds it too — the
              // shell-safety census reads argv literals; belt+braces costs nothing.
              [
                'ssh',
                '-vv',
                '-o',
                'BatchMode=yes',
                `root@${ip}`,
                'docker version --format {{.Server.Version}}',
              ],
              {
                silent: true,
                env,
              },
            );
            sshDiag =
              '\n[ssh-diag] verbose probe SUCCEEDED after the build transport died — the drop is build-session-specific (BuildKit stream/mux), not host reachability.';
          } catch (diagErr) {
            const detail = diagErr instanceof Error ? diagErr.message : String(diagErr);
            sshDiag = `\n[ssh-diag] verbose probe ALSO failed — transport-level. Last ssh -vv output:\n${detail
              .split('\n')
              .slice(-25)
              .join('\n')}`;
          }
          throw new Error(
            `docker build failed on ${ip} for tag ${imageTag} after ${totalAttempts} transient attempts:${sshDiag}\n${lastOutput
              .split('\n')
              .slice(-40)
              .join('\n')}`,
          );
        }
        // The "Building image natively" spinner (above) animates during the
        // async build, so this retry line fires mid-spinner — route it through
        // progressLog to update that spinner's message instead of shredding
        // its cursor line with a raw console.error.
        const waitMs = delaysMs[attempt - 1];
        progressLog(
          `[remote-build] ${dnsNotSettled ? 'DNS-not-settled' : 'transient BuildKit/SSH'} drop on ${ip} (attempt ${attempt}/${totalAttempts}) — retrying in ${waitMs / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    buildT.end();

    s.stop(`Image built natively: ${imageTag}`);
    return true;
  } catch (error) {
    s.stop(`Remote build failed`);
    p.log.error(error.message);
    return false;
  } finally {
    try {
      rmSync(tempBinDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}
