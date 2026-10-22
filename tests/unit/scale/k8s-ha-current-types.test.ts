import { beforeEach, describe, expect, it, vi } from 'vitest';

// k8s-ha scale shows the serving primary's own types (ha.primary), not the
// top-level ones, which describe the side that was primary at the first
// deploy: after a failover, or with a standby on other types, they differ.

const notes: string[] = [];
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro() {},
    note: (msg: string) => notes.push(msg),
    outro() {},
    spinner: () => ({ start() {}, stop() {}, message() {} }),
    multiselect: async () => Symbol('cancel'),
    isCancel: () => true,
    cancel() {},
    log: { info() {}, warn() {}, step() {}, success() {}, message() {}, error() {} },
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
  // No saved token: scaleK8s skips the live catalog fetch.
  return { ...actual, resolveProviderToken: () => null };
});

const { run } = await import('../../../src/scale.js');

beforeEach(() => {
  notes.length = 0;
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
});

describe('k8s-ha scale current configuration', () => {
  it("shows ha.primary's types after a failover", async () => {
    projectConfig = {
      projectName: 'proj',
      environments: {
        prod: {
          status: 'deployed',
          provider: 'digitalocean',
          deployMode: 'kubernetes',
          region: 'tor1',
          secondaryRegion: 'sfo3',
          masterServerType: 's-2vcpu-4gb-amd',
          dbServerType: 's-1vcpu-2gb-amd',
          workerServerType: 's-2vcpu-4gb-amd',
          ha: {
            enabled: true,
            primary: {
              stack: 'prod-standby',
              region: 'tor1',
              masterServerType: 's-2vcpu-4gb',
              dbServerType: 's-1vcpu-2gb',
              workerServerType: 's-2vcpu-4gb',
            },
            standby: { stack: 'prod-primary', region: 'sfo3' },
          },
        },
      },
    };
    await run(['prod']).catch(() => {});
    const current = notes.join('\n');
    expect(current).toMatch(/Master type\s+\S*s-2vcpu-4gb\b(?!-amd)/);
    expect(current).toMatch(/Database type\s+\S*s-1vcpu-2gb\b(?!-amd)/);
    expect(current).toMatch(/Worker type\s+\S*s-2vcpu-4gb\b(?!-amd)/);
  });
});
