import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A k8s-ha scale's ups declare each cluster's replication rule from the other
// side's recorded database address (replicationPeerIpFor, read again inside
// convergeClusterInfra). A hand-edited address must stop the scale before any
// up: refused inside the standby's converge, it left the primary resized, the
// standby not, and the record not updated. Review Focus 5.

const errors: string[] = [];
vi.mock('../../../src/lib/deploy/preflight.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertScaffoldSupportsRoleFile: () => {},
}));
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro() {},
    note() {},
    outro() {},
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: {
      info() {},
      warn() {},
      step() {},
      success() {},
      message() {},
      error: (msg: string) => errors.push(msg),
    },
  };
});

let projectConfig: Record<string, unknown> = {};
vi.mock('../../../src/lib/project-guard.js', () => ({
  assertInProjectDir: () => projectConfig,
}));
vi.mock('../../../src/lib/cli/intro.js', () => ({ introCommand: () => {} }));
vi.mock('../../../src/lib/project.js', () => ({ repairLegacyEnvQuoting: () => {} }));
vi.mock('../../../src/lib/iac/converge-cluster.js', () => ({
  convergeClusterInfra: vi.fn(async () => ({ outputs: {} })),
}));
vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  // No saved token and no catalog: the location check has nothing to refuse.
  return { ...actual, resolveProviderToken: () => null };
});

const { run } = await import('../../../src/scale.js');
const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');
const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');

const PRIMARY_DB = '198.51.100.1';
const STANDBY_DB = '198.51.100.2';

function haEnv(primary: Record<string, unknown>, standby: Record<string, unknown>) {
  return {
    status: 'deployed',
    provider: 'digitalocean',
    deployMode: 'kubernetes',
    region: 'sfo3',
    secondaryRegion: 'tor1',
    masterServerType: 's-2vcpu-4gb-amd',
    dbServerType: 's-1vcpu-2gb-amd',
    workerServerType: 's-2vcpu-4gb-amd',
    ha: { enabled: true, primary, standby },
  };
}

const message = (role: string, bad: string, stack: string) =>
  `ha.${role}.dbIp ${JSON.stringify(bad)} in environment prod is not an IPv4 address ` +
  `(the replication peer of stack ${stack}; set it to that database node's public IPv4 in ` +
  '.vibecarbon.json, or delete it and vibecarbon deploy records it again)';

beforeEach(() => {
  errors.length = 0;
  vi.mocked(convergeClusterInfra).mockClear();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  // Past the refusal under test, the scale stops at the token prompt.
  vi.spyOn(DigitalOceanProvider, 'promptApiToken').mockResolvedValue(null as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('k8s-ha scale -type with a recorded peer address that is not IPv4', () => {
  it('a bad ha.primary.dbIp: refused before the token prompt and any up', async () => {
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: haEnv(
          { stack: 'prod-primary', region: 'sfo3', dbIp: '10.0.0.300' },
          { stack: 'prod-standby', region: 'tor1', dbIp: STANDBY_DB },
        ),
      },
    };
    await expect(run(['prod', '-y', '-type', 's-4vcpu-8gb-amd'])).rejects.toThrow('exit 1');
    // The standby's program declares the primary's address.
    expect(errors).toEqual([message('primary', '10.0.0.300', 'prod-standby')]);
    expect(DigitalOceanProvider.promptApiToken).not.toHaveBeenCalled();
    expect(convergeClusterInfra).not.toHaveBeenCalled();
  });

  it('a bad ha.standby.dbIp: refused the same way', async () => {
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: haEnv(
          { stack: 'prod-primary', region: 'sfo3', dbIp: PRIMARY_DB },
          { stack: 'prod-standby', region: 'tor1', dbIp: 'not-an-ip' },
        ),
      },
    };
    await expect(run(['prod', '-y', '-type', 's-4vcpu-8gb-amd'])).rejects.toThrow('exit 1');
    expect(errors).toEqual([message('standby', 'not-an-ip', 'prod-primary')]);
    expect(DigitalOceanProvider.promptApiToken).not.toHaveBeenCalled();
    expect(convergeClusterInfra).not.toHaveBeenCalled();
  });

  it('after a failover the stacks keep their names: the message names the stack that reads it', async () => {
    // swapHaRoles: ha.primary is now the prod-standby stack.
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: haEnv(
          { stack: 'prod-standby', region: 'tor1', dbIp: STANDBY_DB },
          { stack: 'prod-primary', region: 'sfo3', dbIp: 'not-an-ip' },
        ),
      },
    };
    await expect(run(['prod', '-y', '-type', 's-4vcpu-8gb-amd'])).rejects.toThrow('exit 1');
    expect(errors).toEqual([message('standby', 'not-an-ip', 'prod-standby')]);
    expect(convergeClusterInfra).not.toHaveBeenCalled();
  });

  it('good addresses pass the check and the scale goes on to the token prompt', async () => {
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: haEnv(
          { stack: 'prod-primary', region: 'sfo3', dbIp: PRIMARY_DB },
          { stack: 'prod-standby', region: 'tor1', dbIp: STANDBY_DB },
        ),
      },
    };
    await expect(run(['prod', '-y', '-type', 's-4vcpu-8gb-amd'])).rejects.toThrow('exit 1');
    expect(errors).toEqual(['API token required for server type changes']);
    expect(DigitalOceanProvider.promptApiToken).toHaveBeenCalledTimes(1);
  });
});
