import { describe, expect, it, vi } from 'vitest';
import { dispatchDiagnose } from '../../../src/diagnose.js';

// `vibecarbon diagnose` historically only knew how to inspect k8s clusters
// (kubectl against .vibecarbon/kubeconfig-<env>). Run against a compose /
// compose-ha env it produced a wall of kubectl errors. The dispatcher must
// route by the env's deploy mode: compose tiers go to the SSH-based compose
// collector, k8s tiers to the kubectl collector. Collectors are injected so
// this test asserts the routing WITHOUT any real SSH or kubectl.
describe('diagnose dispatch by deploy mode', () => {
  function stubDeps() {
    return {
      collectCompose: vi.fn().mockResolvedValue(undefined),
      collectK8s: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('routes a single-server compose env to the compose collector, not kubectl', async () => {
    const deps = stubDeps();
    const branch = await dispatchDiagnose({ envConfig: { deployMode: 'compose' } }, deps);
    expect(branch).toBe('compose');
    expect(deps.collectCompose).toHaveBeenCalledOnce();
    expect(deps.collectK8s).not.toHaveBeenCalled();
  });

  it('routes a compose-ha env to the compose collector', async () => {
    const deps = stubDeps();
    const branch = await dispatchDiagnose(
      { envConfig: { deployMode: 'compose-ha', ha: { enabled: true } } },
      deps,
    );
    expect(branch).toBe('compose');
    expect(deps.collectCompose).toHaveBeenCalledOnce();
    expect(deps.collectK8s).not.toHaveBeenCalled();
  });

  it('routes a kubernetes env to the k8s collector, not compose', async () => {
    const deps = stubDeps();
    const branch = await dispatchDiagnose({ envConfig: { deployMode: 'kubernetes' } }, deps);
    expect(branch).toBe('k8s');
    expect(deps.collectK8s).toHaveBeenCalledOnce();
    expect(deps.collectCompose).not.toHaveBeenCalled();
  });

  it('falls back to the k8s collector for a legacy env with no deployMode (preserves historical behavior)', async () => {
    const deps = stubDeps();
    const branch = await dispatchDiagnose({ envConfig: {} }, deps);
    expect(branch).toBe('k8s');
    expect(deps.collectK8s).toHaveBeenCalledOnce();
    expect(deps.collectCompose).not.toHaveBeenCalled();
  });
});
