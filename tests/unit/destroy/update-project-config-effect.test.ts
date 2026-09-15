/**
 * M3 Task 9f fix round 2 — `updateProjectConfigEffect` must NOT remove an
 * environment's `.vibecarbon.json` entry when its k8s Pulumi destroy
 * couldn't be verified (`ctx.results.pulumiDestroyFailed`, set by
 * recordPulumiDestroyOutcome / destroyK8sTier's catch — see
 * record-pulumi-destroy-outcome.test.ts).
 *
 * Why this matters beyond just "don't remove tracked state": a second
 * `vibecarbon destroy <env>` after the entry was wiped falls through to
 * orphan-stack handling (never targets the env normally), AND
 * recordPulumiDestroyOutcome's `hasRecordedInfra` check would see NO
 * envConfig for a second call and wave a still-broken destroy through as a
 * quiet "(all via Pulumi)" success — right past the state bucket the
 * round-1 fix preserved specifically so a retry could use it.
 *
 * Exercises the effect directly via DESTROY_EFFECTS (matches
 * destroy-plan.test.ts's own access pattern) rather than driving the whole
 * plan/CLI, with `lib/config.js`'s `saveProjectConfig` mocked so no real
 * file write happens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const saveProjectConfigMock = vi.fn();

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    saveProjectConfig: (...a: unknown[]) => saveProjectConfigMock(...a),
  };
});

const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');

function fakeSpinner() {
  return { start: vi.fn(), stop: vi.fn() };
}

function makeCtx(overrides: { pulumiDestroyFailed: boolean }) {
  return {
    projectConfig: {
      projectName: 'proj',
      environments: { prod: { deployMode: 'kubernetes', status: 'deployed' } },
    },
    environment: 'prod',
    spinner: fakeSpinner(),
    results: {
      leaks: createLeakLedger(),
      pulumiDestroyFailed: overrides.pulumiDestroyFailed,
    },
  };
}

describe('updateProjectConfigEffect (DESTROY_EFFECTS.updateProjectConfig)', () => {
  beforeEach(() => {
    saveProjectConfigMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the environment entry and calls saveProjectConfig when pulumiDestroyFailed is false (unchanged behavior)', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(saveProjectConfigMock).toHaveBeenCalledTimes(1);
    const savedConfig = saveProjectConfigMock.mock.calls[0][0];
    expect(savedConfig.environments).not.toHaveProperty('prod');
    expect(ctx.results.leaks.entries).toEqual([]);
    expect(ctx.spinner.stop).toHaveBeenCalledWith('Configuration updated');
  });

  // The reproduced-incident / genuine-failure case: the entry MUST survive.
  it("records the destroyed environment's identity under destroyedEnvironments.<env> so a redeploy needs no hand-typed block", async () => {
    // Region-move runbook, 2026-09-15: after destroy the operator had to
    // re-type provider/domain/DNS zone/backup bucket/schedule into
    // .vibecarbon.json before `deploy -y` could run. Those fields describe
    // WHAT the env is, not what exists; keep them somewhere `deploy` reads
    // and nothing else treats as "a deployed environment" (access, console,
    // status, operator-ip all key off presence in `environments`).
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    ctx.projectConfig.environments.prod = {
      deployMode: 'kubernetes',
      status: 'deployed',
      provider: 'hetzner',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      dns: { provider: 'cloudflare', zoneId: 'z1' },
      backupS3: { bucket: 'proj-backups', region: 'fsn1', endpoint: 'https://fsn1.x' },
      region: 'ash',
      serverType: 'cpx21',
      servers: [{ ip: '1.2.3.4' }],
      s3: { bucket: 'proj-storage-7b6f58' },
    } as never;
    await DESTROY_EFFECTS.updateProjectConfig(ctx);
    const saved = saveProjectConfigMock.mock.calls[0][0];
    expect(saved.environments.prod).toBeUndefined();
    expect(saved.destroyedEnvironments.prod).toMatchObject({
      deployMode: 'kubernetes',
      provider: 'hetzner',
      domain: 'app.example.com',
      dnsProvider: 'cloudflare',
      dns: { provider: 'cloudflare', zoneId: 'z1' },
      backupS3: { bucket: 'proj-backups', region: 'fsn1', endpoint: 'https://fsn1.x' },
      region: 'ash',
      serverType: 'cpx21',
    });
    expect(saved.destroyedEnvironments.prod.destroyedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const k of ['status', 'servers', 's3']) {
      expect(saved.destroyedEnvironments.prod).not.toHaveProperty(k);
    }
  });

  it('does not record an identity when the destroy is unverified (the live entry is kept instead)', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: true });
    await DESTROY_EFFECTS.updateProjectConfig(ctx);
    expect(ctx.projectConfig).not.toHaveProperty('destroyedEnvironments');
  });

  it('keeps the environment entry and never calls saveProjectConfig when pulumiDestroyFailed is true', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: true });

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(saveProjectConfigMock).not.toHaveBeenCalled();
    // The ORIGINAL projectConfig object is untouched — the entry is still there.
    expect(ctx.projectConfig.environments).toHaveProperty('prod');
  });

  it('records an operator-facing verdict explaining the entry was kept for retry', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: true });

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(ctx.results.leaks.entries).toHaveLength(1);
    const [entry] = ctx.results.leaks.entries;
    expect(entry.severity).toBe('unverified');
    expect(entry.resourceClass).toBe('project-config');
    expect(entry.resource).toContain('prod');
    expect(entry.reason).toMatch(/kept/i);
    expect(entry.hint).toContain('vibecarbon destroy prod');
  });

  it('logs a spinner message distinct from the normal "Configuration updated" success line', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: true });

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(ctx.spinner.stop).toHaveBeenCalledTimes(1);
    const [message] = ctx.spinner.stop.mock.calls[0];
    expect(message).not.toBe('Configuration updated');
    expect(message).toMatch(/kept/i);
  });

  // Same-name state-bucket recreation can silently lose acked writes (e4
  // restore→failover, 2026-08-07): a VERIFIED destroy rotates the generation
  // so the next deploy derives a fresh state-bucket name. An unverified
  // destroy must NOT rotate — its retry targets the old names.
  it('does NOT rotate stateBucketGeneration on a verified destroy', async () => {
    // Inverted deliberately. Rotation existed so the next deploy would derive a
    // fresh state-bucket name rather than recreate the one destroy had just
    // deleted, because Hetzner Object Storage can ack writes into a recreated
    // same-name bucket and lose them (e4 restore->failover, 2026-08-07). We no
    // longer delete the state bucket (retainStateBucket), so nothing is
    // recreated and the hazard cannot arise — and rotating now would do the
    // opposite of what we want, stranding the warm bucket and sending every
    // redeploy to a brand-new one, which is the worst window for this class.
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    ctx.projectConfig.stateBucketGeneration = 'aaaaaa';

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const savedConfig = saveProjectConfigMock.mock.calls[0][0];
    expect(savedConfig.stateBucketGeneration).toBe('aaaaaa');
    // bucketSalt still must NEVER rotate — the surviving backup bucket is found
    // by names embedding it (restore flows depend on this).
    expect(savedConfig.bucketSalt).toBe(ctx.projectConfig.bucketSalt);
  });

  it('does not invent a generation for legacy projects that never had one', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    expect(ctx.projectConfig).not.toHaveProperty('stateBucketGeneration');

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const savedConfig = saveProjectConfigMock.mock.calls[0][0];
    expect(savedConfig).not.toHaveProperty('stateBucketGeneration');
  });

  it('does not rotate the generation when the destroy is unverified', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: true });
    ctx.projectConfig.stateBucketGeneration = 'aaaaaa';

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(saveProjectConfigMock).not.toHaveBeenCalled();
    expect(ctx.projectConfig.stateBucketGeneration).toBe('aaaaaa');
  });
});

describe('storageBucketGeneration rotation (registry-500 RCA, 2026-08-17)', () => {
  // A purge-destroy that DELETED the storage bucket must rotate the
  // generation so the next deploy derives a FRESH bucket name instead of
  // recreating the deleted one — Hetzner's delete→same-name-recreate
  // propagation flapped NoSuchBucket at the registry for >10 minutes (run
  // 32013980356). A destroy that did NOT delete the bucket must not rotate:
  // rotation would strand the still-existing warm bucket.
  beforeEach(() => {
    saveProjectConfigMock.mockReset();
  });

  function ctxWithBucketResult(s3Bucket: string | null) {
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    (ctx.projectConfig as Record<string, unknown>).storageBucketGeneration = 'aaaaaa';
    (ctx.results as Record<string, unknown>).s3Bucket = s3Bucket;
    return ctx;
  }

  it('rotates the generation when this destroy deleted the storage bucket', async () => {
    const ctx = ctxWithBucketResult('proj-a1b2c3-storage-aaaaaa');

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const savedConfig = saveProjectConfigMock.mock.calls[0][0];
    expect(savedConfig.storageBucketGeneration).toBeTruthy();
    expect(savedConfig.storageBucketGeneration).not.toBe('aaaaaa');
  });

  it('does NOT rotate when the storage bucket was not deleted', async () => {
    const ctx = ctxWithBucketResult(null);

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const savedConfig = saveProjectConfigMock.mock.calls[0][0];
    expect(savedConfig.storageBucketGeneration).toBe('aaaaaa');
  });

  it('does NOT invent a generation for legacy projects that never had one', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    (ctx.results as Record<string, unknown>).s3Bucket = 'proj-storage';

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const savedConfig = saveProjectConfigMock.mock.calls[0][0];
    expect(savedConfig).not.toHaveProperty('storageBucketGeneration');
  });
});
