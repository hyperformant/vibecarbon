/**
 * Who asks for the open-state-backend step (open-state-backend.test.ts proves
 * what the step does). Drives the real executeDeployment up to its plan, with
 * a fake object store, then runs the plan's real gates and the real open
 * effect against a fake Pulumi workspace: every HA deploy opens the state
 * backend once before the pair starts, whoever created the bucket.
 *
 * F5 (audit, 2026-11-14): the open ran only when this very run's CreateBucket
 * made the state bucket. A first HA deploy that created the bucket and then
 * stopped before the open (the restore-point resolve, the app key mint, or the
 * open itself on a brand-new bucket) left a rerun that found the bucket
 * already there, skipped the open, and let the primary and standby engines
 * write `.pulumi/meta.yaml` together: the race that failed a k8s-ha deploy
 * with `could not list bucket: ... NoSuchKey` (2026-04-28).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectConfigStore } from '../helpers/project-config-store.js';

const run = vi.hoisted(() => ({
  ctx: null as Record<string, unknown> | null,
  stateBucketCreated: true,
  skipStorageSetup: false,
  buckets: [] as string[],
  /** The backend URL of each workspace the open made, in order. */
  opened: [] as string[],
  whoAmI: 0,
}));

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  LocalWorkspace: {
    create: async (opts: { projectSettings: { backend: { url: string } } }) => {
      run.opened.push(opts.projectSettings.backend.url);
      return {
        whoAmI: async () => {
          run.whoAmI += 1;
          return { user: 'me' };
        },
      };
    },
  },
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
vi.mock('../../../src/lib/deploy/state.js', () => ({
  StateTracker: class {
    results = new Map<string, unknown>();
    clear() {}
    async shouldSkipWithVerify() {
      return run.skipStorageSetup;
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
// The plan's own gates decide which steps run; of those, only the open runs
// (for real), and the deploy stops before the pair starts.
vi.mock('../../../src/lib/deploy/plan/runner.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runPlan: async (
    steps: Array<{ name: string; effect: string; when?: (ctx: unknown) => boolean }>,
    ctx: Record<string, unknown>,
  ) => {
    run.ctx = ctx;
    const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
    for (const step of steps) {
      if (step.when && !step.when(ctx)) continue;
      if (step.effect === 'openStateBackend') await EFFECTS.openStateBackend(ctx);
    }
    throw new Error('FAKE_PLAN_STOP');
  },
}));
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getObjectStorageProvider: async () => ({
    region: 'hel1',
    endpoint: 'https://hel1.your-objectstorage.com',
    getEndpoint: () => 'https://hel1.your-objectstorage.com',
    // One region here: every bucket is in hel1.
    forRegion() {
      return this;
    },
    createBucket: async (name: string) => {
      run.buckets.push(name);
      // The app and backup buckets are always new here, so only the state
      // bucket's own answer can decide.
      const created = name.includes('pulumi-state') ? run.stateBucketCreated : true;
      return {
        name,
        created,
        ready: true,
        region: 'hel1',
        endpoint: 'https://hel1.your-objectstorage.com',
      };
    },
    hasObjectsWithPrefix: async () => false,
    bucketExists: async () => true,
    setBucketCors: async () => {},
    getBucketCorsOrigins: async () => [],
    bucketCreatedAt: async () => null,
  }),
}));

const { executeDeployment } = await import('../../../src/lib/deploy/orchestrator.js');
const { loadProjectConfig } = await import('../../../src/lib/config.js');

const S3 = {
  accessKey: 'ABCDEFGHIJ0123456789',
  secretKey: 'x'.repeat(40),
  bucket: 'wireapp-abc123-prod-storage',
  region: 'hel1',
  endpoint: 'https://hel1.your-objectstorage.com',
  walgPrefix: 'backups/wireapp/prod/walg',
};

function gathered(deployMode: string) {
  return {
    projectConfig: loadProjectConfig(),
    envConfig: {},
    environment: 'prod',
    resuming: false,
    config: {
      environment: 'prod',
      provider: 'hetzner',
      ha: true,
      observability: false,
      deployMode,
    },
    apiToken: 'a'.repeat(64),
    region: 'hel1',
    secondaryRegion: 'nbg1',
    serverType: 'cpx22',
    masterServerType: 'cpx22',
    dbServerType: 'cpx12',
    workerServerType: 'cpx22',
    minWorkers: 1,
    maxWorkers: 3,
    domain: null,
    dnsProvider: 'manual',
    dnsZoneId: null,
    dnsToken: null,
    s3Config: S3,
    backupConfig: {},
    services: {},
    branchName: 'main',
  };
}

/** The ctx the HA plan received. */
async function planCtx(deployMode: string) {
  await expect(executeDeployment({ yes: true }, gathered(deployMode) as never)).rejects.toThrow(
    'FAKE_PLAN_STOP',
  );
  return run.ctx as Record<string, unknown>;
}

const MODES = ['compose-ha', 'kubernetes'];

/** The state bucket's backend, opened exactly once. */
function expectOpenedOnce() {
  expect(run.whoAmI).toBe(1);
  expect(run.opened).toHaveLength(1);
  expect(run.opened[0]).toMatch(/^s3:\/\/wireapp-[a-z0-9-]*pulumi-state[a-z0-9-]*\?/);
}

describe('every HA deploy opens the state backend before the pair starts', () => {
  // Each case runs in a scratch project dir: the deploy's command log goes to
  // <cwd>/.vibecarbon/logs, never the repo's.
  let scratch = '';
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'vc-open-state-wiring-'));
    vi.spyOn(process, 'cwd').mockReturnValue(scratch);
    store.current = projectConfigStore({
      projectName: 'wireapp',
      bucketSalt: 'abc123',
      environments: {},
    });
    run.ctx = null;
    run.stateBucketCreated = true;
    run.skipStorageSetup = false;
    run.buckets.length = 0;
    run.opened.length = 0;
    run.whoAmI = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each(MODES)('%s: when this run created the state bucket', async (mode) => {
    await planCtx(mode);
    expect(run.buckets.some((b) => b.includes('pulumi-state'))).toBe(true);
    expectOpenedOnce();
  });

  // F5: the first run created the bucket and stopped before the open.
  it.each(MODES)('%s: a rerun into the state bucket an earlier run created', async (mode) => {
    run.stateBucketCreated = false;
    await planCtx(mode);
    expect(run.buckets.some((b) => b.includes('pulumi-state'))).toBe(true);
    expectOpenedOnce();
  });

  it.each(MODES)('%s: a warm deploy that skipped the storage setup', async (mode) => {
    run.skipStorageSetup = true;
    await planCtx(mode);
    expect(run.buckets).toEqual([]);
    expectOpenedOnce();
  });
});
