/**
 * The GitOps layer `vibecarbon configure cicd <env>` puts on a running k8s
 * cluster. It is pull only: nothing at GitHub ever connects to the cluster.
 *
 * stale-deploy-ignore: historical context — describes what this file replaced.
 * It replaced the ~2000 LOC imperative `applyKubernetesManifests`, and then
 * the deploy.yml workflow it seeded GitHub Environments for, with:
 *   1. Render deploy-time-varying manifests into the customer's k8s/ tree
 *      (the image tag in the app Deployment, the real owner and repo).
 *   2. git add k8s/ && git commit && git push.
 *   3. Hand the cluster to Flux from this machine (handOverCluster in
 *      ./flux-handover.js): install Flux, give it the cluster's own
 *      read-only deploy key, put the app image's pull Secret in place (a
 *      private package's), apply the root GitRepository and Kustomization,
 *      wait for the first sync. A GitHub runner never could: the k8s API
 *      admits only the operator's addresses.
 *
 * The objects Flux leaves to the CLI (the namespace, the backup CronJob and
 * its settings, the vibecarbon-app-secrets / vibecarbon-infra-secrets
 * Secrets, cert-manager, the Traefik CRDs, the TLS Certificate) are applied by
 * every `vibecarbon deploy <env>`, as on a cluster without GitOps, from the
 * operator's own .env.local. Nothing is copied to GitHub for them, and no
 * cloud provider token goes there: `vibecarbon deploy` hands it to the
 * cluster itself (applyCloudSecrets in ./k3s.js).
 *
 * What an earlier vibecarbon copied to GitHub is named once per run and
 * never deleted here: the repo's provider token secret
 * (noteUnreadTokenSecrets) and the secrets and variables it seeded into each
 * GitHub Environment for its deploy.yml, with that workflow file
 * (noteLeftoverGitopsCopies).
 * Flux reconciles the rest from the committed k8s/ tree.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { spinner } from '../../cli/progress.js';
import { gitSafeEnv } from '../../command.js';
import { environmentForStack } from '../../environment-name.js';
import {
  listEnvironmentSecretNames,
  listEnvironmentVariables,
  listRepoSecretNames,
} from '../../github-environments.js';
import { GITHUB_REF_FILES, originGitHubRepo, writeGitHubRefs } from '../../template-edits.js';
import { handOverCluster } from './flux-handover.js';
import {
  describeFluxPlaceholders,
  FLUX_CLUSTER_FILE,
  fluxHttpsSource,
  fluxPlaceholders,
} from './unrendered-placeholders.js';

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
export function resolveOwnerAndRepo(projectDir) {
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
function refuseFluxPlaceholders(projectDir, { fills = {} } = {}) {
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
 * Refuse, before anything is written or committed, a Flux cluster file that
 * still clones the repo over https. Its Secret held the deploy workflow's
 * GITHUB_TOKEN, which GitHub revokes when the job ends; the cluster file this
 * vibecarbon ships clones over ssh with the cluster's own deploy key. Only
 * the url differs, so the refusal names the ssh url to put there, and the new
 * cluster file `upgrade -y` saves beside a changed one.
 *
 * @param {string} projectDir
 * @param {string} environment - the cluster (`prod`, `prod-standby`)
 */
function refuseHttpsFluxSource(projectDir, environment) {
  const https = fluxHttpsSource(projectDir);
  if (!https) return;
  throw new Error(
    `${FLUX_CLUSTER_FILE} still has flux read your repo over https, which needs a token github ` +
      `takes back after every workflow run. changing its url: to ${https.ssh} is enough. the new ` +
      'cluster file has that url too: take it with vibecarbon upgrade (upgrade -y may have left it ' +
      `beside yours as ${FLUX_CLUSTER_FILE}.upgrade-new). ` +
      `then rerun vibecarbon configure cicd ${environmentForStack(environment)}`,
  );
}

/**
 * Refuse, before anything is written, committed or asked for, a project Flux
 * could not run as it is: a tree it would apply with a `{{TOKEN}}` still in
 * it (refuseFluxPlaceholders), or a cluster file that still clones over
 * https (refuseHttpsFluxSource). Both read local files only and change
 * nothing, so `configure cicd <env>` runs this before the firewall gate and
 * the pull token ask, and deployK8sGitOps runs it again first thing for any
 * other caller.
 *
 * @param {string} projectDir
 * @param {{ environment: string, imageTag?: string }} opts - environment is
 *   the cluster or the environment (`prod`, `prod-standby`), named in the
 *   rerun command; imageTag, when given, is a token the deploy fills in the
 *   app Deployment itself before it commits
 */
export function refuseUnreadyGitopsProject(projectDir, { environment, imageTag }) {
  refuseFluxPlaceholders(projectDir, {
    fills: imageTag ? { [APP_DEPLOYMENT]: ['{{IMAGE_TAG}}'] } : {},
  });
  refuseHttpsFluxSource(projectDir, environment);
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
 * The repo's Actions secret the retired deploy.yml once wrote kube-system/hcloud
 * from, on every provider: an earlier deployK8sGitOps seeded it from the
 * operator's HETZNER_API_TOKEN, whatever the environment's provider.
 */
const LEGACY_TOKEN_SECRET = 'HETZNER_API_TOKEN';

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
 * read of one: the retired deploy.yml took the cloud tokens out of it).
 *
 * @param {string} text
 * @param {string} name - an Actions secret name, [A-Z0-9_]
 */
function readsSecret(text, name) {
  return new RegExp(`\\bsecrets\\s*(?:\\.\\s*${name}\\b|\\[\\s*['"]${name}['"]\\s*\\])`).test(text);
}

/** Each gh call a note makes, at most this long: a stalled gh holds up no setup for advice. */
const NOTE_GH_TIMEOUT_MS = 20_000;

/**
 * Say once, without deleting anything, which provider token secrets the
 * repo still holds at GitHub that no workflow reads: LEGACY_TOKEN_SECRET,
 * which an earlier vibecarbon seeded, and the environment's own token
 * variable (ProviderClass.TOKEN_ENV), should one be there. A secret a
 * workflow still reads (workflowTexts, readsSecret) is not named: that one
 * is the operator's own, or the old deploy.yml's, which
 * noteLeftoverGitopsCopies names, and once it is gone this names the
 * secret. Names only: `gh secret list` returns no value. A list that fails
 * says nothing, since the note is only advice.
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
 * Every name the retired GitHub Environment seeding ever wrote for deploy.yml
 * (seedEnvironmentSecrets and uploadKubeconfig, fed by deployK8sGitOps and
 * buildPerEnvSecrets, and the TLS re-seed after a failover): the names
 * noteLeftoverGitopsCopies may name, and no others. A name the seeding never
 * wrote is the operator's own.
 *
 * Read from git history, every version of src/lib/deploy/k8s/gitops-deploy.js
 * and src/lib/github-environments.js from 32afb12d to deac42c2, with the
 * feature keys of every src/lib/config-registry.js version in that range
 * (32afb12d, 075a91df, 932266fe, 0e327785, 717211ef, c30d120c, 14c0895e,
 * 3a000149, 12c76b22, deac42c2). FROZEN: the seeding is gone, so a key the
 * registry or SECRET_KEYS gains later must never widen this list.
 *
 * Left out: three secrets of the stack before 0e327785 and one feature key of
 * its auth server, whose names the terminology census keeps out of src
 * (tests/unit/lib/terminology-census.test.ts). Any Environment that holds
 * them was seeded before 0e327785 and holds KUBECONFIG_B64 too, so the note
 * still names it.
 */
const RETIRED_GITOPS_COPIES = Object.freeze({
  secrets: Object.freeze([
    // Every version, 32afb12d to deac42c2.
    'KUBECONFIG_B64',
    'DB_PASSWORD',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    // Before the lean stack, 32afb12d to f2058f5d (0e327785 dropped them).
    'DB_ENC_KEY',
    'JWT_SECRET',
    'LOGFLARE_API_KEY',
    'PG_META_CRYPTO_KEY',
    'VAULT_ENC_KEY',
    // From 0e327785.
    'BETTER_AUTH_SECRET',
    'METABASE_DB_PASSWORD',
    'N8N_DB_PASSWORD',
    // From 717211ef: the app's own role and its storage pair.
    'APP_DB_PASSWORD',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    // From 4b02b38d.
    'N8N_ENCRYPTION_KEY',
    // From 6095af55.
    'VIBECARBON_ENV',
    // The registry's feature keys (featureSecretKeys, featureConfigKeys), the
    // union over every version above.
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_STARTER',
    'STRIPE_PRICE_PRO',
    'PADDLE_API_KEY',
    'PADDLE_WEBHOOK_SECRET',
    'PADDLE_ENVIRONMENT',
    'PADDLE_PRICE_STARTER',
    'PADDLE_PRICE_PRO',
    'POLAR_ACCESS_TOKEN',
    'POLAR_WEBHOOK_SECRET',
    'POLAR_ORGANIZATION_ID',
    'POLAR_PRICE_STARTER',
    'POLAR_PRICE_PRO',
    'BILLING_PROVIDER',
    'GOOGLE_ENABLED',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'MICROSOFT_ENABLED',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET',
    'MICROSOFT_TENANT_ID',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_ADMIN_EMAIL',
    'SMTP_SENDER_NAME',
    // From 932266fe.
    'ACME_CA_SERVER',
    'ALLOWED_SSH_IPS',
  ]),
  vars: Object.freeze([
    // Every version.
    'SITE_URL',
    // 32afb12d to 8b3c41f7 (c30d120c dropped it).
    'DNS_PROVIDER',
    // 32afb12d to c198a4fd (e237e3ea dropped it).
    'HCLOUD_NETWORK_ID',
    // From 63717682.
    'BACKUP_SCHEDULE',
    'BACKUP_RETENTION_DAYS',
    // From 8b3c41f7, also written by the failover re-seed.
    'TLS_SNAPSHOT_S3_PREFIX',
    'TLS_CERT_ISSUER',
    'TLS_CERT_EFFECTIVE_ISSUER',
    'TLS_CERT_DNS_NAMES',
    // From 14c0895e.
    'KUBECTL_IMAGE',
    'TRAEFIK_VERSION',
  ]),
});

/** The workflow an earlier `configure cicd` installed, which nothing dispatches now. */
const RETIRED_DEPLOY_WORKFLOW = '.github/workflows/deploy.yml';

/** `n word`, with an s past one. */
const counted = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `a`, `a and b`, `a, b and c`. */
const andList = (items) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * Say once, without deleting anything, what an earlier vibecarbon copied to
 * GitHub for its deploy.yml and nothing reads now: in each GitHub
 * Environment named (one per cluster: `prod`, or `prod-primary` and
 * `prod-standby`), the secrets and variables its seeding wrote
 * (RETIRED_GITOPS_COPIES), KUBECONFIG_B64 (cluster-admin credentials) first;
 * and the workflow file itself, when the repo still has it. A name the old
 * seeding never wrote is the operator's own and is left out. Names only:
 * `gh secret list` and `gh variable list` return no value. Each gh call is
 * bounded, and any failure says nothing, since the note is only advice.
 *
 * @param {{ projectDir: string, envNames: string[] }} args
 * @returns {Promise<string[]>} each copy it named, as `<env>:<NAME>`, then the
 *   workflow file when named
 */
export async function noteLeftoverGitopsCopies({ projectDir, envNames }) {
  const bound = { timeout: NOTE_GH_TIMEOUT_MS };
  const found = [];
  try {
    for (const env of envNames) {
      const [secrets, vars] = await Promise.all([
        listEnvironmentSecretNames(env, bound),
        listEnvironmentVariables(env, bound),
      ]);
      const ours = (names, kind) =>
        RETIRED_GITOPS_COPIES[kind].filter((name) => names.includes(name));
      const secretNames = ours(secrets, 'secrets');
      const varNames = ours(vars, 'vars');
      if (secretNames.length + varNames.length > 0) found.push({ env, secretNames, varNames });
    }
  } catch {
    return [];
  }
  const workflow = existsSync(join(projectDir, RETIRED_DEPLOY_WORKFLOW));
  if (found.length === 0 && !workflow) return [];
  if (found.length === 0) {
    // One repo file, nothing at GitHub's settings: say so, not "copies".
    p.log.info(
      `your repo still has ${RETIRED_DEPLOY_WORKFLOW}, the deploy workflow an earlier vibecarbon ` +
        'installed. nothing dispatches it now: vibecarbon deploy applies your secrets from ' +
        '.env.local, and flux pulls from inside the cluster. this command leaves it alone, so ' +
        `remove it when you like with: git rm ${RETIRED_DEPLOY_WORKFLOW}`,
    );
    return [RETIRED_DEPLOY_WORKFLOW];
  }

  const kubeconfig = 'KUBECONFIG_B64 (admin access to the cluster)';
  const parts = found.map(({ env, secretNames, varNames }) => {
    const hasKubeconfig = secretNames.includes('KUBECONFIG_B64');
    const others = secretNames.length - (hasKubeconfig ? 1 : 0);
    const items = [
      ...(hasKubeconfig ? [kubeconfig] : []),
      ...(others > 0 ? [counted(others, hasKubeconfig ? 'more secret' : 'secret')] : []),
      ...(varNames.length > 0 ? [counted(varNames.length, 'variable')] : []),
    ];
    return `${env} has ${andList(items)}`;
  });
  if (workflow)
    parts.push(`${parts.length > 0 ? 'and ' : ''}your repo has ${RETIRED_DEPLOY_WORKFLOW}`);

  const withKubeconfig = found.find(({ secretNames }) => secretNames.includes('KUBECONFIG_B64'));
  const withSecret = found.find(({ secretNames }) => secretNames.length > 0);
  const example = withKubeconfig
    ? `gh secret delete KUBECONFIG_B64 --env ${withKubeconfig.env}`
    : withSecret
      ? `gh secret delete ${withSecret.secretNames[0]} --env ${withSecret.env}`
      : `gh variable delete ${found[0].varNames[0]} --env ${found[0].env}`;
  p.log.info(
    `github still holds copies an earlier vibecarbon made for its old deploy workflow: ${parts.join('; ')}. ` +
      'nothing reads them now: vibecarbon deploy applies your secrets from .env.local, and flux ' +
      'pulls from inside the cluster. this command leaves them alone, so delete them when you ' +
      `like, for example: ${example}`,
  );
  return [
    ...found.flatMap(({ env, secretNames, varNames }) =>
      [...secretNames, ...varNames].map((name) => `${env}:${name}`),
    ),
    ...(workflow ? [RETIRED_DEPLOY_WORKFLOW] : []),
  ];
}

/**
 * GitOps on a running cluster: render the image tag and the real owner and
 * repo into k8s/, commit and push, then hand the cluster to Flux and wait for
 * its first sync. Nothing goes to GitHub but the push.
 *
 * @param {object} args
 * @param {string} args.projectDir - customer repo root
 * @param {string} args.environment - the cluster's stack: "prod", or "prod-primary" / "prod-standby"
 * @param {string} args.projectName
 * @param {string} args.kubeconfigPath - path to kubeconfig fetched from the cluster
 * @param {string} [args.imageTag] - specific image tag to bake into app Deployment (default "main")
 * @param {string} [args.githubOwner] - the repo's owner, when `gh repo view` cannot say
 * @param {import('./ghcr-pull-secret.js').GhcrPull} args.ghcrPull - the app image's pull
 *   credential, resolved once for every cluster of the environment (resolveGhcrPull); the
 *   handover puts it in this cluster's ghcr-pull-secret
 * @param {boolean} [args.skipCi] - mark the deploy commit [skip ci]
 * @returns {Promise<{ pushed: boolean }>} whether a new deploy commit was pushed
 */
export async function deployK8sGitOps(args) {
  const {
    projectDir,
    environment,
    projectName,
    kubeconfigPath,
    imageTag,
    skipCi = false,
    ghcrPull,
  } = args;

  // Before anything is written or committed: a tree Flux would apply with a
  // token in it, and a cluster file that still clones over https, fail here.
  refuseUnreadyGitopsProject(projectDir, { environment, imageTag });

  // H-9: loudly warn (before any spinner) if observability is installed — the
  // gitops path won't reconcile it until its Flux wiring lands (tracked follow-up).
  const obsWarning = observabilityGitopsWarning(projectDir);
  if (obsWarning) {
    p.log.warn(obsWarning);
  }

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

  // 3. Hand the cluster to Flux from here, after the push: its first sync
  // reads main. The firewall admits the operator's address, so this machine
  // reaches the k8s API where a GitHub runner never could. Flux clones the
  // repo the refs were just pointed at, with a deploy key on that repo.
  // What a step warns of and carries on past is printed once the spinner is
  // done, so no line lands under it.
  const warnings = [];
  const sayWarnings = () => {
    for (const line of warnings) p.log.warn(line);
  };
  s.start(`handing ${environment} to flux`);
  try {
    await handOverCluster({
      projectDir,
      envName: environment,
      kubeconfigPath,
      owner: repoOwner,
      repo: repoName,
      ghcrPull,
      warn: (line) => warnings.push(line),
    });
  } catch (err) {
    s.error(`flux has not taken over ${environment}`);
    sayWarnings();
    throw err;
  }
  s.stop(`flux has ${environment}, so a push under k8s/ to main deploys it from here on`);
  sayWarnings();

  return { pushed };
}

/**
 * The clusters of an environment, by stack name, each with its CURRENT role:
 * a k8s-ha env has `<env>-primary` and `<env>-standby`, and a failover swaps
 * which stack is primary (envConfig.ha.primary.stack); any other env has
 * one, the primary. The names are the GitHub Environments an earlier
 * vibecarbon seeded for its deploy.yml, too (noteLeftoverGitopsCopies).
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
