/**
 * A warm compose-ha deploy skips both Pulumi `up`s when nothing the two
 * programs receive changed, as k8s does with `k3s-infra`. These tests drive
 * haProvisionServers with `upStack` faked at its boundary and a real
 * StateTracker on a temp directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  upStack: vi.fn(),
  standbyType: 'cpx22',
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
const { StateTracker } = await import('../../../src/lib/deploy/state.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ha-infra-skip-'));
  cwd = process.cwd();
  process.chdir(dir);
  mkdirSync(join(dir, '.vibecarbon'));
  keyPath = join(dir, 'key');
  setPublicKey('ssh-ed25519 AAAA-one');
  fake.standbyType = 'cpx22';
  let n = 0;
  fake.upStack.mockReset();
  fake.upStack.mockImplementation(async (stack: string) => {
    n += 1;
    return { outputs: outputsFor(stack, n) };
  });
  vi.spyOn(HetznerProvider.prototype, 'createSSHKey').mockResolvedValue(111 as never);
  vi.spyOn(DigitalOceanProvider.prototype, 'createSSHKey').mockResolvedValue(222 as never);
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

    const second = makeCtx({ state: new StateTracker('myapp', 'prod') });
    await provision(second);
    expect(ups()).toBe(2);
    expect(second.primary).toEqual(first.primary);
    expect(second.standby).toEqual(first.standby);
  });

  const changes: Array<[string, (c: Record<string, any>) => void]> = [
    ['project name', (c) => (c.projectConfig = { ...c.projectConfig, projectName: 'other' })],
    ['environment', (c) => (c.environment = 'staging')],
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
    [
      'provider',
      (c) => {
        c.envConfig = { provider: 'digitalocean' };
        c.region = 'nyc3';
        c.secondaryRegion = 'sfo3';
      },
    ],
    ['state bucket', (c) => (c.s3Config = { stateBucket: 'state-b' })],
  ];

  it.each(changes)('a changed %s runs Pulumi', async (_name, change) => {
    await provision(makeCtx());
    expect(ups()).toBe(2);

    const next = makeCtx({ state: new StateTracker('myapp', 'prod') });
    change(next);
    // The ledger file is keyed by environment, so a changed environment reads
    // its own empty one: the tracker below is what a real deploy builds.
    next.state = new StateTracker('myapp', next.environment);
    await provision(next);
    expect(ups()).toBe(4);
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
    expect(new StateTracker('myapp', 'prod').getStepResult('compose-ha-infra')).toBeNull();

    fake.upStack.mockImplementation(async (stack: string) => ({ outputs: outputsFor(stack, 9) }));
    const before = ups();
    await provision(makeCtx({ state: new StateTracker('myapp', 'prod') }));
    expect(ups() - before).toBe(2);
  });

  it('an arm that returns no serverIp fails the gate and completes nothing', async () => {
    fake.upStack.mockImplementation(async (stack: string) => ({
      outputs: stack === 'prod-primary' ? {} : outputsFor(stack, 2),
    }));
    await expect(provision(makeCtx())).rejects.toThrow(/no serverIp output for the primary/);
    expect(new StateTracker('myapp', 'prod').getStepResult('compose-ha-infra')).toBeNull();
  });

  it('a ledger entry with missing outputs provisions instead of continuing with undefined', async () => {
    await provision(makeCtx());
    const ledger = join(dir, '.vibecarbon', 'deploy-state-prod.json');
    const { readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync(ledger, 'utf-8'));
    delete raw.steps['compose-ha-infra'].result.standby.serverIp;
    writeFileSync(ledger, JSON.stringify(raw));

    const before = ups();
    const ctx = makeCtx({ state: new StateTracker('myapp', 'prod') });
    await provision(ctx);
    expect(ups() - before).toBe(2);
    expect(ctx.standby.ip).toMatch(/^10\.0\.0\./);
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
    expect(new StateTracker('myapp', 'prod').getStepResult('compose-ha-infra')).toBeNull();

    await provision(makeCtx({ state: new StateTracker('myapp', 'prod') }));
    expect(ups()).toBe(4);
  });
});
