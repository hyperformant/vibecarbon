/**
 * handOverCluster runs the three Flux steps in order, each against the
 * environment's own kubeconfig. The steps themselves are flux-bootstrap.js's,
 * pinned in flux-bootstrap.test.ts; here they are fakes.
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

const { handOverCluster } = await import('../../../src/lib/deploy/k8s/flux-handover.js');

describe('handOverCluster', () => {
  it('hands over in order: install, root, sync', async () => {
    const kubeconfigPath = '/project/.vibecarbon/kubeconfig-prod-standby';
    await handOverCluster({ projectDir: '/project', envName: 'prod-standby', kubeconfigPath });
    expect(steps.map((s) => s.step)).toEqual(['install', 'root', 'sync']);
    for (const { step, o } of steps) {
      expect((o.env as NodeJS.ProcessEnv).KUBECONFIG, step).toBe(kubeconfigPath);
    }
    expect(steps[1].o.projectDir).toBe('/project');
    expect(steps[2].o.envName).toBe('prod-standby');
  });
});
