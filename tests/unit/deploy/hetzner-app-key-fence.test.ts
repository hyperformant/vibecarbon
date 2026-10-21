/**
 * The Hetzner app-key deny-fence (security plan R2, Task 4; Review Focus 7).
 * Sentinel key ids only.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  APP_STORAGE_SECRET_PREFIX,
  appStorageSecretKeys,
  resolveAppStorageCredential,
  syncHetznerFences,
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

  it('destroying staging takes AK_S out of every remaining fence', () => {
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

  it('syncHetznerFences on destroy takes the leaving key out of every fence it wrote', async () => {
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
    await syncHetznerFences({
      projectConfig: cfg,
      environment: 'staging',
      leaving: true,
      s3,
      secrets,
      createProbe: async () => scriptedProbe([true]),
      ...clock,
    });
    for (const [bucket, policy] of s3.policies) {
      expect(JSON.stringify(policy), bucket).not.toContain('AK_S');
    }
    expect(s3.deletes).toEqual(['proj-abc-prod']);
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
