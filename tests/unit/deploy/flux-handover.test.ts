/**
 * handOverCluster runs the five Flux steps in order, each against the
 * environment's own kubeconfig. The steps themselves are flux-bootstrap.js's,
 * flux-deploy-key.js's and ghcr-pull-secret.js's, pinned in their own tests;
 * here they are fakes.
 */
import { describe, expect, it, vi } from 'vitest';

const steps = vi.hoisted(() => [] as Array<{ step: string; o: Record<string, unknown> }>);

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

vi.mock('../../../src/lib/deploy/k8s/ghcr-pull-secret.js', () => ({
  ensureGhcrPullSecretOn: vi.fn(async (o: Record<string, unknown>) => {
    steps.push({ step: 'pull secret', o });
    return 'public';
  }),
}));

const { handOverCluster } = await import('../../../src/lib/deploy/k8s/flux-handover.js');

describe('handOverCluster', () => {
  it('hands over in order: install, deploy key, pull secret, root, sync', async () => {
    const kubeconfigPath = '/project/.vibecarbon/kubeconfig-prod-standby';
    const ghcrPull = { mode: 'public' };
    await handOverCluster({
      projectDir: '/project',
      envName: 'prod-standby',
      kubeconfigPath,
      owner: 'acme',
      repo: 'shop',
      ghcrPull,
    });
    // The key after the install, which makes the flux-system namespace its
    // Secret goes in; the key and the pull Secret before the root, so the
    // first fetch already has the key and the first app pull the Secret.
    expect(steps.map((s) => s.step)).toEqual([
      'install',
      'deploy key',
      'pull secret',
      'root',
      'sync',
    ]);
    for (const { step, o } of steps) {
      expect((o.env as NodeJS.ProcessEnv).KUBECONFIG, step).toBe(kubeconfigPath);
    }
    // The key is this cluster's own, named for it, on the project's repo.
    expect(steps[1].o).toMatchObject({ owner: 'acme', repo: 'shop', envName: 'prod-standby' });
    // The pull credential configure cicd resolved once, public included:
    // that call writes nothing (ghcr-pull-secret.test.ts).
    expect(steps[2].o.pull).toBe(ghcrPull);
    expect(steps[3].o.projectDir).toBe('/project');
    // The sync names the cluster and its kubeconfig in what it prints.
    expect(steps[4].o).toMatchObject({ envName: 'prod-standby', kubeconfigPath });
  });
});
