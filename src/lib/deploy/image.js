/**
 * Sideload primitives for local-first deploys.
 *
 * Three responsibilities:
 *   1. Generate a unique local image tag (pure)
 *   2. Inspect git state (sha + dirty)
 *   3. Build + sideload to a compose-mode server (laptop → docker daemon)
 *
 * The k8s-mode sideload lives in src/lib/deploy/k8s/k3s.js (`sideloadK3s`).
 * No registry round-trip; the image goes operator → target directly.
 *
 * See the local-first-deploy-design spec §1.
 */

import { execFileSync } from 'node:child_process';
import { gitSafeEnv, runCommandAsync } from '../command.js';
import { knownHostsPathForKey, SSH_CONNECTION_OPTS } from '../host-keys.js';
import { shEscape } from '../shell.js';
import { AMD64_BUILD_HINT, PLATFORM_BUILD_FLAG } from './platform.js';

const LOCAL_REGISTRY_PREFIX = 'vibecarbon-local';

/**
 * Build a unique local image tag.
 *
 * Tag scheme: `<prefix>/<project>:<sha>[-dirty]-<timestamp>`. The
 * `-dirty` marker fires when the working tree has uncommitted changes, so
 * stale rebuilds from a clean tree don't collide with iterative
 * uncommitted work. Timestamp is UTC YYYYMMDDHHMMSS for sortability.
 *
 * `prefix` defaults to the compose-mode default `vibecarbon-local`. The
 * k8s-mode caller (buildAppImage in k8s/k3s.js) passes `10.0.1.1:5000` so
 * the same tag works as both a sideload reference (kubelet `IfNotPresent`
 * on static workers) and a registry-pull reference (CA-spawned workers
 * pulling from master's local registry pod via `registries.yaml`).
 *
 * @param {{projectName: string, gitSha: string, isDirty: boolean, timestamp: string, prefix?: string}} args
 * @returns {string}
 */
export function generateLocalImageTag({
  projectName,
  gitSha,
  isDirty,
  timestamp,
  prefix = LOCAL_REGISTRY_PREFIX,
}) {
  const dirtyMarker = isDirty ? '-dirty' : '';
  return `${prefix}/${projectName}:${gitSha}${dirtyMarker}-${timestamp}`;
}

/**
 * Read git short-sha + dirty-state for `cwd`. Both halves swallow errors and
 * return safe fallbacks: `nogit`/`false`. The caller (buildLocalImage)
 * doesn't fail just because the project is outside a git repo or git isn't
 * on PATH — sketch-mode users may not have committed yet.
 *
 * @param {string} cwd
 * @returns {{gitSha: string, isDirty: boolean}}
 */
export function inspectGitState(cwd) {
  let gitSha = 'nogit';
  let isDirty = false;
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      // GIT_DIR overrides cwd — under a hook wrapper this would stamp the HOST
      // repo's sha onto the built image. See gitSafeEnv.
      env: gitSafeEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    gitSha = sha.trim() || 'nogit';
  } catch {
    return { gitSha: 'nogit', isDirty: false };
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      env: gitSafeEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    isDirty = status.trim().length > 0;
  } catch {
    // git status failed but rev-parse worked — non-fatal, treat as clean.
  }
  return { gitSha, isDirty };
}

/**
 * Build a local container image and return its unique tag.
 *
 * Combines `inspectGitState` for cache-busting inputs, `generateLocalImageTag`
 * for the tag scheme, and a `docker build` shell-out. Side-effecting; the
 * docker build step inherits stdio so the operator sees layer progress.
 *
 * `tagPrefix` defaults to `vibecarbon-local` (compose-mode behavior). k8s
 * mode passes `10.0.1.1:5000` so the resulting tag is a valid registry
 * reference that CA-spawned workers can pull from master's local registry
 * pod (Phase 1 wired the registries.yaml; Phase 6 wires the push).
 *
 * @param {string} projectDir - Project root with the Dockerfile.
 * @param {{projectName: string, timestamp?: string, rebuild?: boolean, tagPrefix?: string, buildArgs?: Record<string,string>}} options
 * @returns {Promise<{tag: string, gitSha: string, isDirty: boolean}>}
 */
export async function buildLocalImage(projectDir, options) {
  const { projectName, rebuild = false, tagPrefix, buildArgs = {} } = options;
  if (!projectName) {
    throw new Error('buildLocalImage: projectName is required');
  }
  const timestamp = options.timestamp ?? defaultTimestamp();
  const { gitSha, isDirty } = inspectGitState(projectDir);
  const tag = generateLocalImageTag({
    projectName,
    gitSha,
    isDirty,
    timestamp,
    prefix: tagPrefix,
  });

  // Pin the target architecture. This build runs on the OPERATOR's machine, so
  // without the flag the image inherits whatever the operator's Docker daemon
  // is — an Apple Silicon operator silently shipped an arm64 image to an amd64
  // server and only found out when the container failed to exec. vibecarbon is
  // x86-64 only (see platform.js for the provider data behind that decision),
  // so state it here rather than hoping the operator's host matches.
  const args = ['build', PLATFORM_BUILD_FLAG];
  if (rebuild) args.push('--no-cache');
  // Vite inlines import.meta.env.VITE_* at build time, so the browser bundle
  // bakes whatever these ARGs resolve to. Without passing them the bundle ships
  // empty VITE_SUPABASE_* and crashes at page load with "Missing Supabase
  // environment variables" — k8s shipped exactly this because buildAppImage
  // passed no build args (compose plumbs them via collectComposeBuildArgs).
  for (const [k, v] of Object.entries(buildArgs)) {
    if (v !== undefined && v !== null && v !== '') args.push('--build-arg', `${k}=${v}`);
  }
  args.push('-t', tag, projectDir);

  // silent: false (the default) inherits stdio so the operator sees layer
  // progress — but runCommandAsync only *rejects* on nonzero exit when
  // silent:true; with inherited stdio it resolves `false` instead (see
  // global constraints). The old execFileSync({stdio:'inherit'}) threw on
  // its own, so we must replicate "fail loudly" by hand here.
  const ok = await runCommandAsync(['docker', ...args], {});
  if (ok === false) {
    throw new Error(`buildLocalImage: docker build failed for ${tag}. ${AMD64_BUILD_HINT}`);
  }
  return { tag, gitSha, isDirty };
}

function defaultTimestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '');
}

/**
 * Sideload a built local image to a compose-mode server.
 *
 * `set -o pipefail && docker save | gzip -1 | ssh target gunzip | docker load`
 * streams the image tarball compressed over the wire — no temp file on
 * either end, no registry. The image lands in the server's docker daemon
 * and is immediately referenceable by tag for `docker compose up`.
 *
 * gzip on the wire: Node app images compress 3-5x (most layers are JS
 * source + node_modules text), so a ~600MB save becomes ~150-200MB on
 * the wire. The K8s sideload (sideloadK3s in k3s.js) used the same trick
 * to drop sideload time from 23-29 min to 5-10 min on the operator's
 * residential upload — compose-mode missed the optimization until now.
 * `gzip -1` is universally present and dominant cost is network, not CPU.
 *
 * `pipefail` so a docker-save / gzip failure isn't masked by ssh's exit code.
 *
 * @param {{tag: string, sshTarget: string, sshKey?: string}} args
 * @returns {Promise<void>}
 */
export async function sideloadCompose({ tag, sshTarget, sshKey }) {
  // SSH options mirror remote-build.js's wrapper + the compose deploy path:
  //   * Host-key pinned per-env (knownHostsPathForKey), NOT /dev/null + no.
  //     accept-new TOFU's an ephemeral/recycled Hetzner IP but rejects a
  //     changed key for an already-pinned host (MITM on an established env
  //     fails). GlobalKnownHostsFile=/dev/null ignores the system file; the
  //     operator's ~/.ssh/known_hosts is never touched (a stale entry there
  //     would otherwise reject a recycled IP — iter-perfwave4 hit this).
  //   * ConnectTimeout=30: bound the network half of dial; sideload's own
  //     stream is unbounded (limited by docker save throughput). Placed
  //     BEFORE the shared opts' ConnectTimeout=10 — OpenSSH takes the FIRST
  //     value obtained per option, so 30 wins for this long-haul stream.
  //   * SSH_CONNECTION_OPTS supplies the rest (BatchMode, ServerAlive
  //     keepalives, ControlMaster) from the single shared source — this
  //     site's hand-rolled subset had silently dropped the keepalives, the
  //     exact gap that bit the bundle upload in run 31961619204 (raw-ssh
  //     census now pins every such site).
  const sshFlags = ['-o', 'StrictHostKeyChecking=accept-new'];
  if (sshKey) {
    // shEscape the known_hosts assignment so a project dir with spaces can't
    // split the argument in the bash -c string below.
    sshFlags.push('-o', shEscape(`UserKnownHostsFile=${knownHostsPathForKey(sshKey)}`));
    sshFlags.push('-o', 'GlobalKnownHostsFile=/dev/null');
  }
  sshFlags.push('-o', 'ConnectTimeout=30');
  // Every path-valued shared token (ControlPath) shEscaped for the bash -c
  // string, same rule as composeSshOptsString.
  sshFlags.push(...SSH_CONNECTION_OPTS.map((tok) => (tok === '-o' ? tok : shEscape(tok))));
  if (sshKey) sshFlags.unshift('-i', shEscape(sshKey));
  const cmd = `set -o pipefail && docker save ${tag} | gzip -1 | ssh ${sshFlags.join(' ')} ${sshTarget} 'gunzip | docker load'`;
  // Capture stdio rather than inheriting it: ssh's "Permanently added" host-
  // key warning + `docker load`'s "Loaded image:" success line both bypass
  // the clack gutter when inherited and print flush-left, breaking the
  // visual flow. On success we don't need either; on failure we surface
  // the captured stderr for debugging via the thrown Error. silent:true is
  // required both to get the capture and because runCommandAsync only
  // rejects (rather than resolving `false`) on nonzero exit in that mode.
  try {
    await runCommandAsync(['bash', '-c', cmd], { silent: true });
  } catch (err) {
    const stderr = err.stderr?.toString().trim() || '';
    const stdout = err.stdout?.toString().trim() || '';
    // Surface whatever signal the operator can act on: child stderr first
    // (real ssh / docker errors), then stdout, then the wrapping error's
    // message (preserves "Connection refused" when runCommandAsync's own
    // error string is the only thing we have).
    const detail = [stderr, stdout, err.message].filter(Boolean).join('\n').trim();
    // An SSH connect timeout/refusal on port 22 is almost always the operator
    // allowlist (SSH is firewalled to an IP allowlist while the app's 80/443
    // stay open), not a dead server — point there instead of leaving a raw
    // "Connection timed out" that sends the operator debugging their network.
    const host = sshTarget.split('@').pop();
    const looksLikeSshBlocked =
      /connect to host .* port 22|Connection timed out|Connection refused|Operation timed out|No route to host/i.test(
        detail,
      );
    const hint = looksLikeSshBlocked
      ? `, could not reach ${host} over SSH (port 22). This usually means your ` +
        `current IP isn't on the operator allowlist (SSH is locked to an allowlist; ` +
        `the app's 80/443 stay open, so the server is likely fine). Run ` +
        `\`vibecarbon access add <your-cidr>\` to add it, or check your connection / ` +
        `an outbound port-22 block.`
      : '';
    const wrapped = new Error(
      `sideloadCompose failed (exit ${err.status ?? '?'}): ${detail}${hint}`,
    );
    wrapped.cause = err;
    throw wrapped;
  }
}
