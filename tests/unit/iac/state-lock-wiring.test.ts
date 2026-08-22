import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proves the LOCK IS WIRED IN, not merely that the lock works.
 *
 * state-lock.test.ts exercises the mechanism in isolation; that would still
 * pass if nothing called it. This drives the real `upStack` entry point the way
 * the HA runners do — two stacks, one state bucket, both started in the same
 * tick under Promise.all — and asserts the two Pulumi updates never overlap.
 *
 * That fan-out is the shape behind 16 of the 38 throttle events in run
 * 31898658781: `stack-select ci4-primary` 8 and `stack-select ci4-standby` 8,
 * the k8s-ha pair hitting one bucket together.
 */

const selectStackMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called: it would clobber real state');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

/** Same bucket for both stacks — the HA arrangement. */
const s3Config = {
  bucket: 'proj-storage',
  stateBucket: 'proj-storage-pulumi-state-a1b2c3',
  endpoint: 'https://nbg1.your-objectstorage.com',
  region: 'nbg1',
};

/** A stack whose `up` takes a turn we can observe. */
const makeStack = (name: string, log: string[], gate: Promise<void>) => ({
  name,
  cancel: async () => {},
  refresh: async () => ({}),
  exportStack: async () => ({ deployment: { resources: [] } }),
  outputs: async () => ({ serverIp: { value: '1.2.3.4' } }),
  workspace: { removeStack: async () => {} },
  up: async () => {
    log.push(`${name}:start`);
    await gate;
    log.push(`${name}:end`);
    return { outputs: { serverIp: { value: '1.2.3.4' } }, summary: { result: 'succeeded' } };
  },
});

beforeEach(() => {
  vi.resetModules();
  selectStackMock.mockReset();
});

describe('state lock — wiring', () => {
  it('never runs two ups against one state bucket at the same time', async () => {
    const { upStack } = await import('../../../src/lib/iac/index.js');
    const { resetStateLocksForTest } = await import('../../../src/lib/iac/state-lock.js');
    resetStateLocksForTest();

    const log: string[] = [];
    let openPrimary!: () => void;
    const primaryGate = new Promise<void>((r) => {
      openPrimary = r;
    });

    selectStackMock.mockImplementation((args: { stackName: string }) =>
      Promise.resolve(
        args.stackName === 'e2-primary'
          ? makeStack('e2-primary', log, primaryGate)
          : makeStack('e2-standby', log, Promise.resolve()),
      ),
    );

    const fan = Promise.all([
      upStack('e2-primary', () => ({}), { s3Config, projectName: 'testproj' }),
      upStack('e2-standby', () => ({}), { s3Config, projectName: 'testproj' }),
    ]);

    // Let every microtask that can run, run. Without the lock the standby's up
    // would have started by now — that is precisely the concurrency we are
    // removing.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(log).toEqual(['e2-primary:start']);

    openPrimary();
    await fan;

    // Strict interleaving check: primary fully finishes before standby begins.
    expect(log).toEqual([
      'e2-primary:start',
      'e2-primary:end',
      'e2-standby:start',
      'e2-standby:end',
    ]);
  });

  it('does not serialize stacks in different state buckets', async () => {
    // Two unrelated environments must not queue behind each other; the lock is
    // keyed on the backend URL for exactly this reason.
    const { upStack } = await import('../../../src/lib/iac/index.js');
    const { resetStateLocksForTest } = await import('../../../src/lib/iac/state-lock.js');
    resetStateLocksForTest();

    const log: string[] = [];
    let openFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      openFirst = r;
    });

    selectStackMock.mockImplementation((args: { stackName: string }) =>
      Promise.resolve(
        args.stackName === 'alpha'
          ? makeStack('alpha', log, firstGate)
          : makeStack('beta', log, Promise.resolve()),
      ),
    );

    const alpha = upStack('alpha', () => ({}), { s3Config, projectName: 'testproj' });
    const beta = upStack('beta', () => ({}), {
      s3Config: { ...s3Config, stateBucket: 'other-project-pulumi-state-9z8y7x' },
      projectName: 'otherproj',
    });

    await beta;
    expect(log).toContain('beta:end');

    openFirst();
    await alpha;
  });
});
