/**
 * A Vultr k8s or k8s-ha deploy that names sjc, as the primary or the standby,
 * is refused before any provider API or Pulumi call: Vultr sells no NVMe
 * block storage in sjc, which the cluster's database volume needs. Both entry
 * points hold the rule (providers/index.js assertRegionSupportedForTier): the
 * wizard right after the tier is known (gatherDeploymentConfig), and the
 * orchestrator's entry (executeDeployment), which a saved config reaches
 * without the wizard. The wizard's region and standby lists for those tiers
 * leave sjc out. Compose tiers use sjc freely. Harness as in
 * linode-k8s-region-gate.test.ts and deploy-key-refusal.test.ts.
 */
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';
import { copyTemplate } from '../helpers/copy-template.js';

const clackMock = await vi.hoisted(async () => {
  const { clackFake } = await import('../../_shared/clack-fake.js');
  return clackFake({
    fns: ['select', 'cancel', 'text', 'password', 'note', 'intro'],
    log: ['step', 'info', 'warn', 'error', 'success', 'message'],
    spinner: true,
    with: { isCancel: vi.fn(() => false), confirm: vi.fn(async () => true) },
  });
});
vi.mock('@clack/prompts', () => clackMock);
vi.mock('../../../src/lib/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadProjectConfig: () => ({
    projectName: 'lockapp',
    bucketSalt: 'abc123',
    environments: { prod: { provider: 'vultr' } },
  }),
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', () => ({
  collectDeployDelta: () => ({}),
  formatDeployDeltaLines: () => [],
}));

// The orchestrator's steps around its entry guard, each recorded. The
// host-tool preflight passes, so the guard is what stops the deploy; every
// step after it is provider or Pulumi work and must not run.
const entry = vi.hoisted(() => ({
  preflight: vi.fn(),
  operatorIp: vi.fn(async () => ({ added: false })),
  stateTracker: vi.fn(),
  upStack: vi.fn(async () => {
    throw new Error('STOP_AT_UP');
  }),
}));
vi.mock('../../../src/lib/deploy/preflight.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  assertOperatorConfig: vi.fn(),
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
vi.mock('../../../src/lib/iac/index.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  upStack: entry.upStack,
}));
vi.mock('../../../src/lib/ci-setup.js', () => ({ ciAvailable: () => false }));

import { executeDeployment } from '../../../src/lib/deploy/orchestrator.js';
import { gatherDeploymentConfig } from '../../../src/lib/deploy/prompts.js';
import { assertRegionSupportedForTier } from '../../../src/lib/providers/index.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const SJC_REFUSAL =
  "Kubernetes on Vultr does not run in Silicon Valley (sjc): Vultr sells no NVMe block storage there for the cluster's database volume. Use lax, ewr or another region.";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function project() {
  const dir = createTempDir('vc-gather-vultr-region-');
  dirs.push(dir);
  copyTemplate(dir);
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
}

let restoreCatalog: () => void;
let fetchSpy: ReturnType<typeof vi.spyOn>;
/** Provider and Pulumi work that must not start once sjc is named for a k8s tier. */
const later = {
  apiToken: vi.fn(),
  fetchTypes: vi.fn(),
  s3Keys: vi.fn(),
  k8sProgram: vi.fn(),
};
beforeEach(() => {
  vi.spyOn(console, 'clear').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.spyOn(VultrProvider, 'promptApiToken').mockImplementation(async () => {
    later.apiToken();
    return 'A'.repeat(36);
  });
  vi.spyOn(VultrProvider, 'fetchServerTypes').mockImplementation(async () => {
    later.fetchTypes();
    return undefined as never;
  });
  vi.spyOn(VultrProvider, 'promptObjectStorageCredentials').mockImplementation(async () => {
    later.s3Keys();
    return { accessKey: 'ABCDEFGHIJ0123456789', secretKey: 'x'.repeat(40) };
  });
  vi.spyOn(VultrProvider, 'getK8sProgram').mockImplementation(async () => {
    later.k8sProgram();
    throw new Error('STOP_AT_PROGRAM');
  });
  // Any provider API call is a failure here.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('NO_NETWORK_IN_THIS_TEST');
  });
  restoreCatalog = seedCatalog(VultrProvider, '2026-10-22/vultr');
});
afterEach(() => {
  restoreCatalog();
  vi.restoreAllMocks();
  for (const fn of [...Object.values(later), ...Object.values(entry)]) fn.mockClear();
  for (const fn of [clackMock.select, clackMock.text, clackMock.password]) fn.mockClear();
  clackMock.log.error.mockClear();
});

function expectNoProviderOrPulumiWork() {
  for (const [name, fn] of Object.entries(later)) {
    expect(fn, `${name} ran before the refusal`).not.toHaveBeenCalled();
  }
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(entry.upStack).not.toHaveBeenCalled();
}

describe('the Vultr k8s region rule', () => {
  it.each(['k8s', 'k8s-ha'])(
    '%s refuses sjc as the primary, naming it and a region that works',
    (tier) => {
      expect(() => assertRegionSupportedForTier(VultrProvider, tier, 'sjc')).toThrow(SJC_REFUSAL);
    },
  );

  it('k8s-ha refuses sjc as the standby', () => {
    expect(() => assertRegionSupportedForTier(VultrProvider, 'k8s-ha', 'ewr', 'sjc')).toThrow(
      SJC_REFUSAL,
    );
  });

  it.each(['compose', 'compose-ha'])('%s may use sjc', (tier) => {
    expect(() => assertRegionSupportedForTier(VultrProvider, tier, 'sjc', 'lax')).not.toThrow();
  });

  it('every other Vultr region runs Kubernetes', () => {
    for (const region of Object.keys(VultrProvider.REGIONS).filter((r) => r !== 'sjc')) {
      expect(VultrProvider.k8sRegionProblem(region), region).toBeNull();
    }
  });
});

describe('deploy wizard: a Vultr k8s tier in sjc', () => {
  it.each([
    ['k8s', { k8s: true }],
    ['k8s-ha', { k8s: true, ha: true }],
  ])('%s -region sjc: refused before any prompt or provider call', async (_tier, mode) => {
    project();
    const err = await gatherDeploymentConfig({
      env: 'prod',
      yes: true,
      region: 'sjc',
      ...mode,
    }).catch((e) => e);
    expect(String(err)).toContain(SJC_REFUSAL);
    expectNoProviderOrPulumiWork();
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('k8s-ha -standby-region sjc is refused the same way', async () => {
    project();
    const err = await gatherDeploymentConfig({
      env: 'prod',
      yes: true,
      region: 'ewr',
      secondaryRegion: 'sjc',
      k8s: true,
      ha: true,
    }).catch((e) => e);
    expect(String(err)).toContain(SJC_REFUSAL);
    expectNoProviderOrPulumiWork();
  });

  it.each([
    ['k8s', { k8s: true }],
    ['k8s-ha', { k8s: true, ha: true }],
  ])('%s: the interactive region and standby lists leave sjc out', async (_tier, mode) => {
    project();
    const lists: Record<string, string[]> = {};
    clackMock.select.mockImplementation(async ({ message, options, initialValue }) => {
      lists[message] = options.map((o: { value: string }) => o.value);
      if (message === 'Region:') return initialValue;
      throw new Error('stop');
    });
    vi.spyOn(VultrProvider, 'promptObjectStorageCredentials').mockRejectedValue(new Error('stop'));
    await gatherDeploymentConfig({ env: 'prod', ...mode }).catch(() => {});
    expect(lists['Region:']).toContain('ewr');
    expect(lists['Region:']).toContain('lax');
    expect(lists['Region:']).not.toContain('sjc');
    if ('ha' in mode) {
      const standby = lists['Standby region (HA failover target):'];
      expect(standby).toContain('ord');
      expect(standby).not.toContain('sjc');
    }
    clackMock.select.mockReset();
  });

  it('compose: the region list keeps sjc', async () => {
    project();
    const lists: Record<string, string[]> = {};
    clackMock.select.mockImplementation(async ({ message, options }) => {
      lists[message] = options.map((o: { value: string }) => o.value);
      throw new Error('stop');
    });
    await gatherDeploymentConfig({ env: 'prod', compose: true }).catch(() => {});
    expect(lists['Region:']).toContain('sjc');
    clackMock.select.mockReset();
  });
});

describe('orchestrator entry: a saved Vultr k8s config in sjc', () => {
  const gathered = (tier: 'k8s' | 'k8s-ha', region: string, secondaryRegion?: string) => {
    const ha = tier === 'k8s-ha';
    const envConfig = { provider: 'vultr' };
    return {
      projectConfig: { projectName: 'lockapp', environments: { prod: envConfig } },
      envConfig,
      environment: 'prod',
      domain: 'prod.example.com',
      region,
      secondaryRegion,
      config: {
        environment: 'prod',
        provider: 'vultr',
        deployMode: 'kubernetes',
        ha,
        region,
        secondaryRegion,
      },
    };
  };

  it.each([
    ['k8s', 'sjc', undefined],
    ['k8s-ha', 'sjc', 'ewr'],
    ['k8s-ha', 'ewr', 'sjc'],
  ] as const)(
    '%s primary %s standby %s: refused before any provider or Pulumi call',
    async (tier, region, standby) => {
      project();
      const err = await executeDeployment({}, gathered(tier, region, standby) as never).catch(
        (e) => e,
      );
      expect(String(err)).toContain(SJC_REFUSAL);
      // The host-tool preflight ran, so the guard is what stopped the deploy.
      expect(entry.preflight).toHaveBeenCalled();
      expect(entry.operatorIp).not.toHaveBeenCalled();
      expect(entry.stateTracker).not.toHaveBeenCalled();
      expectNoProviderOrPulumiWork();
    },
  );

  it('a k8s config in lax goes on past the guard (the same harness sees both)', async () => {
    project();
    const err = await executeDeployment({}, gathered('k8s', 'lax') as never).catch((e) => e);
    expect(String(err)).not.toContain('Kubernetes on Vultr does not run');
    expect(entry.operatorIp).toHaveBeenCalled();
  });
});
