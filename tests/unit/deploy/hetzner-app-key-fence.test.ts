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
