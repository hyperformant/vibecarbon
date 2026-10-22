/**
 * Image primitives for local-first deploys.
 *
 * Four responsibilities:
 *   1. Generate a unique local image tag (pure)
 *   2. Inspect git state (sha + dirty)
 *   3. Build the image on the operator's machine
 *   4. Read the runtime base the Dockerfile builds FROM
 *
 * Delivery to a server, compose or k8s, is the layer delta (layer-delta.js,
 * deliverImage).
 *
 * See the local-first-deploy-design spec §1.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitSafeEnv, runCommandAsync } from '../command.js';
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
  // empty client config — k8s once shipped exactly this because buildAppImage
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
 * The runtime base a project's Dockerfile builds its app image FROM: the
 * `ARG RUNTIME_IMAGE=<ref>` default (carbon/Dockerfile, NODE_RUNTIME_IMAGE in
 * images.js). A deploy pulls exactly this ref on the server so the layer delta
 * (layer-delta.js) ships only the app's own layers. A Dockerfile without the
 * ARG (a customer's own) gets null: no base pull, and the delta carries every
 * layer, which is the same algorithm.
 *
 * @param {string} projectDir - Project root holding the Dockerfile.
 * @returns {string|null}
 */
export function readRuntimeBaseRef(projectDir) {
  let text;
  try {
    text = readFileSync(join(projectDir, 'Dockerfile'), 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  // A Dockerfile may quote the default (`ARG RUNTIME_IMAGE="ref"`); the ref is
  // what the build resolved, without them.
  const m = /^ARG RUNTIME_IMAGE=(?:"([^"\s]+)"|'([^'\s]+)'|([^"'\s]\S*))\s*$/m.exec(text);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}
