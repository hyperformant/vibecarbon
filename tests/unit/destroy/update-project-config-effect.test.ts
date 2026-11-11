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
 * plan/CLI, with `lib/config.js`'s `updateProjectConfig` backed by an
 * in-memory file (ctx.projectConfig is what is on disk) so no real write
 * happens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectConfigStore } from '../helpers/project-config-store.js';

const store = projectConfigStore();

vi.mock('../../../src/lib/config.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
      store.updateProjectConfig(fn),
  };
});

const { DESTROY_EFFECTS, sweepTaggedReservedIps } = await import('../../../src/destroy.js');
const { PROVIDERS } = await import('../../../src/lib/providers/index.js');
const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');

function fakeSpinner() {
  return { start: vi.fn(), stop: vi.fn() };
}

function makeCtx(overrides: { pulumiDestroyFailed: boolean }) {
  const ctx = {
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
  // What is on disk: the test's later edits to ctx.projectConfig land there too.
  store.reset(ctx.projectConfig);
  return ctx;
}

describe('updateProjectConfigEffect (DESTROY_EFFECTS.updateProjectConfig)', () => {
  beforeEach(() => {
    store.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the environment entry and writes the config when pulumiDestroyFailed is false (unchanged behavior)', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(store.state.writes).toHaveLength(1);
    const savedConfig = store.state.writes[0];
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
      s3: { bucket: 'proj-a1b2c3-prod-storage', stateBucket: 'proj-state' },
    } as never;
    await DESTROY_EFFECTS.updateProjectConfig(ctx);
    const saved = store.state.writes[0];
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
      // plain destroy keeps the env's bucket, so the seed names it
      s3: { bucket: 'proj-a1b2c3-prod-storage' },
    });
    expect(saved.destroyedEnvironments.prod.destroyedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const k of ['status', 'servers']) {
      expect(saved.destroyedEnvironments.prod).not.toHaveProperty(k);
    }
    expect(saved.destroyedEnvironments.prod.s3).not.toHaveProperty('stateBucket');
  });

  it('does not record an identity when the destroy is unverified (the live entry is kept instead)', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: true });
    await DESTROY_EFFECTS.updateProjectConfig(ctx);
    expect(ctx.projectConfig).not.toHaveProperty('destroyedEnvironments');
  });

  it('keeps the environment entry and never writes the config when pulumiDestroyFailed is true', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: true });

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(store.state.writes).toEqual([]);
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
  // restore→failover, 2026-08-07). The generation rotates only when a
  // last-environment -purge deleted the state bucket (covered in
  // state-bucket-purge-scope.test.ts). An unverified destroy must NOT rotate —
  // its retry targets the old names (unless its -purge already deleted the
  // state bucket; see the purge cases below).
  it('does NOT rotate stateBucketGeneration on a verified destroy that kept the state bucket', async () => {
    // A plain destroy keeps the state bucket (retainStateBucket), so nothing
    // is recreated and the hazard cannot arise — rotating would strand the
    // warm bucket and send the redeploy to a brand-new one, which is the
    // worst window for this class.
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    ctx.projectConfig.stateBucketGeneration = 'aaaaaa';

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const savedConfig = store.state.writes[0];
    expect(savedConfig.stateBucketGeneration).toBe('aaaaaa');
    // bucketSalt still must NEVER rotate — the surviving backup bucket is found
    // by names embedding it (restore flows depend on this).
    expect(savedConfig.bucketSalt).toBe(ctx.projectConfig.bucketSalt);
  });

  it('does not invent a generation for legacy projects that never had one', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    expect(ctx.projectConfig).not.toHaveProperty('stateBucketGeneration');

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const savedConfig = store.state.writes[0];
    expect(savedConfig).not.toHaveProperty('stateBucketGeneration');
  });

  it('does not rotate the generation when the destroy is unverified', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: true });
    ctx.projectConfig.stateBucketGeneration = 'aaaaaa';

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(store.state.writes).toEqual([]);
    expect(ctx.projectConfig.stateBucketGeneration).toBe('aaaaaa');
  });

  // The reserved-IP backstop could not prove an address released (the read
  // by address did not answer 404). The environment's record is the only
  // place that address is named, so the entry stays and the next destroy
  // retries it; the backstop's own leak line already says so, once.
  it('keeps the environment entry while a reserved IP is not proven released', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    (ctx.results as Record<string, unknown>).unreleasedReservedIps = ['203.0.113.7'];

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(store.state.writes).toEqual([]);
    expect(ctx.projectConfig.environments).toHaveProperty('prod');
    expect(ctx.projectConfig).not.toHaveProperty('destroyedEnvironments');
    expect(ctx.results.leaks.entries).toEqual([]);
    const [message] = ctx.spinner.stop.mock.calls[0];
    expect(message).toContain('203.0.113.7');
    expect(message).toContain('`vibecarbon destroy prod`');
    expect(message).not.toContain('—');
  });

  it('names each unreleased address once: "X, Y and Z"', async () => {
    // k8s-ha: both side stacks can name one environment-level address.
    const ctx = Object.assign(makeCtx({ pulumiDestroyFailed: false }), {
      envConfig: { provider: 'digitalocean' },
    });
    (ctx.results as Record<string, unknown>).unreleasedReservedIps = [
      '203.0.113.7',
      '203.0.113.8',
      '203.0.113.7',
      '203.0.113.9',
    ];

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const [message] = ctx.spinner.stop.mock.calls[0];
    expect(message).toContain('the reserved IPs 203.0.113.7, 203.0.113.8 and 203.0.113.9 are');
  });

  // A -purge of the last environment deletes the state bucket in the step
  // before this one, whether or not the entry is then kept. The kept entry
  // must not take the generation's rotation with it: the next deploy or
  // destroy would derive the deleted bucket's name and recreate it, the
  // same-name recreate that lost acked writes on 2026-08-07.
  for (const keptBy of ['an unreleased reserved IP', 'an unverified Pulumi destroy']) {
    it(`a purge that deleted the state bucket still rotates the generation when ${keptBy} keeps the entry`, async () => {
      const ctx = makeCtx({ pulumiDestroyFailed: keptBy === 'an unverified Pulumi destroy' });
      ctx.projectConfig.stateBucketGeneration = 'aaaaaa';
      ctx.projectConfig.retainedStateBucket = 'proj-state-old';
      store.reset(ctx.projectConfig);
      Object.assign(ctx.results, {
        stateBucketPurged: true,
        // retainStateBucket's purge drops the retained name.
        retainedStateBucket: { value: undefined },
        ...(keptBy === 'an unreleased reserved IP' && {
          unreleasedReservedIps: ['203.0.113.7'],
        }),
      });

      await DESTROY_EFFECTS.updateProjectConfig(ctx);

      expect(store.state.writes).toHaveLength(1);
      const saved = store.state.writes[0];
      expect(saved.environments).toHaveProperty('prod');
      expect(saved).not.toHaveProperty('destroyedEnvironments');
      expect(saved.stateBucketGeneration).toMatch(/^\w+$/);
      expect(saved.stateBucketGeneration).not.toBe('aaaaaa');
      expect(saved).not.toHaveProperty('retainedStateBucket');
    });
  }

  it('a kept entry still records the retained state-bucket name', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    Object.assign(ctx.results, {
      retainedStateBucket: { value: 'proj-state' },
      unreleasedReservedIps: ['203.0.113.7'],
    });

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const saved = store.lastWrite();
    expect(saved?.retainedStateBucket).toBe('proj-state');
    expect(saved?.environments).toHaveProperty('prod');
  });

  it('removes the entry as before once every reserved IP is released', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    (ctx.results as Record<string, unknown>).unreleasedReservedIps = [];

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(store.state.writes[0].environments).not.toHaveProperty('prod');
    expect(ctx.spinner.stop).toHaveBeenCalledWith('Configuration updated');
  });
});

describe('storageBucketGeneration', () => {
  beforeEach(() => {
    store.reset();
  });

  it('never writes storageBucketGeneration', async () => {
    const ctx = makeCtx({ pulumiDestroyFailed: false });
    (ctx.projectConfig as Record<string, unknown>).storageBucketGeneration = 'aaaaaa';
    (ctx.results as Record<string, unknown>).s3Bucket = 'proj-a1b2c3-storage';

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const savedConfig = store.state.writes[0];
    expect(savedConfig.storageBucketGeneration).toBe('aaaaaa');
  });
});

/**
 * The kept-config line names the IPs in the provider's own word (its
 * RESERVED_IP_NAME), the word the backstop's leak line above it uses too.
 */
describe("the kept-config line uses the provider's own word for the IP", () => {
  const WORD: Record<string, string> = {
    hetzner: 'Floating IP',
    scaleway: 'flexible IP',
    digitalocean: 'reserved IP',
    linode: 'reserved IP',
    vultr: 'reserved IP',
  };

  it('covers every provider', () => {
    expect(Object.keys(WORD).sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  it.each(Object.entries(WORD))('%s: %s', async (provider, word) => {
    const ctx = Object.assign(makeCtx({ pulumiDestroyFailed: false }), {
      envConfig: { provider },
    });
    (ctx.results as Record<string, unknown>).unreleasedReservedIps = ['203.0.113.7', '203.0.113.8'];

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    const [message] = ctx.spinner.stop.mock.calls[0];
    expect(message).toContain(`the ${word}s 203.0.113.7 and 203.0.113.8 are not released yet`);
  });
});

/**
 * A label listing that cannot be read leaves an IP no record names possibly
 * billing. The sweep records it unverified, and the entry stays, so
 * `vibecarbon destroy <env>` can run the sweep again.
 */
describe('an unreadable label listing keeps the entry', () => {
  function unreadable() {
    function Hetzner() {}
    Object.assign(Hetzner, { NAME: 'Hetzner Cloud', RESERVED_IP_NAME: 'Floating IP' });
    Hetzner.prototype.deleteReservedIpsByLabels = async () => {
      throw new Error('GET /floating_ips failed: HTTP 503');
    };
    return new (Hetzner as unknown as new () => object)();
  }

  it('the next destroy can run the sweep again', async () => {
    const ctx = Object.assign(makeCtx({ pulumiDestroyFailed: false }), {
      envConfig: { provider: 'hetzner' },
    });
    await sweepTaggedReservedIps({
      provider: unreadable(),
      projectName: 'proj',
      stackEnv: 'prod-primary',
      results: ctx.results,
      s: fakeSpinner(),
      environment: 'prod',
    });
    const [entry] = ctx.results.leaks.entries;
    expect(entry).toMatchObject({ severity: 'unverified', resourceClass: 'reserved-ip' });
    expect(entry.hint).toContain('`vibecarbon destroy prod`');

    await DESTROY_EFFECTS.updateProjectConfig(ctx);

    expect(store.state.writes).toEqual([]);
    expect(ctx.projectConfig.environments).toHaveProperty('prod');
    const [message] = ctx.spinner.stop.mock.calls[0];
    expect(message).toContain('the Floating IPs labelled for prod-primary could not be listed');
    expect(message).toContain('`vibecarbon destroy prod`');
  });
});
