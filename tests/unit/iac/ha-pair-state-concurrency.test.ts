import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An HA pair on one state bucket runs side by side from the first request: two
 * `upStack`s select, refresh and provision at once, on a bucket of any age, on
 * every provider. No lock, no wait.
 *
 * Measured 2026-11-05 on real Hetzner: whole-operation lock on a new bucket,
 * compose-ha 212 s and k8s-ha 330 s; `up` outside the lock, 184 and 201 s, 260
 * and 247 s, no backpressure. The numbers for select and refresh are in the
 * state-lock.js header.
 *
 * Drives the REAL upStack entry point with a fake Pulumi workspace, counting
 * how many selects, refreshes and ups are in flight at once.
 */

const selectStackMock = vi.fn();

// These tests drive getOrCreateStack against a mocked LocalWorkspace. The real
// state-passphrase check would write a passphrase into the cwd's .env.local and
// .vibecarbon.json, so it is stubbed; state-passphrase-census.test.ts covers
// the real wiring.
vi.mock('../../../src/lib/state-passphrase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async () => 'test-passphrase',
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: () => {
      throw new Error('createStack must not be called: it would clobber real state');
    },
    create: async () => ({ listStacks: async () => [] }),
  },
}));

const progress = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../../src/lib/cli/progress.js', () => ({
  progressLog: (line: string) => progress.lines.push(line),
}));

const s3Config = {
  bucket: 'proj-storage',
  stateBucket: 'proj-storage-pulumi-state-a1b2c3',
  endpoint: 'https://nbg1.your-objectstorage.com',
  region: 'nbg1',
};

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-flight counters with their peaks. */
function gauge() {
  let active = 0;
  let peak = 0;
  return {
    async during<T>(fn: () => Promise<T>): Promise<T> {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await fn();
      } finally {
        active -= 1;
      }
    },
    get peak() {
      return peak;
    },
  };
}

/** Fan two ups out against one state bucket, the way both HA runners do. */
async function runPair() {
  const { upStack } = await import('../../../src/lib/iac/index.js');
  const { observeStateLockWaits } = await import('../../../src/lib/iac/state-lock.js');
  const waits: string[] = [];
  const stopObserving = observeStateLockWaits(({ label }: { label: string }) => waits.push(label));

  const selects = gauge();
  const refreshes = gauge();
  const ups = gauge();
  selectStackMock.mockImplementation((args: { stackName: string }) =>
    selects.during(async () => {
      await tick(5);
      return {
        name: args.stackName,
        cancel: async () => {},
        // A populated stack, so the pre-up refresh actually runs.
        exportStack: async () => ({
          deployment: { resources: [{ type: 'hcloud:index/server:Server' }] },
        }),
        refresh: () => refreshes.during(() => tick(5).then(() => ({}))),
        outputs: async () => ({ serverIp: { value: '1.2.3.4' } }),
        workspace: { removeStack: async () => {} },
        up: () =>
          ups.during(async () => {
            await tick(30);
            return {
              outputs: { serverIp: { value: '1.2.3.4' } },
              summary: { result: 'succeeded' },
            };
          }),
      };
    }),
  );

  await Promise.all(
    ['e2-primary', 'e2-standby'].map((name) =>
      upStack(name, () => ({}), { s3Config, projectName: 'testproj' }),
    ),
  );
  stopObserving();
  return { peakUp: ups.peak, peakSelect: selects.peak, peakRefresh: refreshes.peak, waits };
}

beforeEach(() => {
  vi.resetModules();
  selectStackMock.mockReset();
  progress.lines.length = 0;
});

describe('an HA pair on one state bucket', () => {
  it('selects, refreshes and provisions side by side', async () => {
    const { peakUp, peakSelect, peakRefresh } = await runPair();
    expect(peakSelect).toBe(2);
    expect(peakRefresh).toBe(2);
    expect(peakUp).toBe(2);
  });

  it('never waits on the state lock', async () => {
    const { waits } = await runPair();
    expect(waits).toEqual([]);
  });

  it('still counts its state operations in the [state] line the e2e budget reads', async () => {
    await runPair();
    const last = progress.lines.filter((l) => l.startsWith('[state] up ')).at(-1) ?? '';
    expect(last).toMatch(/ops .*up=2/);
    expect(last).toMatch(/ops .*stack-select=2/);
    expect(last).toMatch(/lock-waits 0/);
  });
});
