/**
 * CI-first image setup for `vibecarbon deploy`.
 *
 * The deploy command doesn't build images locally — CI (GitHub Actions) does,
 * publishing to GitHub Container Registry. This module bootstraps that pipeline
 * on first deploy and verifies the expected image tag is available before we
 * touch any infrastructure.
 *
 * Contract: `ensureCIImageReady()` returns `{ imageTag, githubOwner, repoName,
 * ghcrPullCreds }`. If any step fails irrecoverably the caller should abort
 * the deploy — there's no image to pull.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { exitCancelled } from './cli/exit-guard.js';
import { spinner } from './cli/progress.js';
import { checkDependency, runCommand, runCommandAsync } from './command.js';
import { loadProjectConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the bundled workflow template that ships with the CLI.
// Note: carbon/ is copied into user projects by `vibecarbon create`, but the
// workflow may be missing or out-of-date on existing projects — we copy-on-demand
// from here so the shipped CLI version is always authoritative.
const WORKFLOW_TEMPLATE_PATH = join(
  __dirname,
  '..',
  '..',
  'carbon',
  '.github',
  'workflows',
  'vibecarbon-build.yml',
);

const PROJECT_WORKFLOW_PATH = '.github/workflows/vibecarbon-build.yml';
const PROJECT_DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy.yml';

// The build workflow resolves its Node version from the project's `.nvmrc`
// (`node-version-file`), so that file is a hard prerequisite — setup-node
// fails the run outright if the path doesn't exist. `vibecarbon create`
// writes it, but projects scaffolded before it existed have none, and the
// workflow is copy-on-demand from the shipped CLI. Install both together or
// the first CI run after an upgrade dies on a missing file.
const NODE_VERSION_TEMPLATE_PATH = join(__dirname, '..', '..', 'carbon', '.nvmrc');
const PROJECT_NODE_VERSION_PATH = '.nvmrc';

// Deploy workflow template (lives alongside the build workflow in carbon/).
const DEPLOY_WORKFLOW_TEMPLATE_PATH = join(
  __dirname,
  '..',
  '..',
  'carbon',
  '.github',
  'workflows',
  'deploy.yml',
);

/**
 * Check whether CI/CD is configured for the project.
 *
 * Authoritative signal: `.vibecarbon.json` has `cicdEnabled: true`, set by
 * `vibecarbon configure` → CI/CD. Anything else returns false — direct
 * deploy is the default, CI/CD is an explicit opt-in.
 *
 * Goes through loadProjectConfig rather than reading a path itself. The first
 * cut hand-rolled `join(cwd, 'vibecarbon.json')` and missed the leading dot,
 * so the file never existed, this always returned false, resolveBuildMode()
 * could never return 'push', and the CI branch in deploy/prompts.js was
 * unreachable. Nothing failed loudly — the push path just silently never ran.
 */
export function ciAvailable(cwd = process.cwd()) {
  try {
    return loadProjectConfig(cwd)?.cicdEnabled === true;
  } catch {
    return false;
  }
}

/**
 * Resolve the build mode for a deploy.
 *
 * Returns one of: 'local' | 'direct' | 'push'.
 *
 *   - 'local'  — k3s + compose default: build the image on the operator's
 *                machine, sideload the tarball via `docker save | ssh
 *                docker load`. No registry round-trip. Compose runs the
 *                local build in parallel with `iac.upStack` (Pulumi VPS
 *                provisioning) so the build cost is hidden behind the
 *                ~109s VM-provisioning window.
 *   - 'direct' — compose legacy: build over `DOCKER_HOST=ssh://` against
 *                the new VPS. Slower (sequential after upStack) but works
 *                when the operator has no local Docker. Selected via
 *                `--direct`, or auto-fallback when `docker` is missing.
 *   - 'push'   — compose: commit + push triggers GitHub Actions build
 *                and deploy. Default when CI/CD is configured.
 *
 * K8s/k8s-ha is always 'local'. Layer in Flux + GHA via
 * `vibecarbon configure cicd <env>` after the cluster is up — that
 * doesn't go through this function.
 *
 * Compose modes auto-detect the default. The interactive compose prompt
 * (lib/deploy/prompts.js) lets the operator override by mutating
 * args.direct or args.push when CI/CD is configured; this function
 * honors that mutation. --yes deploys take the auto-detected default.
 *
 * Pre-PR-5 (2026-04-25 spec): five flags (`--direct`/`--push`/`--build-local`/
 * `--gitops`/`--no-gitops`) gated this with a precedence ladder. PR 5
 * collapsed them to one default per mode. The `--gitops` path moved
 * to a new `vibecarbon configure cicd <env>` subcommand (PR 7).
 */
export function resolveBuildMode(args = {}, cwd = process.cwd(), deployMode = null) {
  const isK8s = deployMode === 'kubernetes' || deployMode === 'kubernetes-ha';
  if (isK8s) return 'local';
  if (args.direct && args.push) {
    throw new Error('Cannot pass both direct and push build modes. Pick one.');
  }
  if (args.push) return 'push';
  if (args.direct) return 'direct';
  if (ciAvailable(cwd)) return 'push';
  // Compose default: prefer 'local' when the operator has docker so we can
  // run buildLocalImage in parallel with iac.upStack (saves ~30-40s off
  // cold deploy by hiding the build behind VPS provisioning). Fall back to
  // 'direct' (build over DOCKER_HOST=ssh://) when docker is missing —
  // legacy behavior, no operator-side dependencies.
  return checkDependency('docker') ? 'local' : 'direct';
}

/**
 * Resolve the short git SHA for the current HEAD. Falls back to 'latest' if
 * the project isn't a git repo.
 */
export function getImageTag(cwd = process.cwd()) {
  try {
    const sha = runCommand(['git', 'rev-parse', '--short', 'HEAD'], {
      silent: true,
      returnOutput: true,
      cwd,
      cleanEnv: true,
    })
      ?.toString()
      .trim();
    return sha || 'latest';
  } catch {
    return 'latest';
  }
}

/**
 * Resolve the GitHub owner/repo pair for the current working directory.
 * Uses `gh repo view` — returns null if no gh remote is configured.
 */
export function getGitHubRepo(cwd = process.cwd()) {
  try {
    const out = runCommand(['gh', 'repo', 'view', '--json', 'owner,name'], {
      silent: true,
      returnOutput: true,
      cwd,
    });
    const parsed = JSON.parse(out.toString());
    return { owner: parsed.owner?.login || null, name: parsed.name || null };
  } catch {
    return { owner: null, name: null };
  }
}

/**
 * Get a GHCR-authenticated token using `gh auth token`. Returns null if gh
 * isn't authenticated. Works for both public and private packages.
 */
function getGHCRToken() {
  try {
    const token = runCommand(['gh', 'auth', 'token'], {
      silent: true,
      returnOutput: true,
    })
      ?.toString()
      .trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Check whether a specific tag exists in ghcr.io. Uses the GitHub packages API
 * via `gh api` (inherits auth), so this works for private packages.
 *
 * Missing `read:packages` scope causes a 403 here — we surface that as a
 * thrown error rather than swallowing it as "tag not found", because the
 * symptom (deploy waits 15m for an image CI already published) is miserable
 * to debug otherwise.
 */
export async function ghcrTagExists(owner, repo, tag) {
  try {
    const out = runCommand(
      [
        'gh',
        'api',
        `/users/${owner}/packages/container/${repo}/versions`,
        '--jq',
        `.[].metadata.container.tags[] | select(. == "${tag}")`,
      ],
      { silent: true, returnOutput: true },
    );
    return Boolean(out?.toString().trim());
  } catch (err) {
    const stderr = (err?.stderr ?? '').toString();
    if (/You need at least read:packages scope/.test(stderr)) {
      throw new Error(
        'gh token missing `read:packages` scope — run `gh auth refresh -h github.com -s read:packages` and retry.',
      );
    }
    if (/HTTP 401|HTTP 403/.test(stderr)) {
      throw new Error(`gh api for ghcr package versions failed: ${stderr.trim()}`);
    }
    // 404 on first poll (package doesn't exist yet) is legitimate "tag not found".
    return false;
  }
}

/**
 * Commit + push any pending changes, then wait for the build workflow to
 * publish the expected tag. Returns when the tag is available in ghcr.io.
 *
 * Poll cadence: fast (2s) for the first 60s while CI is nearly done on
 * redeploys with layer cache; slow (10s) after so we don't hammer the
 * GitHub API during genuine cold builds.
 */
async function waitForCIImage(owner, repo, tag, options = {}) {
  // 35-min budget — first deploy on a fresh repo cold-builds npm ci,
  // runs lint+typecheck+test, then docker buildx + GHCR push. Empirically:
  //   - 12-18 min on a warm runner with primed buildx cache
  //   - 25-30 min on a cold fresh-repo path (no cache, full deps install,
  //     full Vite build, full Docker build)
  // An earlier 25-min cap tripped both compose scenarios on a cold
  // e2e run; they failed at the cap with no inline diagnostic
  // surfaced. 35 min covers the cold tail; the lifecycle
  // deploy step's overall timeout (40 min in
  // tests/e2e/scenarios/_run-lifecycle.ts) bounds this with 5 min
  // for the actual deploy after the image is ready (compose pulls + ups
  // in ~2 min normally).
  const { tracker, timeoutMs = 2_100_000 } = options;
  // Use the caller's tracker spinner when provided; otherwise a registered
  // spinner() so any concurrent retry loggers route through it, not over it.
  const spin = tracker ? tracker.spinner() : spinner();
  spin.start(`Waiting for CI to publish ghcr.io/${owner}/${repo}:${tag}...`);
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    if (await ghcrTagExists(owner, repo, tag)) {
      spin.stop(`Image published: ghcr.io/${owner}/${repo}:${tag}`);
      return true;
    }
    const elapsed = Date.now() - start;
    const intervalMs = elapsed < 60_000 ? 2_000 : 10_000;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  spin.stop('CI build did not publish image within timeout');
  return false;
}

/**
 * Exchange a GitHub PAT for a short-lived GHCR pull token.
 *
 * GHCR implements the OCI Distribution Spec: unauthenticated requests to
 * `/v2/...` return 401 with a `WWW-Authenticate: Bearer realm=...` challenge,
 * and the realm is `https://ghcr.io/token`. We exchange our PAT for a
 * pull-scoped token there using Basic auth, then use that token as Bearer
 * against the manifests endpoint.
 *
 * Returns the pull token, or null if exchange fails.
 */
async function getGhcrPullToken(owner, repo, pat) {
  try {
    const res = await fetch(`https://ghcr.io/token?scope=repository:${owner}/${repo}:pull`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${owner}:${pat}`).toString('base64')}`,
      },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.token || body.access_token || null;
  } catch {
    return null;
  }
}

/**
 * Wait for a manifest to be pullable from ghcr.io.
 *
 * `ghcrTagExists` (GH packages API) can report a tag present while the OCI
 * manifests endpoint (what kubelet / docker actually hit on pull) still
 * returns 404 for a few seconds. Polling the manifests endpoint directly
 * closes that race without the old blanket 30s sleep.
 *
 * The OCI registry auth dance: exchange our PAT for a pull-scoped token
 * against ghcr.io/token (Basic auth), then HEAD the manifest with Bearer.
 * The earlier version bearer-encoded the PAT directly — GHCR rejected
 * that with 401, so every probe timed out and we fell back to "proceed
 * anyway" after 30s. Proper exchange makes the probe actually work.
 *
 * Poll every 2s, cap at `timeoutMs` (default 30s). Returns true on first
 * HTTP 2xx; false on timeout (caller logs a warning but proceeds — the
 * probe is best-effort).
 */
export async function waitForGhcrManifest(owner, repo, tag, options = {}) {
  const { timeoutMs = 30_000, intervalMs = 2_000 } = options;
  const pat = getGHCRToken();
  if (!pat) return false;
  const pullToken = await getGhcrPullToken(owner, repo, pat);
  if (!pullToken) return false;
  const url = `https://ghcr.io/v2/${owner}/${repo}/manifests/${tag}`;
  const headers = {
    Authorization: `Bearer ${pullToken}`,
    Accept:
      'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers });
      if (res.ok) return true;
    } catch {
      // Network hiccup — keep polling until the deadline.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Install `.nvmrc` into the project if missing, from the CLI-bundled template.
 *
 * Separate from installWorkflowFile so it runs even when the workflow is
 * already present: a project created before `.nvmrc` shipped has the old
 * workflow (literal `node-version`), and `vibecarbon upgrade` will replace
 * that workflow with the `node-version-file` one. Without this the upgraded
 * workflow would reference a file that was never written.
 *
 * Returns true if newly installed, false if already present (idempotent).
 */
export function installNodeVersionFile(cwd = process.cwd()) {
  const target = join(cwd, PROJECT_NODE_VERSION_PATH);
  if (existsSync(target)) return false;
  if (!existsSync(NODE_VERSION_TEMPLATE_PATH)) {
    throw new Error(
      `Node version template not found at ${NODE_VERSION_TEMPLATE_PATH}, vibecarbon install is incomplete`,
    );
  }
  writeFileSync(target, readFileSync(NODE_VERSION_TEMPLATE_PATH, 'utf-8'));
  return true;
}

/**
 * Install the vibecarbon build workflow into the project if missing.
 * Returns true if THE WORKFLOW was newly created — not whether anything was
 * written. `vibecarbon configure` → CI/CD reports on the workflow specifically
 * and then tells the operator to stage both files by hand, so it wants exactly
 * this signal.
 *
 * Always ensures `.nvmrc` too — the workflow reads it via `node-version-file`
 * and setup-node hard-fails on a missing path. Callers that AUTO-COMMIT must
 * use installCiFiles() instead, which reports that write as well; see there.
 */
export function installWorkflowFile(cwd = process.cwd()) {
  installNodeVersionFile(cwd);
  const target = join(cwd, PROJECT_WORKFLOW_PATH);
  if (existsSync(target)) return false;
  if (!existsSync(WORKFLOW_TEMPLATE_PATH)) {
    throw new Error(
      `Workflow template not found at ${WORKFLOW_TEMPLATE_PATH}, vibecarbon install is incomplete`,
    );
  }
  const content = readFileSync(WORKFLOW_TEMPLATE_PATH, 'utf-8');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return true;
}

/**
 * Install every file CI needs, reporting which ones were actually written.
 *
 * Returns `{ workflow, nodeVersion, needsCommit }`.
 *
 * `needsCommit` is the whole point. A project scaffolded before `.nvmrc`
 * shipped already has the workflow, so installWorkflowFile() returns false
 * there — but `.nvmrc` still gets written. Gating the commit on the workflow
 * alone would leave that file untracked in the operator's working tree: an
 * unrequested mutation, in a module whose commit path deliberately stages only
 * its own files ("don't sweep the user's working tree"). Worse, the next
 * `vibecarbon upgrade` swaps in the node-version-file workflow, and CI then
 * dies at setup-node on a path that was never committed.
 *
 * Anything this function writes must end up in the commit, so callers gate on
 * `needsCommit`, never on `workflow`.
 */
export function installCiFiles(cwd = process.cwd()) {
  // Order matters: installWorkflowFile() also ensures .nvmrc, so calling it
  // first would swallow the nodeVersion signal (its inner call would write the
  // file and this one would then report false).
  const nodeVersion = installNodeVersionFile(cwd);
  const workflow = installWorkflowFile(cwd);
  return { workflow, nodeVersion, needsCommit: workflow || nodeVersion };
}

/**
 * Install `.github/workflows/deploy.yml` from the CLI-bundled template.
 *
 * This workflow drives the K8s push-deploy path: applies env-secrets,
 * bootstraps Flux, triggers reconciliation. Only relevant for K8s deploys
 * but installed unconditionally during `vibecarbon configure` → CI/CD so
 * the project can flip to K8s later without a second configure step.
 *
 * Returns true if newly installed, false if already present (idempotent).
 */
export function installDeployWorkflowFile(cwd = process.cwd()) {
  const target = join(cwd, PROJECT_DEPLOY_WORKFLOW_PATH);
  if (existsSync(target)) return false;
  if (!existsSync(DEPLOY_WORKFLOW_TEMPLATE_PATH)) {
    throw new Error(
      `Deploy workflow template not found at ${DEPLOY_WORKFLOW_TEMPLATE_PATH}, vibecarbon install is incomplete`,
    );
  }
  const content = readFileSync(DEPLOY_WORKFLOW_TEMPLATE_PATH, 'utf-8');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return true;
}

/**
 * Update Docker/K8s image references + Flux GitRepository URLs with the
 * correct GitHub owner. At `vibecarbon create` time, GITHUB_OWNER defaults
 * to the project name (see create.js); `configure` → CI/CD learns the real
 * owner via `gh api user` (or the operator-supplied owner) and rewrites
 * every place that baked in the wrong owner.
 *
 * Two substitution passes:
 *   - `ghcr.io/<wrong>/<project>` → `ghcr.io/<owner>/<project>`
 *     (app image refs in docker-compose, k8s Deployment + overlays)
 *   - `github.com/<wrong>/<project>` → `github.com/<owner>/<project>`
 *     (Flux GitRepository source URL in both cluster overlays)
 *
 * The Flux URL rewrite was missing before 2026-04-22 and caused the
 * GitRepository to fail with "authentication required" — the URL owner
 * was the project name, the auth token was scoped to the real repo,
 * so source-controller's git clone 403'd. Flux Kustomizations then
 * sat with "Source artifact not found, retrying in 30s" forever and
 * deploy.yml's `kubectl wait` for vibecarbon-base hit 10m timeout.
 *
 * Mirrored at deploy time by rewriteOwnerAndRepo() in lib/deploy/k8s/
 * gitops-deploy.js for projects that reach deploy without configuring
 * CI/CD first — keep the two helpers in sync.
 */
export function updateImageReferences(projectName, githubOwner, cwd = process.cwd()) {
  const filesToUpdate = [
    'docker-compose.prod.yml',
    'k8s/base/app/deployment.yaml',
    'k8s/base/backup/cronjob.yaml',
    'k8s/values/supabase.values.yaml',
    'k8s/overlays/production/kustomization.yaml',
    'k8s/flux/clusters/primary/vibecarbon.yaml',
    'k8s/flux/clusters/standby/vibecarbon.yaml',
  ];

  // Match the main app image plus the `-db` and `-backup` suffix variants
  // that supabase.values.yaml + backup/cronjob.yaml pull.
  const imagePattern = new RegExp(`ghcr\\.io/[^/]+/${projectName}(-db|-backup)?\\b`, 'g');
  const fluxPattern = new RegExp(`github\\.com/[^/]+/${projectName}\\b`, 'g');

  for (const file of filesToUpdate) {
    const filePath = join(cwd, file);
    if (existsSync(filePath)) {
      let content = readFileSync(filePath, 'utf-8');
      content = content.replace(
        imagePattern,
        (_m, suffix) => `ghcr.io/${githubOwner}/${projectName}${suffix ?? ''}`,
      );
      content = content.replace(fluxPattern, `github.com/${githubOwner}/${projectName}`);
      writeFileSync(filePath, content);
    }
  }
}

/**
 * Detect GitHub username from gh CLI (authenticated user). Returns null if
 * gh is not installed/authenticated or the API call fails.
 */
export function detectGitHubUsername() {
  return runCommand('gh api user -q .login', { silent: true, ignoreError: true })?.trim() || null;
}

/**
 * Commit + push the CI files so GitHub Actions picks them up.
 *
 * `installedWorkflow` only selects the commit subject — both paths are staged
 * either way, since `git add` on an unchanged file is a no-op and staging the
 * pair is what keeps the workflow and the `.nvmrc` it resolves from landing in
 * the same commit.
 */
async function commitAndPushWorkflow(cwd = process.cwd(), installedWorkflow = true) {
  // Only commit our own files (the workflow + the .nvmrc it reads via
  // node-version-file — pushing the workflow without it fails the run at
  // setup-node) — don't sweep the user's working tree
  runCommand(['git', 'add', PROJECT_WORKFLOW_PATH, PROJECT_NODE_VERSION_PATH], {
    cwd,
    cleanEnv: true,
  });
  const subject = installedWorkflow
    ? 'chore: add vibecarbon build workflow'
    : `chore: add ${PROJECT_NODE_VERSION_PATH} for the vibecarbon build workflow`;
  runCommand(
    ['git', 'commit', '-m', subject],
    { cwd, ignoreError: true, cleanEnv: true }, // already-committed or empty is fine
  );
  await runCommandAsync(['git', 'push'], { cwd, silent: true, cleanEnv: true });
}

/**
 * Ensure a built image exists in ghcr.io for the current HEAD. Bootstraps CI
 * if needed (first deploy). Returns deploy-time info:
 *   { imageTag, githubOwner, repoName, ghcrPullCreds }
 *
 * - `imageTag`: the tag to reference in k8s/compose manifests
 * - `githubOwner`: the GH owner (user/org) for ghcr.io path
 * - `repoName`: the GH repo name (= ghcr package name)
 * - `ghcrPullCreds`: { owner, token } for kubelet/docker login (null if user
 *   opts for a public package)
 */
// Per-process cache of `gh auth status` — the call costs ~500ms and the result
// never changes within a single deploy invocation.
let _ghAuthChecked = false;

export async function ensureCIImageReady(options = {}) {
  const { yes = false, tracker, cwd = process.cwd(), buildArgs = null } = options;

  if (!checkDependency('gh', 'GitHub CLI')) {
    throw new Error(
      '`gh` CLI is required. Install from https://cli.github.com/ and run `gh auth login`.',
    );
  }
  if (!_ghAuthChecked) {
    // `gh auth status` prints to stderr even on success; return code is the signal.
    try {
      runCommand(['gh', 'auth', 'status'], { silent: true });
      _ghAuthChecked = true;
    } catch {
      throw new Error('`gh` is not authenticated. Run `gh auth login` and re-run deploy.');
    }
  }

  const repo = getGitHubRepo(cwd);
  if (!repo.owner || !repo.name) {
    throw new Error(
      'No GitHub remote detected. Run `gh repo create` (or `gh repo fork`) in this project first.',
    );
  }

  // Seed the VITE_* build args as repo variables BEFORE the workflow runs, so
  // the CI-built image bakes real values instead of empty strings. Must
  // precede commitAndPushWorkflow / workflow dispatch below (both trigger the
  // build). Skipped when the caller passes no buildArgs (e.g. older callers).
  if (buildArgs && Object.keys(buildArgs).length > 0) {
    const { seedBuildVars } = await import('./github-environments.js');
    const applied = await seedBuildVars(buildArgs);
    if (applied.length) p.log.info(`Seeded ${applied.length} VITE build var(s) for CI`);
  }

  // Install the workflow and the .nvmrc it reads if either is missing —
  // first-deploy case, and the pre-.nvmrc project case where only the latter
  // is. Gate on needsCommit, NOT on `workflow`: anything written here has to
  // reach the commit below or it lingers untracked in the operator's tree.
  const { workflow, nodeVersion, needsCommit } = installCiFiles(cwd);
  if (needsCommit) {
    if (workflow) p.log.info(`Installed ${PROJECT_WORKFLOW_PATH}`);
    if (nodeVersion) p.log.info(`Installed ${PROJECT_NODE_VERSION_PATH}`);
    const what = workflow
      ? 'the workflow'
      : `${PROJECT_NODE_VERSION_PATH} (required by the workflow)`;
    const shouldPush =
      yes ||
      (await p.confirm({
        message: `Commit + push ${what} to trigger the first image build?`,
        initialValue: true,
      }));
    if (p.isCancel(shouldPush)) {
      exitCancelled();
    }
    if (!shouldPush) {
      p.log.error('Workflow push cancelled, deploy requires a CI-built image.');
      process.exit(1);
    }
    await commitAndPushWorkflow(cwd, workflow);
  }

  const imageTag = getImageTag(cwd);
  const tagExists = await ghcrTagExists(repo.owner, repo.name, imageTag);
  if (!tagExists) {
    p.log.info(`ghcr.io/${repo.owner}/${repo.name}:${imageTag} not yet built, waiting for CI...`);
    // Brand-new repos don't auto-trigger workflows that were added in the
    // same initial commit (a known GitHub Actions quirk). The push event
    // is delivered before the workflow file is indexed, so the run is
    // silently skipped. E2E test runs hit this every time because
    // setup-repo creates the throwaway repo + pushes the initial commit
    // in one shot. Explicitly dispatching here is a no-op when the push
    // already triggered it (concurrency group cancels duplicates), and a
    // safety net when the push didn't.
    //
    // Indexing the new workflow file takes 30-60s on GitHub's side; an
    // immediate `gh workflow run` returns 404 "could not find workflow"
    // until then. Retry every 10s for up to 90s — long enough to cover
    // the indexing window, short enough to fail fast if something else
    // is wrong.
    let dispatched = false;
    for (let attempt = 0; attempt < 9; attempt++) {
      try {
        execFileSync('gh', ['workflow', 'run', 'vibecarbon-build.yml', '--ref', 'main'], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        dispatched = true;
        break;
      } catch {
        // Not yet indexed — wait and retry.
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    if (!dispatched) {
      p.log.warn(
        'Could not dispatch vibecarbon-build.yml after 90s, relying on push trigger if it fires.',
      );
    }
    const ok = await waitForCIImage(repo.owner, repo.name, imageTag, { tracker });
    if (!ok) {
      // Inline the build workflow's state so the operator isn't sent to
      // `gh run list` — in e2e-test runs the throwaway repo is
      // deleted seconds after this throws, so post-hoc `gh run view`
      // 404s. Mirrors the same pattern in waitForLatestWorkflowRun
      // (src/lib/github-environments.js). Each gh probe is wrapped
      // independently so a single failure (e.g., empty run list) doesn't
      // erase the rest of the diagnostic — the whole point of this block
      // is to ALWAYS leave a trace of why CI didn't publish.
      const safeGhJson = (argv) => {
        try {
          const out = execFileSync('gh', argv, {
            cwd,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          return { ok: true, value: out, parsed: JSON.parse(out) };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message.split('\n')[0] : String(err),
          };
        }
      };
      const detailLines = [];
      // (1) Did the workflow_dispatch even register?
      detailLines.push(`dispatched=${dispatched ? 'true' : 'false (push fallback only)'}`);
      // (2) Are there any runs at all? List the most-recent build runs.
      const listResult = safeGhJson([
        'run',
        'list',
        '--workflow',
        'vibecarbon-build.yml',
        '--limit',
        '3',
        '--json',
        'databaseId,status,conclusion,url,createdAt,event',
      ]);
      if (!listResult.ok) {
        detailLines.push(`gh run list failed: ${listResult.error}`);
      } else if (!listResult.parsed || listResult.parsed.length === 0) {
        detailLines.push(
          'gh run list returned 0 runs, workflow_dispatch never started a run ' +
            '(workflow file likely not yet indexed when push event fired). ' +
            'Check `gh workflow list` and re-trigger with `gh workflow run vibecarbon-build.yml`.',
        );
      } else {
        for (const run of listResult.parsed) {
          detailLines.push(
            `run ${run.databaseId} event=${run.event} status=${run.status}` +
              `${run.conclusion ? ` conclusion=${run.conclusion}` : ''} created=${run.createdAt} url=${run.url}`,
          );
        }
        // (3) Detail the most-recent run's job/step state.
        const run = listResult.parsed[0];
        if (run.status === 'completed' && run.conclusion !== 'success') {
          const logResult = (() => {
            try {
              const out = execFileSync(
                'gh',
                ['run', 'view', String(run.databaseId), '--log-failed'],
                { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
              );
              return { ok: true, value: out };
            } catch (err) {
              return {
                ok: false,
                error: err instanceof Error ? err.message.split('\n')[0] : String(err),
              };
            }
          })();
          if (logResult.ok) {
            const tail =
              logResult.value.length > 5000
                ? `…\n${logResult.value.slice(-5000)}`
                : logResult.value;
            detailLines.push(`--- build failing-step log (last 5KB) ---\n${tail}`);
          } else {
            detailLines.push(`gh run view --log-failed failed: ${logResult.error}`);
          }
        } else {
          const jobsResult = safeGhJson([
            'run',
            'view',
            String(run.databaseId),
            '--json',
            'status,conclusion,jobs,url',
          ]);
          if (jobsResult.ok) {
            const info = jobsResult.parsed;
            const jobs = (info.jobs ?? [])
              .map((j) => {
                const steps = (j.steps ?? [])
                  .map((s) => `    ${s.conclusion ?? s.status}  ${s.name}`)
                  .join('\n');
                return `  job: ${j.name} [${j.status}${j.conclusion ? `/${j.conclusion}` : ''}]\n${steps}`;
              })
              .join('\n');
            detailLines.push(
              `most-recent run still ${info.status} @ ${info.url}:\n${jobs || '  (no jobs)'}`,
            );
          } else {
            detailLines.push(`gh run view jobs failed: ${jobsResult.error}`);
          }
        }
      }
      const detail = `\n--- waitForCIImage diagnostics ---\n${detailLines.join('\n')}`;
      throw new Error(
        `CI did not publish ghcr.io/${repo.owner}/${repo.name}:${imageTag} in time.${detail}`,
      );
    }
  } else {
    p.log.success(`Using image ghcr.io/${repo.owner}/${repo.name}:${imageTag}`);
  }

  const token = getGHCRToken();
  const ghcrPullCreds = token ? { owner: repo.owner, token } : null;

  return {
    imageTag,
    githubOwner: repo.owner,
    repoName: repo.name,
    ghcrPullCreds,
  };
}

/**
 * Build the fully-qualified image reference for a ghcr.io-hosted app image.
 */
export function buildImageRef(owner, repo, tag) {
  return `ghcr.io/${owner}/${repo}:${tag}`.toLowerCase();
}
