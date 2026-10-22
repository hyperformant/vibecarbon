import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ruling A′ (cold-deploy speed, Task 6): the state lock's scope depends on the
 * state bucket's age against its provider's declared settle window.
 *
 * Past the window, an HA pair's two `up`s provision in parallel: only the
 * stack select, the stale-lock cancel, the pre-up refresh and the Vultr repair
 * run under the lock. Inside the window (a customer's first HA deploy on
 * Hetzner), the whole `upStack` stays under it, because every `up` throttle on
 * record landed inside a young bucket's first minutes (History check, job
 * 95045761606).
 *
 * Drives the REAL upStack entry point with a fake Pulumi workspace, counting
 * how many selects, refreshes and ups are in flight at once.
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
async function runPair(options: { stateBucketYoung?: boolean }) {
  const { upStack } = await import('../../../src/lib/iac/index.js');
  const { resetStateLocksForTest } = await import('../../../src/lib/iac/state-lock.js');
  resetStateLocksForTest();

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
      upStack(name, () => ({}), { s3Config, projectName: 'testproj', ...options }),
    ),
  );
  return { peakUp: ups.peak, peakSelect: selects.peak, peakRefresh: refreshes.peak };
}

beforeEach(() => {
  vi.resetModules();
  selectStackMock.mockReset();
});

describe('state lock scope (Ruling A′)', () => {
  it('past the window, two ups on one bucket overlap while selects stay serial', async () => {
    const { peakUp, peakSelect, peakRefresh } = await runPair({ stateBucketYoung: false });
    expect(peakUp).toBe(2);
    expect(peakSelect).toBe(1);
    expect(peakRefresh).toBe(1);
  });

  it('inside the window, the ups never overlap (Review Focus 7)', async () => {
    const { peakUp, peakSelect } = await runPair({ stateBucketYoung: true });
    expect(peakUp).toBe(1);
    expect(peakSelect).toBe(1);
  });

  it('an unstated bucket age is treated as young (the safe side)', async () => {
    const { peakUp } = await runPair({});
    expect(peakUp).toBe(1);
  });
});

describe('readStateBucketYoung', () => {
  const MIN = 60_000;
  const provider = (createdAt: Date | null) => ({ bucketCreatedAt: vi.fn(async () => createdAt) });

  it('a 0-window provider never reads the bucket age', async () => {
    const { readStateBucketYoung } = await import('../../../src/lib/deploy/bucket-settle.js');
    const age = vi.fn();
    const young = await readStateBucketYoung({
      providerId: 'digitalocean',
      createProvider: async () => ({ bucketCreatedAt: age }),
      bucket: 'proj-pulumi-state',
    });
    expect(young).toBe(false);
    expect(age).not.toHaveBeenCalled();
  });

  it('on Hetzner, a bucket inside its 20 minute window is young and one past it is not', async () => {
    const { readStateBucketYoung } = await import('../../../src/lib/deploy/bucket-settle.js');
    const fresh = provider(new Date(Date.now() - 2 * MIN));
    const old = provider(new Date(Date.now() - 25 * MIN));
    expect(
      await readStateBucketYoung({
        providerId: 'hetzner',
        createProvider: async () => fresh,
        bucket: 'b',
      }),
    ).toBe(true);
    expect(fresh.bucketCreatedAt).toHaveBeenCalledWith('b');
    expect(
      await readStateBucketYoung({
        providerId: 'hetzner',
        createProvider: async () => old,
        bucket: 'b',
      }),
    ).toBe(false);
  });

  it('an unreadable age counts as young', async () => {
    const { readStateBucketYoung } = await import('../../../src/lib/deploy/bucket-settle.js');
    expect(
      await readStateBucketYoung({
        providerId: 'hetzner',
        createProvider: async () => provider(null),
        bucket: 'b',
      }),
    ).toBe(true);
    expect(
      await readStateBucketYoung({
        providerId: 'hetzner',
        createProvider: async () => ({
          bucketCreatedAt: async () => {
            throw new Error('403');
          },
        }),
        bucket: 'b',
      }),
    ).toBe(true);
  });
});
