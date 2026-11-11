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
  fenceTargets,
  renderHetznerFencePolicy,
} from '../../../src/lib/deploy/hetzner-app-key-fence.js';

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
      bucketExists: vi.fn(async () => false),
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

  it('a first deploy whose own bucket answers NoSuchBucket and HeadBucket 404 is not skipped: it fails with the cause', async () => {
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
      bucketExists: vi.fn(async () => false),
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
      bucketExists: vi.fn(async (b: string) => b !== 'proj-abc-staging'),
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

  /**
   * Two storage regions: prod in nbg1 with the base backups bucket, staging
   * in fsn1 with fsn1's own, and the one state bucket in nbg1. Staging is
   * listed first, so the state bucket's region must come from
   * stateBucketRegion, not from staging's uploads region.
   */
  function twoRegions() {
    const env = (name: string, id: string, region: string, backups: string) => ({
      provider: 'hetzner',
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
    return {
      projectName: 'proj',
      environments: {
        staging: env('staging', 'AK_S', 'fsn1', FSN1),
        prod: env('prod', 'AK_P', 'nbg1', BASE),
      },
    } as {
      projectName: string;
      environments: Record<string, ReturnType<typeof env> | Record<string, unknown>>;
      retiredAppKeys?: string[];
    };
  }

  const noSuchBucket = () =>
    Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' });

  /**
   * The infra key's store at `region`, as Hetzner answers it: a bucket of
   * another region is not there. Every call is logged as `<op> <bucket>@<region>`.
   */
  function storeAt(region: string, world: { calls: string[]; policies: Map<string, object> }) {
    const here = (bucket: string) => {
      if (WHERE[bucket] !== region) throw noSuchBucket();
    };
    return {
      region,
      forRegion: (r: string) => storeAt(r, world),
      ownerId: async () => OWNER,
      getBucketPolicy: vi.fn(async (bucket: string) => {
        world.calls.push(`get ${bucket}@${region}`);
        here(bucket);
        return world.policies.get(bucket) ?? null;
      }),
      bucketExists: vi.fn(async (bucket: string) => {
        world.calls.push(`head ${bucket}@${region}`);
        return WHERE[bucket] === region;
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
        return WHERE[bucket] === region;
      }),
    };
  }

  /** Both pasted keys stored on this machine, as `configure storage` saves them. */
  function bothKeys() {
    const store: Record<string, string> = {};
    for (const [env, id] of [
      ['prod', 'AK_P'],
      ['staging', 'AK_S'],
    ]) {
      const names = appStorageSecretKeys(env);
      store[names.accessKey] = id;
      store[names.secretKey] = `SENTINEL_${id}_SK`;
    }
    return { get: (k: string) => store[k] };
  }

  /** Each logged `<what> <bucket>@<region>` names its bucket's own region. */
  const inOwnRegion = (entries: string[]) =>
    entries.filter((e) => {
      const [bucket, region] = (e.split(' ').at(-1) ?? '').split('@');
      return WHERE[bucket] !== region;
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
