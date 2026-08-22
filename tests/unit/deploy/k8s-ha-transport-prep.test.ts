/**
 * Early replication transport prep (k8s-ha deploy overlap).
 *
 * The gateway manifest can only be applied once the vibecarbon namespace
 * exists on a cluster, but transport prep starts as soon as both clusters'
 * infra is up — minutes before applyBase creates the namespace. The bounded
 * namespace wait bridges that gap without mutating cluster state out of
 * order (prep must NOT create the namespace itself — applyBase owns it).
 */
import { describe, expect, it, vi } from 'vitest';
import { waitForNamespace } from '../../../src/lib/deploy/k8s/ha/index.js';

const noSleep = () => Promise.resolve();

describe('waitForNamespace', () => {
  it('returns true once kubectl reports the namespace', async () => {
    const answers: Array<string | false> = [false, '', 'namespace/vibecarbon'];
    const runKubectl = vi.fn(async () => answers.shift() ?? 'namespace/vibecarbon');
    const ok = await waitForNamespace(runKubectl, {
      attempts: 10,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runKubectl).toHaveBeenCalledTimes(3);
    expect(runKubectl).toHaveBeenCalledWith('kubectl get namespace vibecarbon -o name');
  });

  it('returns false (never throws) when the budget lapses', async () => {
    const runKubectl = vi.fn(async () => false as const);
    const ok = await waitForNamespace(runKubectl, {
      attempts: 4,
      sleep: noSleep,
    });
    expect(ok).toBe(false);
    expect(runKubectl).toHaveBeenCalledTimes(4);
  });

  it('keeps polling through thrown errors (SSH blips mid-provision)', async () => {
    let calls = 0;
    const runKubectl = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('ssh: connect refused');
      return 'namespace/vibecarbon';
    });
    const ok = await waitForNamespace(runKubectl, {
      attempts: 10,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
  });

  it('honors a custom namespace', async () => {
    const runKubectl = vi.fn(async () => 'namespace/custom-ns');
    const ok = await waitForNamespace(runKubectl, {
      namespace: 'custom-ns',
      attempts: 2,
      sleep: noSleep,
    });
    expect(ok).toBe(true);
    expect(runKubectl).toHaveBeenCalledWith('kubectl get namespace custom-ns -o name');
  });
});
