/**
 * The deploy bundle (src/lib/deploy/bundle.js) holds the rendered .env and
 * app.env: every secret the servers get (database passwords, storage keys, the
 * auth secret). executeDeployment used to render it into the OS temp dir and
 * never remove it, so every deploy left one behind: thousands of them, each
 * readable later by anything that can read the operator's /tmp.
 *
 * Its one reader is the compose plan's setup-server-files step (each arm of
 * compose-ha's setup fan); k8s never reads it. It is rendered before the DNS
 * warm-up and the pending-server repair, so a render that fails stops the
 * deploy before anything outside the operator's machine changes (the warm-up
 * points the domain at 0.0.0.0), and it is removed once the dispatch settles,
 * whatever the outcome. A Ctrl-C exits the process mid-plan without running a
 * finally; the exit sweep (src/lib/temp-dir.js) removes it then.
 *
 * Drives the REAL executeDeployment with the REAL plans; the plan's effects
 * are stubs that record what the bundle looked like while they ran. Each
 * deploy stops right after its plan (at the write-fence read), or inside it.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const run = vi.hoisted(() => ({
  /** Effect name to stub; anything not here is a no-op. */
  effects: {} as Record<string, (ctx: Record<string, unknown>) => Promise<void> | void>,
  /** What each effect saw: the ctx's bundle path, and whether it held .env. */
  seen: [] as Array<{ effect: string; bundlePath: unknown; hadEnv: boolean }>,
  /** The bundle path the plan ran with. */
  bundlePath: null as string | null,
  /** Whether the bundle dir existed when the first statement after the plan ran. */
  bundleAfterPlan: null as boolean | null,
  /** What each progress spinner started with. */
  spinnerStarts: [] as string[],
}));

// What reaches outside the machine before the plan: the DNS warm-up (the
// provider's setupSimple, pointing the domain at 0.0.0.0) and the repair of a
// server a compose scale replaced (Pulumi state).
const outside = vi.hoisted(() => ({
  getDnsProvider: vi.fn(),
  setupSimple: vi.fn(),
  repairPendingServerState: vi.fn(),
}));
vi.mock('../../../src/lib/dns-provider.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getDnsProvider: outside.getDnsProvider,
}));
vi.mock('../../../src/lib/deploy/compose/server-state-sync.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  repairPendingServerState: outside.repairPendingServerState,
}));

vi.mock('../../../src/lib/deploy/plan/runner.js', async (orig) => {
  const actual = (await orig()) as typeof import('../../../src/lib/deploy/plan/runner.js');
  return {
    ...actual,
    runPlan: (steps: Array<{ effect: string }>, ctx: Record<string, unknown>) => {
      const effects = Object.fromEntries(
        steps.map((s) => [
          s.effect,
          async (c: Record<string, unknown>) => {
            const bundlePath = c.bundlePath;
            if (typeof bundlePath === 'string') run.bundlePath = bundlePath;
            run.seen.push({
              effect: s.effect,
              bundlePath,
              hadEnv: typeof bundlePath === 'string' && existsSync(join(bundlePath, '.env')),
            });
            await run.effects[s.effect]?.(c);
          },
        ]),
      );
      return actual.runPlan(steps as never, ctx, effects as never);
    },
  };
});

// The first statement after every compose plan: the role primary's write-fence
// read. It records whether the bundle is still there, then stops the deploy.
vi.mock('../../../src/lib/deploy/write-fence.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertRolePrimaryWritable: vi.fn(async () => {
    run.bundleAfterPlan = run.bundlePath ? existsSync(run.bundlePath) : null;
    throw new Error('STOP_AFTER_PLAN');
  }),
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
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  spinner: () => ({
    start: (msg?: string) => {
      run.spinnerStarts.push(msg ?? '');
    },
    stop: () => {},
    message: () => {},
  }),
}));

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
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getObjectStorageProvider: async () => ({
    region: 'hel1',
    endpoint: 'https://hel1.your-objectstorage.com',
    getEndpoint: () => 'https://hel1.your-objectstorage.com',
    createBucket: async (name: string) => ({ name, created: false, ready: true }),
    hasObjectsWithPrefix: async () => false,
    bucketExists: async () => true,
    setBucketCors: async () => {},
    getBucketCorsOrigins: async () => [],
    bucketCreatedAt: async () => null,
  }),
}));
vi.mock('../../../src/lib/deploy/retired-fence.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  reconcileRetiredFence: vi.fn(async () => ({ fenced: [], unreachable: [] })),
  clearRetiredFence: vi.fn(async () => ({ cleared: true })),
}));
vi.mock('../../../src/lib/deploy/state.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  StateTracker: class {
    steps = new Map<string, { status: string; hash: string; result?: unknown }>();
    shouldSkip(step: string, inputs: unknown) {
      const s = this.steps.get(step);
      return s?.status === 'completed' && s.hash === JSON.stringify(inputs);
    }
    async shouldSkipWithVerify(step: string, inputs: unknown) {
      return this.shouldSkip(step, inputs);
    }
    startStep(step: string, inputs: unknown) {
      this.steps.set(step, { status: 'started', hash: JSON.stringify(inputs) });
    }
    completeStep(step: string, result: unknown = {}) {
      const s = this.steps.get(step);
      if (s) Object.assign(s, { status: 'completed', result });
    }
    getStepResult(step: string) {
      const s = this.steps.get(step);
      return s?.status === 'completed' ? s.result : null;
    }
    getStepCompletedAt() {
      return null;
    }
    invalidateStep(step: string) {
      this.steps.delete(step);
    }
    clear() {
      this.steps.clear();
    }
  },
}));

const { executeDeployment } = await import('../../../src/lib/deploy/orchestrator.js');
const { loadProjectConfig } = await import('../../../src/lib/config.js');
const { renderBundle } = await import('../../../src/lib/deploy/bundle.js');
const { sweepTempDirs } = await import('../../../src/lib/temp-dir.js');

const S3 = {
  accessKey: 'ABCDEFGHIJ0123456789',
  secretKey: 'x'.repeat(40),
  bucket: 'bundleapp-abc123-prod-storage',
  region: 'hel1',
  endpoint: 'https://hel1.your-objectstorage.com',
  walgPrefix: 'backups/bundleapp/prod/walg',
};

function gathered(deployMode: 'compose' | 'compose-ha' | 'kubernetes') {
  const projectConfig = loadProjectConfig() as { environments: Record<string, object> };
  return {
    projectConfig,
    envConfig: {},
    environment: 'prod',
    resuming: false,
    config: {
      environment: 'prod',
      provider: 'hetzner',
      ha: deployMode === 'compose-ha',
      observability: false,
      deployMode,
    },
    apiToken: 'a'.repeat(64),
    region: 'hel1',
    secondaryRegion: deployMode === 'compose-ha' ? 'nbg1' : null,
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
    backupS3Config: {
      bucket: 'bundleapp-abc123-prod-backups',
      region: 'hel1',
      endpoint: S3.endpoint,
    },
    backupConfig: {},
    services: {},
    branchName: 'main',
  };
}

/** Bundle dirs in the OS temp dir (this test file's own, per global-setup). */
const bundleDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('vc-deploy-bundle-'));

let project: string;
beforeEach(() => {
  store.current = projectConfigStore({
    projectName: 'bundleapp',
    bucketSalt: 'abc123',
    environments: {},
  });
  run.effects = {};
  run.seen = [];
  run.bundlePath = null;
  run.bundleAfterPlan = null;
  run.spinnerStarts = [];
  outside.setupSimple.mockReset().mockResolvedValue({ success: true });
  outside.getDnsProvider.mockReset().mockResolvedValue({ setupSimple: outside.setupSimple });
  outside.repairPendingServerState.mockReset().mockResolvedValue(1);
  // The real runPlan logs each step a when-predicate skips on stderr.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // The project the bundle is rendered from: its .env is what lands on servers.
  project = createTempDir('vc-bundle-project-');
  writeFileSync(join(project, '.env'), 'BETTER_AUTH_SECRET=not-a-real-secret\n');
  writeFileSync(join(project, 'docker-compose.yml'), 'services: {}\n');
  vi.spyOn(process, 'cwd').mockReturnValue(project);
});
afterEach(() => vi.restoreAllMocks());

/** The setup-server-files effect of each compose tier. */
const SETUP_FILES = { compose: 'setupServerFiles', 'compose-ha': 'haSetupServerFiles' } as const;
/** The provisioning effect of each compose tier, which names the servers. */
const PROVISION = {
  compose: (ctx: Record<string, unknown>) => {
    ctx.serverIp = '203.0.113.5';
  },
  'compose-ha': (ctx: Record<string, unknown>) => {
    ctx.primary = { ip: '203.0.113.5', stack: 'primary' };
    ctx.standby = { ip: '203.0.113.6', stack: 'standby' };
  },
} as const;
const PROVISION_EFFECT = {
  compose: 'provisionServer',
  'compose-ha': 'haProvisionServers',
} as const;

describe.each(['compose', 'compose-ha'] as const)('a %s deploy', (tier) => {
  beforeEach(() => {
    run.effects[PROVISION_EFFECT[tier]] = PROVISION[tier];
  });

  it('uploads a bundle that holds the rendered .env, and has removed it before anything after the plan runs', async () => {
    await expect(executeDeployment({ yes: true }, gathered(tier) as never)).rejects.toThrow(
      'STOP_AFTER_PLAN',
    );
    const upload = run.seen.find((s) => s.effect === SETUP_FILES[tier]);
    expect(upload?.hadEnv).toBe(true);
    expect(run.bundlePath).toMatch(/vc-deploy-bundle-/);
    // The plan succeeded; the bundle was gone before the deploy went on.
    expect(run.bundleAfterPlan).toBe(false);
    expect(bundleDirs()).toEqual([]);
  });

  it('removes the bundle when a step after the upload throws', async () => {
    const failing = tier === 'compose' ? 'startComposeStack' : 'haStartComposeStack';
    run.effects[failing] = () => {
      throw new Error('FAKE_STEP_FAILURE');
    };
    await expect(executeDeployment({ yes: true }, gathered(tier) as never)).rejects.toThrow(
      'FAKE_STEP_FAILURE',
    );
    expect(run.seen.find((s) => s.effect === SETUP_FILES[tier])?.hadEnv).toBe(true);
    expect(run.bundlePath && existsSync(run.bundlePath)).toBe(false);
    expect(bundleDirs()).toEqual([]);
  });

  it('removes the bundle when the first step throws, before anything reads it', async () => {
    run.effects[PROVISION_EFFECT[tier]] = () => {
      throw new Error('FAKE_PROVISION_FAILURE');
    };
    await expect(executeDeployment({ yes: true }, gathered(tier) as never)).rejects.toThrow(
      'FAKE_PROVISION_FAILURE',
    );
    expect(run.bundlePath).toMatch(/vc-deploy-bundle-/);
    expect(bundleDirs()).toEqual([]);
  });

  it('is on the exit sweep while the plan runs, so a Ctrl-C mid-plan removes it too', async () => {
    // What the process 'exit' listener does when cli.js exits on SIGINT.
    run.effects[SETUP_FILES[tier]] = () => {
      sweepTempDirs({ report: () => {} });
    };
    await expect(executeDeployment({ yes: true }, gathered(tier) as never)).rejects.toThrow(
      'STOP_AFTER_PLAN',
    );
    expect(run.seen.find((s) => s.effect === SETUP_FILES[tier])?.hadEnv).toBe(true);
    expect(run.bundleAfterPlan).toBe(false);
  });
});

describe.each(['compose', 'compose-ha'] as const)(
  'a %s deploy with managed DNS and a server scale replaced',
  (tier) => {
    /** A first deploy (nothing to skip) whose warm-up and repair both run. */
    const withDnsAndRepair = (secretKey = S3.secretKey) => ({
      ...gathered(tier),
      domain: 'app.example.test',
      dnsProvider: 'cloudflare',
      dnsZoneId: 'zone-1',
      dnsToken: 'cf-token',
      envConfig: {
        pendingServerState: [{ stack: 'prod', serverId: '42', ip: '203.0.113.9', old: null }],
      },
      s3Config: { ...S3, secretKey },
    });

    beforeEach(() => {
      run.effects[PROVISION_EFFECT[tier]] = PROVISION[tier];
    });

    it('warms DNS up and repairs the server state when the bundle renders', async () => {
      await expect(executeDeployment({ yes: true }, withDnsAndRepair() as never)).rejects.toThrow(
        'STOP_AFTER_PLAN',
      );
      expect(outside.setupSimple).toHaveBeenCalledWith(
        'cf-token',
        'zone-1',
        'app.example.test',
        '0.0.0.0',
        expect.anything(),
      );
      expect(outside.repairPendingServerState).toHaveBeenCalledTimes(1);
      // The spinner the failing case looks for, so its absence there means something.
      if (tier === 'compose-ha') expect(run.spinnerStarts).toContain('Starting HA deployment...');
    });

    it('a render that fails stops the deploy before DNS or the server state is touched', async () => {
      // A storage key no .env can hold: the render refuses it.
      await expect(
        executeDeployment({ yes: true }, withDnsAndRepair('x\ty') as never),
      ).rejects.toThrow(/S3_SECRET_KEY cannot be stored in a \.env file/);
      // The warm-up is a background task: give anything already started a turn.
      await new Promise((resolve) => setImmediate(resolve));
      expect(outside.getDnsProvider).not.toHaveBeenCalled();
      expect(outside.setupSimple).not.toHaveBeenCalled();
      expect(outside.repairPendingServerState).not.toHaveBeenCalled();
      expect(run.seen).toEqual([]);
      // compose-ha's "Starting HA deployment..." spinner comes after the render.
      expect(run.spinnerStarts).not.toContain('Starting HA deployment...');
      expect(bundleDirs()).toEqual([]);
    });
  },
);

describe('a k8s deploy', () => {
  it('renders no bundle at all: nothing on a cluster reads it', async () => {
    let during: string[] = [];
    run.effects.k8sDeployCluster = () => {
      during = bundleDirs();
      throw new Error('STOP_IN_PLAN');
    };
    await expect(executeDeployment({ yes: true }, gathered('kubernetes') as never)).rejects.toThrow(
      'STOP_IN_PLAN',
    );
    expect(run.seen.map((s) => s.effect)).toContain('k8sDeployCluster');
    expect(during).toEqual([]);
    expect(run.bundlePath).toBeNull();
  });
});

describe('renderBundle', () => {
  it('removes its dir when rendering throws partway', () => {
    // formatDotenvLine refuses a value with a tab, after the dir exists.
    expect(() => renderBundle('bundleapp', { envOverrides: { SOME_KEY: 'a\tb' } })).toThrow();
    expect(bundleDirs()).toEqual([]);
  });

  it('renders into a private dir that is on the exit sweep', () => {
    const dir = renderBundle('bundleapp', {});
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(dir, '.env'), 'utf-8')).toContain('BETTER_AUTH_SECRET=');
    } finally {
      sweepTempDirs({ report: () => {} });
    }
    expect(bundleDirs()).toEqual([]);
  });
});
