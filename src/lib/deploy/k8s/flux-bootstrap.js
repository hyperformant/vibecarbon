/**
 * The steps that hand a cluster to Flux, run by the CLI from the operator's
 * machine, the one place the operator-IP firewall lets reach the k8s API.
 * They were deploy.yml's, run from a GitHub runner the firewall never let in;
 * after them the cluster pulls (Flux watches main) and nothing at GitHub
 * connects to it.
 *
 * Install Flux once (installFluxIfAbsent), apply the root GitRepository and
 * Kustomization (applyFluxRoot), then have each reconcile and wait until it
 * has (awaitFluxReconcile). Every step is idempotent, so a rerun of
 * `configure cicd <env>` walks them again safely. Between the install and the
 * root, flux-deploy-key.js writes the Secret Flux clones with, and
 * ghcr-pull-secret.js the app image's pull Secret (replaceWholeSecret).
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { runKubectlWithRetry } from './k3s.js';
import { FLUX_CLUSTER_FILE } from './unrendered-placeholders.js';

/** The Flux release `configure cicd <env>` installs; bump it deliberately. */
export const FLUX_VERSION = 'v2.10.0';

export const FLUX_INSTALL_URL = `https://github.com/fluxcd/flux2/releases/download/${FLUX_VERSION}/install.yaml`;

/** The field manager of everything this module applies. */
const FIELD_MANAGER = 'vibecarbon-cli';

/**
 * Server-side apply, as `flux install` itself applies: Flux's large CRDs
 * carry no last-applied annotation (a client-side apply of them can pass the
 * annotation size limit), and --force-conflicts takes over the fields an
 * earlier deploy.yml run applied as github-actions-deploy.
 */
const SERVER_SIDE_APPLY = [
  'apply',
  '--server-side',
  '--force-conflicts',
  `--field-manager=${FIELD_MANAGER}`,
];

const FLUX_CONTROLLERS = [
  'source-controller',
  'kustomize-controller',
  'helm-controller',
  'notification-controller',
];

/**
 * Install Flux unless its source-controller is already there, then wait for
 * all four controllers either way. Missing is an empty answer
 * (`--ignore-not-found`), so a first install prints no NotFound error; an
 * unreachable API or a refused credential fails here, before anything is
 * applied. The wait runs on a Flux found in place too: a rerun after an
 * install that stopped part way fails here, with kubectl naming the
 * controller that is missing or not available, not later as a sync that
 * never finishes.
 *
 * @param {{ env: NodeJS.ProcessEnv }} args - env carries the cluster's KUBECONFIG
 * @returns {Promise<'installed' | 'present'>}
 */
export async function installFluxIfAbsent({ env }) {
  const found = await runKubectlWithRetry(
    [
      '-n',
      'flux-system',
      'get',
      'deployment',
      'source-controller',
      '--ignore-not-found',
      '-o',
      'name',
    ],
    { env, captureStdout: true, description: 'flux: look for source-controller' },
  );
  const present = Boolean(found.trim());
  if (!present) {
    await runKubectlWithRetry([...SERVER_SIDE_APPLY, '-f', FLUX_INSTALL_URL], {
      env,
      captureStdout: true,
      description: `flux: install ${FLUX_VERSION}`,
    });
  }
  await runKubectlWithRetry(
    [
      '-n',
      'flux-system',
      'wait',
      '--for=condition=available',
      ...FLUX_CONTROLLERS.map((name) => `deployment/${name}`),
      '--timeout=300s',
    ],
    { env, captureStdout: true, description: 'flux: wait for its controllers' },
  );
  return present ? 'present' : 'installed';
}

/**
 * Apply the project's Flux cluster file: the root GitRepository and the
 * vibecarbon-base Kustomization. The same file goes on every cluster, a
 * k8s-ha standby's too, as deploy.yml applied it.
 *
 * @param {{ env: NodeJS.ProcessEnv, projectDir: string }} args
 */
export async function applyFluxRoot({ env, projectDir }) {
  await runKubectlWithRetry([...SERVER_SIDE_APPLY, '-f', join(projectDir, FLUX_CLUSTER_FILE)], {
    env,
    captureStdout: true,
    description: 'flux: apply the root GitRepository and Kustomization',
  });
}

/**
 * Write a Secret whole: `replace` when it exists, `create` when it does not,
 * so it ends up holding exactly the manifest's keys. An apply would merge,
 * and keep a key an earlier writer left (deploy.yml put a username and
 * password in flux-system). Missing is an empty answer (`--ignore-not-found`),
 * so a first write prints no NotFound error; an unreachable API fails here,
 * before anything is written. The manifest goes to kubectl on stdin only.
 *
 * @param {{ env: NodeJS.ProcessEnv, namespace: string, name: string, manifest: string }} args
 * @returns {Promise<'created' | 'replaced'>}
 */
export async function replaceWholeSecret({ env, namespace, name, manifest }) {
  const found = await runKubectlWithRetry(
    ['get', 'secret', name, '-n', namespace, '--ignore-not-found', '-o', 'name'],
    { env, captureStdout: true, description: `flux: look for Secret/${name}` },
  );
  const verb = found.trim() ? 'replace' : 'create';
  await runKubectlWithRetry([verb, '-f', '-'], {
    env,
    input: manifest,
    captureStdout: true,
    description: `flux: ${verb} Secret/${name}`,
  });
  return verb === 'replace' ? 'replaced' : 'created';
}

/**
 * How long the GitRepository may take to fetch: a clone of the repo over ssh,
 * which takes seconds. Three minutes covers a slow GitHub without leaving a
 * source that cannot fetch at all (a refused key) to wait out the apply's
 * budget too.
 */
const FETCH_TIMEOUT_SEC = 180;

/**
 * How long the Kustomization may take to apply: its own `timeout: 10m` in the
 * cluster file (k8s/flux/clusters/primary/vibecarbon.yaml), within which Flux
 * applies the base and waits on its health checks. The wait ends when Flux's
 * own does; change the two together.
 */
const APPLY_TIMEOUT_SEC = 600;

/**
 * The root objects, in the order they reconcile: the source, then the base,
 * each with its own budget and what it does in that time.
 */
const FLUX_ROOT = [
  {
    object: 'gitrepository/vibecarbon',
    kind: 'GitRepository',
    does: 'fetch',
    timeoutSec: FETCH_TIMEOUT_SEC,
  },
  {
    object: 'kustomization/vibecarbon-base',
    kind: 'Kustomization',
    does: 'apply',
    timeoutSec: APPLY_TIMEOUT_SEC,
  },
];

/** One object's Ready status, then its message on the lines after. */
const READY_CONDITION =
  'jsonpath={.status.conditions[?(@.type=="Ready")].status}{"\\n"}{.status.conditions[?(@.type=="Ready")].message}';

/** Both objects' Ready messages, one `Kind: message` line each. */
const READY_MESSAGES =
  'jsonpath={range .items[*]}{.kind}: {.status.conditions[?(@.type=="Ready")].message}{"\\n"}{end}';

/** A word the shell reads as one argument, quoted only when it has to be. */
const shellWord = (word) =>
  /^[\w./:@-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** What the operator runs to see what Flux says, on the right cluster. */
const lookCloser = (kubeconfigPath) =>
  `look closer with KUBECONFIG=${shellWord(kubeconfigPath)} kubectl -n flux-system get gitrepository,kustomization`;

/**
 * Have the GitRepository fetch now, then the Kustomization apply what it
 * fetched, and wait until each has done so. Each is annotated with a request
 * of its own (`reconcile.fluxcd.io/requestedAt`, the time and a random
 * suffix, fresh on every call), and the wait is for the controller to record
 * that very request as handled (`.status.lastHandledReconcileAt`). A wait for
 * Ready alone would pass at once on a rerun: an object an earlier sync left
 * Ready stays Ready while Flux keeps its last artifact, even when the source
 * can no longer fetch (a changed URL, a rotated key).
 *
 * Once a request is handled, the object's Ready condition is read once: not
 * True fails at once with its message. A request not handled within the
 * object's own budget (FETCH_TIMEOUT_SEC, APPLY_TIMEOUT_SEC) fails with both
 * objects' Ready messages. Either failure names the kubectl to look closer,
 * on this cluster.
 *
 * @param {{ env: NodeJS.ProcessEnv, envName: string, kubeconfigPath: string,
 *   now?: () => Date }} args
 */
export async function awaitFluxReconcile({ env, envName, kubeconfigPath, now = () => new Date() }) {
  for (const { object, kind, does, timeoutSec } of FLUX_ROOT) {
    const request = `${now().toISOString()}-${randomBytes(4).toString('hex')}`;
    await runKubectlWithRetry(
      [
        '-n',
        'flux-system',
        'annotate',
        '--overwrite',
        object,
        `reconcile.fluxcd.io/requestedAt=${request}`,
      ],
      { env, captureStdout: true, description: `flux: ask ${object} to reconcile` },
    );
    try {
      await runKubectlWithRetry(
        [
          '-n',
          'flux-system',
          'wait',
          `--for=jsonpath={.status.lastHandledReconcileAt}=${request}`,
          object,
          `--timeout=${timeoutSec}s`,
        ],
        { env, captureStdout: true, description: `flux: wait for ${object} to reconcile` },
      );
    } catch (waitErr) {
      throw await notFinished({ env, envName, kubeconfigPath, kind, does, timeoutSec, waitErr });
    }
    const [status, ...message] = (
      await runKubectlWithRetry(['-n', 'flux-system', 'get', object, '-o', READY_CONDITION], {
        env,
        captureStdout: true,
        description: `flux: read ${object}'s Ready`,
      })
    ).split('\n');
    if (status.trim() !== 'True') {
      const said =
        message.join('\n').trim() || `not Ready (${status.trim() || 'no Ready condition'})`;
      throw new Error(
        `flux tried to sync ${envName} and could not. here is what it says:\n` +
          `${kind}: ${said}\n${lookCloser(kubeconfigPath)}`,
      );
    }
  }
}

/**
 * The error for a request not handled in time: which object ran out of its
 * budget, then both objects' Ready messages (a Kind with none is left out),
 * or the wait's own error when neither has one or they cannot be read. True
 * of any run, a rerun's as much as the first.
 */
async function notFinished({ env, envName, kubeconfigPath, kind, does, timeoutSec, waitErr }) {
  let said = '';
  try {
    said = await runKubectlWithRetry(
      ['-n', 'flux-system', 'get', ...FLUX_ROOT.map((r) => r.object), '-o', READY_MESSAGES],
      { env, captureStdout: true, description: 'flux: read why it is not Ready' },
    );
  } catch {
    // Unreadable too: the wait's own error is all there is to say.
  }
  const messages = said
    .split('\n')
    .filter((line) => line.trim() && !/^\w+:\s*$/.test(line))
    .join('\n');
  const minutes = Math.round(timeoutSec / 60);
  return new Error(
    `flux did not finish syncing ${envName}: its ${kind} did not ${does} within ${minutes} minute${minutes === 1 ? '' : 's'}. here is what it says:\n` +
      `${messages || waitErr.message}\n${lookCloser(kubeconfigPath)}`,
  );
}
