/**
 * Two storage regions in one project ("production in nbg1, then staging in
 * fsn1"). Drives the real executeDeployment up to its plan, over real
 * HetznerS3Provider instances and a fake regional object store
 * (helpers/fake-regional-s3.ts), so the real createBucket and
 * findBucketRegion answer.
 *
 * The bug: one storage client created all three buckets, and createBucket
 * moved that client to wherever an existing bucket lived. The project's
 * backups bucket lives in nbg1, so staging's fsn1 uploads bucket was recorded
 * as nbg1, the app was handed the wrong region, and every later deploy kept
 * it. Each bucket's region now comes from its own create.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectConfigStore } from '../helpers/project-config-store.js';

const s3 = await vi.hoisted(async () =>
  (await import('../helpers/fake-regional-s3.js')).createRegionalS3World(),
);
vi.mock('@aws-sdk/client-s3', () => s3.module);

const run = vi.hoisted(() => ({
  ctx: null as Record<string, unknown> | null,
  skipStorageSetup: false,
  priorResults: {} as Record<string, unknown>,
}));

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(async () => true),
  password: vi.fn(),
  note: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    step: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));
vi.mock('@clack/prompts', () => clackMock);

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof projectConfigStore> | null }));
vi.mock('../../../src/lib/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadProjectConfig: () => structuredClone(store.current?.state.disk ?? null),
  updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
    store.current?.updateProjectConfig(fn),
  registerProject: () => {},
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  collectDeployDelta: () => ({}),
  formatDeployDeltaLines: () => [],
}));
vi.mock('../../../src/lib/deploy/preflight.js', () => ({
  assertOperatorConfig: vi.fn(),
  assertScaffoldSupportsRoleFile: vi.fn(),
  checkDeployPrerequisites: vi.fn(),
  operatorCheckEnvs: () => [],
}));
vi.mock('../../../src/lib/ci-setup.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  ciAvailable: () => false,
  resolveBuildMode: () => 'local',
}));
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));
vi.mock('../../../src/lib/operator-ip.js', () => ({
  ensureOperatorIpAccess: vi.fn(async () => ({ added: false })),
}));
vi.mock('../../../src/lib/deploy/compose/app-image.js', () => ({
  buildComposeAppImage: vi.fn(async () => undefined),
}));
vi.mock('../../../src/lib/deploy/app-storage-credential.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  resolveAppStorageCredential: vi.fn(async () => ({
    accessKey: 'AK',
    secretKey: 'SK',
    record: null,
    tier: 'isolated',
    scoping: 'mint',
  })),
  syncHetznerFences: vi.fn(),
}));
// The real tracker's skip contract for s3-setup: a matching hash (here
// `run.skipStorageSetup`) skips only when the verify probe agrees, and a
// probe that throws keeps the skip. `priorResults` is what an earlier run
// recorded.
vi.mock('../../../src/lib/deploy/state.js', () => ({
  StateTracker: class {
    results = new Map<string, unknown>(Object.entries(run.priorResults));
    clear() {}
    async shouldSkipWithVerify(step: string, _inputs: unknown, verify?: () => Promise<boolean>) {
      if (step !== 's3-setup' || !run.skipStorageSetup) return false;
      if (typeof verify !== 'function') return true;
      try {
        return Boolean(await verify());
      } catch {
        return true;
      }
    }
    startStep() {}
    completeStep(step: string, result: unknown) {
      this.results.set(step, result);
    }
    getStepResult(step: string) {
      return this.results.get(step) ?? null;
    }
  },
}));
vi.mock('../../../src/lib/deploy/plan/runner.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runPlan: async (_steps: unknown, ctx: Record<string, unknown>) => {
    run.ctx = ctx;
    throw new Error('FAKE_PLAN_STOP');
  },
}));
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getObjectStorageProvider: async (
    _id: string,
    accessKey: string,
    secretKey: string,
    region: string,
  ) => {
    const { HetznerS3Provider } = await import('../../../src/lib/providers/hetzner-s3.js');
    return new HetznerS3Provider(accessKey, secretKey, region);
  },
}));

const { executeDeployment } = await import('../../../src/lib/deploy/orchestrator.js');
const { loadProjectConfig } = await import('../../../src/lib/config.js');
const { HetznerS3Provider } = await import('../../../src/lib/providers/hetzner-s3.js');

const ENDPOINT = HetznerS3Provider.ENDPOINTS as Record<string, string>;
const BACKUPS = 'myapp-abc123-backups';
const PROD_APP = 'myapp-abc123-prod-storage';
const STAGING_APP = 'myapp-abc123-staging-storage';
const STATE = 'myapp-abc123-storage-pulumi-state';
const KEYS = { accessKey: 'ABCDEFGHIJ0123456789', secretKey: 'x'.repeat(40) };

/** An environment record as a finished deploy leaves it. */
function envRecord(env: string, { app, backups }: { app: string; backups: string }) {
  return {
    envName: env,
    status: 'deployed',
    deployedAt: '2026-11-01T00:00:00.000Z',
    deployMode: 'compose',
    provider: 'hetzner',
    region: app,
    serverType: 'cpx22',
    s3: {
      bucket: `myapp-abc123-${env}-storage`,
      region: app,
      endpoint: ENDPOINT[app],
      stateBucket: STATE,
      stateBucketRegion: 'nbg1',
      stateEndpoint: ENDPOINT.nbg1,
    },
    backupS3: { bucket: BACKUPS, region: backups, endpoint: ENDPOINT[backups] },
  };
}

/** What gatherDeploymentConfig hands the orchestrator for a compose deploy. */
function gathered(
  environment: string,
  { compute, storage, envConfig = {} }: { compute: string; storage: string; envConfig?: object },
) {
  const recorded = envConfig as { s3?: { stateBucket?: string } };
  return {
    projectConfig: loadProjectConfig(),
    envConfig,
    environment,
    resuming: false,
    config: {
      environment,
      provider: 'hetzner',
      ha: false,
      observability: false,
      deployMode: 'compose',
    },
    apiToken: 'a'.repeat(64),
    region: compute,
    secondaryRegion: null,
    serverType: 'cpx22',
    minWorkers: 1,
    maxWorkers: 3,
    domain: null,
    dnsProvider: 'manual',
    dnsZoneId: null,
    dnsToken: null,
    s3Config: {
      ...KEYS,
      bucket: `myapp-abc123-${environment}-storage`,
      ...(recorded.s3?.stateBucket && { stateBucket: recorded.s3.stateBucket }),
      walgPrefix: `backups/myapp/${environment}/walg`,
      region: storage,
      endpoint: ENDPOINT[storage],
    },
    backupS3Config: { bucket: BACKUPS, region: storage, endpoint: ENDPOINT[storage] },
    backupConfig: {},
    services: {},
    branchName: 'main',
  };
}

/** Deploy up to the plan; returns the plan's ctx. */
async function deployToPlan(g: ReturnType<typeof gathered>) {
  await expect(executeDeployment({ yes: true }, g as never)).rejects.toThrow('FAKE_PLAN_STOP');
  return run.ctx as { s3Config: Record<string, unknown> };
}

const env = (name: string) => loadProjectConfig()?.environments?.[name];
const infoLines = () => clackMock.log.info.mock.calls.map((call) => String(call[0]));
const sent = (command: string) => s3.calls.filter((c) => c.command === command);

describe('a second storage region never moves another bucket region', () => {
  let quiet: number;
  beforeAll(() => {
    // The quiet period is proven by bucket-quiet-after-create.test.ts; here it
    // only costs time.
    quiet = HetznerS3Provider.bucketQuietMs;
    HetznerS3Provider.bucketQuietMs = 0;
  });
  afterAll(() => {
    HetznerS3Provider.bucketQuietMs = quiet;
  });

  beforeEach(() => {
    s3.reset();
    run.ctx = null;
    run.skipStorageSetup = false;
    run.priorResults = {};
    clackMock.log.info.mockClear();
    clackMock.log.warn.mockClear();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('staging in fsn1 keeps fsn1 for its uploads while its recorded backups stay in nbg1', async () => {
    s3.seed(BACKUPS, 'nbg1');
    s3.seed(PROD_APP, 'nbg1');
    s3.seed(STATE, 'nbg1');
    store.current = projectConfigStore({
      projectName: 'myapp',
      bucketSalt: 'abc123',
      environments: { prod: envRecord('prod', { app: 'nbg1', backups: 'nbg1' }) },
    });
    const before = new Set(s3.buckets.keys());

    const ctx = await deployToPlan(gathered('staging', { compute: 'fsn1', storage: 'fsn1' }));

    const staging = env('staging');
    expect(staging.s3.region).toBe('fsn1');
    expect(staging.s3.endpoint).toBe(ENDPOINT.fsn1);
    expect(staging.backupS3).toEqual({ bucket: BACKUPS, region: 'nbg1', endpoint: ENDPOINT.nbg1 });
    expect(ctx.s3Config.region).toBe('fsn1');
    expect(ctx.s3Config.endpoint).toBe(ENDPOINT.fsn1);
    // The state bucket lives in nbg1 and is recorded there.
    expect(staging.s3.stateBucketRegion).toBe('nbg1');
    expect(staging.s3.stateEndpoint).toBe(ENDPOINT.nbg1);
    // Only staging's uploads bucket is new, and it is in fsn1.
    const added = [...s3.buckets.keys()].filter((b) => !before.has(b));
    expect(added).toEqual([STAGING_APP]);
    expect(s3.regionOf(STAGING_APP)).toBe('fsn1');
    // prod is untouched, and nothing moved, so there is nothing to say.
    expect(env('prod')).toEqual(envRecord('prod', { app: 'nbg1', backups: 'nbg1' }));
    expect(infoLines().filter((l) => l.includes('for its uploads'))).toEqual([]);
  });

  it('an environment recorded under the wrong region is repaired from where its bucket is', async () => {
    s3.seed(STAGING_APP, 'fsn1');
    s3.seed(BACKUPS, 'nbg1');
    s3.seed(STATE, 'nbg1');
    // What the bug left: staging's fsn1 uploads bucket recorded as nbg1.
    const broken = envRecord('staging', { app: 'nbg1', backups: 'nbg1' });
    broken.region = 'fsn1';
    store.current = projectConfigStore({
      projectName: 'myapp',
      bucketSalt: 'abc123',
      environments: { staging: broken },
    });

    // The record pins the storage region, so the wizard gathers nbg1.
    const ctx = await deployToPlan(
      gathered('staging', { compute: 'fsn1', storage: 'nbg1', envConfig: broken }),
    );

    const staging = env('staging');
    expect(staging.s3.region).toBe('fsn1');
    expect(staging.s3.endpoint).toBe(ENDPOINT.fsn1);
    expect(ctx.s3Config.region).toBe('fsn1');
    expect(staging.backupS3).toEqual({ bucket: BACKUPS, region: 'nbg1', endpoint: ENDPOINT.nbg1 });
    const line = infoLines().find((l) => l.includes('lives in fsn1, not nbg1'));
    expect(line, infoLines().join('\n')).toBeDefined();
    expect(line).toContain(STAGING_APP);
    expect(line).toContain('so staging now records fsn1 for its uploads');
    // Nothing was created: every bucket already existed somewhere.
    expect([...s3.buckets.keys()].sort()).toEqual([BACKUPS, STAGING_APP, STATE].sort());
  });

  it('a backups bucket made during that repair goes where the uploads bucket is', async () => {
    s3.seed(STAGING_APP, 'fsn1');
    s3.seed(STATE, 'nbg1');
    const broken = envRecord('staging', { app: 'nbg1', backups: 'nbg1' });
    broken.region = 'fsn1';
    store.current = projectConfigStore({
      projectName: 'myapp',
      bucketSalt: 'abc123',
      environments: { staging: broken },
    });

    await deployToPlan(
      gathered('staging', { compute: 'fsn1', storage: 'nbg1', envConfig: broken }),
    );

    expect(s3.regionOf(BACKUPS)).toBe('fsn1');
    expect(env('staging').backupS3).toEqual({
      bucket: BACKUPS,
      region: 'fsn1',
      endpoint: ENDPOINT.fsn1,
    });
  });

  it('a state bucket in another region is recorded there, and the uploads region stays', async () => {
    s3.seed(STATE, 'hel1');
    store.current = projectConfigStore({
      projectName: 'myapp',
      bucketSalt: 'abc123',
      environments: {},
    });

    const ctx = await deployToPlan(gathered('staging', { compute: 'fsn1', storage: 'fsn1' }));

    const staging = env('staging');
    expect(staging.s3.region).toBe('fsn1');
    expect(staging.s3.endpoint).toBe(ENDPOINT.fsn1);
    expect(staging.s3.stateBucketRegion).toBe('hel1');
    expect(staging.s3.stateEndpoint).toBe(ENDPOINT.hel1);
    expect(ctx.s3Config.region).toBe('fsn1');
    expect(staging.backupS3).toEqual({ bucket: BACKUPS, region: 'fsn1', endpoint: ENDPOINT.fsn1 });
    expect(s3.regionOf(STAGING_APP)).toBe('fsn1');
    expect(s3.regionOf(BACKUPS)).toBe('fsn1');
    const warned = clackMock.log.warn.mock.calls.map((call) => String(call[0]));
    expect(warned.some((l) => l.includes(`${STATE} lives in hel1`))).toBe(true);
  });

  it('reads a seeded state bucket in its own region, so nothing is migrated', async () => {
    // The state bucket in hel1 holds this project's state; the uploads bucket
    // still holds a pre-split `.pulumi/` tree. Reading the state bucket in
    // any other region would see "no state" and try to migrate.
    s3.seed(STATE, 'hel1', { '.pulumi/stacks/myapp/staging.json': '{}' });
    s3.seed(STAGING_APP, 'fsn1', { '.pulumi/meta.yaml': 'version: 1' });
    store.current = projectConfigStore({
      projectName: 'myapp',
      bucketSalt: 'abc123',
      environments: {},
    });

    await deployToPlan(gathered('staging', { compute: 'fsn1', storage: 'fsn1' }));

    expect(sent('CopyObject')).toEqual([]);
    expect(
      sent('ListObjectsV2')
        .filter((c) => c.bucket === STATE)
        .map((c) => c.region),
    ).toContain('hel1');
  });

  it('a warm deploy checks each bucket in its recorded region and creates nothing', async () => {
    s3.seed(STAGING_APP, 'fsn1');
    s3.seed(BACKUPS, 'nbg1');
    s3.seed(STATE, 'nbg1');
    const staging = envRecord('staging', { app: 'fsn1', backups: 'nbg1' });
    store.current = projectConfigStore({
      projectName: 'myapp',
      bucketSalt: 'abc123',
      environments: { staging },
    });
    run.skipStorageSetup = true;
    run.priorResults = {
      's3-setup': {
        region: 'fsn1',
        endpoint: ENDPOINT.fsn1,
        stateBucket: STATE,
        stateBucketRegion: 'nbg1',
        stateEndpoint: ENDPOINT.nbg1,
        backups: { bucket: BACKUPS, region: 'nbg1', endpoint: ENDPOINT.nbg1 },
      },
    };

    await deployToPlan(
      gathered('staging', { compute: 'fsn1', storage: 'fsn1', envConfig: staging }),
    );

    expect(sent('CreateBucket')).toEqual([]);
    const heads = sent('HeadBucket');
    expect(heads).toContainEqual({ command: 'HeadBucket', region: 'fsn1', bucket: STAGING_APP });
    expect(heads).toContainEqual({ command: 'HeadBucket', region: 'nbg1', bucket: BACKUPS });
    expect(heads).toContainEqual({ command: 'HeadBucket', region: 'nbg1', bucket: STATE });
    expect(env('staging').backupS3).toEqual({
      bucket: BACKUPS,
      region: 'nbg1',
      endpoint: ENDPOINT.nbg1,
    });
    expect(env('staging').s3.region).toBe('fsn1');
  });

  it('a warm deploy with no recorded storage result runs the storage step', async () => {
    s3.seed(STAGING_APP, 'fsn1');
    s3.seed(BACKUPS, 'fsn1');
    s3.seed(STATE, 'fsn1');
    store.current = projectConfigStore({
      projectName: 'myapp',
      bucketSalt: 'abc123',
      environments: {},
    });
    run.skipStorageSetup = true;

    const ctx = await deployToPlan(gathered('staging', { compute: 'fsn1', storage: 'fsn1' }));

    // The step ran and recorded where each bucket is (a skip would leave no
    // result, so no state bucket region). Every bucket already existed.
    expect(ctx.s3Config.stateBucketRegion).toBe('fsn1');
    expect(env('staging').s3.stateBucketRegion).toBe('fsn1');
    expect(sent('CreateBucket')).toEqual([]);
  });
});
