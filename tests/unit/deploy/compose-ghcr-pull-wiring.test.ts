/**
 * A compose or compose-ha deploy resolves the credential its servers pull a
 * private app image with once, before any server is created or provisioned:
 * before the DNS warm-up, the pending-server repair and any Pulumi up
 * (orchestrator.js, after the image is resolved). The resolve only reads
 * (each recorded server's ghcr.io login, over ssh). A refusal there (a
 * headless run with no GHCR_PULL_TOKEN, a token with more than read:packages)
 * stops the deploy before any server is created or provisioned. Local and direct builds pull nothing
 * from ghcr: their plan still runs the ghcr-login step, with a null
 * credential, so a gh token an older vibecarbon left on the server goes.
 *
 * Drives the REAL executeDeployment with the REAL plans (the harness of
 * deploy-bundle-lifetime.test.ts); the plan's effects are stubs that record
 * the credential they were handed. Each deploy stops right after its plan.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const run = vi.hoisted(() => ({
  /** What happened, in order: the resolve, each effect, the outside writes. */
  events: [] as string[],
  /** The ghcrPull each effect's ctx carried. */
  pulls: {} as Record<string, unknown>,
  buildMode: 'push' as 'push' | 'local' | 'direct',
  /** Set to make resolveGhcrPull refuse with this message. */
  refusal: null as string | null,
}));

const PULL = vi.hoisted(() => ({
  mode: 'token' as const,
  username: 'octo',
  token: `ghp_${'vcwiringsentinel'.padEnd(36, 'Q')}`,
}));

const ghcr = vi.hoisted(() => ({
  resolveGhcrPull: vi.fn(async () => {
    run.events.push('resolve');
    if (run.refusal) throw new Error(run.refusal);
    return PULL;
  }),
}));
vi.mock('../../../src/lib/deploy/ghcr-pull.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  resolveGhcrPull: ghcr.resolveGhcrPull,
}));

// What reaches outside the machine: the DNS warm-up, the pending-server
// repair and Pulumi.
const outside = vi.hoisted(() => ({
  getDnsProvider: vi.fn(),
  setupSimple: vi.fn(),
  repairPendingServerState: vi.fn(),
  upStack: vi.fn(),
}));
vi.mock('../../../src/lib/dns-provider.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getDnsProvider: outside.getDnsProvider,
}));
vi.mock('../../../src/lib/deploy/compose/server-state-sync.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  repairPendingServerState: outside.repairPendingServerState,
}));
vi.mock('../../../src/lib/iac/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  upStack: outside.upStack,
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
            run.events.push(s.effect);
            run.pulls[s.effect] = c.ghcrPull;
            if (s.effect === 'provisionServer') c.serverIp = '203.0.113.5';
            if (s.effect === 'haProvisionServers') {
              c.primary = { ip: '203.0.113.5', stack: 'primary' };
              c.standby = { ip: '203.0.113.6', stack: 'standby' };
            }
          },
        ]),
      );
      return actual.runPlan(steps as never, ctx, effects as never);
    },
  };
});

// The first statement after every compose plan: stop the deploy there.
vi.mock('../../../src/lib/deploy/write-fence.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertRolePrimaryWritable: vi.fn(async () => {
    throw new Error('STOP_AFTER_PLAN');
  }),
}));

const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({
    fns: ['select', 'cancel', 'text', 'password', 'note', 'intro', 'outro'],
    log: ['step', 'info', 'warn', 'error', 'success', 'message'],
    spinner: true,
    with: { isCancel: vi.fn(() => false), confirm: vi.fn(async () => true) },
  });
});
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof projectConfigStore> | null }));
vi.mock('../../../src/lib/config.js', async (orig) =>
  (await import('../helpers/deploy-to-plan.js')).configOverStore(await orig(), () => store.current),
);
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', async (orig) =>
  (await import('../helpers/deploy-to-plan.js')).noDeployDelta(await orig()),
);
vi.mock('../../../src/lib/deploy/preflight.js', async () =>
  (await import('../helpers/deploy-to-plan.js')).preflightPasses(),
);
// The build mode is the case's; push mode's CI wait answers at once.
vi.mock('../../../src/lib/ci-setup.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  ciAvailable: () => run.buildMode === 'push',
  resolveBuildMode: () => run.buildMode,
  ensureCIImageReady: vi.fn(async () => {
    run.events.push('ciImageReady');
    return { imageTag: 'abc1234', githubOwner: 'acme', repoName: 'shop' };
  }),
  waitForGhcrManifest: vi.fn(async () => true),
}));
vi.mock('../../../src/lib/operator-ip.js', () => ({
  ensureOperatorIpAccess: vi.fn(async () => ({ added: false })),
}));
vi.mock('../../../src/lib/deploy/compose/app-image.js', () => ({
  buildComposeAppImage: vi.fn(async () => undefined),
}));
vi.mock('../../../src/lib/deploy/app-storage-credential.js', async (orig) =>
  (await import('../helpers/deploy-to-plan.js')).mintedAppStorageKey(await orig()),
);
const hel1Store = {
  region: 'hel1',
  endpoint: 'https://hel1.your-objectstorage.com',
  getEndpoint: () => 'https://hel1.your-objectstorage.com',
  createBucket: async (name: string) => ({
    name,
    created: false,
    ready: true,
    region: 'hel1',
    endpoint: 'https://hel1.your-objectstorage.com',
  }),
  forRegion: () => hel1Store,
  hasObjectsWithPrefix: async () => false,
  bucketExists: async () => true,
  setBucketCors: async () => {},
  getBucketCorsOrigins: async () => [],
  bucketCreatedAt: async () => null,
};
vi.mock('../../../src/lib/providers/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getObjectStorageProvider: async () => hel1Store,
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
    shouldSkip() {
      return false;
    }
    async shouldSkipWithVerify() {
      return false;
    }
    startStep() {}
    completeStep() {}
    getStepResult() {
      return null;
    }
    getStepCompletedAt() {
      return null;
    }
    invalidateStep() {}
    clear() {}
  },
}));

const { executeDeployment } = await import('../../../src/lib/deploy/orchestrator.js');
const { loadProjectConfig } = await import('../../../src/lib/config.js');

const S3 = {
  accessKey: 'ABCDEFGHIJ0123456789',
  secretKey: 'x'.repeat(40),
  bucket: 'shop-abc123-prod-storage',
  region: 'hel1',
  endpoint: 'https://hel1.your-objectstorage.com',
  walgPrefix: 'backups/shop/prod/walg',
};

function gathered(
  deployMode: 'compose' | 'compose-ha',
  { envConfig = {}, managedDns = false }: { envConfig?: object; managedDns?: boolean } = {},
) {
  const projectConfig = loadProjectConfig() as { environments: Record<string, object> };
  return {
    projectConfig,
    envConfig,
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
    domain: managedDns ? 'app.example.test' : null,
    dnsProvider: managedDns ? 'cloudflare' : 'manual',
    dnsZoneId: managedDns ? 'zone-1' : null,
    dnsToken: managedDns ? 'cf-token' : null,
    s3Config: S3,
    backupS3Config: { bucket: 'shop-abc123-prod-backups', region: 'hel1', endpoint: S3.endpoint },
    backupConfig: {},
    services: {},
    branchName: 'main',
  };
}

/** The effect that logs the servers in to ghcr.io, per tier. */
const LOGIN = { compose: 'ghcrLogin', 'compose-ha': 'haSetupServerFiles' } as const;
const PROVISION = { compose: 'provisionServer', 'compose-ha': 'haProvisionServers' } as const;

/** What the one resolve was asked: its arguments, with each store's name. */
const resolveArgs = () => {
  expect(ghcr.resolveGhcrPull).toHaveBeenCalledTimes(1);
  const [args] = ghcr.resolveGhcrPull.mock.calls[0] as unknown as [Record<string, unknown>];
  return { ...args, stores: (args.stores as Array<{ name: string }>).map((s) => s.name) };
};

let project: string;
/** The deploy key a redeploy's recorded servers trust (not a real key: nothing reads it here). */
const withDeployKey = () => {
  mkdirSync(join(project, '.vibecarbon'), { recursive: true });
  writeFileSync(join(project, '.vibecarbon', 'deploy_key_prod'), 'not-a-real-key\n');
  writeFileSync(join(project, '.vibecarbon', 'deploy_key_prod.pub'), 'ssh-ed25519 AAAA test\n');
};

beforeEach(() => {
  store.current = projectConfigStore({
    projectName: 'shop',
    bucketSalt: 'abc123',
    environments: {},
  });
  run.events = [];
  run.pulls = {};
  run.buildMode = 'push';
  run.refusal = null;
  ghcr.resolveGhcrPull.mockClear();
  outside.upStack.mockReset();
  outside.setupSimple.mockReset().mockImplementation(async () => {
    run.events.push('dnsWarmup');
    return { success: true };
  });
  outside.getDnsProvider.mockReset().mockResolvedValue({ setupSimple: outside.setupSimple });
  outside.repairPendingServerState.mockReset().mockImplementation(async () => {
    run.events.push('repairPendingServerState');
    return 1;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  project = createTempDir('vc-ghcr-wiring-project-');
  writeFileSync(join(project, '.env'), 'BETTER_AUTH_SECRET=not-a-real-secret\n');
  writeFileSync(join(project, 'docker-compose.yml'), 'services: {}\n');
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  vi.stubEnv('GHCR_PULL_TOKEN', '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(['compose', 'compose-ha'] as const)('a %s push deploy', (tier) => {
  it('a push deploy resolves the pull credential once, before provisioning', async () => {
    const first = gathered(tier, {
      managedDns: true,
      envConfig: {
        pendingServerState: [{ stack: 'prod', serverId: '42', ip: '203.0.113.9', old: null }],
      },
    });
    await expect(executeDeployment({ yes: true }, first as never)).rejects.toThrow(
      'STOP_AFTER_PLAN',
    );
    const at = (e: string) => run.events.indexOf(e);
    expect(run.events.filter((e) => e === 'resolve')).toHaveLength(1);
    // After the image it pulls is known, before any server is created or provisioned.
    expect(at('ciImageReady')).toBeLessThan(at('resolve'));
    for (const later of ['dnsWarmup', 'repairPendingServerState', PROVISION[tier]]) {
      expect(at(later), later).toBeGreaterThan(at('resolve'));
    }
    expect(outside.upStack).not.toHaveBeenCalled();
    // For the image CI built, kept where a compose server keeps it. A first
    // deploy has no server to read a stored token from.
    expect(resolveArgs()).toMatchObject({
      owner: 'acme',
      repo: 'shop',
      projectName: 'shop',
      envName: 'prod',
      stores: [],
      keptAs: "on the server in docker's login file",
      where: {
        lives: "on the server in docker's login file",
        readers: 'anyone with root on the server',
        puller: 'the server',
      },
    });
    // The login step got exactly what was resolved.
    expect(run.pulls[LOGIN[tier]]).toBe(PULL);
  });

  it('a refusal provisions nothing', async () => {
    run.refusal =
      'your app image at ghcr.io/acme/shop is private or not published yet, so prod needs a token ' +
      'to pull it, and there is no terminal to ask for one. export GHCR_PULL_TOKEN as a classic ' +
      'token with only read:packages, made here: https://github.com/settings/tokens/new';
    const first = gathered(tier, {
      managedDns: true,
      envConfig: {
        pendingServerState: [{ stack: 'prod', serverId: '42', ip: '203.0.113.9', old: null }],
      },
    });
    await expect(executeDeployment({ yes: true }, first as never)).rejects.toThrow(
      /export GHCR_PULL_TOKEN/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.events).toEqual(['ciImageReady', 'resolve']);
    expect(outside.setupSimple).not.toHaveBeenCalled();
    expect(outside.repairPendingServerState).not.toHaveBeenCalled();
    expect(outside.upStack).not.toHaveBeenCalled();
  });
});

describe('the stores a redeploy reads a stored token from', () => {
  it('compose: the environment recorded server, named for the environment', async () => {
    withDeployKey();
    const warm = gathered('compose', {
      envConfig: { servers: [{ name: 'master', id: '7', ip: '203.0.113.5' }] },
    });
    await expect(executeDeployment({ yes: true }, warm as never)).rejects.toThrow(
      'STOP_AFTER_PLAN',
    );
    expect(resolveArgs().stores).toEqual(["on prod's server"]);
    expect(run.pulls.ghcrLogin).toBe(PULL);
  });

  it('both sides get the same credential from one resolve', async () => {
    withDeployKey();
    const warm = gathered('compose-ha', {
      envConfig: {
        servers: [
          { name: 'shop-prod-primary', id: '7', ip: '203.0.113.5', role: 'primary' },
          { name: 'shop-prod-standby', id: '8', ip: '203.0.113.6', role: 'standby' },
        ],
      },
    });
    await expect(executeDeployment({ yes: true }, warm as never)).rejects.toThrow(
      'STOP_AFTER_PLAN',
    );
    // One ask covers both sides, and a good token on either is reused.
    expect(resolveArgs().stores).toEqual(["on prod-primary's server", "on prod-standby's server"]);
    expect(run.pulls.haSetupServerFiles).toBe(PULL);
  });

  it('a side a failover retired is not a store: this deploy rebuilds it', async () => {
    withDeployKey();
    // A failover since the last deploy swapped the roles: the standby entry
    // is the old primary, which the deploy reconverges.
    const warm = gathered('compose-ha', {
      envConfig: {
        deployedAt: '2026-11-20T00:00:00Z',
        lastFailover: '2026-11-25T00:00:00Z',
        servers: [
          { name: 'shop-prod-primary', id: '7', ip: '203.0.113.5', role: 'primary' },
          { name: 'shop-prod-standby', id: '8', ip: '203.0.113.6', role: 'standby' },
        ],
      },
    });
    await executeDeployment({ yes: true }, warm as never).catch(() => {});
    expect(ghcr.resolveGhcrPull).toHaveBeenCalledTimes(1);
    expect(resolveArgs().stores).toEqual(["on prod-primary's server"]);
  });
});

describe.each([
  ['compose', 'local'],
  ['compose', 'direct'],
  ['compose-ha', 'local'],
] as const)('a %s %s deploy', (tier, mode) => {
  it('a local deploy passes ghcrPull null and the step still runs', async () => {
    run.buildMode = mode;
    await expect(executeDeployment({ yes: true }, gathered(tier) as never)).rejects.toThrow(
      'STOP_AFTER_PLAN',
    );
    expect(ghcr.resolveGhcrPull).not.toHaveBeenCalled();
    expect(run.events).toContain(LOGIN[tier]);
    expect(run.pulls[LOGIN[tier]]).toBeNull();
  });
});
