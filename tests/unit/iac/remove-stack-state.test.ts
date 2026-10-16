/**
 * `removeStackState` — remove a stack's state record WITHOUT running
 * `pulumi destroy`.
 *
 * Evidence (e2e run 32309395314, vultr compose restore, 2026-08-19): the
 * compose tiers reap their cloud resources via direct provider APIs, so
 * their destroy never ran `pulumi destroy`/`removeStack` — and since the
 * state bucket is retained (717d49e7), the stack file survived a verified
 * teardown still describing the deleted resources. The next deploy of the
 * same environment (the e2e restore re-deploy) selected that stale stack,
 * and on providers whose refresh cannot prune a deleted resource
 * (terraform-provider-vultr v2.27.1 returns an ERROR, not not-found, when
 * reading a deleted firewall rule) `pulumi up` tried to delete the stale
 * rules against the live API and died on 404.
 *
 * removeStackState is the compose-side twin of the removal destroyStack
 * already performs for the k8s tiers: state must be reconciled by the thing
 * that deleted the resources, not left for the next deploy's refresh to
 * repair.
 *
 * Mocks `@pulumi/pulumi/automation/index.js`'s LocalWorkspace directly (the
 * destroy-stack-partial-detection pattern) so the real getOrCreateStack /
 * removeStackState code paths run against the automation API's shapes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectStackMock = vi.fn();
const createStackMock = vi.fn(() => {
  throw new Error('createStack must not be called: removal must never conjure a stack');
});

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: (...args: unknown[]) => createStackMock(...args),
    create: async () => ({ listStacks: async () => [] }),
  },
}));

// The store's answer to "which region holds this bucket?", swapped per test.
// A plain function, not vi.fn: the only thing under test is what
// removeStackState does with each answer.
let locateBucket: (bucket: string) => Promise<string | null> = async () => null;
const locatedBuckets: string[] = [];
vi.mock('../../../src/lib/providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/providers/index.js')>()),
  getObjectStorageProvider: async () => ({
    locateBucket: (bucket: string) => {
      locatedBuckets.push(bucket);
      return locateBucket(bucket);
    },
  }),
}));

// The exact `pulumi stack select` failure from the excitingai destroy
// (2026-10-16): the deploy failed before the state bucket existed.
const NO_SUCH_BUCKET =
  'code: -2\n stdout: \n stderr: Command failed with exit code 1: pulumi stack select --stack prod --non-interactive\n' +
  'error: error listing stacks: could not list bucket: blob (code=NotFound): operation error S3: ListObjectsV2, ' +
  'https response error StatusCode: 404, RequestID: N/A, HostID: N/A, NoSuchBucket: The specified bucket does not exist.\n';

const S3 = {
  bucket: 'excitingai-88d16c-storage-2074c7',
  stateBucket: 'excitingai-88d16c-storage-2074c7-pulumi-state',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  accessKey: 'ABCDEFGHIJ0123456789',
  secretKey: 'x'.repeat(40),
};
const OPTS = { projectName: 'excitingai', provider: 'hetzner', s3Config: S3 };

function makeStack() {
  return {
    workspace: { removeStack: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('removeStackState — state-only stack removal after out-of-band teardown', () => {
  beforeEach(() => {
    selectStackMock.mockReset();
    createStackMock.mockClear();
  });

  it('removes an existing stack with force (its state still lists the reaped resources) and reports removed', async () => {
    const stack = makeStack();
    selectStackMock.mockResolvedValue(stack);

    const { removeStackState } = await import('../../../src/lib/iac/index.js');
    const out = await removeStackState('civ1', { projectName: 'testproj' });

    expect(out.removed).toBe(true);
    // force: the state record deliberately still lists resources — the whole
    // point is that the caller already deleted them out-of-band and verified
    // it (clean leak ledger). A non-forced remove refuses non-empty stacks.
    expect(stack.workspace.removeStack).toHaveBeenCalledWith('civ1', { force: true });
  });

  it('is a no-op (removed: false) when the stack is durably absent', async () => {
    const err = Object.assign(new Error('no stack named "civ1" found'), {});
    selectStackMock.mockRejectedValue(err);

    const { removeStackState } = await import('../../../src/lib/iac/index.js');
    const out = await removeStackState('civ1', { projectName: 'testproj' });

    expect(out.removed).toBe(false);
  });

  it('never creates a stack while removing one', async () => {
    selectStackMock.mockRejectedValue(new Error('no stack named "civ1" found'));

    const { removeStackState } = await import('../../../src/lib/iac/index.js');
    await removeStackState('civ1', { projectName: 'testproj' });

    expect(createStackMock).not.toHaveBeenCalled();
  });

  it('propagates errors that are NOT stack-absence (backend/credential failures must stay loud)', async () => {
    selectStackMock.mockRejectedValue(new Error('403 Forbidden reading s3://state-bucket'));

    const { removeStackState } = await import('../../../src/lib/iac/index.js');
    await expect(removeStackState('civ1', { projectName: 'testproj' })).rejects.toThrow(
      /403 Forbidden/,
    );
  });

  describe('state bucket missing (NoSuchBucket)', () => {
    beforeEach(() => {
      locatedBuckets.length = 0;
    });

    it('counts the stack as absent when the state bucket exists in no region', async () => {
      selectStackMock.mockRejectedValue(new Error(NO_SUCH_BUCKET));
      locateBucket = async () => null;

      const { removeStackState } = await import('../../../src/lib/iac/index.js');
      const out = await removeStackState('prod', OPTS);

      expect(out).toEqual({ removed: false, stateBucketMissing: true });
      expect(locatedBuckets).toEqual([S3.stateBucket]);
      expect(createStackMock).not.toHaveBeenCalled();
    });

    it('stays a failure when the bucket does exist in another region (wrong endpoint, real state)', async () => {
      selectStackMock.mockRejectedValue(new Error(NO_SUCH_BUCKET));
      locateBucket = async () => 'nbg1';

      const { removeStackState } = await import('../../../src/lib/iac/index.js');
      await expect(removeStackState('prod', OPTS)).rejects.toThrow(/NoSuchBucket/);
    });

    it('stays a failure when absence cannot be confirmed', async () => {
      selectStackMock.mockRejectedValue(new Error(NO_SUCH_BUCKET));
      locateBucket = () =>
        Promise.reject(Object.assign(new Error('no answer'), { name: 'TimeoutError' }));

      const { removeStackState } = await import('../../../src/lib/iac/index.js');
      await expect(removeStackState('prod', OPTS)).rejects.toThrow(/NoSuchBucket/);
    });

    it('never probes for an unrelated failure', async () => {
      selectStackMock.mockRejectedValue(new Error('403 Forbidden reading s3://state-bucket'));

      const { removeStackState } = await import('../../../src/lib/iac/index.js');
      await expect(removeStackState('prod', OPTS)).rejects.toThrow(/403 Forbidden/);
      expect(locatedBuckets).toEqual([]);
    });
  });
});
