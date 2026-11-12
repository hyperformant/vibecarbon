/**
 * A warm compose-ha deploy skips both Pulumi `up`s when nothing the two
 * programs receive changed, as k8s does with `k3s-infra`, and both stacks are
 * marked sealed (lib/iac/state-seal.js). These tests drive haProvisionServers
 * with `upStack` faked at its boundary and a real StateTracker on a temp
 * directory. The fake records the seal marker in the ledger it is handed, as
 * the real upStack does once its seal and history cleanup finish
 * (fake.sealFinishes false: they didn't).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  upStack: vi.fn(),
  standbyType: 'cpx22',
  version: '1.2.3',
  sealFinishes: true,
}));
vi.mock('../../../src/lib/version.js', () => ({
  get VERSION() {
    return fake.version;
  },
}));

vi.mock('../../../src/lib/iac/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  upStack: fake.upStack,
}));
vi.mock('../../../src/lib/deploy/utils.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  generateSSHKeyPair: () => {},
}));
vi.mock('../../../src/lib/sizing.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  haStandbyType: () => fake.standbyType,
  haClassMessage: () => null,
}));

const { COMPOSE_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/compose-ha.js');
const { recordStateSeal, stateSealRecorded } = await import('../../../src/lib/iac/state-seal.js');
const { StateTracker, COMPOSE_HA_INFRA_STEP } = await import('../../../src/lib/deploy/state.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');

const summaries = vi.fn();
let dir: string;
let cwd: string;
let keyPath: string;
let publicKey: string;

const outputsFor = (stack: string, n: number) => ({
  serverIp: stack.endsWith('primary') ? '10.0.0.1' : '10.0.0.2',
  serverId: `${stack}-${n}`,
  firewallId: `fw-${stack}-${n}`,
});

function setPublicKey(value: string) {
  publicKey = value;
  writeFileSync(`${keyPath}.pub`, `${value}\n`);
}

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    projectConfig: { projectName: 'myapp', operatorCidrs: [{ cidr: '203.0.113.0/24' }] },
    environment: 'prod',
    sshKeyPath: keyPath,
    region: 'nbg1',
    secondaryRegion: 'fsn1',
    serverType: 'cpx22',
    serverTypeRequested: true,
    apiToken: 'test-token',
    imageRef: 'ghcr.io/owner/repo:tag',
    envConfig: { provider: 'hetzner' },
    s3Config: { stateBucket: 'state-a' },
    state: new StateTracker('myapp', 'prod'),
    onProgress: () => {},
    ...over,
  } as Record<string, any>;
}

/** The context of the next deploy: servers[] records what the last one persisted. */
function warmCtx(first: Record<string, any>, over: Record<string, unknown> = {}) {
  const entry = (node: any, stack: string) => ({
    name: `myapp-${first.environment}-${stack}`,
    id: node.serverId,
    ip: node.ip,
    role: stack,
  });
  return makeCtx({
    state: new StateTracker('myapp', first.environment),
    envConfig: {
      ...first.envConfig,
      servers: [entry(first.primary, 'primary'), entry(first.standby, 'standby')],
    },
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-infra-skip-'));
  cwd = process.cwd();
  process.chdir(dir);
  mkdirSync(join(dir, '.vibecarbon'));
  keyPath = join(dir, 'key');
  setPublicKey('ssh-ed25519 AAAA-one');
  fake.standbyType = 'cpx22';
  fake.version = '1.2.3';
  fake.sealFinishes = true;
  let n = 0;
  fake.upStack.mockReset();
  fake.upStack.mockImplementation(
    async (stack: string, _program: unknown, opts: { ledger?: unknown }) => {
      n += 1;
      if (opts?.ledger && fake.sealFinishes) recordStateSeal(opts.ledger as never, stack);
      return { outputs: outputsFor(stack, n) };
    },
  );
  vi.spyOn(HetznerProvider.prototype, 'createSSHKey').mockResolvedValue(111 as never);
  vi.spyOn(DigitalOceanProvider.prototype, 'createSSHKey').mockResolvedValue(111 as never);
  summaries.mockReset();
  summaries.mockResolvedValue({ status: 'running', serverType: 'cpx22' });
  vi.spyOn(HetznerProvider.prototype, 'getServerSummary').mockImplementation(summaries as never);
  vi.spyOn(DigitalOceanProvider.prototype, 'getServerSummary').mockImplementation(
    summaries as never,
  );
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const provision = (ctx: Record<string, any>) => COMPOSE_HA_EFFECTS.haProvisionServers(ctx);
const ups = () => fake.upStack.mock.calls.length;

describe('compose-ha infra skip', () => {
  it('the same inputs twice run Pulumi once and hand back identical outputs', async () => {
    const first = makeCtx();
    await provision(first);
    expect(ups()).toBe(2);

    const second = warmCtx(first);
    await provision(second);
    expect(ups()).toBe(2);
    expect(second.primary).toEqual(first.primary);
    expect(second.standby).toEqual(first.standby);
    expect(summaries).toHaveBeenCalledTimes(2);
    expect(summaries.mock.calls.map((c) => c[0]).sort()).toEqual(
      [first.primary.serverId, first.standby.serverId].sort(),
    );
  });

  // One test per hash input, each changing that input alone.
  const changes: Array<[string, (c: Record<string, any>) => void]> = [
    ['project name', (c) => (c.projectConfig = { ...c.projectConfig, projectName: 'other' })],
    ['primary region', (c) => (c.region = 'hel1')],
    ['standby region', (c) => (c.secondaryRegion = 'ash')],
    ['primary server type', (c) => (c.serverType = 'cpx32')],
    ['standby server type', () => (fake.standbyType = 'cpx32')],
    ['ssh public key', () => setPublicKey('ssh-ed25519 AAAA-two')],
    [
      'operator CIDRs',
      (c) =>
        (c.projectConfig = {
          ...c.projectConfig,
          operatorCidrs: [{ cidr: '198.51.100.7/32' }],
        }),
    ],
    [
      'operator CIDR added',
      (c) =>
        (c.projectConfig = {
          ...c.projectConfig,
          operatorCidrs: [{ cidr: '203.0.113.0/24' }, { cidr: '198.51.100.7/32' }],
        }),
    ],
    ['provider', (c) => (c.envConfig = { ...c.envConfig, provider: 'digitalocean' })],
    [
      'shared ssh key id',
      () => vi.spyOn(HetznerProvider.prototype, 'createSSHKey').mockResolvedValue(999 as never),
    ],
    ['state bucket', (c) => (c.s3Config = { stateBucket: 'state-b' })],
    ['CLI version', () => (fake.version = '999.0.0')],
  ];

  it.each(changes)('a changed %s runs Pulumi', async (_name, change) => {
    const first = makeCtx();
    await provision(first);
    expect(ups()).toBe(2);

    const next = warmCtx(first);
    change(next);
    await provision(next);
    expect(ups()).toBe(4);
  });

  it('each up is handed the ledger its seal marks', async () => {
    const first = makeCtx();
    await provision(first);
    for (const call of fake.upStack.mock.calls) expect(call[2].ledger).toBe(first.state);
    expect(stateSealRecorded(first.state, 'prod-primary')).toBe(true);
    expect(stateSealRecorded(first.state, 'prod-standby')).toBe(true);
  });

  it('a ledger an older version wrote (same inputs, no seal marker) runs both ups once more, then skips', async () => {
    const first = makeCtx();
    fake.sealFinishes = false;
    await provision(first);
    expect(ups()).toBe(2);

    // The upgraded CLI's first deploy: nothing changed, but nothing is sealed.
    fake.sealFinishes = true;
    const second = warmCtx(first);
    await provision(second);
    expect(ups()).toBe(4);

    const third = warmCtx(second);
    await provision(third);
    expect(ups()).toBe(4);
  });

  it('one stack sealed, the other not: both ups run', async () => {
    const first = makeCtx();
    fake.sealFinishes = false;
    await provision(first);
    const second = warmCtx(first);
    recordStateSeal(second.state, 'prod-primary');
    await provision(second);
    expect(ups()).toBe(4);
  });

  it('a changed environment runs Pulumi (its hash, not just its ledger file)', async () => {
    const first = makeCtx();
    await provision(first);
    // Same ledger file, hash compared: write the prod ledger under the
    // staging name so only the environment input differs.
    const ledger = JSON.parse(
      readFileSync(join(dir, '.vibecarbon', 'deploy-state-prod.json'), 'utf-8'),
    );
    writeFileSync(join(dir, '.vibecarbon', 'deploy-state-staging.json'), JSON.stringify(ledger));
    const next = warmCtx(first, { environment: 'staging' });
    next.state = new StateTracker('myapp', 'staging');
    next.envConfig.servers = next.envConfig.servers.map((s: any) => ({
      ...s,
      name: s.name.replace('-prod-', '-staging-'),
    }));
    await provision(next);
    expect(ups()).toBe(4);
  });

  describe('the ledger is checked against reality', () => {
    it('servers[] naming a different ip runs Pulumi', async () => {
      const first = makeCtx();
      await provision(first);
      const next = warmCtx(first);
      next.envConfig.servers[0].ip = '10.9.9.9';
      await provision(next);
      expect(ups()).toBe(4);
    });

    it('servers[] naming a different server id runs Pulumi', async () => {
      const first = makeCtx();
      await provision(first);
      const next = warmCtx(first);
      next.envConfig.servers[1].id = 'someone-else';
      await provision(next);
      expect(ups()).toBe(4);
    });

    it('no servers[] entry for a stack runs Pulumi', async () => {
      const first = makeCtx();
      await provision(first);
      const next = warmCtx(first);
      next.envConfig.servers = next.envConfig.servers.slice(0, 1);
      await provision(next);
      expect(ups()).toBe(4);
    });

    it('a numeric servers[] id equal to the recorded string still skips', async () => {
      fake.upStack.mockImplementation(
        async (stack: string, _program: unknown, opts: { ledger?: unknown }) => {
          if (opts?.ledger) recordStateSeal(opts.ledger as never, stack);
          return {
            outputs: { ...outputsFor(stack, 1), serverId: stack.endsWith('primary') ? '41' : '42' },
          };
        },
      );
      const first = makeCtx();
      await provision(first);
      const next = warmCtx(first);
      next.envConfig.servers[0].id = 41;
      next.envConfig.servers[1].id = 42;
      await provision(next);
      expect(ups()).toBe(2);
    });

    it('a server the provider no longer has runs Pulumi', async () => {
      const first = makeCtx();
      await provision(first);
      summaries.mockImplementation(async (id: string) =>
        id === first.standby.serverId ? null : { status: 'running' },
      );
      await provision(warmCtx(first));
      expect(ups()).toBe(4);
    });

    it('a probe that throws runs Pulumi', async () => {
      const first = makeCtx();
      await provision(first);
      summaries.mockRejectedValue(new Error('api down'));
      await provision(warmCtx(first));
      expect(ups()).toBe(4);
    });
  });

  it('a first run that fails in one arm completes nothing, and the next run provisions', async () => {
    let calls = 0;
    fake.upStack.mockImplementation(async (stack: string) => {
      calls += 1;
      if (stack === 'prod-standby') throw new Error('standby arm failed');
      return { outputs: outputsFor(stack, calls) };
    });
    const failed = makeCtx();
    await expect(provision(failed)).rejects.toThrow('standby arm failed');
    expect(new StateTracker('myapp', 'prod').getStepResult(COMPOSE_HA_INFRA_STEP)).toBeNull();

    fake.upStack.mockImplementation(async (stack: string) => ({ outputs: outputsFor(stack, 9) }));
    const before = ups();
    await provision(makeCtx({ state: new StateTracker('myapp', 'prod') }));
    expect(ups() - before).toBe(2);
  });

  describe('one region fails while the other is still updating', () => {
    it('waits for the other region, so no update is left running when the CLI exits', async () => {
      let finishStandby: (value: unknown) => void = () => {};
      fake.upStack.mockImplementation((stack: string) =>
        stack.endsWith('primary')
          ? Promise.reject(new Error('primary failed'))
          : new Promise((resolve) => {
              finishStandby = resolve;
            }),
      );

      const outcome = provision(makeCtx()).then(
        () => 'resolved',
        (err: Error) => err.message,
      );
      await vi.waitFor(() => expect(ups()).toBe(2));
      const pending = new Promise((resolve) => setTimeout(() => resolve('pending'), 25));
      expect(await Promise.race([outcome, pending])).toBe('pending');

      finishStandby({ outputs: outputsFor('prod-standby', 1) });
      expect(await outcome).toBe('primary failed');
    });

    it('rethrows the one failure as it was', async () => {
      const failure = new Error('standby failed');
      fake.upStack.mockImplementation(async (stack: string) => {
        if (stack.endsWith('standby')) throw failure;
        return { outputs: outputsFor(stack, 1) };
      });

      await expect(provision(makeCtx())).rejects.toBe(failure);
    });

    it('names both regions when both fail', async () => {
      fake.upStack.mockImplementation(async (stack: string) => {
        throw new Error(`${stack} failed`);
      });

      const message = await provision(makeCtx()).then(
        () => 'resolved',
        (err: Error) => err.message,
      );
      expect(message).toContain('primary: ');
      expect(message).toContain('prod-primary failed');
      expect(message).toContain('standby: ');
      expect(message).toContain('prod-standby failed');
    });
  });

  it('an arm that returns no serverIp fails the gate and completes nothing', async () => {
    fake.upStack.mockImplementation(async (stack: string) => ({
      outputs: stack === 'prod-primary' ? {} : outputsFor(stack, 2),
    }));
    await expect(provision(makeCtx())).rejects.toThrow(/no serverIp output for the primary/);
    expect(new StateTracker('myapp', 'prod').getStepResult(COMPOSE_HA_INFRA_STEP)).toBeNull();
  });

  describe.each(['primary', 'standby'])('a ledger entry missing an output of the %s', (arm) => {
    it.each(['serverIp', 'serverId', 'firewallId'])('%s provisions', async (field) => {
      const first = makeCtx();
      await provision(first);
      const ledger = join(dir, '.vibecarbon', 'deploy-state-prod.json');
      const raw = JSON.parse(readFileSync(ledger, 'utf-8'));
      delete raw.steps[COMPOSE_HA_INFRA_STEP].result[arm][field];
      writeFileSync(ledger, JSON.stringify(raw));

      const before = ups();
      const ctx = warmCtx(first);
      await provision(ctx);
      expect(ups() - before).toBe(2);
      expect(ctx.standby.ip).toMatch(/^10\.0\.0\./);
    });
  });

  it('a reconverge always provisions: the retired server may be gone', async () => {
    await provision(makeCtx());
    const before = ups();
    await provision(
      makeCtx({
        state: new StateTracker('myapp', 'prod'),
        reconverge: {
          promoted: { stack: 'primary', ip: '10.0.0.1', region: 'nbg1' },
          retired: { stack: 'standby', ip: '10.0.0.2', region: 'fsn1' },
        },
      }),
    );
    expect(ups() - before).toBe(2);
  });
});

describe('a compose scale invalidates the recorded infra', () => {
  it('recordPendingServerState drops compose-ha-infra so the next deploy provisions', async () => {
    const { recordPendingServerState } = await import(
      '../../../src/lib/deploy/compose/server-state-sync.js'
    );
    const config = await import('../../../src/lib/config.js');
    vi.spyOn(config, 'updateProjectConfig').mockImplementation((() => ({})) as never);

    await provision(makeCtx());
    expect(ups()).toBe(2);
    recordPendingServerState('prod', {
      stack: 'prod-primary',
      serverId: 'new',
      serverType: 'cpx22',
      ip: '10.0.0.9',
    });
    expect(new StateTracker('myapp', 'prod').getStepResult(COMPOSE_HA_INFRA_STEP)).toBeNull();

    await provision(makeCtx({ state: new StateTracker('myapp', 'prod') }));
    expect(ups()).toBe(4);
  });
});
