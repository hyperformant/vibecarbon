/**
 * The CLI hands a cluster to Flux itself (flux-bootstrap.js), from the
 * operator's machine, which the operator-IP firewall lets in: nothing at
 * GitHub connects to the cluster. These pin the kubectl each step runs: Flux
 * installed once and server-side, the one cluster file applied, then each
 * root object asked to reconcile and waited on until it has handled that
 * very request, so a rerun cannot pass on the Ready an earlier sync left.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../_shared/source-files.js';

type Call = { args: string[]; env?: NodeJS.ProcessEnv; input?: string };
const k = vi.hoisted(() => ({
  calls: [] as Call[],
  answer: (_args: string[]): string => '',
}));

vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runKubectlWithRetry: async (
    args: string[],
    { env, input }: { env?: NodeJS.ProcessEnv; input?: string } = {},
  ) => {
    k.calls.push({ args, env, input });
    return k.answer(args);
  },
}));

const {
  FLUX_INSTALL_URL,
  FLUX_VERSION,
  applyFluxRoot,
  awaitFluxReconcile,
  installFluxIfAbsent,
  replaceWholeSecret,
} = await import('../../../src/lib/deploy/k8s/flux-bootstrap.js');
const { FLUX_CLUSTER_FILE } = await import(
  '../../../src/lib/deploy/k8s/unrendered-placeholders.js'
);

const kubeconfigPath = '/project/.vibecarbon/kubeconfig-prod';
const env = { KUBECONFIG: kubeconfigPath } as NodeJS.ProcessEnv;
const PROBE = [
  '-n',
  'flux-system',
  'get',
  'deployment',
  'source-controller',
  '--ignore-not-found',
  '-o',
  'name',
];
const SERVER_SIDE = [
  'apply',
  '--server-side',
  '--force-conflicts',
  '--field-manager=vibecarbon-cli',
];
const GIT = 'gitrepository/vibecarbon';
const BASE = 'kustomization/vibecarbon-base';
const HINT = `look closer with KUBECONFIG=${kubeconfigPath} kubectl -n flux-system get gitrepository,kustomization`;

/** What runKubectlWithRetry throws for a kubectl that exited 1 with this stderr. */
const kubectlFailed = (args: string[], stderr: string) =>
  Object.assign(new Error(`kubectl ${args.slice(0, 4).join(' ')} failed with exit 1: ${stderr}`), {
    status: 1,
    stderr,
  });

const argsOf = () => k.calls.map((c) => c.args);

beforeEach(() => {
  k.calls.length = 0;
  k.answer = () => '';
});

describe('installFluxIfAbsent', () => {
  it('pins the Flux release deploy.yml used', () => {
    expect(FLUX_VERSION).toBe('v2.10.0');
    expect(FLUX_INSTALL_URL).toBe(
      'https://github.com/fluxcd/flux2/releases/download/v2.10.0/install.yaml',
    );
  });

  const WAIT = [
    '-n',
    'flux-system',
    'wait',
    '--for=condition=available',
    'deployment/source-controller',
    'deployment/kustomize-controller',
    'deployment/helm-controller',
    'deployment/notification-controller',
    '--timeout=300s',
  ];

  it('installs Flux only when source-controller is missing, server-side, then waits for the four controllers', async () => {
    // --ignore-not-found: a missing controller is an empty answer, not a
    // NotFound error kubectl would print under the spinner.
    k.answer = () => '';
    await expect(installFluxIfAbsent({ env })).resolves.toBe('installed');
    expect(argsOf()).toEqual([PROBE, [...SERVER_SIDE, '-f', FLUX_INSTALL_URL], WAIT]);
    expect(k.calls.every((c) => c.env === env)).toBe(true);

    // Already there: nothing applied, and the same four-controller wait, so a
    // Flux an earlier run left half installed is found here.
    k.calls.length = 0;
    k.answer = () => 'deployment.apps/source-controller\n';
    await expect(installFluxIfAbsent({ env })).resolves.toBe('present');
    expect(argsOf()).toEqual([PROBE, WAIT]);
    expect(k.calls.every((c) => c.env === env)).toBe(true);
  });

  it('a rerun after a partial install fails fast at the wait, naming the missing controller', async () => {
    // An earlier install that stopped after source-controller: the probe
    // finds it, and the wait says which controller is not there, before any
    // key or Secret is touched.
    const missing = kubectlFailed(
      WAIT,
      'Error from server (NotFound): deployments.apps "helm-controller" not found',
    );
    k.answer = (args) => {
      if (args[2] === 'wait') throw missing;
      return 'deployment.apps/source-controller\n';
    };
    const err = await installFluxIfAbsent({ env }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBe(missing);
    expect(err?.message).toContain('helm-controller');
    expect(argsOf()).toEqual([PROBE, WAIT]);
  });

  it('an unreachable API fails before anything is applied', async () => {
    const down = kubectlFailed(
      PROBE,
      'Unable to connect to the server: dial tcp 203.0.113.20:6443: i/o timeout',
    );
    k.answer = () => {
      throw down;
    };
    await expect(installFluxIfAbsent({ env })).rejects.toBe(down);
    expect(argsOf()).toEqual([PROBE]);
  });
});

describe('applyFluxRoot', () => {
  it('applies the one cluster file server-side as vibecarbon-cli', async () => {
    await applyFluxRoot({ env, projectDir: '/project' });
    expect(argsOf()).toEqual([[...SERVER_SIDE, '-f', join('/project', FLUX_CLUSTER_FILE)]]);
    expect(k.calls[0].env).toBe(env);
  });
});

describe('replaceWholeSecret', () => {
  const GET = [
    'get',
    'secret',
    'flux-system',
    '-n',
    'flux-system',
    '--ignore-not-found',
    '-o',
    'name',
  ];
  const manifest = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    '  name: flux-system',
    '  namespace: flux-system',
    'type: Opaque',
    'stringData:',
    '  identity: "-----BEGIN PRIVATE KEY-----\\nMC4CAQ\\n-----END PRIVATE KEY-----\\n"',
  ].join('\n');
  const write = () =>
    replaceWholeSecret({ env, namespace: 'flux-system', name: 'flux-system', manifest });

  it('writes a Secret whole: replace when it exists, create when not, the manifest on stdin', async () => {
    // Whole, not applied: a key an earlier writer left (deploy.yml's
    // username and password) goes with the old Secret.
    k.answer = (args) => (args[0] === 'get' ? 'secret/flux-system\n' : '');
    await expect(write()).resolves.toBe('replaced');
    expect(argsOf()).toEqual([GET, ['replace', '-f', '-']]);
    expect(k.calls.map((c) => c.input)).toEqual([undefined, manifest]);

    // Missing is an empty answer (--ignore-not-found), so a first handover
    // prints no NotFound error under the spinner.
    k.calls.length = 0;
    k.answer = () => '';
    await expect(write()).resolves.toBe('created');
    expect(argsOf()).toEqual([GET, ['create', '-f', '-']]);
    expect(k.calls.map((c) => c.input)).toEqual([undefined, manifest]);
    expect(k.calls.every((c) => c.env === env)).toBe(true);
    expect(argsOf().flat().join(' ')).not.toContain('PRIVATE KEY');
  });

  it('an unreachable API fails before anything is written', async () => {
    const down = kubectlFailed(
      GET,
      'Unable to connect to the server: dial tcp 203.0.113.20:6443: i/o timeout',
    );
    k.answer = () => {
      throw down;
    };
    await expect(write()).rejects.toBe(down);
    expect(argsOf()).toEqual([GET]);
  });
});

describe('awaitFluxReconcile', () => {
  const at = new Date('2026-11-26T10:00:00.000Z');
  const now = () => at;
  const reconcile = (extra: Record<string, unknown> = {}) =>
    awaitFluxReconcile({ env, envName: 'prod', kubeconfigPath, now, ...extra });

  /** The request each annotate made, by object. */
  const requested = () =>
    Object.fromEntries(
      k.calls
        .filter((c) => c.args[2] === 'annotate')
        .map((c) => [c.args[4], c.args[5].replace('reconcile.fluxcd.io/requestedAt=', '')]),
    );
  /** One line per call: its verb and the object it names. */
  const steps = () =>
    k.calls.map(({ args }) => `${args[2]} ${args.find((a) => a === GIT || a === BASE) ?? ''}`);
  const isReadyRead = (args: string[], object: string) =>
    args[2] === 'get' && args[3] === object && args.join(' ').includes('Ready');

  /** Every wait handles its request, and each object's Ready reads as given. */
  const flux = (ready: Record<string, string>) => (args: string[]) => {
    for (const [object, answer] of Object.entries(ready)) {
      if (isReadyRead(args, object)) return answer;
    }
    return '';
  };

  it('asks the source to reconcile, then the base, each waited on until it handled that request', async () => {
    k.answer = flux({ [GIT]: 'True\nstored artifact', [BASE]: 'True\nApplied revision' });
    await reconcile();
    // The base only after the source handled its request: the base then
    // applies the artifact just fetched.
    expect(steps()).toEqual([
      `annotate ${GIT}`,
      `wait ${GIT}`,
      `get ${GIT}`,
      `annotate ${BASE}`,
      `wait ${BASE}`,
      `get ${BASE}`,
    ]);
    expect(k.calls.every((c) => c.env === env)).toBe(true);
  });

  it('each wait is for the very request annotated, fresh per object', async () => {
    k.answer = flux({ [GIT]: 'True\nok', [BASE]: 'True\nok' });
    await reconcile();
    const asked = requested();
    expect(asked[GIT]).toMatch(/^2026-11-26T10:00:00\.000Z-\w+$/);
    expect(asked[BASE]).toMatch(/^2026-11-26T10:00:00\.000Z-\w+$/);
    expect(asked[GIT]).not.toBe(asked[BASE]);
    const waits = k.calls.filter((c) => c.args[2] === 'wait').map((c) => c.args);
    expect(waits).toEqual([
      [
        '-n',
        'flux-system',
        'wait',
        `--for=jsonpath={.status.lastHandledReconcileAt}=${asked[GIT]}`,
        GIT,
        '--timeout=180s',
      ],
      [
        '-n',
        'flux-system',
        'wait',
        `--for=jsonpath={.status.lastHandledReconcileAt}=${asked[BASE]}`,
        BASE,
        '--timeout=600s',
      ],
    ]);
    // A fresh request every call, so a rerun never matches the last one's.
    k.calls.length = 0;
    await reconcile();
    expect(requested()[GIT]).not.toBe(asked[GIT]);
  });

  it('each object waits its own budget: the fetch 3 minutes, the apply the 10 its own timeout allows', async () => {
    // A slow fetch takes nothing from the apply's budget, which matches the
    // Kustomization's `timeout: 10m` in the cluster file.
    let clock = at.getTime();
    k.answer = (args) => {
      if (args[2] === 'wait' && args[4] === GIT) clock += 170_000;
      return flux({ [GIT]: 'True\nok', [BASE]: 'True\nok' })(args);
    };
    await reconcile({ now: () => new Date(clock) });
    const timeouts = k.calls.filter((c) => c.args[2] === 'wait').map((c) => c.args.at(-1));
    expect(timeouts).toEqual(['--timeout=180s', '--timeout=600s']);
    expect(readFileSync(join(REPO_ROOT, 'carbon', FLUX_CLUSTER_FILE), 'utf-8')).toMatch(
      /kind: Kustomization[\s\S]*\n {2}timeout: 10m\n/,
    );
  });

  it('a rerun whose source can no longer fetch fails with what the GitRepository says, though it was Ready', async () => {
    // A rotated key or a changed URL: Flux keeps the old artifact, so a
    // plain wait for Ready would pass at once. The request it handled says
    // otherwise.
    k.answer = (args) => {
      if (args.includes('--for=condition=Ready')) return '';
      return flux({
        [GIT]:
          'False\nfailed to checkout and determine revision: unable to clone: authentication required',
      })(args);
    };
    const err = await reconcile().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('flux tried to sync prod and could not. here is what it says:');
    expect(err?.message).toContain(
      'GitRepository: failed to checkout and determine revision: unable to clone: authentication required',
    );
    expect(err?.message).toContain(HINT);
    // It stops there: the base is never asked to apply a stale artifact.
    expect(steps()).toEqual([`annotate ${GIT}`, `wait ${GIT}`, `get ${GIT}`]);
  });

  it('a base the cluster rejects fails with what the Kustomization says', async () => {
    k.answer = flux({
      [GIT]: 'True\nstored artifact',
      [BASE]: 'False\nStatefulSet/vibecarbon/db dry-run failed: field is immutable',
    });
    const err = await reconcile().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(
      'Kustomization: StatefulSet/vibecarbon/db dry-run failed: field is immutable',
    );
    expect(err?.message).toContain(HINT);
  });

  it('a request never handled in time fails with what Flux said', async () => {
    k.answer = (args) => {
      if (args[2] === 'wait') {
        throw kubectlFailed(
          args,
          'error: timed out waiting for the condition on gitrepositories/vibecarbon',
        );
      }
      if (args[2] === 'get' && args.includes(BASE)) {
        return 'GitRepository: authentication required\nKustomization: \n';
      }
      return '';
    };
    const err = await reconcile().then(
      () => null,
      (e: Error) => e,
    );
    // True of any run, a rerun's too: no "first" sync.
    expect(err?.message).toContain(
      'flux did not finish syncing prod: its GitRepository did not fetch within 3 minutes. here is what it says:',
    );
    expect(err?.message).not.toMatch(/first/);
    expect(err?.message).toContain('GitRepository: authentication required');
    // A Kind with no message says nothing.
    expect(err?.message).not.toMatch(/Kustomization:/);
    expect(err?.message).toContain(HINT);
    // What it read: both objects' Ready messages, after the wait gave up.
    const get = k.calls.at(-1);
    expect(get?.args.slice(0, 5)).toEqual(['-n', 'flux-system', 'get', GIT, BASE]);
    expect(get?.args.join(' ')).toMatch(/-o jsonpath=.*Ready/);
    expect(get?.env).toBe(env);
  });

  it('an apply not handled in time says the Kustomization did not apply within 10 minutes', async () => {
    k.answer = (args) => {
      if (args[2] === 'wait' && args[4] === BASE) {
        throw kubectlFailed(args, 'error: timed out waiting for the condition');
      }
      if (args[2] === 'get' && args.includes(BASE) && args.includes(GIT)) {
        return 'GitRepository: stored artifact\nKustomization: health check failed\n';
      }
      return flux({ [GIT]: 'True\nstored artifact' })(args);
    };
    const err = await reconcile().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(
      'flux did not finish syncing prod: its Kustomization did not apply within 10 minutes. here is what it says:',
    );
    expect(err?.message).toContain('Kustomization: health check failed');
  });

  it("with no Ready message on either, the wait's own error is what it says", async () => {
    k.answer = (args) => {
      if (args[2] === 'wait') {
        throw kubectlFailed(
          args,
          'error: timed out waiting for the condition on gitrepositories/vibecarbon',
        );
      }
      if (args[2] === 'get') return 'GitRepository: \nKustomization: \n';
      return '';
    };
    const err = await reconcile().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(
      'error: timed out waiting for the condition on gitrepositories/vibecarbon',
    );
  });

  it('the hint quotes a kubeconfig path the shell would split', async () => {
    k.answer = (args) => {
      if (args[2] === 'wait') throw kubectlFailed(args, 'error: timed out');
      return '';
    };
    const err = await reconcile({ kubeconfigPath: "/my projects/o'brien/kubeconfig-prod" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(
      `KUBECONFIG='/my projects/o'\\''brien/kubeconfig-prod' kubectl -n flux-system get`,
    );
  });
});
