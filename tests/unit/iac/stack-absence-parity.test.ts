/**
 * The two destroy-side openers of a stack, `destroyStack` (the k8s tiers and
 * orphan stacks) and `removeStackState` (the compose tiers and unreadable
 * stacks), give the same answer to the same `pulumi stack select` failure:
 * either the stack is durably absent, or the failure stands.
 *
 * Evidence (e2e hetzner/k8s final destroy, 2026-11-13): a deploy stopped while
 * creating the app bucket ("Nothing was provisioned"), so no state bucket was
 * ever made. The select failed with NoSuchBucket; removeStackState already
 * counted that as absent once every region of the store said "not found"
 * (excitingai, 2026-10-16), but destroyStack did not, so the k8s destroy
 * printed an UNVERIFIED pulumi-stack, kept the environment's entry, and every
 * rerun did the same.
 *
 * Absence must be definite. A bucket that answers from another region, a
 * locate that cannot finish, and any other failure (access denied, a 5xx) keep
 * the original error on both paths.
 *
 * Mocks `@pulumi/pulumi/automation/index.js`'s LocalWorkspace directly (the
 * remove-stack-state pattern) so the real getOrCreateStack, destroyStack and
 * removeStackState code paths run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectStackMock = vi.fn();
const createStackMock = vi.fn(() => {
  throw new Error('createStack must not be called: a destroy never conjures a stack');
});

vi.mock('../../../src/lib/state-passphrase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/state-passphrase.js')>()),
  ensureStatePassphrase: async () => 'test-passphrase',
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    selectStack: (...args: unknown[]) => selectStackMock(...args),
    createStack: (...args: unknown[]) => createStackMock(...args),
    create: async () => ({ listStacks: async () => [] }),
  },
}));

// The store's answer to "which region holds this bucket?", swapped per case.
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

const { destroyStack, removeStackState } = await import('../../../src/lib/iac/index.js');

// The exact `pulumi stack select` failure of a backend whose bucket was never
// created (excitingai, 2026-10-16; the same shape on the 2026-11-13 k8s run).
const NO_SUCH_BUCKET =
  'code: -2\n stdout: \n stderr: Command failed with exit code 1: pulumi stack select --stack e3 --non-interactive\n' +
  'error: error listing stacks: could not list bucket: blob (code=NotFound): operation error S3: ListObjectsV2, ' +
  'https response error StatusCode: 404, RequestID: N/A, HostID: N/A, NoSuchBucket: The specified bucket does not exist.\n';

const S3 = {
  bucket: 'proj-8aded2-e3-storage',
  region: 'nbg1',
  endpoint: 'https://nbg1.your-objectstorage.com',
  accessKey: 'ABCDEFGHIJ0123456789',
  secretKey: 'x'.repeat(40),
};
const OPTS = { projectName: 'proj', provider: 'hetzner', s3Config: S3 };

type Case = {
  name: string;
  select: () => Error;
  locate?: (bucket: string) => Promise<string | null>;
  /** null: the failure stands (rejects matching this). */
  absent: { stateBucketMissing: boolean } | null;
  rejects?: RegExp;
  /** Whether the bucket's absence was asked of the store at all. */
  probes: boolean;
};

const CASES: Case[] = [
  {
    name: 'no stack named: absent, no probe',
    select: () => new Error("error: no stack named 'e3' found"),
    absent: { stateBucketMissing: false },
    probes: false,
  },
  {
    name: 'NoSuchBucket and no region has the bucket: absent',
    select: () => new Error(NO_SUCH_BUCKET),
    locate: async () => null,
    absent: { stateBucketMissing: true },
    probes: true,
  },
  {
    name: 'NoSuchBucket but another region has it (wrong endpoint, real state): stands',
    select: () => new Error(NO_SUCH_BUCKET),
    locate: async () => 'fsn1',
    absent: null,
    rejects: /NoSuchBucket/,
    probes: true,
  },
  {
    name: 'NoSuchBucket and the locate never answered (network): stands',
    select: () => new Error(NO_SUCH_BUCKET),
    locate: () =>
      Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
    absent: null,
    rejects: /NoSuchBucket/,
    probes: true,
  },
  {
    name: 'NoSuchBucket and the locate got a 5xx: stands',
    select: () => new Error(NO_SUCH_BUCKET),
    locate: () =>
      Promise.reject(
        Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } }),
      ),
    absent: null,
    rejects: /NoSuchBucket/,
    probes: true,
  },
  {
    name: 'access denied: stands, no probe',
    select: () => new Error('error: AccessDenied: Access Denied, StatusCode: 403'),
    absent: null,
    rejects: /AccessDenied/,
    probes: false,
  },
  {
    name: 'a 5xx from the backend: stands, no probe',
    select: () =>
      new Error('error: InternalError: We encountered an internal error, StatusCode: 500'),
    absent: null,
    rejects: /InternalError/,
    probes: false,
  },
];

/** Each opener, with its "absent" answer spelled its own way. */
const OPENERS = {
  destroyStack: {
    run: () => destroyStack('e3', () => {}, OPTS),
    absent: (stateBucketMissing: boolean) => ({
      destroyed: false,
      ...(stateBucketMissing && { stateBucketMissing: true }),
    }),
  },
  removeStackState: {
    run: () => removeStackState('e3', OPTS),
    absent: (stateBucketMissing: boolean) => ({
      removed: false,
      ...(stateBucketMissing && { stateBucketMissing: true }),
    }),
  },
};

describe.each(Object.entries(OPENERS))('%s', (_name, opener) => {
  beforeEach(() => {
    selectStackMock.mockReset();
    createStackMock.mockClear();
    locatedBuckets.length = 0;
    locateBucket = async () => null;
  });

  it.each(CASES)('$name', async (c) => {
    selectStackMock.mockImplementation(async () => {
      throw c.select();
    });
    if (c.locate) locateBucket = c.locate;

    if (c.absent) {
      await expect(opener.run()).resolves.toEqual(opener.absent(c.absent.stateBucketMissing));
    } else {
      await expect(opener.run()).rejects.toThrow(c.rejects);
    }
    // The bucket in the backend URL is the one asked about: the app bucket
    // here, since the record of a deploy that stopped in s3-setup names no
    // state bucket (resolveBackendUrl's `?? bucket`).
    expect(locatedBuckets).toEqual(c.probes ? [S3.bucket] : []);
    expect(createStackMock).not.toHaveBeenCalled();
  });
});
