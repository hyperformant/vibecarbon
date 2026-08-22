/**
 * Phase 4.3c of the GitOps refactor: the thin GitOps-driven deploy path.
 *
 * stale-deploy-ignore: historical context — describes what this file replaced.
 * Replaces the ~2000 LOC imperative `applyKubernetesManifests` with:
 *   1. Render deploy-time-varying manifests into the customer's k8s/ tree
 *      (image tag in app Deployment, rendered Supabase values.yaml).
 *   2. git add k8s/ && git commit && git push.
 *   3. Seed GitHub Environment secrets + vars + upload KUBECONFIG_B64.
 *   4. Trigger .github/workflows/deploy.yml + wait for completion.
 *
 * The workflow (Phase 4.3b.C) installs Flux + root Kustomization + applies
 * vibecarbon-secrets / cert-manager `hetzner` / kube-system/hcloud Secrets.
 * Flux reconciles the rest from the committed k8s/ tree.
 *
 * Callers: `vibecarbon configure cicd <env>` (PR 7) layers this onto an
 * already-running local-first cluster. Pre-PR-5 it was the default for
 * `vibecarbon deploy --k8s --gitops`; that flag was retired with PR 5.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { spinner } from '../../cli/progress.js';
import { gitSafeEnv } from '../../command.js';
import { featureConfigKeys, featureSecretKeys } from '../../config-registry.js';
import {
  seedEnvironmentSecrets,
  seedOrgSecrets,
  triggerDeployWorkflow,
  uploadKubeconfig,
  waitForLatestWorkflowRun,
} from '../../github-environments.js';
import { deriveProjectBucketName } from '../../providers/s3-base.js';

/**
 * Resolve the wal-g backup bucket for a gitops render: persisted names first
 * (sub-environment, then parent env — the keys orchestrator.js actually
 * writes are `backupS3.bucket`), deriving a fresh salt-aware name only when
 * neither environment has ever deployed.
 *
 * Regression guard: configure.js used to read `envConfig.backupBucket`, a key
 * nothing writes, so the render always fell through to a raw
 * `${projectName}-backups` interpolation — unsanitized and salt-blind.
 *
 * Pure + exported for unit tests.
 */
export function resolveGitopsBackupBucket(subEnvConfig, envConfig, projectConfig) {
  return (
    subEnvConfig?.backupS3?.bucket ||
    envConfig?.backupS3?.bucket ||
    deriveProjectBucketName(projectConfig, 'backups')
  );
}

/**
 * Build the operator-facing warning when observability is installed but this
 * gitops deploy won't reconcile it.
 *
 * H-9 isolation keeps observability OUT of k8s/base (it's applied as a separate
 * isolated kustomization by the direct k3s path — see applyK3sManifests). The
 * gitops/Flux path reconciles ONLY k8s/base and its Flux Kustomization for
 * k8s/base/observability is not wired yet (tracked follow-up). So a gitops deploy
 * would otherwise SILENTLY not ship observability — surface it loudly instead.
 *
 * Pure + exported so it's unit-testable without running a real deploy. Returns
 * the warning text, or null when observability isn't installed.
 *
 * @param {string} projectDir
 * @returns {string | null}
 */
export function observabilityGitopsWarning(projectDir) {
  const installed = existsSync(
    join(projectDir, 'k8s', 'base', 'observability', 'kustomization.yaml'),
  );
  if (!installed) return null;
  return (
    'Observability is installed but will NOT be deployed on the gitops/Flux path. ' +
    'For namespace isolation (H-9) it is kept out of k8s/base, and the Flux ' +
    'Kustomization for k8s/base/observability is not wired yet (tracked follow-up). ' +
    'It deploys only via a direct `vibecarbon deploy` (k3s) today. Grafana/Prometheus/Loki ' +
    'will be absent from this gitops deployment until that wiring lands.'
  );
}

/**
 * Render `{{PLACEHOLDER}}` tokens in a text file in-place. Used to bake
 * the deploy-time image tag + domain into manifests before committing.
 */
function renderInPlace(path, vars) {
  if (!existsSync(path)) return;
  let content = readFileSync(path, 'utf-8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, String(value ?? ''));
  }
  writeFileSync(path, content);
}

/**
 * Resolve the real `{owner, name}` of the deploy target repo.
 *
 * At `vibecarbon create` time both placeholders bake to `projectName`
 * (see src/create.js:616), producing `ghcr.io/<project>/<project>` image
 * refs and `github.com/<project>/<project>` Flux URLs. Those paths only
 * match reality when the user later runs `vibecarbon configure` → CI/CD
 * with project name == repo name (which calls updateImageReferences()).
 * E2E tests (and any user whose repo slug differs) need the real
 * owner/repo wired in at deploy time, which is what this helper handles.
 */
function resolveOwnerAndRepo(projectDir) {
  try {
    const out = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cwd: projectDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const [owner, name] = out.split('/');
    if (owner && name) return { owner, name };
  } catch {}
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectDir,
      env: gitSafeEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return { owner: m[1], name: m[2] };
  } catch {}
  return null;
}

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite stale `<project>/<project>` owner+repo pairs in ghcr.io image
 * refs and github.com Flux URLs to the real `<owner>/<repoName>` pair.
 * Idempotent: after one pass the paths no longer match the stale pattern
 * so subsequent calls are no-ops.
 */
function rewriteOwnerAndRepo(projectDir, projectName, owner, repoName) {
  const pn = escapeForRegex(projectName);
  // ghcr.io/<stale>/<project>[-db|-backup]  → ghcr.io/<owner>/<repoName>[-db|-backup]
  const ghcrRe = new RegExp(`ghcr\\.io/[^/\\s:]+/${pn}(-db|-backup)?\\b`, 'g');
  // github.com/<stale>/<project>  → github.com/<owner>/<repoName>
  //   Match plain `github.com/a/b` plus optional `.git` suffix. Avoid
  //   devouring a trailing path segment (e.g. branch names) by anchoring
  //   on word-boundary / end.
  const ghRe = new RegExp(`github\\.com/[^/\\s:]+/${pn}(?=\\.git\\b|[^\\w-]|$)`, 'g');

  const files = [
    'k8s/base/app/deployment.yaml',
    'k8s/base/backup/cronjob.yaml',
    'k8s/values/supabase.values.yaml',
    'k8s/overlays/production/kustomization.yaml',
    'k8s/flux/clusters/primary/vibecarbon.yaml',
    'k8s/flux/clusters/standby/vibecarbon.yaml',
  ];

  for (const rel of files) {
    const path = join(projectDir, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf-8');
    const after = before
      .replace(ghcrRe, (_match, suffix) => `ghcr.io/${owner}/${repoName}${suffix ?? ''}`)
      .replace(ghRe, `github.com/${owner}/${repoName}`);
    if (after !== before) writeFileSync(path, after);
  }
}

/**
 * Commit the k8s/ tree + push to origin/main. Returns true if a commit was
 * actually made, false if the tree was already clean.
 */
function commitAndPushManifests(cwd, message) {
  // Stage only k8s/ — don't accidentally commit unrelated dirty files.
  execFileSync('git', ['add', 'k8s/'], { cwd, env: gitSafeEnv() });

  // `git diff --cached --quiet` exits 0 if nothing staged, 1 if changes.
  const hasChanges = (() => {
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd, env: gitSafeEnv() });
      return false;
    } catch {
      return true;
    }
  })();

  if (hasChanges) {
    execFileSync('git', ['commit', '-m', message], { cwd, env: gitSafeEnv() });
  }
  // Push unconditionally — the remote may have commits we need to fast-forward
  // (e.g., previous deploy from a different workstation). If the commit above
  // was a no-op, this is a cheap no-op too.
  execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd, env: gitSafeEnv() });
  return hasChanges;
}

/**
 * Full GitOps deploy: render manifests, commit + push, seed GitHub
 * Environment, trigger workflow, wait for Flux reconciliation.
 *
 * @param {object} args
 * @param {string} args.projectDir - customer repo root
 * @param {string} args.environment - "dev" | "staging" | "prod"
 * @param {string} args.domain - deployed domain
 * @param {string} args.projectName
 * @param {string} args.kubeconfigPath - path to kubeconfig fetched from the cluster
 * @param {string} args.networkId - Hetzner private network ID (Pulumi output)
 * @param {string} args.dnsProvider - "cloudflare" | "hetzner" | "manual"
 * @param {object} args.providerCreds - operator-secret values read from
 *   process.env by the caller (see config-registry.js's operator-secret
 *   class): { hetznerApiToken, dnsTokens, s3AccessKey, s3SecretKey }
 * @param {string} [args.imageTag] - specific image tag to bake into app Deployment (default "main")
 * @param {number} [args.workflowTimeoutSec] - default 60 min. deploy.yml's
 *   internal Flux waits cap at 10m (vibecarbon-base) + 20m (vibecarbon-supabase)
 *   = 30m, on top of ~5m Flux install + ~5m CRD apply. A 30m outer budget
 *   ties with the internal ceiling — every timeout was racing the workflow
 *   to its own error. 3600s gives the workflow room to fail naturally and
 *   surface its own log.
 */
export async function deployK8sGitOps(args) {
  const {
    projectDir,
    environment,
    domain,
    projectName,
    kubeconfigPath,
    networkId,
    dnsProvider,
    providerCreds,
    imageTag,
    workflowTimeoutSec = 3600,
    skipCi = false,
  } = args;

  // H-9: loudly warn (before any spinner) if observability is installed — the
  // gitops path won't reconcile it until its Flux wiring lands (tracked follow-up).
  const obsWarning = observabilityGitopsWarning(projectDir);
  if (obsWarning) {
    p.log.warn(obsWarning);
  }

  const s = spinner();
  const skipCiStr = skipCi ? ' [skip ci]' : '';

  // 1. Render image tag + values.yaml into the repo. The Supabase values.yaml
  // (Phase 4.3a) already renders here; repeat is idempotent. The app
  // Deployment manifest uses {{GITHUB_OWNER}}/{{PROJECT_NAME}} from create
  // time — we add {{IMAGE_TAG}} rendering so Flux pulls the exact tag the
  // CI build just published.
  s.start('Rendering manifests for GitOps deploy');
  // Flux GitRepository URL + every ghcr.io image ref bakes in owner/repo at
  // create time as <project>/<project>. Rewrite to the real pair before we
  // commit, otherwise Flux source-controller 403s cloning the nonexistent
  // github.com/<project>/<project> and Kustomizations never reconcile.
  const resolvedRepo = resolveOwnerAndRepo(projectDir);
  const repoOwner = args.githubOwner || resolvedRepo?.owner;
  const repoName = resolvedRepo?.name || projectName;
  if (!repoOwner) {
    throw new Error(
      `GitOps deploy: could not resolve GitHub owner for ${projectDir}. ` +
        `Run 'gh repo view' or 'git remote get-url origin' and ensure origin points at github.com.`,
    );
  }
  rewriteOwnerAndRepo(projectDir, projectName, repoOwner, repoName);
  const appDeployment = join(projectDir, 'k8s', 'base', 'app', 'deployment.yaml');
  if (existsSync(appDeployment) && imageTag) {
    // Only substitute — don't touch tags that are already concrete. The
    // default template uses `:main`; callers passing a pinned imageTag can
    // rewrite that via renderInPlace if the template exposes {{IMAGE_TAG}}
    // (follow-up: switch template to use {{IMAGE_TAG}} so SHAs can pin).
    renderInPlace(appDeployment, { IMAGE_TAG: imageTag });
  }
  const supabaseValues = join(projectDir, 'k8s', 'gitops', 'supabase', 'values.yaml');
  if (existsSync(supabaseValues)) {
    // values.yaml is already rendered by Phase 4.3a's ensureVibecarbonSecrets
    // call chain, but re-render here with {{DOMAIN}}/{{PROJECT_NAME}} in
    // case the caller landed us without that step (e.g., `vibecarbon
    // configure cicd <env>` against a cluster whose initial deploy
    // didn't run the imperative bundle path).
    renderInPlace(supabaseValues, {
      DOMAIN: domain,
      PROJECT_NAME: projectName,
      // Always provided by the single caller (configure.js) via
      // resolveGitopsBackupBucket — no raw-interpolation fallback here.
      S3_BACKUP_BUCKET: args.s3BackupBucket,
      GITHUB_OWNER: repoOwner,
    });
  }
  s.stop('Manifests rendered');

  // 2. git add/commit/push — this is the deploy.
  s.start('Committing + pushing k8s/ tree to customer repo');
  const commitMsg = `deploy(${environment}): ${imageTag || 'latest'} @ ${new Date().toISOString()}${skipCiStr}`;
  const pushed = commitAndPushManifests(projectDir, commitMsg);
  s.stop(pushed ? 'Pushed new deploy commit' : 'Tree already clean, no new commit');

  // 3. Seed GitHub Environment secrets + upload kubeconfig. Repo-level
  // secrets (Hetzner token, Cloudflare token, S3 creds) are idempotent; env
  // secrets + KUBECONFIG_B64 get written fresh every deploy (rotation path).
  s.start(`Seeding GitHub Environment '${environment}'`);
  await seedOrgSecrets(providerCreds);

  const envLocal = parseEnvLocal(projectDir);
  const perEnvSecrets = buildPerEnvSecrets(envLocal);
  const perEnvVars = {
    SITE_URL: domain ? `https://${domain}` : '',
    DNS_PROVIDER: dnsProvider || '',
    HCLOUD_NETWORK_ID: networkId || '',
  };
  await seedEnvironmentSecrets(environment, perEnvSecrets, perEnvVars);
  await uploadKubeconfig(environment, kubeconfigPath);
  s.stop(`GitHub Environment '${environment}' seeded`);

  // 4. Trigger the deploy workflow on the just-pushed commit + wait for
  // completion. The workflow_dispatch trigger takes environment as an
  // input; the concurrency group ensures only one run per env at a time.
  s.start(`Triggering deploy.yml workflow for '${environment}'`);
  await triggerDeployWorkflow(environment);
  s.stop('Workflow triggered');

  s.start('Waiting for Flux reconciliation (via GitHub Actions)');
  const result = await waitForLatestWorkflowRun(workflowTimeoutSec);
  s.stop(`Workflow run ${result.runId} succeeded`);

  return { runId: result.runId, pushed };
}

/**
 * Minimal .env.local parser. Handles double-quoted, single-quoted, and
 * bare values; ignores comments and blank lines. Mirrors the readDotenv
 * helper in src/lib/deploy/k8s/index.js — kept as a small duplicate here
 * to avoid a cross-module import dependency that forces bringing the
 * full k8s deploy module into GitOps flow.
 */
/**
 * Build the per-environment GitHub Environment secret map from a parsed
 * .env.local. Generated infra secrets are enumerated here (they carry the
 * Supabase ANON_KEY/SERVICE_ROLE_KEY alias logic); every configure-managed
 * feature key (billing/OAuth/SMTP — secret and non-secret) is folded in from
 * the config-registry so a new feature secret propagates with no edit here.
 *
 * Values that are undefined/empty are dropped by setSecretFromBodyFile, so
 * unconfigured features upload nothing. Canonical SMTP key is SMTP_PASS (no
 * SMTP_PASSWORD rename — the app and manifests read SMTP_PASS).
 *
 * @param {Record<string,string>} envLocal
 * @returns {Record<string,string|undefined>}
 */
export function buildPerEnvSecrets(envLocal) {
  const infra = {
    DB_PASSWORD: envLocal.DB_PASSWORD,
    JWT_SECRET: envLocal.JWT_SECRET,
    SUPABASE_ANON_KEY: envLocal.SUPABASE_ANON_KEY || envLocal.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: envLocal.SUPABASE_SERVICE_ROLE_KEY || envLocal.SERVICE_ROLE_KEY,
    REALTIME_SECRET: envLocal.REALTIME_SECRET,
    DB_ENC_KEY: envLocal.DB_ENC_KEY,
    VAULT_ENC_KEY: envLocal.VAULT_ENC_KEY,
    PG_META_CRYPTO_KEY: envLocal.PG_META_CRYPTO_KEY,
    LOGFLARE_API_KEY: envLocal.LOGFLARE_API_KEY,
    ADMIN_EMAIL: envLocal.ADMIN_EMAIL,
    ADMIN_PASSWORD: envLocal.ADMIN_PASSWORD,
  };
  /** @type {Record<string,string|undefined>} */
  const features = {};
  for (const key of [...featureSecretKeys(), ...featureConfigKeys()]) {
    features[key] = envLocal[key];
  }
  return { ...infra, ...features };
}

function parseEnvLocal(projectDir) {
  const path = join(projectDir, '.env.local');
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*))\s*$/);
    if (!m) continue;
    const [, key, dq, sq, raw] = m;
    out[key] = dq ?? sq ?? raw ?? '';
  }
  return out;
}
