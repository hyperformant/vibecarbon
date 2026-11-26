/**
 * The CLI hands a cluster to Flux itself (flux-bootstrap.js), from the
 * operator's machine, which the operator-IP firewall lets in: nothing at
 * GitHub connects to the cluster. These pin the kubectl each step runs, as
 * the deploy workflow ran it before: Flux installed once and server-side,
 * the one cluster file applied, then a nudge and a bounded wait for the
 * first sync, whose failure says what Flux said.
 */
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { FLUX_INSTALL_URL, FLUX_VERSION, applyFluxRoot, awaitFluxReconcile, installFluxIfAbsent } =
  await import('../../../src/lib/deploy/k8s/flux-bootstrap.js');
const { FLUX_CLUSTER_FILE } = await import(
  '../../../src/lib/deploy/k8s/unrendered-placeholders.js'
);

const env = { KUBECONFIG: '/project/.vibecarbon/kubeconfig-prod' } as NodeJS.ProcessEnv;
const PROBE = ['-n', 'flux-system', 'get', 'deployment', 'source-controller', '-o', 'name'];
const SERVER_SIDE = [
  'apply',
  '--server-side',
  '--force-conflicts',
  '--field-manager=vibecarbon-cli',
];

/** What runKubectlWithRetry throws for a kubectl that exited 1 with this stderr. */
const kubectlFailed = (args: string[], stderr: string) =>
  Object.assign(new Error(`kubectl ${args.slice(0, 4).join(' ')} failed with exit 1: ${stderr}`), {
    status: 1,
    stderr,
  });

const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
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

  it('installs Flux only when source-controller is missing, server-side, then waits for the four controllers', async () => {
    k.answer = (args) => {
      if (same(args, PROBE)) {
        throw kubectlFailed(
          args,
          'Error from server (NotFound): deployments.apps "source-controller" not found',
        );
      }
      return '';
    };
    await expect(installFluxIfAbsent({ env })).resolves.toBe('installed');
    expect(argsOf()).toEqual([
      PROBE,
      [...SERVER_SIDE, '-f', FLUX_INSTALL_URL],
      [
        '-n',
        'flux-system',
        'wait',
        '--for=condition=available',
        'deployment/source-controller',
        'deployment/kustomize-controller',
        'deployment/helm-controller',
        'deployment/notification-controller',
        '--timeout=300s',
      ],
    ]);
    expect(k.calls.every((c) => c.env === env)).toBe(true);

    k.calls.length = 0;
    k.answer = () => 'deployment.apps/source-controller\n';
    await expect(installFluxIfAbsent({ env })).resolves.toBe('present');
    expect(argsOf()).toEqual([PROBE]);
  });

  it('any other probe failure is not read as missing', async () => {
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

describe('awaitFluxReconcile', () => {
  const at = new Date('2026-11-26T10:00:00.000Z');
  const now = () => at;
  const WAIT = [
    '-n',
    'flux-system',
    'wait',
    '--for=condition=Ready',
    'kustomization/vibecarbon-base',
    '--timeout=600s',
  ];

  it('nudges the source and the base, then waits for Ready', async () => {
    await awaitFluxReconcile({ env, envName: 'prod', now });
    const requested = 'reconcile.fluxcd.io/requestedAt=2026-11-26T10:00:00.000Z';
    expect(argsOf()).toEqual([
      ['-n', 'flux-system', 'annotate', '--overwrite', 'gitrepository/vibecarbon', requested],
      ['-n', 'flux-system', 'annotate', '--overwrite', 'kustomization/vibecarbon-base', requested],
      WAIT,
    ]);
    expect(k.calls.every((c) => c.env === env)).toBe(true);
  });

  it('a first sync that never gets Ready fails with what Flux said', async () => {
    k.answer = (args) => {
      if (same(args, WAIT)) {
        throw kubectlFailed(
          args,
          'error: timed out waiting for the condition on kustomizations/vibecarbon-base',
        );
      }
      if (args.includes('get')) return 'GitRepository: authentication required\n';
      return '';
    };
    const err = await awaitFluxReconcile({ env, envName: 'prod', now }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain(
      'flux did not finish its first sync of prod within 10 minutes. here is what it says:',
    );
    expect(err?.message).toContain('authentication required');
    expect(err?.message).toContain(
      'look closer with kubectl -n flux-system get gitrepository,kustomization',
    );
    // What it read: both objects' Ready messages, after the wait gave up.
    const get = k.calls.at(-1);
    expect(get?.args.slice(0, 5)).toEqual([
      '-n',
      'flux-system',
      'get',
      'gitrepository/vibecarbon',
      'kustomization/vibecarbon-base',
    ]);
    expect(get?.args.join(' ')).toMatch(/-o jsonpath=.*Ready/);
    expect(get?.env).toBe(env);
  });
});
