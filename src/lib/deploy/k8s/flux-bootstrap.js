/**
 * The steps that hand a cluster to Flux, run by the CLI from the operator's
 * machine, the one place the operator-IP firewall lets reach the k8s API.
 * They were deploy.yml's, run from a GitHub runner the firewall never let in;
 * after them the cluster pulls (Flux watches main) and nothing at GitHub
 * connects to it.
 *
 * Install Flux once (installFluxIfAbsent), apply the root GitRepository and
 * Kustomization (applyFluxRoot), then nudge both and wait for the first sync
 * (awaitFluxReconcile). Every step is idempotent, so a rerun of `configure
 * cicd <env>` walks them again safely.
 */

import { join } from 'node:path';
import { kubectlErrorHaystack, runKubectlWithRetry } from './k3s.js';
import { FLUX_CLUSTER_FILE } from './unrendered-placeholders.js';

/** The Flux release the deploy workflow installed; bump it deliberately. */
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
 * Install Flux unless its source-controller is already there. Only a NotFound
 * answer counts as missing: an unreachable API or a refused credential
 * fails here, before anything is applied.
 *
 * @param {{ env: NodeJS.ProcessEnv }} args - env carries the cluster's KUBECONFIG
 * @returns {Promise<'installed' | 'present'>}
 */
export async function installFluxIfAbsent({ env }) {
  try {
    await runKubectlWithRetry(
      ['-n', 'flux-system', 'get', 'deployment', 'source-controller', '-o', 'name'],
      { env, captureStdout: true, description: 'flux: look for source-controller' },
    );
    return 'present';
  } catch (err) {
    if (!/\bNotFound\b/.test(kubectlErrorHaystack(err))) throw err;
  }
  await runKubectlWithRetry([...SERVER_SIDE_APPLY, '-f', FLUX_INSTALL_URL], {
    env,
    captureStdout: true,
    description: `flux: install ${FLUX_VERSION}`,
  });
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
  return 'installed';
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

/** Both objects' Ready messages, one `Kind: message` line each. */
const READY_MESSAGES =
  'jsonpath={range .items[*]}{.kind}: {.status.conditions[?(@.type=="Ready")].message}{"\\n"}{end}';

/**
 * Ask Flux to fetch and reconcile now rather than at its next interval, then
 * wait for vibecarbon-base to be Ready. A sync that is not Ready in time
 * fails with what the GitRepository and the Kustomization say, which names
 * the cause (a refused clone, a manifest the cluster rejects).
 *
 * @param {{ env: NodeJS.ProcessEnv, envName: string, timeoutSec?: number,
 *   now?: () => Date }} args
 */
export async function awaitFluxReconcile({
  env,
  envName,
  timeoutSec = 600,
  now = () => new Date(),
}) {
  const requested = `reconcile.fluxcd.io/requestedAt=${now().toISOString()}`;
  for (const object of ['gitrepository/vibecarbon', 'kustomization/vibecarbon-base']) {
    await runKubectlWithRetry(['-n', 'flux-system', 'annotate', '--overwrite', object, requested], {
      env,
      captureStdout: true,
      description: `flux: ask ${object} to reconcile`,
    });
  }
  try {
    await runKubectlWithRetry(
      [
        '-n',
        'flux-system',
        'wait',
        '--for=condition=Ready',
        'kustomization/vibecarbon-base',
        `--timeout=${timeoutSec}s`,
      ],
      { env, captureStdout: true, description: 'flux: wait for the first sync' },
    );
  } catch (waitErr) {
    let said = '';
    try {
      said = await runKubectlWithRetry(
        [
          '-n',
          'flux-system',
          'get',
          'gitrepository/vibecarbon',
          'kustomization/vibecarbon-base',
          '-o',
          READY_MESSAGES,
        ],
        { env, captureStdout: true, description: 'flux: read why it is not Ready' },
      );
    } catch {
      // Unreadable too: the wait's own error is all there is to say.
    }
    const minutes = Math.round(timeoutSec / 60);
    throw new Error(
      `flux did not finish its first sync of ${envName} within ${minutes} minute${minutes === 1 ? '' : 's'}. here is what it says:\n` +
        `${said.trim() || waitErr.message}\n` +
        'look closer with kubectl -n flux-system get gitrepository,kustomization',
    );
  }
}
