/**
 * PR 2 final review C1(a): an environment whose servers exist, deployed from a
 * machine without `.vibecarbon/deploy_key_<env>`, stops before any key is made
 * and before any up runs. Before this, provisionServer made a new key and the
 * seal's up ran with it: on DigitalOcean the SshKey resource was replaced, the
 * droplet's sshKeys with it, and so the droplet and its database.
 *
 * Every mode's key step runs here with the REAL generators (generateSSHKeyPair,
 * ensureSshKey): a missing guard makes a key file, which the tests look for.
 * The up and every provider API call are recorded and must not happen. The
 * deploy's own entry check (orchestrator.js) runs before the first SSH call.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../../_shared/temp-dir.js';

const upStackMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('STOP_AT_UP');
  }),
);
vi.mock('../../../src/lib/iac/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  upStack: upStackMock,
}));

// deployK3s' preflight answers "no docker" so a deployK3s that got past the
// key check stops there instead of starting an image build.
vi.mock('../../../src/lib/command.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkDependency: () => false,
}));

// executeDeployment's first steps after the key check: the stranded-fence
// lift (SSH to the primary), the host-tool preflight, the operator firewall
// patch and the deploy ledger. Each one recorded; none may run.
const entry = vi.hoisted(() => ({
  lift: vi.fn(async () => {}),
  preflight: vi.fn(() => {
    throw new Error('STOP_AT_PREFLIGHT');
  }),
  operatorIp: vi.fn(async () => ({ added: false })),
  stateTracker: vi.fn(),
}));
vi.mock('../../../src/lib/deploy/write-fence.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  liftStrandedWriteFence: entry.lift,
}));
vi.mock('../../../src/lib/deploy/preflight.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  checkDeployPrerequisites: entry.preflight,
  operatorCheckEnvs: () => [],
}));
vi.mock('../../../src/lib/operator-ip.js', () => ({ ensureOperatorIpAccess: entry.operatorIp }));
vi.mock('../../../src/lib/deploy/state.js', () => ({
  StateTracker: class {
    constructor(...args: unknown[]) {
      entry.stateTracker(...args);
      throw new Error('STOP_AT_STATE_TRACKER');
    }
  },
}));

const { EFFECTS } = await import('../../../src/lib/deploy/effects/index.js');
const { deployK3s } = await import('../../../src/lib/deploy/k8s/k3s.js');
const { executeDeployment } = await import('../../../src/lib/deploy/orchestrator.js');
// @ts-expect-error: JS module without types
const { DeployKeyMissingError } = await import('../../../src/lib/deploy/deploy-key.js');
const { sshKeyPathFor } = await import('../../../src/lib/ssh.js');

const PROJECT = 'testapp';
const ENV = 'prod';

/** Each mode's record of servers a deploy already made, on DigitalOcean. */
const RECORDED: Record<string, Record<string, unknown>> = {
  compose: {
    provider: 'digitalocean',
    deployMode: 'compose',
    region: 'sfo3',
    servers: [{ name: 'master', id: '501', ip: '203.0.113.5', region: 'sfo3' }],
  },
  'compose-ha': {
    provider: 'digitalocean',
    deployMode: 'compose-ha',
    region: 'sfo3',
    secondaryRegion: 'tor1',
    ha: { enabled: true, failoverRegion: 'tor1' },
    servers: [
      {
        name: `${PROJECT}-${ENV}-primary`,
        id: 601,
        ip: '203.0.113.6',
        region: 'sfo3',
        serverType: 's-2vcpu-4gb-intel',
        role: 'primary',
      },
      {
        name: `${PROJECT}-${ENV}-standby`,
        id: 602,
        ip: '203.0.113.7',
        region: 'tor1',
        serverType: 's-2vcpu-4gb-intel',
        role: 'standby',
      },
    ],
  },
  k8s: {
    provider: 'digitalocean',
    deployMode: 'kubernetes',
    region: 'sfo3',
    servers: [
      { name: 'master', ip: '203.0.113.8', region: 'sfo3', role: 'master' },
      { name: 'db', ip: '203.0.113.9', region: 'sfo3', role: 'db' },
    ],
  },
  'k8s-ha': {
    provider: 'digitalocean',
    deployMode: 'kubernetes',
    region: 'sfo3',
    secondaryRegion: 'tor1',
    ha: {
      enabled: true,
      primary: { stack: `${ENV}-primary`, region: 'sfo3', masterIp: '203.0.113.10' },
      standby: { stack: `${ENV}-standby`, region: 'tor1', masterIp: '203.0.113.11' },
    },
    servers: [
      { name: 'primary', role: 'primary', ip: '203.0.113.10', region: 'sfo3' },
      { name: 'standby', role: 'standby', ip: '203.0.113.11', region: 'tor1' },
    ],
  },
};

let dir = '';
let keyPath = '';
let cwd: ReturnType<typeof vi.spyOn> | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  // A project on a machine that never deployed it: no .vibecarbon/ at all.
  dir = createTempDir('deploy-key-refusal-');
  cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
  keyPath = sshKeyPathFor(ENV, dir);
  // Any provider API call (createSSHKey, a catalog read) is a failure here.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('NO_NETWORK_IN_THIS_TEST');
  });
  upStackMock.mockClear();
  for (const fn of Object.values(entry)) fn.mockClear();
});
afterEach(() => {
  cwd?.mockRestore();
  fetchSpy?.mockRestore();
});

/** Nothing was made or touched: no key file, no up, no provider call. */
function expectNothingTouched() {
  expect(existsSync(keyPath)).toBe(false);
  expect(existsSync(`${keyPath}.pub`)).toBe(false);
  expect(upStackMock).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

const composeCtx = (envConfig: Record<string, unknown>) => ({
  projectConfig: { projectName: PROJECT, operatorCidrs: [{ cidr: '198.51.100.1/32' }] },
  environment: ENV,
  region: 'sfo3',
  serverType: undefined,
  apiToken: 'test-token',
  s3Config: { bucket: 'b', region: 'sfo3' },
  sshKeyPath: keyPath,
  envConfig,
  state: { invalidateStep: () => {} },
  serverIp: (envConfig.servers as { ip?: string }[] | undefined)?.[0]?.ip ?? null,
  providerServerId: (envConfig.servers as { id?: string }[] | undefined)?.[0]?.id ?? null,
  stateSealed: false,
});

describe('compose: provisionServer', () => {
  it('a server on record and no key here: refused before a key is made or the up runs', async () => {
    await expect(EFFECTS.provisionServer(composeCtx(RECORDED.compose))).rejects.toBeInstanceOf(
      DeployKeyMissingError,
    );
    expectNothingTouched();
  });

  it('a first deploy makes its key and runs the up (the same harness sees both)', async () => {
    await expect(EFFECTS.provisionServer(composeCtx({ provider: 'digitalocean' }))).rejects.toThrow(
      'STOP_AT_UP',
    );
    expect(readFileSync(`${keyPath}.pub`, 'utf8')).toMatch(/^ssh-ed25519 /);
    expect(upStackMock).toHaveBeenCalledTimes(1);
  });
});

describe('compose-ha: haProvisionServers', () => {
  it('servers on record and no key here: refused before a key is made, uploaded or used', async () => {
    const ctx = {
      ...composeCtx(RECORDED['compose-ha']),
      imageRef: 'ghcr.io/owner/testapp:abc',
      secondaryRegion: 'tor1',
      onProgress: () => {},
    };
    await expect(EFFECTS.haProvisionServers(ctx)).rejects.toBeInstanceOf(DeployKeyMissingError);
    expectNothingTouched();
  });
});

describe('k8s: deployK3s', () => {
  const k8sOptions = (envConfig: Record<string, unknown>) => ({
    projectName: PROJECT,
    environment: ENV,
    provider: 'digitalocean',
    region: 'sfo3',
    envConfig,
    state: { getStepResult: () => undefined },
  });

  it('a cluster on record and no key here: refused before the preflight, a key or the up', async () => {
    await expect(deployK3s(k8sOptions(RECORDED.k8s))).rejects.toBeInstanceOf(DeployKeyMissingError);
    expectNothingTouched();
  });

  it('a first deploy goes on past the key check (to the preflight here)', async () => {
    await expect(deployK3s(k8sOptions({ provider: 'digitalocean' }))).rejects.toThrow(
      /Required tool 'docker' not found/,
    );
  });

  it("an HA cluster uses the shared key haK8sGenerateSshKey required, so it isn't checked again", async () => {
    await expect(
      deployK3s({
        ...k8sOptions(RECORDED['k8s-ha']),
        environment: `${ENV}-primary`,
        sharedSshKeyPath: keyPath,
      }),
    ).rejects.toThrow(/Required tool 'docker' not found/);
  });
});

describe('k8s-ha: haK8sGenerateSshKey', () => {
  const k8sHaCtx = (envConfig: Record<string, unknown>) => ({
    options: {
      projectName: PROJECT,
      environment: ENV,
      provider: 'digitalocean',
      region: 'sfo3',
      secondaryRegion: 'tor1',
      envConfig,
    },
  });

  it('clusters on record and no key here: refused before the shared key is made or uploaded', async () => {
    const ctx: Record<string, unknown> = k8sHaCtx(RECORDED['k8s-ha']);
    await expect(EFFECTS.haK8sGenerateSshKey(ctx)).rejects.toBeInstanceOf(DeployKeyMissingError);
    expect(ctx.sharedSshKeyPath).toBeUndefined();
    expectNothingTouched();
  });

  it('a first deploy makes the shared key', async () => {
    const ctx: Record<string, unknown> = k8sHaCtx({ provider: 'digitalocean' });
    await EFFECTS.haK8sGenerateSshKey(ctx);
    expect(ctx.sharedSshKeyPath).toBe(keyPath);
    expect(existsSync(`${keyPath}.pub`)).toBe(true);
  });
});

describe('executeDeployment: the entry check', () => {
  const gathered = (envConfig: Record<string, unknown>) => ({
    projectConfig: { projectName: PROJECT, environments: { [ENV]: envConfig } },
    envConfig,
    environment: ENV,
    domain: 'prod.example.com',
    config: {
      environment: ENV,
      provider: 'digitalocean',
      deployMode: envConfig.deployMode,
      ha: envConfig.ha,
    },
  });

  for (const tier of Object.keys(RECORDED)) {
    it(`${tier}: refused before the stranded-fence lift, the preflight, the firewall and the ledger`, async () => {
      // A stranded write fence on record: the lift would SSH to the primary
      // with the key this machine lacks.
      const envConfig = structuredClone(RECORDED[tier]);
      const primaryIp = (envConfig.servers as { ip: string }[])[0].ip;
      envConfig.ha = {
        ...((envConfig.ha as object | undefined) ?? {}),
        writeFence: { node: 'primary', ip: primaryIp, at: '2026-11-11T00:00:00.000Z' },
      };

      await expect(executeDeployment({}, gathered(envConfig) as never)).rejects.toBeInstanceOf(
        DeployKeyMissingError,
      );
      expect(entry.lift).not.toHaveBeenCalled();
      expect(entry.preflight).not.toHaveBeenCalled();
      expect(entry.operatorIp).not.toHaveBeenCalled();
      expect(entry.stateTracker).not.toHaveBeenCalled();
      expectNothingTouched();
    });
  }

  it('an env with nothing on record goes on to the preflight', async () => {
    await expect(
      executeDeployment({}, gathered({ provider: 'digitalocean', deployMode: 'compose' }) as never),
    ).rejects.toThrow('STOP_AT_PREFLIGHT');
  });
});
