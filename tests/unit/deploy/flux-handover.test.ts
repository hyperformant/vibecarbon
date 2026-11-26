/**
 * handOverCluster runs the Flux steps in order, each against the
 * environment's own kubeconfig. The steps themselves are flux-bootstrap.js's,
 * flux-deploy-key.js's and ghcr-pull-secret.js's, pinned in their own tests;
 * here they are fakes, except the app image check (assertAppImageBuilt),
 * which runs for real against a fake ghcr.io.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const steps = vi.hoisted(() => [] as Array<{ step: string; o: Record<string, unknown> }>);
/** ghcr's answer to the HEAD of the app image's :main manifest. */
const ghcr = vi.hoisted(() => ({ manifest: 200 }));

vi.mock('../../../src/lib/deploy/k8s/flux-bootstrap.js', () => ({
  installFluxIfAbsent: vi.fn(async (o: Record<string, unknown>) => {
    steps.push({ step: 'install', o });
    return 'installed';
  }),
  applyFluxRoot: vi.fn(async (o: Record<string, unknown>) => {
    steps.push({ step: 'root', o });
  }),
  awaitFluxReconcile: vi.fn(async (o: Record<string, unknown>) => {
    steps.push({ step: 'sync', o });
  }),
}));

vi.mock('../../../src/lib/deploy/k8s/flux-deploy-key.js', () => ({
  rotateFluxDeployKey: vi.fn(async (o: Record<string, unknown>) => {
    steps.push({ step: 'deploy key', o });
    return { keyId: 42, removed: [] };
  }),
}));

vi.mock('../../../src/lib/deploy/k8s/ghcr-pull-secret.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  ensureGhcrPullSecretOn: vi.fn(async (o: Record<string, unknown>) => {
    steps.push({ step: 'pull secret', o });
    return 'public';
  }),
}));

// ghcr.io: an anonymous pull token, then the manifest's answer.
vi.mock('../../../src/lib/fetch-retry.js', () => ({
  fetchWithRetry: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (url.startsWith('https://ghcr.io/token?')) {
      return new Response(JSON.stringify({ token: 'anon-bearer' }), { status: 200 });
    }
    if (url === 'https://ghcr.io/v2/acme/shop/manifests/main' && init.method === 'HEAD') {
      steps.push({ step: 'image check', o: { url } });
      return new Response(null, { status: ghcr.manifest });
    }
    throw new Error(`unexpected fetch ${url}`);
  }),
}));

const { handOverCluster } = await import('../../../src/lib/deploy/k8s/flux-handover.js');

const kubeconfigPath = '/project/.vibecarbon/kubeconfig-prod-standby';
const ghcrPull = { mode: 'public' as const };
const handOver = () =>
  handOverCluster({
    projectDir: '/project',
    envName: 'prod-standby',
    kubeconfigPath,
    owner: 'acme',
    repo: 'shop',
    ghcrPull,
  });

beforeEach(() => {
  steps.length = 0;
  ghcr.manifest = 200;
});

describe('handOverCluster', () => {
  it('hands over in order: install, deploy key, pull secret, image check, root, sync', async () => {
    await handOver();
    // The key after the install, which makes the flux-system namespace its
    // Secret goes in; the key and the pull Secret before the root, so the
    // first fetch already has the key and the first app pull the Secret.
    // The image Flux rolls to is checked after the Secret and before the
    // root, so the app is never rolled to an image that is not built.
    expect(steps.map((s) => s.step)).toEqual([
      'install',
      'deploy key',
      'pull secret',
      'image check',
      'root',
      'sync',
    ]);
    for (const { step, o } of steps.filter((s) => s.step !== 'image check')) {
      expect((o.env as NodeJS.ProcessEnv).KUBECONFIG, step).toBe(kubeconfigPath);
    }
    // The key is this cluster's own, named for it, on the project's repo.
    expect(steps[1].o).toMatchObject({ owner: 'acme', repo: 'shop', envName: 'prod-standby' });
    // The pull credential configure cicd resolved once, public included:
    // that call writes nothing (ghcr-pull-secret.test.ts).
    expect(steps[2].o.pull).toBe(ghcrPull);
    expect(steps[4].o.projectDir).toBe('/project');
    // The sync names the cluster and its kubeconfig in what it prints.
    expect(steps[5].o).toMatchObject({ envName: 'prod-standby', kubeconfigPath });
  });

  it('an app image not built yet refuses after the pull Secret, before the root and the sync', async () => {
    ghcr.manifest = 404;
    const err = await handOver().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe(
      'your app image ghcr.io/acme/shop:main is not built yet, so flux would roll the app to an ' +
        'image that does not exist. commit and push .github/workflows to main, wait for its first ' +
        'build in the actions tab, then run vibecarbon configure cicd prod',
    );
    // The Secret is in place, so the rerun finds the token and asks nothing;
    // the root never went on, so Flux never rolls the app to a missing image.
    expect(steps.map((s) => s.step)).toEqual([
      'install',
      'deploy key',
      'pull secret',
      'image check',
    ]);
  });

  it('ghcr down says to try again, and nothing past the check runs', async () => {
    ghcr.manifest = 503;
    await expect(handOver()).rejects.toThrow(/try again in a minute/);
    expect(steps.map((s) => s.step)).not.toContain('root');
  });
});
