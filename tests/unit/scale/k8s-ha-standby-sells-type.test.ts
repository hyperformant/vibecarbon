import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';

// k8s-ha `scale -type X` resizes the standby cluster too. With the live
// catalog loaded, a type the standby's location does not sell is refused
// before any Pulumi run, naming the location and the type. With no catalog
// loaded, scale behaves as before.
//
// DigitalOcean 2026-10-22: sfo3 sells the -amd Basic droplets, tor1 does not.

const errors: string[] = [];
const infos: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro() {},
    note() {},
    outro() {},
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    log: {
      info: (msg: string) => infos.push(msg),
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
  // No saved token: the catalog is whatever the test seeds.
  return { ...actual, resolveProviderToken: () => null };
});

const { run } = await import('../../../src/scale.js');
const { convergeClusterInfra } = await import('../../../src/lib/iac/converge-cluster.js');
const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');

const env = {
  status: 'deployed',
  provider: 'digitalocean',
  deployMode: 'kubernetes',
  region: 'sfo3',
  secondaryRegion: 'tor1',
  masterServerType: 's-2vcpu-4gb-amd',
  dbServerType: 's-1vcpu-2gb-amd',
  workerServerType: 's-2vcpu-4gb-amd',
  ha: {
    enabled: true,
    primary: { stack: 'prod-primary', region: 'sfo3' },
    standby: { stack: 'prod-standby', region: 'tor1' },
  },
};

let restore: (() => void) | undefined;
beforeEach(() => {
  errors.length = 0;
  infos.length = 0;
  vi.mocked(convergeClusterInfra).mockClear();
  projectConfig = { projectName: 'proj', environments: { prod: env } };
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  // Stop right after the checks under test, at the token prompt.
  vi.spyOn(DigitalOceanProvider, 'promptApiToken').mockResolvedValue(null as never);
});
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

describe('k8s-ha scale -type the standby location does not sell', () => {
  it('refuses before any Pulumi run, naming the location and type', async () => {
    restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    await expect(run(['prod', '-y', '-type', 's-4vcpu-8gb-amd'])).rejects.toThrow('exit 1');
    expect(errors).toEqual([
      "the standby's location tor1 does not sell s-4vcpu-8gb-amd, so the standby cannot be scaled to it",
    ]);
    expect(infos.at(-1)).toMatch(/both sfo3 and tor1 sell/);
    expect([...errors, ...infos].join('\n')).not.toContain('—');
    expect(DigitalOceanProvider.promptApiToken).not.toHaveBeenCalled();
    expect(convergeClusterInfra).not.toHaveBeenCalled();
  });

  it('a type both locations sell passes the check', async () => {
    restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    await expect(run(['prod', '-y', '-type', 's-4vcpu-8gb-intel'])).rejects.toThrow('exit 1');
    expect(errors).toEqual(['API token required for server type changes']);
  });

  it('with no catalog loaded, scale behaves as before', async () => {
    await expect(run(['prod', '-y', '-type', 's-4vcpu-8gb-amd'])).rejects.toThrow('exit 1');
    expect(errors).toEqual(['API token required for server type changes']);
  });
});
