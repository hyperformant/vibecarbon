import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The telemetry exists so a failure log can answer "were we over the store's
 * budget?" without a human grepping 12k lines of CI output — which is how the
 * run 31898658781 analysis had to be done, and why this class was misread as a
 * consistency problem for months.
 *
 * The wiring tests drive the REAL upStack path: a mechanism-only test would
 * still pass with nothing recording, which is the vacuous-guard failure mode.
 */

const selectStackMock = vi.fn();
const progressLogMock = vi.fn();

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (...args: unknown[]) => progressLogMock(...args),
}));

const s3Config = {
  bucket: 'proj-storage',
  stateBucket: 'proj-storage-pulumi-state-a1b2c3',
  endpoint: 'https://nbg1.your-objectstorage.com',
  region: 'nbg1',
};

const healthyStack = (name: string) => ({
  name,
  cancel: async () => {},
  refresh: async () => ({}),
  exportStack: async () => ({ deployment: { resources: [] } }),
  outputs: async () => ({ serverIp: { value: '1.2.3.4' } }),
  workspace: { removeStack: async () => {} },
  up: async () => ({
    outputs: { serverIp: { value: '1.2.3.4' } },
    summary: { result: 'succeeded' },
  }),
});

const stateLines = () =>
  progressLogMock.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[state]'));

beforeEach(() => {
  vi.resetModules();
  selectStackMock.mockReset();
  progressLogMock.mockReset();
});

afterEach(async () => {
  const { resetStateTelemetryForTest } = await import('../../../src/lib/iac/state-telemetry.js');
  resetStateTelemetryForTest();
});

describe('state telemetry — wiring through upStack', () => {
  it('an up emits one [state] summary naming ops and the provider ceilings', async () => {
    const { upStack } = await import('../../../src/lib/iac/index.js');
    const { resetStateTelemetryForTest } = await import('../../../src/lib/iac/state-telemetry.js');
    resetStateTelemetryForTest();
    selectStackMock.mockImplementation((a: { stackName: string }) =>
      Promise.resolve(healthyStack(a.stackName)),
    );

    await upStack('e1', () => ({}), { s3Config, provider: 'hetzner', projectName: 'testproj' });

    const lines = stateLines();
    expect(lines).toHaveLength(1);
    // Both operation kinds counted: the wrapper's own `up` and the nested
    // stack-select it performs through the re-entrant lock.
    expect(lines[0]).toMatch(/ops .*up=1/);
    expect(lines[0]).toMatch(/stack-select=1/);
    // Hetzner's documented ceilings are printed next to the counts — the
    // budget-vs-consistency comparison in one greppable line.
    expect(lines[0]).toContain('750 rps/bucket');
    expect(lines[0]).toContain('256 conn/ip');
  });

  it('a throttled retry shows up as backpressure, by cause', async () => {
    const { upStack } = await import('../../../src/lib/iac/index.js');
    const { resetStateTelemetryForTest } = await import('../../../src/lib/iac/state-telemetry.js');
    resetStateTelemetryForTest();

    let attempts = 0;
    const stack = {
      ...healthyStack('e1'),
      up: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('error: 503 SlowDown: Please reduce your request rate');
        }
        return { outputs: { serverIp: { value: '1.2.3.4' } }, summary: { result: 'succeeded' } };
      },
    };
    selectStackMock.mockResolvedValue(stack);

    vi.useFakeTimers();
    try {
      const pending = upStack('e1', () => ({}), {
        s3Config,
        provider: 'hetzner',
        projectName: 'testproj',
      });
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(stateLines()[0]).toMatch(/backpressure .*throttle=1/);
  });

  it('the summary is emitted on FAILURE too — that log is where it matters', async () => {
    const { upStack } = await import('../../../src/lib/iac/index.js');
    const { resetStateTelemetryForTest } = await import('../../../src/lib/iac/state-telemetry.js');
    resetStateTelemetryForTest();
    const stack = {
      ...healthyStack('e1'),
      up: async () => {
        throw new Error('error: hcloud/server: resource_unavailable');
      },
    };
    selectStackMock.mockResolvedValue(stack);

    await expect(
      upStack('e1', () => ({}), { s3Config, provider: 'hetzner', projectName: 'testproj' }),
    ).rejects.toThrow('resource_unavailable');
    expect(stateLines()).toHaveLength(1);
  });

  it('an unknown provider degrades to counts without ceilings, never throws', async () => {
    const { upStack } = await import('../../../src/lib/iac/index.js');
    const { resetStateTelemetryForTest } = await import('../../../src/lib/iac/state-telemetry.js');
    resetStateTelemetryForTest();
    selectStackMock.mockImplementation((a: { stackName: string }) =>
      Promise.resolve(healthyStack(a.stackName)),
    );

    await upStack('e1', () => ({}), { s3Config, projectName: 'testproj' });

    const lines = stateLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ops .*up=1/);
    expect(lines[0]).not.toContain('rps/bucket');
  });
});
