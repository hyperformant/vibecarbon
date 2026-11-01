import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The DNS records are written as soon as the server IPs are known, while
 * cloud-init runs, not after the bundle upload (DO e2e 2026-10-31: compose's
 * dns.create ran after deploy.bundle.upload, on the critical path). Only the
 * timing moves: the same records, written by the same calls, and the old
 * update-dns position stays the barrier before anything starts Traefik, so a
 * failed write still fails the deploy before the stack comes up.
 *
 * These drive the REAL plan (planDeploy + runPlan) with the real DNS effects
 * and a recorder for every other effect, so the order asserted is the order a
 * deploy runs.
 */

const setupSimple = vi.fn();
const setupHA = vi.fn();
vi.mock('../../../src/lib/dns-provider.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getDnsProvider: async () => ({ setupSimple, setupHA }),
}));

vi.mock('../../../src/lib/dns-propagation.js', () => ({
  waitForDNSPropagation: vi.fn(async () => true),
  waitForZoneServed: vi.fn(async () => ({ served: true, detail: 'ok', waitedMs: 1 })),
  resolveNameservers: vi.fn(),
}));

// The project config, in memory: the persist step's writes land here, in order.
const disk: { environments: Record<string, Record<string, unknown>> } = { environments: {} };
vi.mock('../../../src/lib/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  updateProjectConfig: (mutator: (c: typeof disk) => unknown) => {
    calls.push('config:persist');
    mutator(disk);
  },
}));

vi.mock('@clack/prompts', () => {
  const mk = () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });
  return {
    spinner: mk,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
  };
});

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { planDeploy } = await import('../../../src/lib/deploy/plan/deploy-plan.js');
const { runPlan } = await import('../../../src/lib/deploy/plan/runner.js');

function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

let calls: string[] = [];

/** Every effect a recorder, except the DNS ones under test. */
function effects(real: string[], hold: Record<string, Promise<void>> = {}) {
  const out: Record<string, (ctx: unknown) => Promise<void>> = {};
  for (const [name, impl] of Object.entries(EFFECTS)) {
    out[name] = real.includes(name)
      ? (impl as (ctx: unknown) => Promise<void>)
      : async () => {
          calls.push(name);
          if (hold[name]) await hold[name];
        };
  }
  return out;
}

const state = () => {
  const steps: Record<string, string> = {};
  return {
    steps,
    shouldSkip: () => false,
    startStep: (id: string) => {
      steps[id] = 'started';
    },
    completeStep: (id: string) => {
      steps[id] = 'completed';
    },
  };
};

beforeEach(() => {
  calls = [];
  setupSimple.mockReset();
  setupSimple.mockImplementation(async () => {
    calls.push('dns:setupSimple');
    return { success: true };
  });
  setupHA.mockReset();
  setupHA.mockImplementation(async () => {
    calls.push('dns:setupHA');
    return { success: true };
  });
});

describe('compose: the A record is written while cloud-init runs', () => {
  const composeCtx = () => ({
    domain: 'e1.example.com',
    serverIp: '203.0.113.10',
    dnsProvider: 'cloudflare',
    dnsZoneId: 'zone-1',
    dnsToken: 'tok',
    dnsChallenge: true,
    dnsWarmupPromise: Promise.resolve(),
    state: state(),
  });
  const REAL = ['startDnsUpdate', 'updateDns'];

  it('writes the record before cloud-init finishes and before the bundle upload', async () => {
    const cloudInit = makeGate();
    const ctx = composeCtx();
    const run = runPlan(
      planDeploy('compose', {}),
      ctx,
      effects(REAL, { setupServer: cloudInit.promise }),
    );
    // cloud-init is still running...
    await vi.waitFor(() => expect(calls).toContain('setupServer'));
    await vi.waitFor(() => expect(setupSimple).toHaveBeenCalledTimes(1));
    expect(calls).not.toContain('setupServerFiles');
    cloudInit.release();
    await run;
    expect(setupSimple).toHaveBeenCalledWith('tok', 'zone-1', 'e1.example.com', '203.0.113.10', {
      onProgress: expect.any(Function),
    });
    expect(calls.indexOf('dns:setupSimple')).toBeLessThan(calls.indexOf('setupServerFiles'));
    expect(ctx.state.steps['compose-dns-update']).toBe('completed');
  });

  it('the stack does not start before the write lands (update-dns is the barrier)', async () => {
    const write = makeGate();
    setupSimple.mockImplementation(async () => {
      calls.push('dns:setupSimple');
      await write.promise;
      return { success: true };
    });
    const run = runPlan(planDeploy('compose', {}), composeCtx(), effects(REAL));
    await vi.waitFor(() => expect(calls).toContain('setupServerFiles'));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).not.toContain('restoreTlsSnapshot');
    expect(calls).not.toContain('startComposeStack');
    write.release();
    await run;
    expect(calls).toContain('startComposeStack');
  });

  it('a refused write fails the deploy at update-dns, before the stack starts', async () => {
    setupSimple.mockImplementation(async () => {
      calls.push('dns:setupSimple');
      return { success: false, error: 'zone not found' };
    });
    await expect(runPlan(planDeploy('compose', {}), composeCtx(), effects(REAL))).rejects.toThrow(
      /\[step:update-dns\].*zone not found/s,
    );
    expect(calls).not.toContain('startComposeStack');
  });

  it('writes the record exactly once', async () => {
    await runPlan(planDeploy('compose', {}), composeCtx(), effects(REAL));
    expect(setupSimple).toHaveBeenCalledTimes(1);
  });
});

describe('compose-ha: the HA records are written while both servers boot', () => {
  const haCtx = () => ({
    projectConfig: { projectName: 'quorum' },
    environment: 'e2',
    region: 'nyc3',
    standbyRegion: 'sfo3',
    domain: 'e2.example.com',
    dnsProvider: 'cloudflare',
    dnsZoneId: 'zone-1',
    dnsToken: 'tok',
    onProgress: () => {},
    primary: { ip: '203.0.113.1', stack: 'e2-primary' },
    standby: { ip: '203.0.113.2', stack: 'e2-standby' },
  });
  const REAL = ['haStartDnsUpdate', 'haUpdateDns'];

  it('writes both records before cloud-init finishes on either server', async () => {
    const cloudInit = makeGate();
    const run = runPlan(
      planDeploy('compose-ha', {}),
      haCtx(),
      effects(REAL, { haSetupServers: cloudInit.promise }),
    );
    await vi.waitFor(() => expect(calls).toContain('haSetupServers'));
    await vi.waitFor(() => expect(setupHA).toHaveBeenCalledTimes(1));
    cloudInit.release();
    await run;
    expect(setupHA).toHaveBeenCalledWith('tok', 'zone-1', 'e2.example.com', [
      { name: 'quorum-e2-e2-primary', ip: '203.0.113.1', region: 'nyc3' },
      { name: 'quorum-e2-e2-standby', ip: '203.0.113.2', region: 'sfo3' },
    ]);
    expect(setupHA).toHaveBeenCalledTimes(1);
    expect(calls.indexOf('dns:setupHA')).toBeLessThan(calls.indexOf('haPullImages'));
  });

  // M1: the 0.0.0.0 warm-up (started at deploy start) writes the same apex
  // record; the HA write, now minutes earlier, must not race it.
  it('waits for the 0.0.0.0 warm-up write before writing the HA records', async () => {
    const warm = makeGate();
    const run = runPlan(
      planDeploy('compose-ha', {}),
      { ...haCtx(), dnsWarmupPromise: warm.promise },
      effects(REAL),
    );
    await vi.waitFor(() => expect(calls).toContain('haSetupServers'));
    await new Promise((r) => setTimeout(r, 20));
    expect(setupHA).not.toHaveBeenCalled();
    warm.release();
    await run;
    expect(setupHA).toHaveBeenCalledTimes(1);
  });

  it('a refused write fails the deploy at update-dns, before either stack starts', async () => {
    setupHA.mockImplementation(async () => ({ success: false, error: 'rate limited' }));
    await expect(runPlan(planDeploy('compose-ha', {}), haCtx(), effects(REAL))).rejects.toThrow(
      /\[step:update-dns\].*rate limited/s,
    );
    expect(calls).not.toContain('haStartComposeStack');
  });
});

/**
 * I2: the early write points the record at the new server before the deploy
 * ends. destroy deletes only records whose target it can attribute to this
 * env (planDestroyTargets ownedIps, from envConfig.servers), so the server
 * must be on disk BEFORE the write, as compose-ha's persist-pending-config
 * already is. Otherwise a deploy that fails later leaves an A record that
 * destroy keeps as unowned.
 */
describe('compose: the provisioned server is on disk before the early write', () => {
  const provisioned = () => ({
    environment: 'e1',
    region: 'nyc3',
    serverType: 's-2vcpu-4gb',
    domain: 'e1.example.com',
    dnsProvider: 'digitalocean',
    dnsZoneId: 'zone-1',
    dnsToken: 'tok',
    dnsChallenge: true,
    dnsWarmupPromise: Promise.resolve(),
    state: state(),
  });
  const REAL = ['persistProvisionedServer', 'startDnsUpdate', 'updateDns'];

  /** A provisionServer that does what the real one does to ctx. */
  const withProvision = (fx: Record<string, (ctx: never) => Promise<void>>) => ({
    ...fx,
    provisionServer: async (ctx: Record<string, unknown>) => {
      calls.push('provisionServer');
      Object.assign(ctx, {
        serverIp: '203.0.113.10',
        providerServerId: '4242',
        providerServerName: 'quorum-e1',
        providerFirewallId: 'fw-1',
        serverProvisioned: true,
      });
    },
  });

  beforeEach(() => {
    disk.environments = { e1: { envName: 'e1', status: 'deploying', deployMode: 'compose' } };
  });

  it('persists the server before the record write starts', async () => {
    await runPlan(
      planDeploy('compose', {}),
      { ...provisioned(), serverIp: null },
      withProvision(effects(REAL)),
    );
    expect(calls.indexOf('config:persist')).toBeGreaterThan(-1);
    expect(calls.indexOf('config:persist')).toBeLessThan(calls.indexOf('dns:setupSimple'));
    expect(disk.environments.e1.servers).toEqual([
      {
        name: 'master',
        id: '4242',
        providerServerName: 'quorum-e1',
        firewallId: 'fw-1',
        ip: '203.0.113.10',
        region: 'nyc3',
        serverType: 's-2vcpu-4gb',
      },
    ]);
    expect(disk.environments.e1.status).toBe('deploying');
  });

  it('a deploy that fails after the write leaves a record destroy owns', async () => {
    const run = runPlan(
      planDeploy('compose', {}),
      { ...provisioned(), serverIp: null },
      withProvision({
        ...effects(REAL),
        startComposeStack: async () => {
          throw new Error('compose up failed');
        },
      }),
    );
    await expect(run).rejects.toThrow('compose up failed');
    const { planDestroyTargets } = await import('../../../src/destroy.js');
    const { ownedIps } = planDestroyTargets(disk.environments.e1, { projectName: 'quorum' }, 'e1');
    // The A record the early write set points here: destroy deletes it.
    expect(setupSimple.mock.calls[0][3]).toBe('203.0.113.10');
    expect(ownedIps).toContain('203.0.113.10');
  });

  it('a warm deploy (server already recorded) writes nothing to disk', async () => {
    await runPlan(
      planDeploy('compose', {}),
      { ...provisioned(), serverIp: '203.0.113.10' },
      effects(REAL),
    );
    expect(calls).not.toContain('config:persist');
  });
});
