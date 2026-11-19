/**
 * What every e2e orphan sweep must do the same way, as one table.
 *
 * The five sweeps share the project-name guard and the bucket pass
 * (sweep-core.ts), but each wires its own buckets in: DigitalOcean lists
 * per region, Linode per account with each bucket's cluster, Vultr one
 * subscription cluster, Scaleway and Hetzner one store per region. A row
 * here is that wiring; the cases run through each sweep's own entry point,
 * so a sweep that stops routing its buckets through the shared pass, or
 * routes them wrongly, fails by name. There is one row per provider in the
 * registry, and the first case fails when a provider has no row.
 *
 * What each sweep does beyond this stays in its own file: the compute
 * passes (and sweep-pass-transcript.test.ts, every line of them), which
 * buckets a listing hands over and through which region, protected
 * buckets, a store that throws, missing storage keys.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { sweepOrphanedDigitalOceanResources } from '../../e2e/utils/sweep-digitalocean.js';
import { sweepOrphanedHetznerResources } from '../../e2e/utils/sweep-hetzner.js';
import { sweepOrphanedLinodeResources } from '../../e2e/utils/sweep-linode.js';
import { sweepOrphanedScalewayResources } from '../../e2e/utils/sweep-scaleway.js';
import { sweepOrphanedVultrResources } from '../../e2e/utils/sweep-vultr.js';

const TAG = '[test]';
const PROJECT = 'testapp-sh1';
const BUCKET = `${PROJECT}-backups`;

type Mock = ReturnType<typeof vi.fn>;

/** The one place a row's buckets live; a row adapts it to its sweep's shape. */
interface Store {
  listBuckets: Mock;
  emptyAndDeleteBucket: Mock;
  locateBucket: Mock;
}

function store(overrides: Partial<Store> = {}): Store {
  return {
    listBuckets: vi.fn().mockResolvedValue([]),
    emptyAndDeleteBucket: vi.fn().mockResolvedValue({ objectsRemoved: 0 }),
    locateBucket: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** Every compute listing reads empty and complete. */
function emptyProvider() {
  const empty = async () => ({ items: [], complete: true });
  return {
    listServersDetailed: empty,
    deleteServer: async () => undefined,
    listVolumesDetailed: empty,
    volumeAttachedServerIds: () => [],
    volumeLabels: () => ({}),
    labelValue: (_key: string, value: string) => value,
    serverLabels: () => ({}),
    deleteVolume: async () => true,
    deleteFirewallByName: async () => ({ deleted: true, everExisted: true }),
    deleteSSHKeyById: async () => 'deleted',
    deleteSSHKeyByName: async () => true,
    listFlexibleIPsDetailed: empty,
    releaseFlexibleIP: async () => true,
    deleteLoadBalancer: async () => true,
  };
}

/** Every direct-API listing answers `body`, one final page; every DELETE succeeds. */
function emptyFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

interface SweepRow {
  /** Run the sweep with `s` as the one store that holds buckets. */
  run(
    projectName: string,
    s: Store,
  ): Promise<{ counts: { s3Buckets: number }; enumFailed: boolean }>;
  /** What the sweep passes to locateBucket for a bucket `s` listed. */
  locateArgs(name: string): unknown[];
}

const SWEEPS: Record<string, SweepRow> = {
  hetzner: {
    run: (projectName, s) =>
      sweepOrphanedHetznerResources(TAG, projectName, 'tok', {
        fetchImpl: emptyFetch({}),
        objectStorageByRegion: { nbg1: s, fsn1: store(), hel1: store() },
      }),
    locateArgs: (name) => [name],
  },
  digitalocean: {
    run: (projectName, s) =>
      sweepOrphanedDigitalOceanResources(TAG, projectName, {
        provider: emptyProvider() as never,
        spaces: { regions: () => ['nyc3'], ...s },
        fetchImpl: emptyFetch({}),
      }),
    locateArgs: (name) => ['nyc3', name],
  },
  linode: {
    run: (projectName, s) =>
      sweepOrphanedLinodeResources(TAG, projectName, {
        provider: emptyProvider() as never,
        objectStorage: {
          // The account listing names each bucket's cluster.
          listAllBuckets: async () =>
            (await s.listBuckets())?.map((name: string) => ({ name, cluster: 'us-iad-10' })) ??
            null,
          emptyAndDeleteBucket: s.emptyAndDeleteBucket,
          locateBucket: s.locateBucket,
        },
        fetchImpl: emptyFetch({ data: [], page: 1, pages: 1 }),
      }),
    locateArgs: (name) => ['us-iad-10', name],
  },
  vultr: {
    run: (projectName, s) =>
      sweepOrphanedVultrResources(TAG, projectName, {
        provider: emptyProvider() as never,
        objectStorage: s,
        storageRegion: 'ewr1',
        fetchImpl: emptyFetch({ meta: { links: { next: '' } } }),
      }),
    locateArgs: (name) => [name],
  },
  scaleway: {
    run: (projectName, s) =>
      sweepOrphanedScalewayResources(TAG, projectName, {
        provider: emptyProvider() as never,
        objectStorageByRegion: { 'fr-par': s, 'nl-ams': store() },
        fetchImpl: emptyFetch({}),
      }),
    locateArgs: (name) => [name],
  },
};

/**
 * "No such bucket", as the SDK hands it over: with no message (Spaces
 * after a delete, run 43757126064, which the SDK words "UnknownError") and
 * with one (Hetzner, delete after delete, 2026-11-15).
 */
const NO_SUCH_BUCKET = {
  'no message': Object.assign(new Error('UnknownError'), {
    name: 'NoSuchBucket',
    Code: 'NoSuchBucket',
    $metadata: { httpStatusCode: 404 },
  }),
  worded: Object.assign(new Error('The specified bucket does not exist.'), {
    name: 'NoSuchBucket',
    Code: 'NoSuchBucket',
    $metadata: { httpStatusCode: 404 },
  }),
};
const SHAPES = Object.keys(NO_SUCH_BUCKET) as Array<keyof typeof NO_SUCH_BUCKET>;

/** Run `fn` with console output captured, and hand back what it printed. */
async function captured<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logged: string; warned: string }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const result = await fn();
  const said = (spy: typeof log) => spy.mock.calls.map((c) => String(c[0])).join('\n');
  return { result, logged: said(log), warned: said(warn) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('has a sweep row for every provider in the registry', () => {
  expect(Object.keys(SWEEPS).sort()).toEqual(Object.keys(PROVIDERS).sort());
});

describe.each(Object.entries(SWEEPS))('%s sweep', (_id, row) => {
  it('refuses to sweep with an empty project name (an empty prefix matches everything)', async () => {
    await expect(row.run('', store())).rejects.toThrow(/project name/i);
  });

  it('marks enumFailed when the bucket listing is unreadable', async () => {
    const s = store({ listBuckets: vi.fn().mockResolvedValue(null) });

    const { result } = await captured(() => row.run(PROJECT, s));

    expect(result.enumFailed).toBe(true);
  });

  it.each(SHAPES)(
    'a bucket destroy removed seconds earlier reads clean once no region holds it and a second listing has dropped it (%s)',
    async (shape) => {
      const s = store({
        listBuckets: vi.fn().mockResolvedValueOnce([BUCKET]).mockResolvedValue([]),
        emptyAndDeleteBucket: vi.fn().mockRejectedValue(NO_SUCH_BUCKET[shape]),
      });

      const { result } = await captured(() => row.run(PROJECT, s));

      expect(s.locateBucket).toHaveBeenCalledWith(...row.locateArgs(BUCKET));
      // Read once to enumerate and once more after the search, never again.
      expect(s.listBuckets).toHaveBeenCalledTimes(2);
      expect(result.enumFailed).toBe(false);
      expect(result.counts.s3Buckets).toBe(0);
    },
  );

  it.each(SHAPES)(
    'the 2026-11-16 leak: no such bucket and no region holds it, but the listing still shows it, so the sweep FAILS and never says gone (%s)',
    async (shape) => {
      // A new Hetzner bucket answered this way for 20 minutes while it
      // existed and billed. The listing was the one answer that told the truth.
      const s = store({
        listBuckets: vi.fn().mockResolvedValue([BUCKET]),
        emptyAndDeleteBucket: vi.fn().mockRejectedValue(NO_SUCH_BUCKET[shape]),
      });

      const { result, logged, warned } = await captured(() => row.run(PROJECT, s));

      expect(s.locateBucket).toHaveBeenCalledWith(...row.locateArgs(BUCKET));
      expect(result.enumFailed).toBe(true);
      expect(result.counts.s3Buckets).toBe(0);
      expect(logged).not.toMatch(/already gone/);
      expect(warned).toMatch(new RegExp(`FAILED ${BUCKET}: .*listing still shows it`));
      expect(s.listBuckets).toHaveBeenCalledTimes(2);
    },
  );

  it.each(SHAPES)(
    'a NoSuchBucket for a bucket some region still holds FAILS the sweep (%s)',
    async (shape) => {
      // A second listing would drop it, so only the region search keeps
      // the bucket from reading as gone.
      const s = store({
        listBuckets: vi.fn().mockResolvedValueOnce([BUCKET]).mockResolvedValue([]),
        emptyAndDeleteBucket: vi.fn().mockRejectedValue(NO_SUCH_BUCKET[shape]),
        locateBucket: vi.fn().mockResolvedValue('another-region'),
      });

      const { result, warned } = await captured(() => row.run(PROJECT, s));

      expect(s.locateBucket).toHaveBeenCalledWith(...row.locateArgs(BUCKET));
      expect(result.enumFailed).toBe(true);
      expect(result.counts.s3Buckets).toBe(0);
      expect(warned).toMatch(new RegExp(`FAILED ${BUCKET}: .*finds it in another-region`));
    },
  );
});
