/**
 * The Hetzner app-key deny-fence (security plan R2, Task 4; Review Focus 7).
 * Sentinel key ids only.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  APP_STORAGE_SECRET_PREFIX,
  appStorageSecretKeys,
  markUnfencedBuckets,
  resolveAppStorageCredential,
  syncHetznerFences,
  unfencedBucketsLine,
} from '../../../src/lib/deploy/app-storage-credential.js';
import {
  applyHetznerFences,
  FENCE_PROBE_BUDGET_MS,
  FENCE_PROBE_STREAK,
  fenceInfoLines,
  fenceTargets,
  renderHetznerFencePolicy,
} from '../../../src/lib/deploy/hetzner-app-key-fence.js';
import { envIdentityOf } from '../../../src/lib/env-identity.js';

const OWNER = 'p1234567';

describe('renderHetznerFencePolicy', () => {
  it('renders exactly the R2 statement: one Deny on the bucket and its objects, per-key principals', () => {
    expect(
      renderHetznerFencePolicy({
        bucket: 'proj-abc-backups',
        ownerId: OWNER,
        deniedAccessKeyIds: ['SENTINEL_AK_S', 'SENTINEL_AK_P'],
      }),
    ).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Deny',
          Principal: {
            AWS: [
              `arn:aws:iam:::user/${OWNER}:SENTINEL_AK_P`,
              `arn:aws:iam:::user/${OWNER}:SENTINEL_AK_S`,
            ],
          },
          Action: ['s3:*'],
          Resource: ['arn:aws:s3:::proj-abc-backups', 'arn:aws:s3:::proj-abc-backups/*'],
        },
      ],
    });
  });
});

/** prod deployed first with a pasted key, then staging with its own. */
function project({ staging = true } = {}) {
  const env = (name: string, id: string | null) => ({
    provider: 'hetzner',
    s3: {
      bucket: `proj-abc-${name}`,
      stateBucket: 'proj-abc-state',
      ...(id && { appKey: { id, scoping: 'paste-fence', tier: 'fenced' } }),
    },
    backupS3: { bucket: 'proj-abc-backups' },
  });
  return {
    projectName: 'proj',
    environments: {
      prod: env('prod', 'AK_P'),
      ...(staging && { staging: env('staging', 'AK_S') }),
    },
  };
}

const byBucket = (targets: { bucket: string; deniedAccessKeyIds: string[] }[]) =>
  Object.fromEntries(targets.map((t) => [t.bucket, t.deniedAccessKeyIds]));

describe('fenceTargets (Review Focus 7)', () => {
  it('prod alone: state and backups deny AK_P, prod never denies its own key', () => {
    expect(
      byBucket(fenceTargets({ projectConfig: project({ staging: false }), environment: 'prod' })),
    ).toEqual({
      'proj-abc-state': ['AK_P'],
      'proj-abc-backups': ['AK_P'],
      'proj-abc-prod': [],
    });
  });

  it('then staging: state and backups deny both, each env bucket denies the other', () => {
    expect(byBucket(fenceTargets({ projectConfig: project(), environment: 'staging' }))).toEqual({
      'proj-abc-state': ['AK_P', 'AK_S'],
      'proj-abc-backups': ['AK_P', 'AK_S'],
      'proj-abc-prod': ['AK_S'],
      'proj-abc-staging': ['AK_P'],
    });
  });

  it('leaving without retiring takes the key out (destroy always retires first, see (a))', () => {
    const after = byBucket(
      fenceTargets({ projectConfig: project(), environment: 'staging', leaving: true }),
    );
    expect(after).toEqual({
      'proj-abc-state': ['AK_P'],
      'proj-abc-backups': ['AK_P'],
      'proj-abc-prod': [],
    });
    for (const ids of Object.values(after)) expect(ids).not.toContain('AK_S');
  });

  it('a pinned bucket is not an env own bucket, so it denies every pasted key', () => {
    const cfg = project();
    Object.assign(cfg.environments.prod.s3, {
      bucket: 'legacy-shared',
      bucketPin: 'legacy-shared',
    });
    expect(
      byBucket(fenceTargets({ projectConfig: cfg, environment: 'prod' }))['legacy-shared'],
    ).toEqual(['AK_P', 'AK_S']);
  });
});

/** An in-memory Hetzner: per-bucket policies, write counters. */
function makeS3(initial: Record<string, object | null> = {}) {
  const policies = new Map(Object.entries(initial));
  const s3 = {
    policies,
    puts: [] as string[],
    deletes: [] as string[],
    ownerId: vi.fn(async () => OWNER),
    getBucketPolicy: vi.fn(async (b: string) => policies.get(b) ?? null),
    putBucketPolicy: vi.fn(async (b: string, policy: object) => {
      policies.set(b, policy);
      s3.puts.push(b);
    }),
    deleteBucketPolicy: vi.fn(async (b: string) => {
      policies.delete(b);
      s3.deletes.push(b);
    }),
  };
  return s3;
}
/** A probe that answers from a script, then keeps answering the last value. */
function scriptedProbe(answers: boolean[]) {
  let i = 0;
  return {
    calls: () => i,
    isDeniedOn: vi.fn(async () => answers[Math.min(i++, answers.length - 1)]),
  };
}

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe('applyHetznerFences', () => {
  it('writes each changed fence once, and an unchanged one not at all', async () => {
    const s3 = makeS3();
    const clock = fakeClock();
    const targets = fenceTargets({ projectConfig: project(), environment: 'staging' });
    const probes = { AK_P: scriptedProbe([true]), AK_S: scriptedProbe([true]) };
    await applyHetznerFences({ s3, ownerId: OWNER, targets, probes, ...clock });
    expect(s3.puts.sort()).toEqual([
      'proj-abc-backups',
      'proj-abc-prod',
      'proj-abc-staging',
      'proj-abc-state',
    ]);
    s3.puts.length = 0;
    await applyHetznerFences({ s3, ownerId: OWNER, targets, probes, ...clock });
    expect(s3.puts).toEqual([]);
  });

  it(`passes only after ${FENCE_PROBE_STREAK} denied probes in a row; an allowed one resets the streak`, async () => {
    const s3 = makeS3();
    const clock = fakeClock();
    const probe = scriptedProbe([true, false, true, true, true]);
    await applyHetznerFences({
      s3,
      ownerId: OWNER,
      targets: [{ bucket: 'proj-abc-state', deniedAccessKeyIds: ['AK_P'] }],
      probes: { AK_P: probe },
      ...clock,
    });
    expect(probe.calls()).toBe(5);
    expect(s3.puts).toEqual(['proj-abc-state']);
  });

  it('verifies the buckets in parallel, after every fence is written', async () => {
    const s3 = makeS3();
    const log: string[] = [];
    const probe = {
      isDeniedOn: vi.fn(async (bucket: string) => {
        log.push(`${bucket}@${s3.puts.length}`);
        return true;
      }),
    };
    await applyHetznerFences({
      s3,
      ownerId: OWNER,
      targets: [
        { bucket: 'proj-abc-state', deniedAccessKeyIds: ['AK_P'] },
        { bucket: 'proj-abc-backups', deniedAccessKeyIds: ['AK_P'] },
      ],
      probes: { AK_P: probe },
      ...fakeClock(),
    });
    // Both writes land before the first probe, and the first two probes
    // are one per bucket (serially, the state bucket would take all
    // FENCE_PROBE_STREAK first).
    expect(log.every((e) => e.endsWith('@2'))).toBe(true);
    expect(
      log
        .slice(0, 2)
        .map((e) => e.split('@')[0])
        .sort(),
    ).toEqual(['proj-abc-backups', 'proj-abc-state']);
    expect(log).toHaveLength(2 * FENCE_PROBE_STREAK);
  });

  it('a parallel verification failure names every bucket that did not hold', async () => {
    const s3 = makeS3();
    await expect(
      applyHetznerFences({
        s3,
        ownerId: OWNER,
        targets: [
          { bucket: 'proj-abc-state', deniedAccessKeyIds: ['AK_P'] },
          { bucket: 'proj-abc-backups', deniedAccessKeyIds: ['AK_P'] },
        ],
        probes: { AK_P: scriptedProbe([false]) },
        ...fakeClock(),
      }),
    ).rejects.toThrow(/proj-abc-state[\s\S]*proj-abc-backups/);
  });

  it(`an exhausted ${FENCE_PROBE_BUDGET_MS / 1000} s budget fails naming the bucket, with no rewrite`, async () => {
    const s3 = makeS3();
    const clock = fakeClock();
    await expect(
      applyHetznerFences({
        s3,
        ownerId: OWNER,
        targets: [{ bucket: 'proj-abc-backups', deniedAccessKeyIds: ['AK_P'] }],
        probes: { AK_P: scriptedProbe([false]) },
        ...clock,
      }),
    ).rejects.toThrow(/proj-abc-backups.*120 s/);
    // A consistency gate, not a retry of the write.
    expect(s3.puts).toEqual(['proj-abc-backups']);
    expect(clock.now()).toBeLessThanOrEqual(FENCE_PROBE_BUDGET_MS);
  });

  it('removes our fence when nothing is left to deny, and refuses a policy it did not write', async () => {
    const ours = renderHetznerFencePolicy({
      bucket: 'proj-abc-state',
      ownerId: OWNER,
      deniedAccessKeyIds: ['AK_S'],
    });
    const s3 = makeS3({ 'proj-abc-state': ours });
    await applyHetznerFences({
      s3,
      ownerId: OWNER,
      targets: [{ bucket: 'proj-abc-state', deniedAccessKeyIds: [] }],
      ...fakeClock(),
    });
    expect(s3.deletes).toEqual(['proj-abc-state']);

    const foreign = makeS3({
      'proj-abc-state': {
        Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject' }],
      },
    });
    await expect(
      applyHetznerFences({
        s3: foreign,
        ownerId: OWNER,
        targets: [{ bucket: 'proj-abc-state', deniedAccessKeyIds: ['AK_P'] }],
        ...fakeClock(),
      }),
    ).rejects.toThrow(/proj-abc-state has a bucket policy vibecarbon did not write/);
    expect(foreign.puts).toEqual([]);
  });

  it('(a) destroy retires the leaving key: it stays denied in every fence it was in', async () => {
    const cfg = project();
    const s3 = makeS3();
    const clock = fakeClock();
    const secrets = { get: () => undefined };
    await syncHetznerFences({
      projectConfig: cfg,
      environment: 'staging',
      s3,
      secrets,
      createProbe: async () => scriptedProbe([true]),
      ...clock,
    });
    // What destroy's revoke step does before its sync.
    Object.assign(cfg, { retiredAppKeys: ['AK_S'] });
    await syncHetznerFences({
      projectConfig: cfg,
      environment: 'staging',
      leaving: true,
      s3,
      secrets,
      createProbe: async () => scriptedProbe([true]),
      ...clock,
    });
    for (const bucket of ['proj-abc-state', 'proj-abc-backups', 'proj-abc-prod']) {
      expect(JSON.stringify(s3.policies.get(bucket)), bucket).toContain('AK_S');
    }
    expect(s3.deletes).toEqual([]);
  });

  it('(c) a replaced pasted key stays denied everywhere, the env own bucket included', () => {
    const cfg = { ...project(), retiredAppKeys: ['AK_P_OLD'] };
    const targets = byBucket(fenceTargets({ projectConfig: cfg, environment: 'prod' }));
    for (const ids of Object.values(targets)) expect(ids).toContain('AK_P_OLD');
    expect(targets['proj-abc-prod']).toEqual(['AK_P_OLD', 'AK_S']);
  });

  it('a re-run after an exhausted budget verifies again instead of trusting the unchanged policy', async () => {
    const s3 = makeS3();
    const clock = fakeClock();
    const targets = [{ bucket: 'proj-abc-state', deniedAccessKeyIds: ['AK_P'] }];
    await expect(
      applyHetznerFences({
        s3,
        ownerId: OWNER,
        targets,
        probes: { AK_P: scriptedProbe([false]) },
        ...clock,
      }),
    ).rejects.toThrow(/did not hold/);
    // Policy now unchanged: still probed, and still failing while it leaks.
    const leaking = scriptedProbe([false]);
    await expect(
      applyHetznerFences({ s3, ownerId: OWNER, targets, probes: { AK_P: leaking }, ...clock }),
    ).rejects.toThrow(/proj-abc-state.*1 denied probe/);
    expect(leaking.calls()).toBeGreaterThan(0);
    // Once it holds, one denied probe passes the unchanged fence.
    const holding = scriptedProbe([true]);
    await applyHetznerFences({ s3, ownerId: OWNER, targets, probes: { AK_P: holding }, ...clock });
    expect(holding.calls()).toBe(1);
    expect(s3.puts).toEqual(['proj-abc-state']);
  });

  it('a bucket no env finished a deploy into is skipped and named when it is confirmed gone', async () => {
    const noSuch = Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
    });
    const s3 = {
      ...makeS3(),
      getBucketPolicy: vi.fn(async () => {
        throw noSuch;
      }),
      // No region has it.
      locateBucket: vi.fn(async () => null),
    };
    const out = await applyHetznerFences({
      s3,
      ownerId: OWNER,
      targets: [{ bucket: 'proj-abc-staging', deniedAccessKeyIds: ['AK_P'], mayBeAbsent: true }],
      ...fakeClock(),
    });
    expect(out.skipped).toEqual(['proj-abc-staging']);
    // A deployed env's bucket answering NoSuchBucket (a young Hetzner bucket)
    // is never skipped silently.
    await expect(
      applyHetznerFences({
        s3,
        ownerId: OWNER,
        targets: [{ bucket: 'proj-abc-prod', deniedAccessKeyIds: ['AK_S'], mayBeAbsent: false }],
        ...fakeClock(),
      }),
    ).rejects.toThrow(/proj-abc-prod answered NoSuchBucket.*deployed environment/);
  });

  it('mayBeAbsent is true only for buckets no referencing env finished a deploy into, and never for the deploying env', () => {
    const cfg = project();
    Object.assign(cfg.environments.prod, { status: 'deployed' });
    const by = Object.fromEntries(
      fenceTargets({ projectConfig: cfg, environment: 'prod' }).map((t) => [
        t.bucket,
        t.mayBeAbsent,
      ]),
    );
    expect(by).toEqual({
      'proj-abc-backups': false,
      'proj-abc-prod': false,
      'proj-abc-staging': true,
      'proj-abc-state': false,
    });
    // The env being deployed: s3-setup just ensured its buckets.
    const deploying = fenceTargets({ projectConfig: cfg, environment: 'staging' });
    expect(deploying.every((t) => t.mayBeAbsent === false)).toBe(true);
  });
});

describe('absent fence targets on a deploy (round 2)', () => {
  const noSuch = () =>
    Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' });

  it('a first deploy whose own bucket answers NoSuchBucket is not skipped, nor looked for elsewhere: it fails with the cause', async () => {
    // prod is mid first deploy: no status, no bucketCreatedAt.
    const cfg = project({ staging: false });
    const targets = fenceTargets({ projectConfig: cfg, environment: 'prod' });
    expect(targets.every((t) => t.mayBeAbsent === false)).toBe(true);
    const s3 = {
      ...makeS3(),
      getBucketPolicy: vi.fn(async (b: string) => {
        if (b === 'proj-abc-state') throw noSuch();
        return null;
      }),
      locateBucket: vi.fn(async () => null),
    };
    await expect(
      applyHetznerFences({
        s3,
        ownerId: OWNER,
        targets,
        probes: { AK_P: scriptedProbe([true]) },
        ...fakeClock(),
      }),
    ).rejects.toThrow(/proj-abc-state answered NoSuchBucket/);
    // Its storage step just made it: HEADs in other regions could start
    // Hetzner's NoSuchBucket window on a bucket that young.
    expect(s3.locateBucket).not.toHaveBeenCalled();
  });

  it("a never-deployed other env's absent bucket is skipped, warned about, and marked for status", async () => {
    const cfg = project();
    Object.assign(cfg.environments.prod, { status: 'deployed' });
    // prod is the one deploying; staging never finished a deploy and its
    // bucket is gone.
    const s3 = {
      ...makeS3(),
      getBucketPolicy: vi.fn(async (b: string) => {
        if (b === 'proj-abc-staging') throw noSuch();
        return null;
      }),
      locateBucket: vi.fn(async () => null),
    };
    const out = await syncHetznerFences({
      projectConfig: cfg,
      environment: 'prod',
      s3,
      secrets: { get: () => undefined },
      createProbe: async () => scriptedProbe([true]),
      ...fakeClock(),
    });
    expect(out.skipped).toEqual(['proj-abc-staging']);

    // finish() warns (not info) and hands the skip back for persisting.
    const { startAppBucketFinalize } = await import('../../../src/lib/deploy/orchestrator.js');
    const finalize = startAppBucketFinalize({
      providerId: 'digitalocean',
      createProvider: async () => ({
        getBucketCorsOrigins: async () => ['https://prod.dev'],
        setBucketCors: async () => {},
      }),
      bucket: 'proj-abc-prod',
      domain: 'prod.dev',
      fence: async () => out,
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    await expect(finalize.finish(log)).resolves.toEqual({ fenceSkipped: ['proj-abc-staging'] });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/fence NOT set on proj-abc-staging/),
    );

    markUnfencedBuckets(cfg, out.skipped);
    expect(cfg.environments.staging.s3).toMatchObject({ unfencedBuckets: ['proj-abc-staging'] });
    expect(cfg.environments.prod.s3).not.toHaveProperty('unfencedBuckets');
    expect(unfencedBucketsLine(cfg.environments.staging)).toMatch(
      /^storage fence: not set on proj-abc-staging/,
    );
    // A later sync that fences everything clears the mark.
    markUnfencedBuckets(cfg, []);
    expect(unfencedBucketsLine(cfg.environments.staging)).toBeNull();
  });

  it('the deploy prints what the fence found: a bucket fenced in another region, and one no region has', async () => {
    const { startAppBucketFinalize } = await import('../../../src/lib/deploy/orchestrator.js');
    const finalize = startAppBucketFinalize({
      providerId: 'digitalocean',
      createProvider: async () => ({
        getBucketCorsOrigins: async () => ['https://prod.dev'],
        setBucketCors: async () => {},
      }),
      bucket: 'proj-abc-prod',
      domain: 'prod.dev',
      fence: async () => ({
        written: [],
        removed: [],
        unverified: [],
        skipped: [],
        gone: ['proj-abc-old'],
        located: [
          {
            bucket: 'proj-abc-staging',
            region: 'fsn1',
            onRecord: 'nbg1',
            regionFrom: { env: 'staging', live: false, recorded: true, redeploy: null },
          },
        ],
      }),
    });
    const log = { warn: vi.fn(), info: vi.fn() };
    await finalize.finish(log);
    expect(log.info.mock.calls.map((c) => c[0])).toEqual([
      "app key fence: proj-abc-staging is in fsn1, not nbg1 as destroyed staging's record says; fenced it there",
      "app key fence: nothing to fence on proj-abc-old: only a destroyed environment's record names it, and no region has it now",
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('each bucket is fenced in its own region (Task 5)', () => {
  const BASE = 'proj-abc-backups';
  const FSN1 = 'proj-abc-fsn1-backups';
  /** Where each bucket lives: a store asked anywhere else answers NoSuchBucket. */
  const WHERE: Record<string, string> = {
    'proj-abc-state': 'nbg1',
    [BASE]: 'nbg1',
    'proj-abc-prod': 'nbg1',
    [FSN1]: 'fsn1',
    'proj-abc-staging': 'fsn1',
  };
  /** Every bucket the world holds: WHERE, plus the ones later cases add. */
  const PLACES: Record<string, string> = {
    ...WHERE,
    'proj-abc-qa': 'nbg1',
    'proj-abc-old': 'fsn1',
    'proj-abc-nbg1-backups': 'nbg1',
  };

  /** A deployed environment with a pasted key, its uploads and backups in `region`. */
  const fencedEnv = (name: string, id: string, region: string, backups: string) => ({
    provider: 'hetzner',
    envName: name,
    status: 'deployed',
    s3: {
      bucket: `proj-abc-${name}`,
      region,
      stateBucket: 'proj-abc-state',
      stateBucketRegion: 'nbg1',
      appKey: { id, scoping: 'paste-fence', tier: 'fenced' },
    },
    backupS3: { bucket: backups, region, endpoint: `https://${region}.your-objectstorage.com` },
  });

  type Project = {
    projectName: string;
    /** The base backups bucket an older CLI's env uses derives from it. */
    bucketSalt?: string;
    environments: Record<string, ReturnType<typeof fencedEnv> | Record<string, unknown>>;
    destroyedEnvironments?: Record<string, Record<string, unknown>>;
    retiredAppKeys?: string[];
  };

  /**
   * Two storage regions: prod in nbg1 with the base backups bucket, staging
   * in fsn1 with fsn1's own, and the one state bucket in nbg1. Staging is
   * listed first, so the state bucket's region must come from
   * stateBucketRegion, not from staging's uploads region.
   */
  function twoRegions(): Project {
    return {
      projectName: 'proj',
      bucketSalt: 'abc',
      environments: {
        staging: fencedEnv('staging', 'AK_S', 'fsn1', FSN1),
        prod: fencedEnv('prod', 'AK_P', 'nbg1', BASE),
      },
    };
  }

  /**
   * What `vibecarbon destroy <env>` leaves in the project file: the key
   * retired, and the environment's identity under destroyedEnvironments
   * (with `backupsPurged` and `appBucketPurged` after a -purge that removed
   * its backups and deleted its app bucket). `marked: false` is a -purge by
   * a CLI from before `appBucketPurged`.
   */
  function destroyed(cfg: Project, env: string, { purge = false, marked = purge } = {}) {
    const live = cfg.environments[env] as ReturnType<typeof fencedEnv>;
    cfg.retiredAppKeys = [...(cfg.retiredAppKeys ?? []), live.s3.appKey.id];
    cfg.destroyedEnvironments = {
      ...(cfg.destroyedEnvironments ?? {}),
      [env]: {
        ...envIdentityOf(live),
        ...(purge && { backupsPurged: true }),
        ...(marked && { appBucketPurged: true }),
        destroyedAt: '2026-11-11T00:00:00.000Z',
      },
    };
    delete cfg.environments[env];
    return cfg;
  }

  const noSuchBucket = () =>
    Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' });

  /** The fake store's state: policies, the call log, buckets deleted, and buckets answering two ways. */
  type World = {
    calls: string[];
    policies: Map<string, object>;
    gone?: Set<string>;
    flaky?: Set<string>;
  };
  const newWorld = (extra: Partial<World> = {}): World => ({
    calls: [],
    policies: new Map(),
    ...extra,
  });

  /**
   * The infra key's store at `region`, as Hetzner answers it: a bucket of
   * another region is not there. Every call is logged as `<op> <bucket>@<region>`.
   */
  function storeAt(region: string, world: World) {
    const there = (bucket: string) => PLACES[bucket] === region && !world.gone?.has(bucket);
    const here = (bucket: string) => {
      if (!there(bucket)) throw noSuchBucket();
    };
    return {
      region,
      forRegion: (r: string) => storeAt(r, world),
      ownerId: async () => OWNER,
      getBucketPolicy: vi.fn(async (bucket: string) => {
        world.calls.push(`get ${bucket}@${region}`);
        here(bucket);
        // A Hetzner store can answer one bucket two ways for a while.
        if (world.flaky?.has(bucket)) throw noSuchBucket();
        return world.policies.get(bucket) ?? null;
      }),
      // Every region is asked (S3CompatibleProvider.locateBucket), whatever
      // region this store is at.
      locateBucket: vi.fn(async (bucket: string) => {
        world.calls.push(`locate ${bucket}`);
        return PLACES[bucket] && !world.gone?.has(bucket) ? PLACES[bucket] : null;
      }),
      putBucketPolicy: vi.fn(async (bucket: string, policy: object) => {
        world.calls.push(`put ${bucket}@${region}`);
        here(bucket);
        world.policies.set(bucket, policy);
      }),
      deleteBucketPolicy: vi.fn(async (bucket: string) => {
        world.calls.push(`delete ${bucket}@${region}`);
        here(bucket);
        world.policies.delete(bucket);
      }),
    };
  }

  /**
   * A fenced key's probe at `region`. Asked about a bucket of another region it
   * gets a 404, which is no denial (isDeniedOn counts only a 403).
   */
  function probeAt(region: string, asked: string[]) {
    return {
      forRegion: (r: string) => probeAt(r, asked),
      isDeniedOn: vi.fn(async (bucket: string) => {
        asked.push(`${bucket}@${region}`);
        return PLACES[bucket] === region;
      }),
    };
  }

  /** Both pasted keys stored on this machine, as `configure storage` saves them. */
  const bothKeys = () =>
    keysFor([
      ['prod', 'AK_P'],
      ['staging', 'AK_S'],
    ]);
  function keysFor(pairs: string[][]) {
    const store: Record<string, string> = {};
    for (const [env, id] of pairs) {
      const names = appStorageSecretKeys(env);
      store[names.accessKey] = id;
      store[names.secretKey] = `SENTINEL_${id}_SK`;
    }
    return { get: (k: string) => store[k] };
  }

  /** Each logged `<what> <bucket>@<region>` names its bucket's own region. */
  /** Calls made outside the bucket's own region (a locate asks every region, so it never is). */
  const inOwnRegion = (entries: string[]) =>
    entries.filter((e) => {
      if (e.startsWith('locate ')) return false;
      const [bucket, region] = (e.split(' ').at(-1) ?? '').split('@');
      return PLACES[bucket] !== region;
    });

  it('fenceTargets names each bucket with its own region', () => {
    const regions = Object.fromEntries(
      fenceTargets({ projectConfig: twoRegions(), environment: 'staging' }).map((t) => [
        t.bucket,
        t.region,
      ]),
    );
    expect(regions).toEqual(WHERE);
  });

  it('a deploy in fsn1 reads, writes and probes every fence at its bucket’s own region', async () => {
    const world = { calls: [] as string[], policies: new Map<string, object>() };
    const asked: string[] = [];
    // The deploy builds both clients at its own storage region (fsn1).
    const out = await syncHetznerFences({
      projectConfig: twoRegions(),
      environment: 'staging',
      s3: storeAt('fsn1', world),
      secrets: bothKeys(),
      createProbe: async () => probeAt('fsn1', asked),
      ...fakeClock(),
    });
    expect(out.written.sort()).toEqual(Object.keys(WHERE).sort());
    expect(world.calls.length).toBeGreaterThan(0);
    expect(inOwnRegion(world.calls)).toEqual([]);
    // Every bucket was probed, each at its own region.
    expect(new Set(asked.map((e) => e.split('@')[0]))).toEqual(new Set(Object.keys(WHERE)));
    expect(inOwnRegion(asked)).toEqual([]);
  });

  it('a destroy of staging (its client in fsn1) fences prod’s nbg1 buckets in nbg1', async () => {
    const world = { calls: [] as string[], policies: new Map<string, object>() };
    const asked: string[] = [];
    const cfg = { ...twoRegions(), retiredAppKeys: ['AK_S'] };
    const out = await syncHetznerFences({
      projectConfig: cfg,
      environment: 'staging',
      leaving: true,
      s3: storeAt('fsn1', world),
      secrets: bothKeys(),
      createProbe: async () => probeAt('fsn1', asked),
      ...fakeClock(),
    });
    expect(out.written.sort()).toEqual([BASE, 'proj-abc-prod', 'proj-abc-state']);
    expect(inOwnRegion(world.calls)).toEqual([]);
    expect(inOwnRegion(asked)).toEqual([]);
  });

  it('a target an older CLI recorded without a region goes to the client it was given', async () => {
    // No region anywhere in the record: the target says so with null.
    const old = {
      projectName: 'proj',
      environments: {
        prod: {
          s3: {
            bucket: 'proj-abc-prod',
            stateBucket: 'proj-abc-state',
            appKey: { id: 'AK_P', scoping: 'paste-fence', tier: 'fenced' },
          },
          backupS3: { bucket: BASE },
        },
      },
    };
    const targets = fenceTargets({ projectConfig: old, environment: 'prod' });
    expect(targets.map((t) => t.region)).toEqual([null, null, null]);

    const s3 = { ...makeS3(), forRegion: vi.fn() };
    const probe = { ...scriptedProbe([true]), forRegion: vi.fn() };
    await applyHetznerFences({
      s3,
      ownerId: OWNER,
      targets,
      probes: { AK_P: probe },
      ...fakeClock(),
    });
    expect(s3.forRegion).not.toHaveBeenCalled();
    expect(probe.forRegion).not.toHaveBeenCalled();
    expect(s3.puts.sort()).toEqual([BASE, 'proj-abc-state']);
    expect(probe.calls()).toBeGreaterThan(0);
  });

  it('a bucket noted twice keeps the first region on record', () => {
    // An older env with no regions shares the base backups bucket with prod,
    // whose record knows it lives in nbg1.
    const cfg = twoRegions();
    cfg.environments = {
      old: { s3: { bucket: 'proj-abc-old' }, backupS3: { bucket: BASE } },
      ...cfg.environments,
    };
    const target = fenceTargets({ projectConfig: cfg, environment: 'prod' }).find(
      (t) => t.bucket === BASE,
    );
    expect(target?.region).toBe('nbg1');
  });

  /** The key ids our fence policy on `bucket` denies, sorted. */
  const deniedOn = (world: World, bucket: string) =>
    (
      (world.policies.get(bucket) as { Statement: { Principal: { AWS: string[] } }[] } | undefined)
        ?.Statement[0].Principal.AWS ?? []
    )
      .map((p) => p.split(':').at(-1))
      .sort();

  /** prod and a new qa deploy their pasted keys in nbg1 after `destroy staging`. */
  function afterStagingDestroyed({ purge = false, marked = purge } = {}) {
    const cfg = destroyed(twoRegions(), 'staging', { purge, marked });
    cfg.environments.qa = fencedEnv('qa', 'AK_Q', 'nbg1', BASE);
    return cfg;
  }
  const qaKeys = () =>
    keysFor([
      ['prod', 'AK_P'],
      ['qa', 'AK_Q'],
    ]);

  it('a backups bucket a plain destroy kept stays fenced at its own region, against a key pasted later', async () => {
    const world = newWorld();
    const asked: string[] = [];
    const out = await syncHetznerFences({
      projectConfig: afterStagingDestroyed(),
      environment: 'qa',
      s3: storeAt('nbg1', world),
      secrets: qaKeys(),
      createProbe: async () => probeAt('nbg1', asked),
      ...fakeClock(),
    });
    // fsn1's bucket still holds staging's backups: every pasted key, the
    // retired one included, is denied there, in fsn1.
    expect(world.calls).toContain(`put ${FSN1}@fsn1`);
    expect(deniedOn(world, FSN1)).toEqual(['AK_P', 'AK_Q', 'AK_S']);
    expect(asked).toContain(`${FSN1}@fsn1`);
    expect(out.written).toContain(FSN1);
    expect(inOwnRegion(world.calls)).toEqual([]);
    expect(inOwnRegion(asked)).toEqual([]);
  });

  it('the app bucket a plain destroy kept stays fenced at its own region, its own retired key included', async () => {
    const world = newWorld();
    await syncHetznerFences({
      projectConfig: afterStagingDestroyed(),
      environment: 'qa',
      s3: storeAt('nbg1', world),
      secrets: qaKeys(),
      createProbe: async () => probeAt('nbg1', []),
      ...fakeClock(),
    });
    // No live environment owns it any more, so no key is let through.
    expect(world.calls).toContain('put proj-abc-staging@fsn1');
    expect(deniedOn(world, 'proj-abc-staging')).toEqual(['AK_P', 'AK_Q', 'AK_S']);
  });

  it('after a -purge, the purged backups bucket and the deleted app bucket are never read again', async () => {
    const world = newWorld({ gone: new Set([FSN1, 'proj-abc-staging']) });
    const out = await syncHetznerFences({
      projectConfig: afterStagingDestroyed({ purge: true }),
      environment: 'qa',
      s3: storeAt('nbg1', world),
      secrets: qaKeys(),
      createProbe: async () => probeAt('nbg1', []),
      ...fakeClock(),
    });
    // The record says -purge deleted both: no read, no locate, nothing to say.
    expect(world.calls.filter((c) => c.includes(FSN1) || c.includes('proj-abc-staging'))).toEqual(
      [],
    );
    expect(out.gone).toEqual([]);
    expect(out.skipped).toEqual([]);
    expect(fenceInfoLines(out)).toEqual([]);
  });

  it('a -purge from before the mark: the app bucket is looked for in every region, and one in none is reported', async () => {
    const world = newWorld({ gone: new Set([FSN1, 'proj-abc-staging']) });
    const out = await syncHetznerFences({
      projectConfig: afterStagingDestroyed({ purge: true, marked: false }),
      environment: 'qa',
      s3: storeAt('nbg1', world),
      secrets: qaKeys(),
      createProbe: async () => probeAt('nbg1', []),
      ...fakeClock(),
    });
    expect(world.calls).toEqual(
      expect.arrayContaining(['get proj-abc-staging@fsn1', 'locate proj-abc-staging']),
    );
    // Nothing to fence, and not a skip to warn about (that is for a live
    // environment's bucket), but never silent.
    expect(out.gone).toEqual(['proj-abc-staging']);
    expect(out.skipped).toEqual([]);
    expect(fenceInfoLines(out)).toEqual([
      "app key fence: nothing to fence on proj-abc-staging: only a destroyed environment's record names it, and no region has it now",
    ]);
  });

  it('N1: a kept app bucket whose destroyed record names the wrong region (the old bug) is fenced where it is', async () => {
    // staging was destroyed before a deploy repaired its record: the record
    // says nbg1, the bucket and its uploads are in fsn1.
    const cfg = twoRegions();
    (cfg.environments.staging as ReturnType<typeof fencedEnv>).s3.region = 'nbg1';
    destroyed(cfg, 'staging');
    cfg.environments.qa = fencedEnv('qa', 'AK_Q', 'nbg1', BASE);
    const world = newWorld();
    const asked: string[] = [];
    const out = await syncHetznerFences({
      projectConfig: cfg,
      environment: 'qa',
      s3: storeAt('nbg1', world),
      secrets: qaKeys(),
      createProbe: async () => probeAt('nbg1', asked),
      ...fakeClock(),
    });
    expect(world.calls).toEqual(
      expect.arrayContaining([
        'get proj-abc-staging@nbg1',
        'locate proj-abc-staging',
        'put proj-abc-staging@fsn1',
      ]),
    );
    expect(deniedOn(world, 'proj-abc-staging')).toEqual(['AK_P', 'AK_Q', 'AK_S']);
    expect(asked).toContain('proj-abc-staging@fsn1');
    expect(out.gone).toEqual([]);
    expect(fenceInfoLines(out)).toEqual([
      "app key fence: proj-abc-staging is in fsn1, not nbg1 as destroyed staging's record says; fenced it there",
    ]);
  });

  it('an older CLI’s environment with no backups record keeps the base bucket fenced in its uploads region', () => {
    const cfg: Project = {
      projectName: 'proj',
      bucketSalt: 'abc',
      environments: {
        old: {
          status: 'deployed',
          deployedAt: '2026-01-01T00:00:00.000Z',
          s3: { bucket: 'proj-abc-old', region: 'fsn1' },
        },
        qa: fencedEnv('qa', 'AK_Q', 'nbg1', 'proj-abc-nbg1-backups'),
      },
    };
    const target = fenceTargets({ projectConfig: cfg, environment: 'qa' }).find(
      (t) => t.bucket === BASE,
    );
    expect(target).toMatchObject({ region: 'fsn1', deniedAccessKeyIds: ['AK_Q'] });
  });

  it('a region a record states beats one inferred from an uploads region, whichever is listed first', () => {
    // `old` predates stateBucketRegion and backups records: both its state
    // and its base-bucket regions are its uploads region, fsn1, a guess.
    const cfg = twoRegions();
    cfg.environments = {
      old: {
        status: 'deployed',
        deployedAt: '2026-01-01T00:00:00.000Z',
        s3: { bucket: 'proj-abc-old', region: 'fsn1', stateBucket: 'proj-abc-state' },
      },
      ...cfg.environments,
    };
    const regions = Object.fromEntries(
      fenceTargets({ projectConfig: cfg, environment: 'prod' }).map((t) => [t.bucket, t.region]),
    );
    expect(regions).toMatchObject({ 'proj-abc-state': 'nbg1', [BASE]: 'nbg1' });
  });

  it('M1: a bucket found where it answered NoSuchBucket is the store answering two ways, never a skip', async () => {
    // nbg1 answers the policy read with NoSuchBucket, and the locate's
    // HeadBucket finds the bucket in nbg1.
    const world = newWorld({ flaky: new Set([BASE]) });
    await expect(
      applyHetznerFences({
        s3: storeAt('fsn1', world),
        ownerId: OWNER,
        targets: [
          { bucket: BASE, region: 'nbg1', deniedAccessKeyIds: ['AK_P'], mayBeAbsent: true },
        ],
        ...fakeClock(),
      }),
    ).rejects.toThrow(
      /proj-abc-backups answered NoSuchBucket in nbg1.*HeadBucket in nbg1 finds it/,
    );
    expect(world.calls).toEqual([`get ${BASE}@nbg1`, `locate ${BASE}`]);
  });

  it('M1: a fence nothing needs any more is removed in the bucket’s own region', async () => {
    const world = newWorld();
    world.policies.set(
      BASE,
      renderHetznerFencePolicy({ bucket: BASE, ownerId: OWNER, deniedAccessKeyIds: ['AK_GONE'] }),
    );
    const out = await applyHetznerFences({
      s3: storeAt('fsn1', world),
      ownerId: OWNER,
      targets: [{ bucket: BASE, region: 'nbg1', deniedAccessKeyIds: [] }],
      ...fakeClock(),
    });
    expect(out.removed).toEqual([BASE]);
    expect(world.calls).toEqual([`get ${BASE}@nbg1`, `delete ${BASE}@nbg1`]);
  });

  it('M2: a live environment’s record that names the wrong region (the old bug) does not fail another deploy: the bucket is fenced where it is', async () => {
    // staging's record still names nbg1 for its fsn1 bucket; prod deploys.
    const cfg = twoRegions();
    (cfg.environments.staging as ReturnType<typeof fencedEnv>).s3.region = 'nbg1';
    const world = newWorld();
    const out = await syncHetznerFences({
      projectConfig: cfg,
      environment: 'prod',
      s3: storeAt('nbg1', world),
      secrets: { get: () => undefined },
      createProbe: async () => probeAt('nbg1', []),
      ...fakeClock(),
    });
    expect(world.calls).toContain('put proj-abc-staging@fsn1');
    // staging's own key is still let through on its own bucket.
    expect(deniedOn(world, 'proj-abc-staging')).toEqual(['AK_P']);
    expect(fenceInfoLines(out)).toEqual([
      "app key fence: proj-abc-staging is in fsn1, not nbg1 as staging's record says; fenced it there",
    ]);
  });

  it('N2: only the deploying environment’s own bucket is offered the caught-up reading, and it is never looked for elsewhere', async () => {
    // prod deploys, and its own bucket answers NoSuchBucket where its
    // storage step just made or found it.
    const world = newWorld({ gone: new Set(['proj-abc-prod']) });
    const err = await syncHetznerFences({
      projectConfig: twoRegions(),
      environment: 'prod',
      s3: storeAt('nbg1', world),
      secrets: { get: () => undefined },
      createProbe: async () => probeAt('nbg1', []),
      ...fakeClock(),
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "bucket proj-abc-prod answered NoSuchBucket in nbg1, the region prod's record names for it, while its app key fence was read (The specified bucket does not exist). This deploy's storage step made or found it there just now, so it was not skipped: Hetzner most likely has not caught up with it yet. Deploy again in a few minutes.",
    );
    expect(world.calls.filter((c) => c.startsWith('locate'))).toEqual([]);

    // staging's bucket, gone from every region while staging is deployed:
    // nothing this deploy made, so no caught-up reading.
    const other = await syncHetznerFences({
      projectConfig: twoRegions(),
      environment: 'prod',
      s3: storeAt('nbg1', newWorld({ gone: new Set(['proj-abc-staging']) })),
      secrets: { get: () => undefined },
      createProbe: async () => probeAt('nbg1', []),
      ...fakeClock(),
    }).catch((e: Error) => e);
    expect((other as Error).message).toBe(
      "bucket proj-abc-staging answered NoSuchBucket in fsn1, the region staging's record names for it, while its app key fence was read (The specified bucket does not exist), and no region has it. A deployed environment uses it, so it was not skipped. Deploy staging again: its deploy records the bucket it uses from now on, making it if needed.",
    );
    expect((other as Error).message).not.toMatch(/moments ago|caught up|young/);
  });

  /** `old` predates backups records: it archives into the base bucket, its region a stand-in. */
  const withOlderCliEnv = (): Project => ({
    projectName: 'proj',
    bucketSalt: 'abc',
    environments: {
      old: {
        status: 'deployed',
        deployedAt: '2026-01-01T00:00:00.000Z',
        s3: { bucket: 'proj-abc-old', region: 'fsn1' },
      },
      qa: fencedEnv('qa', 'AK_Q', 'nbg1', 'proj-abc-nbg1-backups'),
    },
  });

  it('N3: an older CLI’s base bucket outside its stand-in region stays fenced, where it is', async () => {
    // The base bucket holds old's earlier backups in nbg1, not old's uploads
    // region fsn1.
    const world = newWorld();
    const out = await syncHetznerFences({
      projectConfig: withOlderCliEnv(),
      environment: 'qa',
      s3: storeAt('nbg1', world),
      secrets: keysFor([['qa', 'AK_Q']]),
      createProbe: async () => probeAt('nbg1', []),
      ...fakeClock(),
    });
    expect(world.calls).toEqual(
      expect.arrayContaining([`get ${BASE}@fsn1`, `locate ${BASE}`, `put ${BASE}@nbg1`]),
    );
    expect(deniedOn(world, BASE)).toEqual(['AK_Q']);
    expect(fenceInfoLines(out)).toEqual([
      "app key fence: proj-abc-backups is in nbg1, not old's uploads region fsn1; fenced it there",
    ]);
  });

  it('a bucket no record names a region for is looked for from the client’s own region, and fenced where it is', async () => {
    const world = newWorld();
    const out = await applyHetznerFences({
      s3: storeAt('fsn1', world),
      ownerId: OWNER,
      targets: [
        {
          bucket: BASE,
          region: null,
          deniedAccessKeyIds: ['AK_P'],
          regionFrom: { env: 'old', live: true, recorded: false, redeploy: 'old' },
        },
      ],
      ...fakeClock(),
    });
    expect(world.calls).toEqual([
      `get ${BASE}@fsn1`,
      `locate ${BASE}`,
      `get ${BASE}@nbg1`,
      `put ${BASE}@nbg1`,
    ]);
    expect(fenceInfoLines(out)).toEqual([
      'app key fence: proj-abc-backups is in nbg1, and no record names its region; fenced it there',
    ]);
  });

  it('N3: an older CLI’s base bucket in no region fails with what its deploy will do, not a promise to find it', async () => {
    const err = await syncHetznerFences({
      projectConfig: withOlderCliEnv(),
      environment: 'qa',
      s3: storeAt('nbg1', newWorld({ gone: new Set([BASE]) })),
      secrets: { get: () => undefined },
      createProbe: async () => probeAt('nbg1', []),
      ...fakeClock(),
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "bucket proj-abc-backups answered NoSuchBucket in fsn1, old's uploads region (no record names a region for this bucket), while its app key fence was read (The specified bucket does not exist), and no region has it. A deployed environment uses it, so it was not skipped. Deploy old again: its deploy records the bucket it uses from now on, making it if needed.",
    );
    expect((err as Error).message).not.toMatch(/young|moments ago|caught up/);
  });

  it('M2: when a destroyed environment’s record gave the wrong region, the bucket is fenced where it is, and a fix names the live environment that uses it', async () => {
    // `old` uses the base bucket with no record (a stand-in region); destroyed
    // staging's record states hel1 for it, which wins as a stated region but
    // is wrong. Deploying staging again would make a new environment, so the
    // message says to deploy old, whose record then states the region.
    const cfg: Project = {
      projectName: 'proj',
      bucketSalt: 'abc',
      environments: {
        old: {
          status: 'deployed',
          deployedAt: '2026-01-01T00:00:00.000Z',
          s3: { bucket: 'proj-abc-old', region: 'fsn1' },
        },
      },
      destroyedEnvironments: {
        staging: {
          s3: { bucket: 'proj-abc-staging', region: 'fsn1' },
          backupS3: { bucket: BASE, region: 'hel1' },
          destroyedAt: '2026-11-11T00:00:00.000Z',
        },
      },
    };
    expect(
      fenceTargets({ projectConfig: cfg, environment: 'old' }).find((t) => t.bucket === BASE),
    ).toMatchObject({
      region: 'hel1',
      mayBeAbsent: false,
      live: true,
      regionFrom: { env: 'staging', live: false, recorded: true, redeploy: 'old' },
    });
    // A deploy of qa, not old: old's buckets are not this deploy's.
    cfg.environments.qa = fencedEnv('qa', 'AK_Q', 'nbg1', 'proj-abc-nbg1-backups');
    const sync = (world: World) =>
      syncHetznerFences({
        projectConfig: cfg,
        environment: 'qa',
        s3: storeAt('nbg1', world),
        secrets: { get: () => undefined },
        createProbe: async () => probeAt('nbg1', []),
        ...fakeClock(),
      });
    // In nbg1 after all: fenced there, and the wrong record is reported.
    const out = await sync(newWorld());
    expect(fenceInfoLines(out)).toEqual([
      "app key fence: proj-abc-backups is in nbg1, not hel1 as destroyed staging's record says; fenced it there",
    ]);
    // In no region: the fix names old.
    const err = await sync(newWorld({ gone: new Set([BASE]) })).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "bucket proj-abc-backups answered NoSuchBucket in hel1, the region destroyed staging's record names for it, while its app key fence was read (The specified bucket does not exist), and no region has it. A deployed environment uses it, so it was not skipped. Deploy old again: its deploy records the bucket it uses from now on, making it if needed.",
    );
  });
});

describe('(b) a fenced env whose key is not on this machine', () => {
  it('refuses the deploy rather than downgrade to shared', async () => {
    await expect(
      resolveAppStorageCredential({
        provider: 'hetzner',
        environment: 'prod',
        envConfig: { s3: { appKey: { id: 'AK_P', scoping: 'paste-fence', tier: 'fenced' } } },
        bucket: 'proj-abc-prod',
        infraCredential: {
          accessKey: 'SENTINEL_INFRA_AK',
          secretKey: 'SENTINEL_INFRA_SK',
          endpoint: 'https://fsn1.your-objectstorage.com',
        },
        secrets: { get: () => undefined, set: vi.fn() },
      }),
    ).rejects.toThrow(
      /prod is fenced with pasted app storage key AK_P, but that key is not stored on this machine/,
    );
  });

  it('a re-paste of a different key returns the old id to retire', async () => {
    const names = appStorageSecretKeys('prod');
    const store: Record<string, string> = {
      [names.accessKey]: 'AK_P_NEW',
      [names.secretKey]: 'SENTINEL_NEW_SK',
    };
    const out = await resolveAppStorageCredential({
      provider: 'hetzner',
      environment: 'prod',
      envConfig: { s3: { appKey: { id: 'AK_P', scoping: 'paste-fence', tier: 'fenced' } } },
      bucket: 'proj-abc-prod',
      infraCredential: {
        accessKey: 'SENTINEL_INFRA_AK',
        secretKey: 'SENTINEL_INFRA_SK',
        endpoint: 'https://fsn1.your-objectstorage.com',
      },
      secrets: { get: (k: string) => store[k], set: vi.fn() },
    });
    expect(out.retire).toBe('AK_P');
    expect(out.record).toEqual({ id: 'AK_P_NEW', scoping: 'paste-fence', tier: 'fenced' });
  });
});

describe('configure storage -forget', () => {
  it('removes a retired id, refuses one still in use, and the next fence drops it', async () => {
    const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'vc-forget-'));
    const cwd = process.cwd();
    const cfg = { ...project(), retiredAppKeys: ['AK_OLD', 'AK_OTHER'] };
    writeFileSync(join(dir, '.vibecarbon.json'), JSON.stringify(cfg));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      process.chdir(dir);
      const { runForgetAppStorageKey } = await import('../../../src/configure.js');
      await runForgetAppStorageKey('AK_OLD');
      const saved = JSON.parse(readFileSync(join(dir, '.vibecarbon.json'), 'utf-8'));
      expect(saved.retiredAppKeys).toEqual(['AK_OTHER']);
      for (const t of fenceTargets({ projectConfig: saved, environment: 'prod' })) {
        expect(t.deniedAccessKeyIds).not.toContain('AK_OLD');
      }
      await expect(runForgetAppStorageKey('AK_P')).rejects.toThrow('exit');
    } finally {
      process.chdir(cwd);
      exit.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('without a pasted key', () => {
  it('no policy is written, and the tier is shared with reason "hetzner: no app key pasted"', async () => {
    const send = vi.fn();
    const out = await resolveAppStorageCredential({
      provider: 'hetzner',
      environment: 'prod',
      envConfig: {},
      bucket: 'proj-abc-prod',
      infraCredential: {
        accessKey: 'SENTINEL_INFRA_AK',
        secretKey: 'SENTINEL_INFRA_SK',
        endpoint: 'https://fsn1.your-objectstorage.com',
      },
      secrets: { get: () => undefined, set: send },
    });
    expect(out).toMatchObject({
      tier: 'shared',
      reason: 'hetzner: no app key pasted',
      record: null,
      accessKey: 'SENTINEL_INFRA_AK',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('a pasted key turns the env fenced, and the deploy key itself is refused', async () => {
    const names = appStorageSecretKeys('prod');
    expect(names.accessKey.startsWith(APP_STORAGE_SECRET_PREFIX)).toBe(true);
    const store: Record<string, string> = {
      [names.accessKey]: 'SENTINEL_APP_AK',
      [names.secretKey]: 'SENTINEL_APP_SK',
    };
    const args = {
      provider: 'hetzner',
      environment: 'prod',
      envConfig: {},
      bucket: 'proj-abc-prod',
      infraCredential: {
        accessKey: 'SENTINEL_INFRA_AK',
        secretKey: 'SENTINEL_INFRA_SK',
        endpoint: 'https://fsn1.your-objectstorage.com',
      },
      secrets: { get: (k: string) => store[k], set: vi.fn() },
    };
    const out = await resolveAppStorageCredential(args);
    expect(out).toMatchObject({
      tier: 'fenced',
      accessKey: 'SENTINEL_APP_AK',
      record: { id: 'SENTINEL_APP_AK', scoping: 'paste-fence', tier: 'fenced' },
    });
    expect(JSON.stringify(out.record)).not.toContain('SENTINEL_APP_SK');
    store[names.accessKey] = 'SENTINEL_INFRA_AK';
    await expect(resolveAppStorageCredential(args)).rejects.toThrow(/deploy's own key/);
  });
});
