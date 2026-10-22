/**
 * The first save of an environment (saveSkeletonEnv, before any S3 or IaC
 * work) records the server sizes the deploy picked, so a deploy that fails
 * after it reruns on the same sizes. Without that record a rerun re-picked
 * from the live catalog, and a price move in between resized a half-built
 * environment.
 *
 * Drives executeDeployment up to a fake failure right after the skeleton
 * save, reads the env back through loadProjectConfig, then reruns the deploy
 * wizard against a catalog where the recorded type is no longer the cheapest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';
import { projectConfigStore } from '../helpers/project-config-store.js';

const clackMock = vi.hoisted(() => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(async () => true),
  password: vi.fn(),
  note: vi.fn(),
  intro: vi.fn(),
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

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof projectConfigStore> | null }));
vi.mock('../../../src/lib/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadProjectConfig: () => structuredClone(store.current?.state.disk ?? null),
  updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
    store.current?.updateProjectConfig(fn),
  registerProject: () => {},
}));
vi.mock('../../../src/lib/licensing/index.js', () => ({
  requireDeployEntitlement: vi.fn(async () => undefined),
}));
vi.mock('../../../src/lib/telemetry/update-check.js', () => ({ printUpdateNotice: vi.fn() }));
vi.mock('../../../src/lib/deploy/delta.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  collectDeployDelta: () => ({}),
  formatDeployDeltaLines: () => [],
}));
vi.mock('../../../src/lib/deploy/preflight.js', () => ({
  assertOperatorConfig: vi.fn(),
  checkDeployPrerequisites: vi.fn(),
  operatorCheckEnvs: () => [],
}));
vi.mock('../../../src/lib/ci-setup.js', () => ({ ciAvailable: () => false }));
vi.mock('../../../src/lib/cli/progress.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));
vi.mock('../../../src/lib/operator-ip.js', () => ({
  ensureOperatorIpAccess: vi.fn(async () => ({ added: false })),
}));
// The first remote step after the skeleton save fails, as an IaC failure would.
vi.mock('../../../src/lib/deploy/state.js', () => ({
  StateTracker: class {
    clear() {}
    async shouldSkipWithVerify() {
      throw new Error('FAKE_IAC_FAILURE');
    }
  },
}));

const { executeDeployment } = await import('../../../src/lib/deploy/orchestrator.js');
const { gatherDeploymentConfig } = await import('../../../src/lib/deploy/prompts.js');
const { loadProjectConfig } = await import('../../../src/lib/config.js');
const { HetznerProvider } = await import('../../../src/lib/providers/hetzner.js');
const { S3CompatibleProvider } = await import('../../../src/lib/providers/s3-base.js');

const S3 = {
  accessKey: 'ABCDEFGHIJ0123456789',
  secretKey: 'x'.repeat(40),
  bucket: 'sizeapp-abc123-prod-storage',
  region: 'hel1',
  endpoint: 'https://hel1.your-objectstorage.com',
  walgPrefix: 'backups/sizeapp/prod/walg',
};

/** A gathered config as gatherDeploymentConfig returns it, for env `prod`. */
function gathered(deployMode: string, ha: boolean, sizes: Record<string, string | undefined>) {
  return {
    projectConfig: loadProjectConfig(),
    envConfig: {},
    environment: 'prod',
    resuming: false,
    config: { environment: 'prod', provider: 'hetzner', ha, observability: false, deployMode },
    apiToken: 'a'.repeat(64),
    region: 'hel1',
    secondaryRegion: ha ? 'nbg1' : null,
    ...sizes,
    minWorkers: 1,
    maxWorkers: 3,
    domain: null,
    dnsProvider: 'manual',
    dnsZoneId: null,
    dnsToken: null,
    s3Config: S3,
    backupS3Config: {
      bucket: 'sizeapp-abc123-prod-backups',
      region: 'hel1',
      endpoint: S3.endpoint,
    },
    backupConfig: {},
    services: {},
    branchName: 'main',
  };
}

async function deployUntilFailure(g: ReturnType<typeof gathered>) {
  await expect(executeDeployment({ yes: true }, g as never)).rejects.toThrow('FAKE_IAC_FAILURE');
  return loadProjectConfig()?.environments?.prod;
}

describe('the skeleton save records the sizes the deploy picked', () => {
  let restore: (() => void) | undefined;
  beforeEach(() => {
    store.current = projectConfigStore({
      projectName: 'sizeapp',
      bucketSalt: 'abc123',
      environments: {},
    });
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.restoreAllMocks();
  });

  it('compose: serverType survives a failure after the skeleton save', async () => {
    const env = await deployUntilFailure(
      gathered('compose', false, {
        serverType: 'cpx22',
        masterServerType: 'cpx22',
        dbServerType: 'cpx22',
        workerServerType: 'cpx22',
      }),
    );
    expect(env).toMatchObject({ status: 'deploying', region: 'hel1', serverType: 'cpx22' });
    // One host: the per-role keys are a k8s record, as in the final save.
    expect(env).not.toHaveProperty('masterServerType');
  });

  it('k8s-ha: every role type and the standby region survive', async () => {
    const env = await deployUntilFailure(
      gathered('kubernetes', true, {
        serverType: 'cpx22',
        masterServerType: 'cpx22',
        dbServerType: 'cpx12',
        workerServerType: 'cpx22',
      }),
    );
    expect(env).toMatchObject({
      deployMode: 'kubernetes',
      masterServerType: 'cpx22',
      dbServerType: 'cpx12',
      workerServerType: 'cpx22',
      secondaryRegion: 'nbg1',
    });
  });

  it('k8s-ha: the resolved standby types are recorded under ha.standby, so a rerun reuses them', async () => {
    const env = await deployUntilFailure({
      ...gathered('kubernetes', true, {
        masterServerType: 'cpx22',
        dbServerType: 'cpx12',
        workerServerType: 'cpx22',
      }),
      standbyServerTypes: {
        masterServerType: 'cpx22',
        dbServerType: 'cpx12',
        workerServerType: 'cpx22',
      },
    });
    expect(env.ha.standby).toEqual({ masterServerType: 'cpx22', dbServerType: 'cpx12' });
    expect(env.ha.standbyWorkerSpec).toEqual({ serverType: 'cpx22' });
    expect(env.ha.primary).toBeUndefined();
  });

  it('k8s-ha: a standby worker with no stocked type is not recorded', async () => {
    const env = await deployUntilFailure({
      ...gathered('kubernetes', true, { masterServerType: 'cpx22', dbServerType: 'cpx12' }),
      standbyServerTypes: { masterServerType: 'cpx22', dbServerType: 'cpx12' },
    });
    expect(env.ha.standby).toEqual({ masterServerType: 'cpx22', dbServerType: 'cpx12' });
    expect(env.ha.standbyWorkerSpec).toBeUndefined();
  });

  it('writes no key for a size that is not defined', async () => {
    const env = await deployUntilFailure(
      gathered('kubernetes', false, { masterServerType: 'cpx22', dbServerType: 'cpx12' }),
    );
    expect(env).toMatchObject({ masterServerType: 'cpx22', dbServerType: 'cpx12' });
    expect(env).not.toHaveProperty('workerServerType');
    expect(env).not.toHaveProperty('serverType');
  });

  it('a rerun of the failed deploy keeps the recorded type, though another is now cheaper', async () => {
    await deployUntilFailure(gathered('compose', false, { serverType: 'cpx22' }));

    restore = seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
    expect(HetznerProvider.getRegionDefaults('hel1').composeType).toBe('cx23');
    vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.spyOn(HetznerProvider, 'promptApiToken').mockResolvedValue('a'.repeat(64));
    vi.spyOn(HetznerProvider, 'fetchServerTypes').mockResolvedValue(undefined as never);
    vi.spyOn(HetznerProvider, 'promptObjectStorageCredentials').mockResolvedValue({
      accessKey: S3.accessKey,
      secretKey: S3.secretKey,
      source: 'prompt',
    } as never);
    vi.spyOn(S3CompatibleProvider.prototype, 'validateCredentials').mockResolvedValue({
      valid: true,
    });
    const rerun = await gatherDeploymentConfig({ env: 'prod', yes: true });
    expect(rerun.resuming).toBe(true);
    expect(rerun.region).toBe('hel1');
    expect(rerun.serverType).toBe('cpx22');
  });
});
