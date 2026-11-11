/**
 * A k8s-ha deploy writes its domain's records once, through the provider's
 * setupHA, and never through setupSimple at a real address.
 *
 * It used to write them twice: the fan-out's setupHA (effects/k8s-ha.js), then
 * the orchestrator's single-cluster post-deploy writer (k8s/dns-record.js),
 * whose `k8s-dns-update` gate never saw the HA write, so it ran setupSimple
 * again on every first deploy, every rerun whose IP moved and every redeploy
 * after a failover (hetzner/k8s-ha CI run 42426102569, 00:01:14Z, while the
 * first certificate could still be issuing). Harmless on Hetzner's atomic
 * set_records; not on a backend whose setupSimple writes something setupHA
 * does not (Cloudflare's setupSimple adds a `<domain>-health` check).
 *
 * Drives the REAL executeDeployment through its post-deploy DNS block, with
 * the real plan, the real DNS effects and the real single-k8s writer, and stops
 * at the public probe that follows. Effects that only touch servers (ssh keys,
 * firewalls, replication, the image copy) are stubbed, and every step of each
 * k8s plan must be classified real or stubbed here, so a new step cannot slip
 * in unexamined. The 0.0.0.0 warm-up at deploy start is the one setupSimple
 * call either tier makes besides single k8s's own record; it precedes the
 * records' real write, which awaits it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectConfigStore } from '../helpers/project-config-store.js';

const run = vi.hoisted(() => ({
  /**
   * Addresses per cluster stack (environment name), what deployK3s reports:
   * no floatingIp is a cluster that takes traffic at its master (DigitalOcean).
   */
  ips: {} as Record<string, { masterIp: string; floatingIp?: string }>,
  /** Effect names of each plan executeDeployment ran, in order. */
  plans: [] as string[][],
  /** Every DNS write, in order: `setupSimple <ip>` / `setupHA <primary> <standby>`. */
  dns: [] as string[],
}));

const dnsMock = vi.hoisted(() => ({
  setupSimple: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  setupHA: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
}));
vi.mock('../../../src/lib/dns-provider.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getDnsProvider: async () => ({ setupSimple: dnsMock.setupSimple, setupHA: dnsMock.setupHA }),
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

// The stop: the public probe's spinner, the first thing after the DNS block.
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  spinner: () => ({
    start: (msg: string) => {
      if (String(msg).startsWith('Probing ')) throw new Error('STOP_AT_PROBE');
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
    // One region here: every bucket is in hel1.
    forRegion() {
      return this;
    },
    createBucket: async (name: string) => ({
      name,
      created: false,
      ready: true,
      region: 'hel1',
      endpoint: 'https://hel1.your-objectstorage.com',
    }),
    hasObjectsWithPrefix: async () => false,
    bucketExists: async () => true,
    setBucketCors: async () => {},
    getBucketCorsOrigins: async () => [],
    bucketCreatedAt: async () => null,
  }),
}));

// Deploy state that survives between the two executeDeployment calls of a
// rerun, keyed by environment like the real file (deploy-state-<env>.json).
const stateFiles = vi.hoisted(
  () =>
    new Map<
      string,
      Map<string, { status: string; hash: string; result?: unknown; completedAt?: number }>
    >(),
);
vi.mock('../../../src/lib/deploy/state.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  StateTracker: class {
    steps: Map<string, { status: string; hash: string; result?: unknown; completedAt?: number }>;
    constructor(_project: string, environment: string) {
      if (!stateFiles.has(environment)) stateFiles.set(environment, new Map());
      this.steps = stateFiles.get(environment) as typeof this.steps;
    }
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
      if (!s) throw new Error(`Step ${step} was not started`);
      s.status = 'completed';
      s.result = result;
      s.completedAt = Date.now();
    }
    getStepResult(step: string) {
      const s = this.steps.get(step);
      return s?.status === 'completed' ? s.result : null;
    }
    getStepCompletedAt(step: string) {
      const s = this.steps.get(step);
      return s?.status === 'completed' ? (s.completedAt ?? null) : null;
    }
    invalidateStep(step: string) {
      this.steps.delete(step);
    }
    clear() {
      this.steps.clear();
    }
  },
}));

// The clusters: each reports its addresses at infra-ready, as deployK3s does.
vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  deployK3s: vi.fn(async (opts: Record<string, unknown>) => {
    const ips = run.ips[opts.environment as string];
    if (!ips) throw new Error(`no IPs for cluster ${String(opts.environment)}`);
    const infra = { ...ips, dbIp: '192.0.2.10', dbPrivateIp: '10.0.1.2' };
    (opts.onInfraReady as ((i: object) => void) | undefined)?.(infra);
    if (opts.role === 'primary') {
      (opts.onImageBuilt as ((t: string) => void) | undefined)?.('10.0.1.1:5000/app:t');
    }
    return { ...infra, masterPrivateIp: '10.0.1.1', kubeconfig: '/k', imageTag: 'app:t' };
  }),
}));
vi.mock('../../../src/lib/deploy/k8s/ha/index.js', () => ({
  prepareReplicationTransport: vi.fn(async () => {}),
  configurePrimaryForReplication: vi.fn(async () => {}),
  setupReplication: vi.fn(async () => ({ streaming: true, lastState: '' })),
}));
vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({
  copyAppImageToStandby: vi.fn(async () => ({ digest: 'sha256:aa', skipped: true })),
}));
// Post-dispatch server reads and writes (ssh to the role primary).
vi.mock('../../../src/lib/deploy/backup-fence.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  writeK8sBackupFence: vi.fn(async () => ({ ok: true })),
  recordBackupFence: vi.fn(),
}));
vi.mock('../../../src/lib/deploy/write-fence.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertRolePrimaryWritable: vi.fn(async () => 'writable'),
}));
vi.mock('../../../src/lib/deploy/retired-fence.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  reconcileRetiredFence: vi.fn(async () => ({ fenced: [], unreachable: [] })),
  clearRetiredFence: vi.fn(async () => ({ cleared: true })),
}));

// Every step of each k8s plan, classified. REAL effects run as shipped; the
// stubs stand in for effects that only reach servers and never write DNS.
const classified = vi.hoisted(() => {
  const spinner = () => ({ start: () => {}, stop: () => {}, message: () => {} });
  const stubs: Record<string, (ctx: Record<string, unknown>) => Promise<void>> = {
    openStateBackend: async () => {},
    haK8sGenerateSshKey: async (ctx) => {
      ctx.s = spinner();
      ctx.sharedSshKeyPath = '/nonexistent/id_ed25519';
      ctx.sharedSshPublicKey = 'ssh-ed25519 AAAA test';
    },
    haK8sUploadSshKey: async (ctx) => {
      ctx.sharedSshKeyId = 1;
      ctx.sharedSshKeyName = 'k';
    },
    haK8sOpenReplicationFirewall: async () => {},
    haK8sConfigureReplication: async () => {},
    haK8sVerifyStreaming: async (ctx) => {
      ctx.replicationStatus = 'streaming';
    },
    haK8sCopyStandbyImage: async () => {},
  };
  return {
    stubs,
    real: {
      'k8s-ha': ['haK8sProvisionClusters', 'haK8sUpdateDns', 'haK8sFinalize'],
      k8s: ['k8sDeployCluster'],
    } as Record<string, string[]>,
  };
});
vi.mock('../../../src/lib/deploy/plan/runner.js', async (orig) => {
  const actual = (await orig()) as typeof import('../../../src/lib/deploy/plan/runner.js');
  return {
    ...actual,
    runPlan: (
      steps: Array<{ effect: string }>,
      ctx: Record<string, unknown>,
      effects: Record<string, unknown>,
    ) => {
      run.plans.push(steps.map((s) => s.effect));
      return actual.runPlan(steps as never, ctx, { ...effects, ...classified.stubs } as never);
    },
  };
});

const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
const { executeDeployment } = await import('../../../src/lib/deploy/orchestrator.js');
const { loadProjectConfig } = await import('../../../src/lib/config.js');
const { swapHaRoles } = await import('../../../src/failover.js');
const { planDeploy } = await import('../../../src/lib/deploy/plan/deploy-plan.js');

const DOMAIN = 'app.example.com';
const P = { masterIp: '198.51.100.1', floatingIp: '203.0.113.1' };
const S = { masterIp: '198.51.100.2', floatingIp: '203.0.113.2' };
const SINGLE = { masterIp: '198.51.100.9', floatingIp: '203.0.113.9' };

const S3 = {
  accessKey: 'ABCDEFGHIJ0123456789',
  secretKey: 'x'.repeat(40),
  bucket: 'dnsapp-abc123-prod-storage',
  region: 'hel1',
  endpoint: 'https://hel1.your-objectstorage.com',
  walgPrefix: 'backups/dnsapp/prod/walg',
};

function gathered(ha: boolean) {
  const projectConfig = loadProjectConfig() as { environments: Record<string, object> };
  const envConfig = projectConfig.environments.prod ?? {};
  return {
    projectConfig,
    envConfig,
    environment: 'prod',
    resuming: false,
    config: {
      environment: 'prod',
      provider: 'hetzner',
      ha,
      observability: false,
      deployMode: 'kubernetes',
    },
    apiToken: 'a'.repeat(64),
    region: (envConfig as { region?: string }).region ?? 'hel1',
    secondaryRegion: (envConfig as { secondaryRegion?: string }).secondaryRegion ?? 'nbg1',
    serverType: 'cpx22',
    masterServerType: 'cpx22',
    dbServerType: 'cpx12',
    workerServerType: 'cpx22',
    minWorkers: 1,
    maxWorkers: 3,
    domain: DOMAIN,
    dnsProvider: 'hetzner',
    dnsZoneId: 'zone-1',
    dnsToken: 'dns-token',
    s3Config: S3,
    backupS3Config: { bucket: 'dnsapp-abc123-prod-backups', region: 'hel1', endpoint: S3.endpoint },
    backupConfig: {},
    services: {},
    branchName: 'main',
  };
}

/** One `vibecarbon deploy`, through the post-deploy DNS block. */
async function deploy(ha: boolean) {
  run.dns.length = 0;
  await expect(executeDeployment({ yes: true }, gathered(ha) as never)).rejects.toThrow(
    'STOP_AT_PROBE',
  );
  return [...run.dns];
}

const WARMUP = 'setupSimple 0.0.0.0';

beforeEach(() => {
  store.current = projectConfigStore({
    projectName: 'dnsapp',
    bucketSalt: 'abc123',
    environments: {},
  });
  stateFiles.clear();
  run.plans.length = 0;
  run.ips = { 'prod-primary': { ...P }, 'prod-standby': { ...S }, prod: { ...SINGLE } };
  dnsMock.setupSimple = vi.fn(async (_t: string, _z: string, _d: string, ip: string) => {
    run.dns.push(`setupSimple ${ip}`);
    return { success: true, mode: 'simple' };
  });
  dnsMock.setupHA = vi.fn(async (_t: string, _z: string, _d: string, servers: { ip: string }[]) => {
    run.dns.push(`setupHA ${servers.map((s) => s.ip).join(' ')}`);
    return { success: true, mode: 'dns' };
  });
  // The fan-out's early firewall check reads the cloud: nothing to find here.
  vi.spyOn(HetznerProvider.prototype, 'findFirewallByName').mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe('every step of the k8s plans is classified for this harness', () => {
  it.each(['k8s-ha', 'k8s'])('%s', (tier) => {
    const effects = planDeploy(tier as never, {}).map((s) => s.effect);
    const known = new Set([...classified.real[tier], ...Object.keys(classified.stubs)]);
    expect(effects.filter((e) => !known.has(e))).toEqual([]);
    for (const e of classified.real[tier]) expect(effects).toContain(e);
  });
});

describe('a k8s-ha deploy writes its DNS records once, through setupHA', () => {
  it('first deploy: the warm-up, then setupHA at the primary, nothing after', async () => {
    const writes = await deploy(true);
    expect(run.plans.at(-1)).toEqual(planDeploy('k8s-ha', {}).map((s) => s.effect));
    expect(writes).toEqual([WARMUP, `setupHA ${P.floatingIp} ${S.floatingIp}`]);
    expect(dnsMock.setupHA).toHaveBeenCalledWith(
      'dns-token',
      'zone-1',
      DOMAIN,
      [
        { name: 'dnsapp-hel1', ip: P.floatingIp },
        { name: 'dnsapp-nbg1', ip: S.floatingIp },
      ],
      { onProgress: expect.any(Function) },
    );
  });

  it('warm rerun, same IPs: setupHA once, no setupSimple at all', async () => {
    await deploy(true);
    expect(await deploy(true)).toEqual([`setupHA ${P.floatingIp} ${S.floatingIp}`]);
  });

  it('rerun whose primary IP moved: setupHA once at the new IP, no setupSimple', async () => {
    await deploy(true);
    run.ips['prod-primary'] = { ...P, floatingIp: '203.0.113.11' };
    expect(await deploy(true)).toEqual([`setupHA 203.0.113.11 ${S.floatingIp}`]);
  });

  it('redeploy after a failover: setupHA once at the promoted primary, no setupSimple', async () => {
    await deploy(true);
    // What `vibecarbon failover` persists: the role mapping swaps.
    store.current?.updateProjectConfig((c) => {
      const env = c.environments.prod;
      env.status = 'deployed';
      env.ha = {
        ...env.ha,
        primary: { ...env.ha.primary, stack: 'prod-primary', region: 'hel1' },
        standby: { ...env.ha.standby, stack: 'prod-standby', region: 'nbg1' },
      };
    });
    swapHaRoles('prod');
    expect(await deploy(true)).toEqual([`setupHA ${S.floatingIp} ${P.floatingIp}`]);
  });

  it('no zone id: nothing writes the records, and the deploy says to set them by hand', async () => {
    const g = gathered(true);
    run.dns.length = 0;
    await expect(
      executeDeployment({ yes: true }, { ...g, dnsZoneId: null } as never),
    ).rejects.toThrow('STOP_AT_PROBE');
    expect(run.dns).toEqual([]);
    expect(clackMock.log.warn).toHaveBeenCalledWith(
      'Hetzner DNS HA DNS skipped (missing token or zone id): configure DNS manually',
    );
  });
});

describe('single k8s keeps its one early write', () => {
  it('first deploy: the warm-up, then setupSimple at the floating IP, never setupHA', async () => {
    const writes = await deploy(false);
    expect(run.plans.at(-1)).toEqual(planDeploy('k8s', {}).map((s) => s.effect));
    expect(writes).toEqual([WARMUP, `setupSimple ${SINGLE.floatingIp}`]);
    expect(dnsMock.setupHA).not.toHaveBeenCalled();
  });

  it('warm rerun, same IP: no write; a moved IP: one write at the new IP', async () => {
    await deploy(false);
    expect(await deploy(false)).toEqual([]);
    run.ips.prod = { ...SINGLE, floatingIp: '203.0.113.19' };
    expect(await deploy(false)).toEqual(['setupSimple 203.0.113.19']);
  });
});

/**
 * A cluster without a floating IP (every DigitalOcean cluster) has its
 * records at its master's own address, so a run that replaces a master must
 * move them to the new master before the public probe, in that same run.
 */
describe('a cluster without a floating IP: records at the master, moved with it', () => {
  const masterOnly = (ip: { masterIp: string }) => ({ masterIp: ip.masterIp });
  beforeEach(() => {
    run.ips = {
      'prod-primary': masterOnly(P),
      'prod-standby': masterOnly(S),
      prod: masterOnly(SINGLE),
    };
  });

  it('single k8s: first deploy writes the master; a replaced master is rewritten in that run', async () => {
    expect(await deploy(false)).toEqual([WARMUP, `setupSimple ${SINGLE.masterIp}`]);
    expect(await deploy(false)).toEqual([]);
    run.ips.prod = { masterIp: '198.51.100.19' };
    expect(await deploy(false)).toEqual(['setupSimple 198.51.100.19']);
    const env = (loadProjectConfig() as { environments: Record<string, object> }).environments.prod;
    expect(env).toMatchObject({ ingressIp: '198.51.100.19' });
    expect(env).not.toHaveProperty('floatingIp');
  });

  it('k8s-ha: setupHA at the masters; a replaced primary master is rewritten in that run', async () => {
    expect(await deploy(true)).toEqual([WARMUP, `setupHA ${P.masterIp} ${S.masterIp}`]);
    run.ips['prod-primary'] = { masterIp: '198.51.100.11' };
    expect(await deploy(true)).toEqual([`setupHA 198.51.100.11 ${S.masterIp}`]);
    const ha = (loadProjectConfig() as { environments: Record<string, { ha: object }> })
      .environments.prod.ha as Record<string, object>;
    expect(ha.primary).toMatchObject({ ingressIp: '198.51.100.11' });
    expect(ha.primary).not.toHaveProperty('floatingIp');
    expect(ha.standby).toMatchObject({ ingressIp: S.masterIp });
  });
});
