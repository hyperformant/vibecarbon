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
 * the vibecarbon-app-secrets / vibecarbon-infra-secrets Secrets. It writes no
 * cloud provider Secret: `vibecarbon deploy` hands the provider API token to
 * the cluster itself (applyCloudSecrets in ./k3s.js), so this CLI puts no copy
 * at GitHub. A copy an earlier one put there is refused while deploy.yml still
 * reads it (refuseLegacyProviderTokenStep) and named once nothing does
 * (noteUnreadTokenSecrets).
 * Flux reconciles the rest from the committed k8s/ tree.
 *
 * Callers: `vibecarbon configure cicd <env>` (PR 7) layers this onto an
 * already-running local-first cluster. Pre-PR-5 it was the default for
 * `vibecarbon deploy --k8s --gitops`; that flag was retired with PR 5.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  listRepoSecretNames,
  seedEnvironmentSecrets,
  triggerDeployWorkflow,
  uploadKubeconfig,
  waitForLatestWorkflowRun,
} from '../../github-environments.js';
import { alpineK8sImageRef, traefikVersion } from '../../images.js';
import { GITHUB_REF_FILES, originGitHubRepo, writeGitHubRefs } from '../../template-edits.js';
import { STANDBY_SELFSIGNED_ISSUER } from './acme-issuer-policy.js';
import { k8sTlsIdentity } from './k3s.js';
import { describeFluxPlaceholders, fluxPlaceholders } from './unrendered-placeholders.js';

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
 * (see src/create.js), producing `ghcr.io/<project>/<project>` image refs
 * and `github.com/<project>/<project>` Flux URLs. Those paths only match
 * reality once `vibecarbon configure` → CI/CD has rewritten them
 * (updateImageReferences). E2E tests (and any user whose repo slug differs)
 * need the real owner/repo wired in at deploy time, which is what this
 * helper handles.
 */
function resolveOwnerAndRepo(projectDir) {
  try {
    const out = execFileSync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      {
        env: gitSafeEnv(),
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    const [owner, name] = out.split('/');
    if (owner && name) return { owner, name };
  } catch {}
  const origin = originGitHubRepo(projectDir);
  return origin ? { owner: origin.owner, name: origin.repo } : null;
}

/**
 * The files the GitOps deploy points at the real owner and repo: the
 * GitHub-ref files under k8s/, the tree it commits. docker-compose.prod.yml
 * is configure's alone, and rewriting it here would leave it uncommitted.
 */
const GITOPS_REF_FILES = GITHUB_REF_FILES.filter((rel) => rel.startsWith('k8s/'));

/** The app Deployment, where the GitOps deploy renders `{{IMAGE_TAG}}`. */
const APP_DEPLOYMENT = 'k8s/base/app/deployment.yaml';

/**
 * Refuse, before anything is written or committed, a tree Flux would apply
 * with a `{{TOKEN}}` still in it: Flux cannot fill one, and it reaches the
 * cluster literally (an image of `{{TRAEFIK_IMAGE}}` is an InvalidImageName
 * rollout). Mostly it is a Flux cluster file older than k8s/base, which the
 * new cluster file fixes; a token no cluster file of ours strips has to be
 * replaced where it is.
 *
 * @param {string} projectDir
 * @param {{ fills?: Record<string, string[]> }} [opts] - tokens this deploy
 *   fills itself before it commits, per file (the app's `{{IMAGE_TAG}}`)
 */
export function refuseFluxPlaceholders(projectDir, { fills = {} } = {}) {
  const findings = fluxPlaceholders(projectDir)
    .map((f) => ({
      ...f,
      placeholders: f.placeholders.filter((p) => !(fills[f.file] ?? []).includes(p)),
    }))
    .filter((f) => f.placeholders.length > 0);
  if (findings.length === 0) return;
  const steps = [];
  const upgrade = [...new Set(findings.filter((f) => f.upgradeStrips).map((f) => f.via))];
  if (upgrade.length > 0) {
    steps.push(
      `Your ${upgrade.join(' and ')} is older than k8s/base: the one this vibecarbon ships keeps those objects out of Flux's build. ` +
        `Run vibecarbon upgrade and take the new ${upgrade.join(' and ')} (or apply its .upgrade-new)`,
    );
  }
  for (const f of findings.filter((x) => !x.upgradeStrips)) {
    steps.push(`Put the real value in place of ${f.placeholders.join(', ')} in ${f.file}`);
  }
  throw new Error(
    'GitOps deploy stopped before changing anything: Flux applies the committed k8s/ tree as it is and ' +
      `cannot fill placeholders. ${describeFluxPlaceholders(findings).join('; ')}. ` +
      `${steps.join('. ')}. Then run this again.`,
  );
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
 * The repo's Actions secret every deploy.yml before this one wrote
 * kube-system/hcloud from, on every provider: an earlier deployK8sGitOps
 * seeded it from the operator's HETZNER_API_TOKEN, whatever the
 * environment's provider.
 */
export const LEGACY_TOKEN_SECRET = 'HETZNER_API_TOKEN';

/**
 * Every workflow GitHub would run for this project, as text: each
 * .github/workflows/*.yml or *.yaml in the working tree and in the HEAD
 * commit (what a push sends). A project with no commit, or no workflow
 * directory, has fewer; none is an empty list.
 *
 * @param {string} projectDir
 * @returns {string[]}
 */
function workflowTexts(projectDir) {
  const dir = join(projectDir, '.github', 'workflows');
  const isWorkflow = (name) => /\.ya?ml$/.test(name);
  const texts = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter(isWorkflow)) {
      try {
        texts.push(readFileSync(join(dir, name), 'utf-8'));
      } catch {
        // A directory named *.yml, say: no workflow.
      }
    }
  }
  const git = (args) =>
    execFileSync('git', args, {
      cwd: projectDir,
      env: gitSafeEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  let committed = [];
  try {
    committed = git(['ls-tree', '--name-only', 'HEAD', '.github/workflows/'])
      .split('\n')
      .filter((path) => isWorkflow(path));
  } catch {
    // No commit yet: the working tree's are all there are.
  }
  for (const path of committed) {
    try {
      texts.push(git(['show', `HEAD:${path}`]));
    } catch {
      // A submodule or another entry `git show` can't print as a file.
    }
  }
  return texts;
}

/**
 * Whether a workflow's text reads this Actions secret by name,
 * `secrets.NAME` or `secrets['NAME']` (a whole `toJSON(secrets)` is not a
 * read of one: deploy.yml takes the cloud tokens out of it).
 *
 * @param {string} text
 * @param {string} name - an Actions secret name, [A-Z0-9_]
 */
function readsSecret(text, name) {
  return new RegExp(`\\bsecrets\\s*(?:\\.\\s*${name}\\b|\\[\\s*['"]${name}['"]\\s*\\])`).test(text);
}

/**
 * Every deploy.yml before this one wrote kube-system/hcloud from the repo's
 * HETZNER_API_TOKEN secret (LEGACY_TOKEN_SECRET), which deployK8sGitOps
 * seeded on every run. The CLI no longer seeds it (deployK3s hands the
 * provider's token to the cluster itself), so in such a project that copy
 * only goes stale. On Hetzner, whose cluster reads kube-system/hcloud,
 * after a token rotation the workflow this deploy triggers would write the
 * revoked token back over the one the deploy applied, and the cloud
 * controller and CSI driver would read it at their next start. On another
 * provider nothing reads that Secret and a deploy removes it
 * (K8S_RETIRED_CLOUD_SECRETS), so each run of the workflow would only put a
 * copy of whatever Hetzner token the secret holds back into the cluster.
 * Refused either way, naming the environment's own token and the way out,
 * before anything is committed, pushed or seeded. Both the committed
 * deploy.yml (what the push sends to main, the workflow GitHub runs) and the
 * working tree's are read.
 *
 * @param {string} projectDir
 * @param {typeof import('../../providers/base.js').BaseProvider} ProviderClass
 */
function refuseLegacyProviderTokenStep(projectDir, ProviderClass) {
  const path = join(projectDir, '.github', 'workflows', 'deploy.yml');
  const working = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  let committed = '';
  try {
    committed = execFileSync('git', ['show', 'HEAD:.github/workflows/deploy.yml'], {
      cwd: projectDir,
      env: gitSafeEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Not committed (or no commit yet): the working tree's is all there is.
  }
  const ref = `secrets.${LEGACY_TOKEN_SECRET}`;
  if (![working, committed].some((yml) => yml.includes(ref))) return;
  const wayOut =
    'Run `vibecarbon upgrade` for a deploy.yml without that step, or delete every step that ' +
    `reads ${ref} yourself; commit the change and run this again. Then remove the copy: ` +
    `\`gh secret delete ${LEGACY_TOKEN_SECRET}\`.`;
  const readsHcloud = ProviderClass.k8sCloudSecrets({ token: '-' }).some(
    ({ namespace, name }) => namespace === 'kube-system' && name === 'hcloud',
  );
  if (readsHcloud) {
    throw new Error(
      `Your .github/workflows/deploy.yml still writes your ${ProviderClass.NAME} API token into ` +
        `the cluster from a GitHub copy of it (${ref}). \`vibecarbon deploy\` hands the token ` +
        'to the cluster itself now and no longer updates that copy, so after you rotate the token, ' +
        `a run of this workflow would write the old one back. ${wayOut}`,
    );
  }
  throw new Error(
    'Your .github/workflows/deploy.yml still writes a kube-system/hcloud Secret into the cluster ' +
      `from your repo's ${LEGACY_TOKEN_SECRET} Actions secret (${ref}), which an earlier ` +
      `vibecarbon filled from your ${LEGACY_TOKEN_SECRET}, a Hetzner Cloud token, whatever the ` +
      `provider. Your ${ProviderClass.NAME} cluster reads neither: \`vibecarbon deploy\` hands it ` +
      `your ${ProviderClass.NAME} API token (${ProviderClass.TOKEN_ENV}) itself and removes that ` +
      `Secret, so each run of this workflow would only put it back. ${wayOut}`,
  );
}

/** The one gh call noteUnreadTokenSecrets makes, at most this long. */
const NOTE_GH_TIMEOUT_MS = 20_000;

/**
 * Say once, without deleting anything, which provider token secrets the
 * repo still holds at GitHub that no workflow reads: LEGACY_TOKEN_SECRET,
 * which an earlier vibecarbon seeded, and the environment's own token
 * variable (ProviderClass.TOKEN_ENV), should one be there. A project whose
 * deploy.yml was already upgraded never meets refuseLegacyProviderTokenStep,
 * so without this it would never learn the copy is still there. A secret a
 * workflow still reads (workflowTexts, readsSecret) is not named: that one
 * is the refusal's, or the operator's own. Names only: `gh secret list`
 * returns no value. A list that fails says nothing, since the note is only
 * advice.
 *
 * @param {{
 *   projectDir: string,
 *   ProviderClass: typeof import('../../providers/base.js').BaseProvider,
 * }} args
 * @returns {Promise<string[]>} the secrets it named
 */
export async function noteUnreadTokenSecrets({ projectDir, ProviderClass }) {
  const candidates = [...new Set([LEGACY_TOKEN_SECRET, ProviderClass.TOKEN_ENV].filter(Boolean))];
  let listed;
  try {
    // Bounded, as the refresh's gh calls are: a stalled gh holds up no setup for advice.
    listed = await listRepoSecretNames({ timeout: NOTE_GH_TIMEOUT_MS });
  } catch {
    return [];
  }
  const texts = workflowTexts(projectDir);
  const unread = candidates.filter(
    (name) => listed.includes(name) && !texts.some((text) => readsSecret(text, name)),
  );
  if (unread.length === 0) return [];
  const one = unread.length === 1;
  const it = one ? 'it' : 'them';
  p.log.info(
    `Your repo still has ${one ? `a ${unread[0]} Actions secret` : `${unread.join(' and ')} Actions secrets`}, ` +
      `and no workflow in .github/workflows reads ${it}. \`vibecarbon deploy\` hands your cloud ` +
      `API token to the cluster itself and puts no copy at GitHub any more, so ` +
      `${one ? 'that copy is' : 'those copies are'} one more place a token lives, and nothing ` +
      `keeps ${it} current. Delete ${it} when you like with ` +
      `${unread.map((name) => `\`gh secret delete ${name}\``).join(' and ')}; this command ` +
      `leaves ${it} alone.`,
  );
  return unread;
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
 * @param {typeof import('../../providers/base.js').BaseProvider} args.ProviderClass - the
 *   environment's provider: the refusal of a deploy.yml that still writes kube-system/hcloud
 *   names its own token (refuseLegacyProviderTokenStep)
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
    appStorage,
    imageTag,
    backupConfig,
    tlsSnapshotPrefix,
    role = 'primary',
    workflowTimeoutSec = 3600,
    skipCi = false,
    ProviderClass,
  } = args;
  if (
    typeof ProviderClass?.NAME !== 'string' ||
    typeof ProviderClass.k8sCloudSecrets !== 'function'
  ) {
    throw new TypeError("deployK8sGitOps needs the environment's ProviderClass");
  }

  // H-9: loudly warn (before any spinner) if observability is installed — the
  // gitops path won't reconcile it until its Flux wiring lands (tracked follow-up).
  const obsWarning = observabilityGitopsWarning(projectDir);
  if (obsWarning) {
    p.log.warn(obsWarning);
  }

  // Before anything is written, committed or seeded: a deploy.yml that would
  // write a stale provider token, a tree Flux would apply with a token in it,
  // and a malformed backup config, fail here.
  refuseLegacyProviderTokenStep(projectDir, ProviderClass);
  refuseFluxPlaceholders(projectDir, {
    fills: imageTag ? { [APP_DEPLOYMENT]: ['{{IMAGE_TAG}}'] } : {},
  });
  const backupSettings = resolveBackupSettings(backupConfig);
  // The Certificate deploy.yml renders, validated before anything is seeded.
  const tlsCertVars = gitopsTlsCertificateVars({ projectDir, domain, role });

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
  writeGitHubRefs(projectDir, {
    projectName,
    owner: repoOwner,
    repo: repoName,
    files: GITOPS_REF_FILES,
  });
  const appDeployment = join(projectDir, APP_DEPLOYMENT);
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

  // 3. Seed GitHub Environment secrets + upload kubeconfig. Env secrets +
  // KUBECONFIG_B64 get written fresh every deploy (rotation path). No
  // repo-level secret: the provider token never goes to GitHub.
  s.start(`Seeding GitHub Environment '${environment}'`);

  const envLocal = parseEnvLocal(projectDir);
  const perEnvSecrets = buildPerEnvSecrets(envLocal, { appStorage });
  const perEnvVars = {
    SITE_URL: domain ? `https://${domain}` : '',
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
    // The two values deploy.yml renders itself, from this environment's
    // version set: the backup CronJob's kubectl and the Traefik CRDs' tag.
    KUBECTL_IMAGE: alpineK8sImageRef(),
    TRAEFIK_VERSION: traefikVersion(),
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
 * issuer, with the real ACME issuer in the promote annotation. Throws when
 * there is no domain.
 *
 * @param {{ projectDir: string, domain?: string|null,
 *   role?: 'primary'|'standby' }} args
 * @returns {{ TLS_CERT_ISSUER: string, TLS_CERT_EFFECTIVE_ISSUER: string, TLS_CERT_DNS_NAMES: string }}
 */
export function gitopsTlsCertificateVars({ projectDir, domain, role = 'primary' }) {
  // No fallback name: a Certificate for another name than the env's is one
  // the cluster would issue and serve, and never trusted.
  if (!domain) throw new Error('the TLS Certificate needs a domain, and this environment has none');
  const { issuerName, dnsNames } = k8sTlsIdentity({ projectDir, domain });
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
