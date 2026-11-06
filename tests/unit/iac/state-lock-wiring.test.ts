import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proves the LOCK IS WIRED IN, not merely that the lock works.
 *
 * state-lock.test.ts exercises the mechanism in isolation; that would still
 * pass if nothing called it. This drives the real `syncServerState`, the one
 * operation that holds the lock: an export, an edit and an import of one
 * state, which must not interleave with another on the same bucket.
 */

const selectStackMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called: the sync never conjures a stack');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

vi.mock('../../../src/lib/cli/progress.js', () => ({ progressLog: vi.fn() }));

const s3Config = {
  bucket: 'proj-storage',
  stateBucket: 'proj-storage-pulumi-state-a1b2c3',
  endpoint: 'https://nbg1.your-objectstorage.com',
  region: 'nbg1',
  accessKey: 'k',
  secretKey: 's',
};

const TARGET = { serverId: 'new-id', serverType: 'big', ip: '1.2.3.4' };

/** A vultr compose stack whose import takes a turn the test can hold open. */
const stateFor = () => ({
  deployment: {
    resources: [
      { type: 'pulumi:pulumi:Stack', outputs: {} },
      {
        type: 'vultr:index/instance:Instance',
        urn: 'urn:pulumi:prod::p::vultr:index/instance:Instance::server',
        id: 'old-id',
        inputs: { plan: 'small' },
        outputs: { plan: 'small', mainIp: '9.9.9.9' },
      },
    ],
  },
});

function stackThat(name: string, log: string[], gate: Promise<void>) {
  return {
    name,
    exportStack: async () => {
      log.push(`${name}:export`);
      return stateFor();
    },
    importStack: async () => {
      await gate;
      log.push(`${name}:import`);
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  selectStackMock.mockReset();
});

const options = (stateBucket = s3Config.stateBucket) => ({
  provider: 'vultr',
  providerToken: 'tok',
  projectName: 'testproj',
  s3Config: { ...s3Config, stateBucket },
});

describe('state lock — wiring', () => {
  it('two server-state syncs on one bucket never interleave', async () => {
    const { syncServerState } = await import('../../../src/lib/iac/server-state.js');
    const log: string[] = [];
    let openFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      openFirst = r;
    });
    selectStackMock.mockImplementation(async (args: { stackName: string }) =>
      args.stackName === 'one'
        ? stackThat('one', log, firstGate)
        : stackThat('two', log, Promise.resolve()),
    );

    const fan = Promise.all([
      syncServerState('one', TARGET, options()),
      syncServerState('two', TARGET, options()),
    ]);
    // The first sync lazily imports the Pulumi automation layer, which takes
    // longer than waitFor's default 1 s on a loaded machine.
    await vi.waitFor(() => expect(log).toContain('one:export'), { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(['one:export']);

    openFirst();
    await fan;
    expect(log).toEqual(['one:export', 'one:import', 'two:export', 'two:import']);
  });

  it('does not serialize stacks in different state buckets', async () => {
    // Two unrelated environments must not queue behind each other; the lock is
    // keyed on the backend URL for exactly this reason.
    const { syncServerState } = await import('../../../src/lib/iac/server-state.js');
    const log: string[] = [];
    let openFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      openFirst = r;
    });
    selectStackMock.mockImplementation(async (args: { stackName: string }) =>
      args.stackName === 'one'
        ? stackThat('one', log, firstGate)
        : stackThat('two', log, Promise.resolve()),
    );

    const first = syncServerState('one', TARGET, options());
    await syncServerState('two', TARGET, options('other-project-pulumi-state-9z8y7x'));
    expect(log).toContain('two:import');

    openFirst();
    await first;
  });
});
