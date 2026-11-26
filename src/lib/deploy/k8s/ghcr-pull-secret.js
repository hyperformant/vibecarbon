/**
 * The credential a cluster pulls a private app image with. The app image is
 * ghcr.io/<owner>/<repo>, and the app's ServiceAccount names a
 * `ghcr-pull-secret` (carbon/k8s/base/app/rbac.yaml). For a private package
 * that Secret holds a GitHub classic token with only read:packages, in the
 * `vibecarbon` namespace of each cluster and nowhere else.
 *
 * `configure cicd <env>` resolves the credential once (resolveGhcrPull) and
 * each cluster's handover writes it (ensureGhcrPullSecretOn). A package
 * anyone can pull needs none. A token already in a cluster that still passes
 * the checks below is reused, so a rerun does not ask. Otherwise the token
 * comes from GHCR_PULL_TOKEN in the operator's shell or, on a terminal, from
 * one ask, and it replaces any stored token that failed.
 *
 * A token is refused before it is stored or copied anywhere unless GitHub
 * says its scopes (the x-oauth-scopes header on its own /user call) are
 * exactly read:packages: anyone who can read Secrets in the cluster can read
 * it. A token GitHub sends no scope header for (a fine-grained one) is
 * refused as not classic, and so is one GitHub no longer accepts. A stored
 * token is checked the same way each run, since a classic token's scopes can
 * be widened after it was made. A package that has gone public deletes a
 * stored token, so none sits in a cluster unchecked.
 *
 * Before the handover gives Flux the root, assertAppImageBuilt asks ghcr,
 * with the same credential, whether the app image Flux rolls to
 * (FLUX_APP_TAG) is built yet.
 *
 * The token goes only into Authorization headers to api.github.com and
 * ghcr.io, and into the Secret's manifest on kubectl's stdin. It is never in
 * a URL, an argv, a file, a log or an error message.
 */

import * as p from '@clack/prompts';
import { exitCancelled } from '../../cli/exit-guard.js';
import { link } from '../../colors.js';
import { registryEntry } from '../../config-registry.js';
import { environmentForStack } from '../../environment-name.js';
import { fetchWithRetry } from '../../fetch-retry.js';
import { normalizeOperatorValue, readOperatorVar } from '../../operator-env.js';
import { replaceWholeSecret } from './flux-bootstrap.js';
import { runKubectlWithRetry, secretManifest } from './k3s.js';

/** The Secret the app's ServiceAccount pulls with. */
export const GHCR_PULL_SECRET = 'ghcr-pull-secret';

/**
 * The tag Flux rolls the app to: every app image line in k8s/base names it
 * (carbon/k8s/base/app/deployment.yaml, pinned by
 * tests/unit/deploy/flux-app-tag-census.test.ts), and the build workflow
 * pushes it on every build of main.
 */
export const FLUX_APP_TAG = 'main';

const NAMESPACE = 'vibecarbon';

/** The operator variable a headless run reads the token from. */
const TOKEN_ENV = 'GHCR_PULL_TOKEN';

/** GitHub's new classic token page with only read:packages ticked. */
const READ_PACKAGES_TOKEN_PAGE = 'https://github.com/settings/tokens/new?scopes=read:packages';

/**
 * The new-token page, with a description that says which cluster the token
 * is for.
 *
 * @param {{ projectName: string, envName: string }} args - envName is the
 *   operator's environment (`prod`)
 * @returns {string}
 */
export function newPullTokenUrl({ projectName, envName }) {
  const description = encodeURIComponent(`${projectName} ${envName} image pulls`);
  return `${READ_PACKAGES_TOKEN_PAGE}&description=${description}`;
}

/**
 * ghcr's token, tags and manifest endpoints for a package. ghcr paths are
 * lowercase, whatever case GitHub spells the owner in.
 */
function ghcrEndpoints(owner, repo) {
  const path = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return {
    image: `ghcr.io/${path}`,
    token: `https://ghcr.io/token?scope=repository:${path}:pull&service=ghcr.io`,
    tags: `https://ghcr.io/v2/${path}/tags/list`,
    manifest: (tag) => `https://ghcr.io/v2/${path}/manifests/${tag}`,
  };
}

/**
 * Every manifest type a build can publish under a tag: an OCI image index or
 * manifest, a Docker manifest list or v2 manifest. All four are accepted, so
 * the HEAD finds the tag whichever type the build pushed.
 */
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * Every character a GitHub token can have. Checked before the token goes in a
 * header: fetch refuses a header value with a space or a control character
 * in it, and its error quotes the value.
 */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

/**
 * Who a token belongs to and what it may do, as GitHub says on its /user
 * call: `scopes` is the x-oauth-scopes header split, or null when there is
 * none (a token that is not classic).
 *
 * An error for a token that is no good, whatever the moment (unreadable,
 * refused, or not a kind /user takes), carries `shortfall`: what is wrong
 * with it, to follow "the token". Any other error (github down, rate
 * limited) carries none.
 *
 * @param {string} token
 * @param {{ fetcher?: typeof fetchWithRetry }} [options]
 * @returns {Promise<{ login: string, scopes: string[] | null }>}
 */
export async function githubTokenScopes(token, { fetcher = fetchWithRetry } = {}) {
  const noGood = (message, shortfall) => Object.assign(new Error(message), { shortfall });
  if (!TOKEN_CHARS.test(token)) {
    throw noGood(
      'that has a space or a character no github token has, so it was sent nowhere. ' +
        'copy the token again, all of it and nothing else.',
      'is not a token github could read',
    );
  }
  const res = await fetcher('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}` },
    label: 'api.github.com',
  });
  if (res.status === 401) {
    throw noGood(
      'github did not accept that token. it may be cut short, expired or revoked, so make a new one.',
      'is one github no longer accepts',
    );
  }
  if (res.status === 403) {
    throw noGood(
      "that is not one github's /user accepts, so github will not say what it may do. " +
        `make a classic token with only read:packages here: ${READ_PACKAGES_TOKEN_PAGE}`,
      'is not a classic token',
    );
  }
  if (!res.ok) {
    const later = res.status === 429 || res.status >= 500 ? ' try again in a minute.' : '';
    throw new Error(`github answered ${res.status} when asked what that token may do.${later}`);
  }
  const { login } = await res.json();
  if (typeof login !== 'string' || !login) {
    throw new Error('github did not say whose token that is. try again in a minute.');
  }
  const header = res.headers.get('x-oauth-scopes');
  return {
    login,
    scopes:
      header === null
        ? null
        : header
            .split(',')
            .map((scope) => scope.trim())
            .filter(Boolean),
  };
}

/**
 * What keeps a token with these scopes from being the pull token: `said`
 * follows "the token", `why` says what it means. Null when its one scope is
 * read:packages.
 */
function scopeShortfall(scopes) {
  if (scopes === null) {
    return { said: 'is not a classic token', why: 'so github will not say what it may do' };
  }
  const extra = scopes.filter((scope) => scope !== 'read:packages');
  if (extra.length > 0) {
    return {
      said: `can also ${extra.join(', ')}`,
      why: `and it lives in your cluster as ${GHCR_PULL_SECRET}, where anyone who can read Secrets can use it`,
    };
  }
  if (!scopes.includes('read:packages')) {
    return { said: 'cannot read packages', why: 'so the cluster could not pull with it' };
  }
  return null;
}

/**
 * Why a token with these scopes may not be the pull token, or null when its
 * one scope is read:packages.
 *
 * @param {string[] | null} scopes - githubTokenScopes's; null is not classic
 * @returns {string | null}
 */
export function pullTokenProblem(scopes) {
  const shortfall = scopeShortfall(scopes);
  if (!shortfall) return null;
  return (
    `that token ${shortfall.said}, ${shortfall.why}. ` +
    `make a classic token with only read:packages here: ${READ_PACKAGES_TOKEN_PAGE}`
  );
}

/**
 * Ask ghcr for a pull token on the package, anonymously or with `basic` (a
 * GitHub token's Basic pair). Null when ghcr refuses it; ghcr not answering
 * throws.
 */
async function ghcrBearer({ owner, repo, fetcher, basic }) {
  const { image, token } = ghcrEndpoints(owner, repo);
  const grant = await fetcher(token, {
    ...(basic && { headers: { Authorization: `Basic ${basic}` } }),
    label: 'ghcr.io',
  });
  if (grant.status === 401 || grant.status === 403) return null;
  if (!grant.ok) {
    throw new Error(
      `ghcr.io answered ${grant.status} when asked to pull ${image}. try again in a minute.`,
    );
  }
  const { token: bearer } = await grant.json();
  if (typeof bearer !== 'string' || !bearer) {
    throw new Error(`ghcr.io gave no pull token for ${image}. try again in a minute.`);
  }
  return bearer;
}

/**
 * Ask ghcr for a pull token on the package (ghcrBearer), then list its tags
 * with it. Null when ghcr refuses the pull token itself; otherwise the tags
 * answer's status.
 */
async function ghcrTagsStatus({ owner, repo, fetcher, basic }) {
  const bearer = await ghcrBearer({ owner, repo, fetcher, basic });
  if (bearer === null) return null;
  const tags = await fetcher(ghcrEndpoints(owner, repo).tags, {
    headers: { Authorization: `Bearer ${bearer}` },
    label: 'ghcr.io',
  });
  return tags.status;
}

/** A tags answer that is neither yes nor no. */
function unexpectedTags(status, owner, repo) {
  return new Error(
    `ghcr.io answered ${status} when asked for the tags of ${ghcrEndpoints(owner, repo).image}. ` +
      'try again in a minute.',
  );
}

/**
 * Whether anyone can pull the package, with no credential at all. A private
 * package and one not published yet both say no.
 *
 * @param {{ owner: string, repo: string, fetcher?: typeof fetchWithRetry }} args
 * @returns {Promise<boolean>}
 */
export async function ghcrPullsAnonymously({ owner, repo, fetcher = fetchWithRetry }) {
  const status = await ghcrTagsStatus({ owner, repo, fetcher });
  if (status === null || status === 401 || status === 403 || status === 404) return false;
  if (status === 200) return true;
  throw unexpectedTags(status, owner, repo);
}

/**
 * Whether ghcr lets this token pull the package. A package not published yet
 * (no tags, 404) still counts: ghcr knew the token, and the first build will
 * publish what it pulls.
 *
 * @param {{ owner: string, repo: string, username: string, token: string,
 *   fetcher?: typeof fetchWithRetry }} args
 * @returns {Promise<boolean>}
 */
export async function ghcrAcceptsToken({ owner, repo, username, token, fetcher = fetchWithRetry }) {
  const basic = Buffer.from(`${username}:${token}`).toString('base64');
  const status = await ghcrTagsStatus({ owner, repo, fetcher, basic });
  if (status === null || status === 401 || status === 403) return false;
  if (status === 200 || status === 404) return true;
  throw unexpectedTags(status, owner, repo);
}

/**
 * Refuse to give a cluster to Flux before the app image Flux rolls the app
 * Deployment to (`ghcr.io/<owner>/<repo>:main`, FLUX_APP_TAG) is built. Until
 * the build workflow has run on main that tag does not exist, so the app's
 * pods would sit in ImagePullBackOff and the first sync would wait out its
 * budget saying only that it is still in progress.
 *
 * Asked with the credential the cluster pulls with: anonymously for a public
 * package, through the token's Basic exchange (ghcrBearer) otherwise, then a
 * HEAD of the tag's manifest. 200 is built; 404, or a 401 to an anonymous
 * probe (a package not published), is not, and refuses; 5xx or 429 says to
 * try again. The token goes only into the exchange's Authorization header,
 * never a URL or an error.
 *
 * @param {{ owner: string, repo: string, pull: GhcrPull, envName: string,
 *   fetcher?: typeof fetchWithRetry }} args - envName is the cluster's stack
 *   (`prod`, `prod-standby`); pull is resolveGhcrPull's
 */
export async function assertAppImageBuilt({
  owner,
  repo,
  pull,
  envName,
  fetcher = fetchWithRetry,
}) {
  const { image, manifest } = ghcrEndpoints(owner, repo);
  const ref = `${image}:${FLUX_APP_TAG}`;
  const env = environmentForStack(envName);
  const anonymous = pull?.mode === 'public';
  const basic = anonymous
    ? undefined
    : Buffer.from(`${pull.username}:${pull.token}`).toString('base64');
  const bearer = await ghcrBearer({ owner, repo, fetcher, basic });
  const status =
    bearer === null
      ? null
      : (
          await fetcher(manifest(FLUX_APP_TAG), {
            method: 'HEAD',
            headers: { Authorization: `Bearer ${bearer}`, Accept: MANIFEST_TYPES },
            label: 'ghcr.io',
          })
        ).status;
  if (status === 200) return;
  if (anonymous && (status === null || status === 401)) {
    // Public mode means an anonymous pull of this package worked earlier in
    // this run, so a refusal now is the package turning private, not a
    // missing build.
    throw new Error(
      `ghcr.io no longer lets anyone pull ${image}, so it may have turned private since this run ` +
        `began, and ${envName} was not handed to flux. a rerun asks for a pull token if it needs ` +
        `one: vibecarbon configure cicd ${env}`,
    );
  }
  if (status === 404) {
    throw new Error(
      `your app image ${ref} is not built yet, so flux would roll the app to an image that does ` +
        'not exist. commit and push .github/workflows to main, wait for its first build in the ' +
        `actions tab, then run vibecarbon configure cicd ${env}`,
    );
  }
  if (status === 429 || status >= 500) {
    throw new Error(
      `ghcr.io answered ${status} when asked whether ${ref} is built. try again in a minute.`,
    );
  }
  if (!anonymous && (status === null || status === 401 || status === 403)) {
    throw new Error(
      `ghcr.io turned down the pull token when asked whether ${ref} is built, so ${envName} was ` +
        'not handed to flux. a rerun checks the stored token again and asks for a new one if ' +
        `ghcr still turns it down: vibecarbon configure cicd ${env}`,
    );
  }
  throw new Error(
    `ghcr.io answered ${status} when asked whether ${ref} is built, which says neither yes nor ` +
      `no, so ${envName} was not handed to flux. try again in a minute.`,
  );
}

/**
 * The pull Secret: a dockerconfigjson for ghcr.io, in the namespace the app
 * runs in.
 *
 * @param {{ username: string, token: string }} args
 * @returns {string}
 */
export function ghcrPullSecretManifest({ username, token }) {
  const auth = Buffer.from(`${username}:${token}`).toString('base64');
  return secretManifest(
    GHCR_PULL_SECRET,
    {
      '.dockerconfigjson': JSON.stringify({
        auths: { 'ghcr.io': { username, password: token, auth } },
      }),
    },
    NAMESPACE,
    'kubernetes.io/dockerconfigjson',
  );
}

/**
 * The ghcr.io pair the cluster's pull Secret holds, or null when there is no
 * Secret or it holds no such pair. Missing is an empty answer
 * (`--ignore-not-found`), so a first handover prints no NotFound error; a
 * cluster kubectl cannot reach throws. Read with captureStdout: nothing is
 * printed.
 *
 * @param {{ env: NodeJS.ProcessEnv }} args - env carries the cluster's KUBECONFIG
 * @returns {Promise<{ username: string, token: string } | null>}
 */
export async function readGhcrPullSecret({ env }) {
  const out = await runKubectlWithRetry(
    [
      'get',
      'secret',
      GHCR_PULL_SECRET,
      '-n',
      NAMESPACE,
      '--ignore-not-found',
      '-o',
      'jsonpath={.data.\\.dockerconfigjson}',
    ],
    { env, captureStdout: true, description: `read Secret ${NAMESPACE}/${GHCR_PULL_SECRET}` },
  );
  const data = String(out ?? '').trim();
  if (!data) return null;
  let entry;
  try {
    entry = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'))?.auths?.['ghcr.io'];
  } catch {
    // Not the JSON a dockerconfigjson holds: there is no pair to reuse.
    return null;
  }
  const { username, password } = entry ?? {};
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return null;
  }
  return { username, token: password };
}

/**
 * What keeps a token read back from a cluster from being used again, checked
 * as a new token is: its scopes at github (a token widened since, or
 * revoked, fails here), then ghcr. Null when it can be reused. Github or
 * ghcr not answering throws: that says nothing about the token.
 */
async function storedTokenShortfall({ owner, repo, stored, fetcher }) {
  let scopes;
  try {
    ({ scopes } = await githubTokenScopes(stored.token, { fetcher }));
  } catch (err) {
    if (err.shortfall) return err.shortfall;
    throw err;
  }
  const shortfall = scopeShortfall(scopes);
  if (shortfall) return shortfall.said;
  if (!(await ghcrAcceptsToken({ owner, repo, ...stored, fetcher }))) {
    return 'is one ghcr.io no longer accepts';
  }
  return null;
}

/**
 * A token the operator gives this run: GHCR_PULL_TOKEN from the shell, else
 * one ask on a terminal. `from` names where it came from in a refusal.
 * `stale` says which cluster's stored token is not used again, and why.
 */
async function newPullToken({ image, envName, projectName, isTTY, prompt, stale }) {
  const shell = readOperatorVar(TOKEN_ENV);
  if (shell.problem) throw new Error(shell.problem);
  const pageUrl = newPullTokenUrl({ projectName, envName });
  if (!shell.value && !isTTY) {
    throw new Error(
      [
        ...stale.map((line) => `${line}, so it is not used again.`),
        `your app image at ${image} is private or not published yet, so ${envName} needs a token ` +
          `to pull it, and there is no terminal to ask for one. export ${TOKEN_ENV} as a classic ` +
          `token with only read:packages, made here: ${pageUrl}`,
      ].join('\n'),
    );
  }
  if (stale.length > 0) {
    p.log.warn(stale.map((line) => `${line}, so it gets replaced.`).join('\n'));
  }
  if (shell.value) return { token: shell.value, from: TOKEN_ENV };
  p.log.info(
    [
      `your app image at ${image} is private or not published yet, so ${envName} needs a token to pull it.`,
      `make a classic token with only read:packages here: ${link(pageUrl)}`,
      `it lives in the cluster as ${GHCR_PULL_SECRET} and nowhere else, so give it nothing more.`,
    ].join('\n'),
  );
  const answer = await prompt({
    message: 'paste the token',
    validate: (value) => (value?.trim() ? undefined : 'paste the token, or press ctrl-c to stop'),
  });
  if (p.isCancel(answer)) exitCancelled();
  return {
    token: normalizeOperatorValue(answer, registryEntry(TOKEN_ENV)).value,
    from: 'the token you pasted',
  };
}

/**
 * @typedef {{ mode: 'public' } | { mode: 'token', username: string, token: string }} GhcrPull
 */

/**
 * The pull credential for every cluster of the environment, resolved once:
 * public when anyone can pull the package; else the first token stored in a
 * cluster that passes the same checks as a new one; else a new token
 * (GHCR_PULL_TOKEN, or one ask on a terminal). A token is refused with the
 * reason unless github says its scopes are exactly read:packages and ghcr
 * lets it pull the package. A stored token that fails is not reused or
 * copied to another cluster: whatever this returns replaces it. Nothing is
 * written here.
 *
 * @param {{ owner: string, repo: string, projectName: string, envName: string,
 *   clusters: Array<{ envName: string, kubeconfigPath: string }>,
 *   isTTY?: boolean, prompt?: (opts: { message: string,
 *   validate: (value: string) => string | undefined }) => Promise<unknown>,
 *   fetcher?: typeof fetchWithRetry }} args - envName is the operator's
 *   environment; clusters are its clusters (both sides of k8s-ha)
 * @returns {Promise<GhcrPull>}
 */
export async function resolveGhcrPull({
  owner,
  repo,
  projectName,
  envName,
  clusters,
  isTTY = process.stdin.isTTY,
  prompt = (opts) => p.password(opts),
  fetcher = fetchWithRetry,
}) {
  if (await ghcrPullsAnonymously({ owner, repo, fetcher })) return { mode: 'public' };
  const stale = [];
  for (const cluster of clusters) {
    const stored = await readGhcrPullSecret({
      env: { ...process.env, KUBECONFIG: cluster.kubeconfigPath },
    });
    if (!stored) continue;
    const shortfall = await storedTokenShortfall({ owner, repo, stored, fetcher });
    if (!shortfall) {
      if (stale.length > 0) {
        p.log.warn(stale.map((line) => `${line}, so it gets replaced.`).join('\n'));
      }
      return { mode: 'token', ...stored };
    }
    stale.push(`the token in ${cluster.envName}'s cluster ${shortfall}`);
  }
  const { image } = ghcrEndpoints(owner, repo);
  const { token, from } = await newPullToken({
    image,
    envName: environmentForStack(envName),
    projectName,
    isTTY,
    prompt,
    stale,
  });
  const refuse = (why) => new Error(`${from} was not stored: ${why}`);
  let login;
  let scopes;
  try {
    ({ login, scopes } = await githubTokenScopes(token, { fetcher }));
  } catch (err) {
    throw refuse(err.message);
  }
  const problem = pullTokenProblem(scopes);
  if (problem) throw refuse(problem);
  if (!(await ghcrAcceptsToken({ owner, repo, username: login, token, fetcher }))) {
    throw refuse(
      `ghcr.io would not let it pull ${image}. make one as someone who can read that package: ` +
        newPullTokenUrl({ projectName, envName: environmentForStack(envName) }),
    );
  }
  return { mode: 'token', username: login, token };
}

/**
 * Put the pull credential in one cluster: for a public package, no Secret
 * (one an earlier run stored is deleted: no later run would check its
 * scopes, and a missing Secret the ServiceAccount names only makes kubelet
 * pull anonymously); nothing when the Secret already holds this pair; else
 * the Secret written whole, its manifest on kubectl's stdin.
 *
 * @param {{ env: NodeJS.ProcessEnv, pull: GhcrPull }} args - env carries the
 *   cluster's KUBECONFIG; pull is resolveGhcrPull's
 * @returns {Promise<'public' | 'kept' | 'stored'>}
 */
export async function ensureGhcrPullSecretOn({ env, pull }) {
  if (pull?.mode === 'public') {
    await runKubectlWithRetry(
      ['delete', 'secret', GHCR_PULL_SECRET, '-n', NAMESPACE, '--ignore-not-found'],
      {
        env,
        captureStdout: true,
        description: `delete Secret ${NAMESPACE}/${GHCR_PULL_SECRET} (the image is public)`,
      },
    );
    return 'public';
  }
  if (pull?.mode !== 'token') {
    throw new TypeError(
      'ensureGhcrPullSecretOn needs the pull credential resolveGhcrPull resolved',
    );
  }
  const stored = await readGhcrPullSecret({ env });
  if (stored?.username === pull.username && stored?.token === pull.token) return 'kept';
  await replaceWholeSecret({
    env,
    namespace: NAMESPACE,
    name: GHCR_PULL_SECRET,
    manifest: ghcrPullSecretManifest(pull),
  });
  return 'stored';
}
