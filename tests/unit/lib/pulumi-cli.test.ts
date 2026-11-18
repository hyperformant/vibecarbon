/**
 * tests/_shared/pulumi-cli.ts: pulumiOnPath, the probe the real-engine iac
 * tests gate on. `pulumi version` answering means true, anything thrown
 * means false, and the answer is asked once per process.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ fails: false, calls: [] as unknown[][] }));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => {
    probe.calls.push(args);
    if (probe.fails) throw new Error('spawnSync pulumi ENOENT');
    return Buffer.from('v3.0.0\n');
  },
}));

const load = async () => (await import('../../_shared/pulumi-cli.js')).pulumiOnPath;

describe('pulumiOnPath', () => {
  beforeEach(() => {
    vi.resetModules();
    probe.fails = false;
    probe.calls = [];
  });

  it('is true when `pulumi version` answers, asked with stdio ignored', async () => {
    const pulumiOnPath = await load();
    expect(pulumiOnPath()).toBe(true);
    expect(probe.calls).toEqual([['pulumi', ['version'], { stdio: 'ignore' }]]);
  });

  it('is false when the probe throws', async () => {
    probe.fails = true;
    const pulumiOnPath = await load();
    expect(pulumiOnPath()).toBe(false);
  });

  it('asks once, and every later call gets the same answer', async () => {
    probe.fails = true;
    const pulumiOnPath = await load();
    expect([pulumiOnPath(), pulumiOnPath(), pulumiOnPath()]).toEqual([false, false, false]);
    expect(probe.calls).toHaveLength(1);
  });
});
