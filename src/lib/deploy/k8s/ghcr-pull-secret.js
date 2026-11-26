/**
 * The credential a cluster pulls a private app image with. The app image is
 * ghcr.io/<owner>/<repo>, and the app's ServiceAccount names a
 * `ghcr-pull-secret` (carbon/k8s/base/app/rbac.yaml). For a private package
 * that Secret holds a GitHub classic token with only read:packages, in the
 * `vibecarbon` namespace of each cluster and nowhere else.
 *
 * `configure cicd <env>` resolves the credential once (resolveGhcrPull, in
 * ../ghcr-pull.js, with the clusters as its stores) and each cluster's
 * handover writes it (ensureGhcrPullSecretOn). The token rules are there. A
 * package that has gone public deletes a stored token, so none sits in a
 * cluster unchecked.
 *
 * Before the handover gives Flux the root, assertAppImageBuilt asks ghcr,
 * with the same credential, whether the app image Flux rolls to
 * (FLUX_APP_TAG) is built yet.
 *
 * The token goes only into Authorization headers to api.github.com and
 * ghcr.io, and into the Secret's manifest on kubectl's stdin. It is never in
 * a URL, an argv, a file, a log or an error message.
 */

import { environmentForStack } from '../../environment-name.js';
import { fetchWithRetry } from '../../fetch-retry.js';
import { ghcrBearer, ghcrEndpoints, MANIFEST_TYPES } from '../ghcr-pull.js';
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
 * @param {{ owner: string, repo: string, pull: import('../ghcr-pull.js').GhcrPull, envName: string,
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
    {
      env,
      captureStdout: true,
      secret: true,
      description: `read Secret ${NAMESPACE}/${GHCR_PULL_SECRET}`,
    },
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
 * Put the pull credential in one cluster: for a public package, no Secret
 * (one an earlier run stored is deleted: no later run would check its
 * scopes, and a missing Secret the ServiceAccount names only makes kubelet
 * pull anonymously); nothing when the Secret already holds this pair; else
 * the Secret written whole, its manifest on kubectl's stdin.
 *
 * @param {{ env: NodeJS.ProcessEnv, pull: import('../ghcr-pull.js').GhcrPull }} args - env carries the
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

/**
 * The clusters of an environment as places a pull token may be stored: each
 * is read with its own kubeconfig.
 *
 * @param {Array<{ envName: string, kubeconfigPath: string }>} clusters
 * @returns {import('../ghcr-pull.js').PullStore[]}
 */
export function clusterStores(clusters) {
  return clusters.map(({ envName, kubeconfigPath }) => ({
    name: `in ${envName}'s cluster`,
    read: () => readGhcrPullSecret({ env: { ...process.env, KUBECONFIG: kubeconfigPath } }),
  }));
}
