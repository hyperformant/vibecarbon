/**
 * Phase 4.3c of the GitOps refactor: the thin GitOps-driven deploy path.
 *
 * stale-deploy-ignore: historical context — describes what this file replaced.
 * Replaces the ~2000 LOC imperative `applyKubernetesManifests` with:
 *   1. Render deploy-time-varying manifests into the customer's k8s/ tree
 *      (the image tag in the app Deployment).
 *   2. git add k8s/ && git commit && git push.
 *   3. Seed GitHub Environment secrets + vars + upload KUBECONFIG_B64.
 *   4. Trigger .github/workflows/deploy.yml + wait for completion.
 *
 * The workflow (Phase 4.3b.C) installs Flux + root Kustomization + applies
 * vibecarbon-app-secrets / vibecarbon-infra-secrets / cert-manager `hetzner` /
 * kube-system/hcloud Secrets.
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
import { resolveBackupSettings } from '../../../../carbon/scripts/render-backup-settings.mjs';
import { tlsCertificateVars } from '../../../../carbon/scripts/render-tls-certificate.mjs';
import { spinner } from '../../cli/progress.js';
import { gitSafeEnv } from '../../command.js';
import { loadProjectConfig } from '../../config.js';
import { featureConfigKeys, featureSecretKeys } from '../../config-registry.js';
import { parseDotenv } from '../../dotenv.js';
import {
  listEnvironmentVariables,
  seedEnvironmentSecrets,
  seedOrgSecrets,
  triggerDeployWorkflow,
  uploadKubeconfig,
  waitForLatestWorkflowRun,
} from '../../github-environments.js';
import { STANDBY_SELFSIGNED_ISSUER } from './acme-issuer-policy.js';
import { k8sTlsIdentity } from './k3s.js';

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
 *   class): { hetznerApiToken, dnsTokens }
 * @param {{ accessKey: string, secretKey: string }} args.appStorage - the env
 *   app's own storage pair (storedAppStoragePair), seeded per environment
 * @param {{schedule?: string, retentionDays?: number}} [args.backupConfig] - envConfig.backup:
 *   seeded as the environment's BACKUP_SCHEDULE / BACKUP_RETENTION_DAYS vars, which deploy.yml renders
 *   into the backup CronJob and its settings ConfigMap (never into the shared committed k8s/base)
 * @param {string} [args.tlsSnapshotPrefix] - tlsSnapshotS3Prefix for this environment: seeded as the
 *   TLS_SNAPSHOT_S3_PREFIX var, which deploy.yml renders into vibecarbon-backup-settings for the
 *   CronJob's TLS snapshot step. Omitted: no snapshot is taken.
 * @param {'primary'|'standby'} [args.role] - this cluster's current role (k8s-ha; default primary).
 *   A standby's Certificate issues from the local self-signed issuer, with the real ACME issuer in
 *   the promote annotation, exactly as the CLI deploy renders it.
 * @param {string} [args.imageTag] - specific image tag to bake into app Deployment (default "main")
 * @param {number} [args.workflowTimeoutSec] - default 60 min. deploy.yml's
 *   internal Flux wait caps at 10m (vibecarbon-base), on top of ~5m Flux
 *   install + ~5m CRD apply. A 30m outer budget once tied with the internal
 *   ceiling and every timeout raced the workflow to its own error; 3600s
 *   gives the workflow room to fail naturally and surface its own log.
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
    appStorage,
    imageTag,
    backupConfig,
    tlsSnapshotPrefix,
    role = 'primary',
    workflowTimeoutSec = 3600,
    skipCi = false,
  } = args;

  // H-9: loudly warn (before any spinner) if observability is installed — the
  // gitops path won't reconcile it until its Flux wiring lands (tracked follow-up).
  const obsWarning = observabilityGitopsWarning(projectDir);
  if (obsWarning) {
    p.log.warn(obsWarning);
  }

  // Before anything is committed or seeded: a malformed backup config fails here.
  const backupSettings = resolveBackupSettings(backupConfig);
  // The Certificate deploy.yml renders, validated before anything is seeded.
  const tlsCertVars = gitopsTlsCertificateVars({ projectDir, dnsProvider, domain, role });

  const s = spinner();
  const skipCiStr = skipCi ? ' [skip ci]' : '';

  // 1. Render the image tag into the repo. The app Deployment manifest uses
  // {{GITHUB_OWNER}}/{{PROJECT_NAME}} from create time — we add {{IMAGE_TAG}}
  // rendering so Flux pulls the exact tag the CI build just published. The db
  // StatefulSet is NOT rendered here: its values are per-cluster, so it stays
  // with the CLI's deploy and the Flux base Kustomization drops it from its
  // build (k8s/flux/clusters/*/vibecarbon.yaml).
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
  const perEnvSecrets = buildPerEnvSecrets(envLocal, { appStorage });
  const perEnvVars = {
    SITE_URL: domain ? `https://${domain}` : '',
    DNS_PROVIDER: dnsProvider || '',
    HCLOUD_NETWORK_ID: networkId || '',
    // Per environment, never in the committed k8s/base every environment
    // shares: deploy.yml renders the backup CronJob and its settings from
    // these (scripts/render-backup-settings.mjs).
    BACKUP_SCHEDULE: backupSettings.schedule,
    BACKUP_RETENTION_DAYS: String(backupSettings.retentionDays),
    // Where the backup CronJob saves the TLS certificate; deploy.yml puts it
    // in the same settings ConfigMap. Empty (no backup bucket): not seeded.
    TLS_SNAPSHOT_S3_PREFIX: tlsSnapshotPrefix || '',
    // The deploy-owned vibecarbon-tls Certificate (Flux drops it from its
    // build); deploy.yml renders and applies it from these.
    ...tlsCertVars,
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
 * The GitHub Environments of an environment, one per cluster, each with its
 * cluster's CURRENT role: a k8s-ha env has `<env>-primary` and
 * `<env>-standby`, and a failover swaps which stack is primary
 * (envConfig.ha.primary.stack); any other env has one, the primary.
 *
 * @param {string} envName
 * @param {object} envConfig
 * @returns {Array<{ suffix: 'primary'|'standby'|null, envName: string, role: 'primary'|'standby' }>}
 */
export function gitopsTargets(envName, envConfig) {
  const isHA = envConfig?.deployMode === 'kubernetes-ha' || envConfig?.deployMode === 'k8s-ha';
  if (!isHA) return [{ suffix: null, envName, role: 'primary' }];
  const primaryStack = envConfig.ha?.primary?.stack ?? `${envName}-primary`;
  const roleOf = (stack) => (stack === primaryStack ? 'primary' : 'standby');
  return ['primary', 'standby'].map((suffix) => ({
    suffix,
    envName: `${envName}-${suffix}`,
    role: roleOf(`${envName}-${suffix}`),
  }));
}

/**
 * The TLS_CERT_* vars deploy.yml renders the vibecarbon-tls Certificate from
 * (scripts/render-tls-certificate.mjs): the same issuer and names the CLI
 * deploy renders, validated. A standby issues from the local self-signed
 * issuer, with the real ACME issuer in the promote annotation.
 *
 * @param {{ projectDir: string, dnsProvider?: string|null, domain?: string|null,
 *   role?: 'primary'|'standby' }} args
 * @returns {{ TLS_CERT_ISSUER: string, TLS_CERT_EFFECTIVE_ISSUER: string, TLS_CERT_DNS_NAMES: string }}
 */
export function gitopsTlsCertificateVars({ projectDir, dnsProvider, domain, role = 'primary' }) {
  const { issuerName, dnsNames } = k8sTlsIdentity({
    projectDir,
    dnsProvider,
    domain: domain || 'localhost',
  });
  return tlsCertificateVars({
    dnsNames,
    issuerName,
    effectiveIssuer: role === 'standby' ? STANDBY_SELFSIGNED_ISSUER : issuerName,
  });
}

/** Bound of each gh call when a failover refreshes the GitOps TLS vars. */
const REFRESH_GH_TIMEOUT_MS = 20_000;

/** Bound of the whole refresh: each call gets at most what is left of it. */
const REFRESH_DEADLINE_MS = 60_000;

/** A gh call refused for lack of time, reported as GitHub not answering. */
class RefreshDeadlineError extends Error {
  constructor() {
    super('GitHub did not answer in time');
    this.timedOut = true;
  }
}

/**
 * After a k8s-ha failover swapped the roles: re-seed the TLS_CERT_* vars of
 * each GitHub Environment `vibecarbon configure cicd` seeded (the ones that
 * hold TLS_CERT_ISSUER), from the roles .vibecarbon.json now records, so the
 * next GitOps deploy renders each cluster's Certificate for its new role.
 * Environments without the vars are not GitOps-managed and are left alone.
 * Each gh call is bounded (20s), and so is the whole refresh (60s): a call
 * gets at most what is left. Never throws and never logs: the caller prints
 * the one warning, with the command that repairs it.
 *
 * @param {{ envName: string, projectDir: string,
 *   deps?: { loadConfig?: Function, listVars?: Function, seed?: Function, timeoutMs?: number,
 *     deadlineMs?: number, now?: () => number } }} args
 * @returns {Promise<{ ok: true, refreshed: string[] } | { ok: false, reason: string }>}
 */
export async function refreshGitopsTlsVars({ envName, projectDir, deps = {} }) {
  const {
    loadConfig = loadProjectConfig,
    listVars = listEnvironmentVariables,
    seed = seedEnvironmentSecrets,
    timeoutMs = REFRESH_GH_TIMEOUT_MS,
    deadlineMs = REFRESH_DEADLINE_MS,
    now = Date.now,
  } = deps;
  const deadline = now() + deadlineMs;
  /** The bound of the next gh call; throws once the deadline is spent. */
  const bound = () => {
    const left = deadline - now();
    if (left <= 0) throw new RefreshDeadlineError();
    return { timeout: Math.min(timeoutMs, left) };
  };
  try {
    const projectConfig = loadConfig(projectDir);
    const envConfig = projectConfig?.environments?.[envName];
    if (!envConfig) return { ok: false, reason: `no ${envName} in .vibecarbon.json` };
    const refreshed = [];
    for (const target of gitopsTargets(envName, envConfig)) {
      const names = await listVars(target.envName, bound());
      if (!names.includes('TLS_CERT_ISSUER')) continue;
      const subEnvConfig = projectConfig.environments?.[target.envName] ?? envConfig;
      const vars = gitopsTlsCertificateVars({
        projectDir,
        dnsProvider: subEnvConfig.dnsProvider || envConfig.dnsProvider,
        domain: subEnvConfig.domain || envConfig.domain,
        role: target.role,
      });
      await seed(target.envName, {}, vars, bound());
      refreshed.push(target.envName);
    }
    return { ok: true, refreshed };
  } catch (err) {
    const line = String(err?.message ?? err).split('\n')[0];
    return { ok: false, reason: err?.timedOut ? 'GitHub did not answer in time' : line };
  }
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
 * .env.local. Generated infra secrets are enumerated here; every configure-managed
 * feature key (billing/OAuth/SMTP — secret and non-secret) is folded in from
 * the config-registry so a new feature secret propagates with no edit here.
 *
 * Values that are undefined/empty are dropped by setSecretFromBodyFile, so
 * unconfigured features upload nothing. Canonical SMTP key is SMTP_PASS (no
 * SMTP_PASSWORD rename — the app and manifests read SMTP_PASS).
 *
 * `appStorage` is the env app's own object-storage pair. It is seeded at
 * environment scope as S3_ACCESS_KEY / S3_SECRET_KEY, which the workflow's
 * APP_KEYS pick into the app Secret; the infra pair is never seeded for it.
 *
 * @param {Record<string,string>} envLocal
 * @param {{ appStorage?: { accessKey: string, secretKey: string } }} [opts]
 * @returns {Record<string,string|undefined>}
 */
export function buildPerEnvSecrets(envLocal, { appStorage } = {}) {
  const infra = {
    DB_PASSWORD: envLocal.DB_PASSWORD,
    // The app's own database role's password (app_service); the owner
    // password above reaches only the migrate init container.
    APP_DB_PASSWORD: envLocal.APP_DB_PASSWORD,
    // The app's session signing key; the app pod envFrom's the Secret.
    BETTER_AUTH_SECRET: envLocal.BETTER_AUTH_SECRET,
    ADMIN_EMAIL: envLocal.ADMIN_EMAIL,
    ADMIN_PASSWORD: envLocal.ADMIN_PASSWORD,
    // The add-on roles' own database passwords; empty (and so not uploaded)
    // when the add-on is not installed.
    METABASE_DB_PASSWORD: envLocal.METABASE_DB_PASSWORD,
    N8N_DB_PASSWORD: envLocal.N8N_DB_PASSWORD,
    N8N_ENCRYPTION_KEY: envLocal.N8N_ENCRYPTION_KEY,
  };
  /** @type {Record<string,string|undefined>} */
  const features = {};
  for (const key of [...featureSecretKeys(), ...featureConfigKeys()]) {
    features[key] = envLocal[key];
  }
  return {
    ...infra,
    ...features,
    S3_ACCESS_KEY: appStorage?.accessKey,
    S3_SECRET_KEY: appStorage?.secretKey,
  };
}

/**
 * The project's `.env.local` as a plain object; `{}` when the file is absent
 * (CI supplies the env another way, so a missing file is not an error here —
 * unlike k3s.js's loadEnvLocal, which is the deploy path's precondition).
 * Parsing is `parseDotenv` (src/lib/dotenv.js), the codebase's one dotenv
 * reader.
 * @param {string} projectDir
 * @returns {Record<string, string>}
 */
function parseEnvLocal(projectDir) {
  const path = join(projectDir, '.env.local');
  if (!existsSync(path)) return {};
  return parseDotenv(readFileSync(path, 'utf-8'));
}
