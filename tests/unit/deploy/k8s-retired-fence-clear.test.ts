/**
 * The k8s-ha deploy takes the retirement fence off the cluster it just rebuilt
 * as the standby (HA-correctness Task 6), through finishK8sRetiredFence, which
 * executeDeployment runs before its final save (the entry-point census pins the
 * position). A clear that cannot be proven throws, so the save that would stamp
 * deployedAt never runs and the env stays swapped for the rerun; with no retired
 * side at entry nothing is cleared at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { finishK8sRetiredFence } from '../../../src/lib/deploy/orchestrator.js';

const base = { projectName: 'myapp', environment: 'prod', standbyIp: '10.0.0.1' };

describe('finishK8sRetiredFence', () => {
  it('clears the rebuilt standby when the env was swapped at entry', async () => {
    const clear = vi.fn(async () => {});
    const ran = await finishK8sRetiredFence({
      ...base,
      retiredAtEntry: [{ ip: '10.0.0.1' }],
      clear,
    });
    expect(ran).toBe(true);
    expect(clear).toHaveBeenCalledWith({
      tier: 'k8s-ha',
      ip: '10.0.0.1',
      projectName: 'myapp',
      environment: 'prod',
    });
  });

  it('a failed clear throws, so the deploy fails before its save', async () => {
    const clear = vi.fn(async () => {
      throw new Error('could not clear the retired marker on the rebuilt standby 10.0.0.1');
    });
    await expect(
      finishK8sRetiredFence({ ...base, retiredAtEntry: [{ ip: '10.0.0.1' }], clear }),
    ).rejects.toThrow(/could not clear the retired marker/);
  });

  it('no retired side at entry: no clear', async () => {
    const clear = vi.fn(async () => {});
    expect(await finishK8sRetiredFence({ ...base, retiredAtEntry: [], clear })).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });
});
