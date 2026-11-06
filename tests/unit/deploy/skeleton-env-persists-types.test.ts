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
  // The scaffold is current (preflight-role-file owns the stale-scaffold refusal).
  assertScaffoldSupportsRoleFile: vi.fn(),
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
const { buildReplicationOverlay } = await import('../../../src/lib/deploy/compose/ha.js');
const { bootPullImages } = await import('../../../src/lib/iac/compose-cloud-init.js');
const { activateImageSet, bundledImageSet, k3sVersion, traefikImageRef } = await import(
  '../../../src/lib/images.js'
);
const { CHANNEL_SCHEMA } = await import('../../../src/lib/version-channel.js');
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

  it('k8s-ha: re-resolved standby types replace the ones on record', async () => {
    store.current?.updateProjectConfig((config) => {
      (config.environments as Record<string, unknown>).prod = {
        ha: {
          standby: { masterServerType: 'cpx32', dbServerType: 'cpx22' },
          standbyWorkerSpec: { serverType: 'cpx32' },
        },
      };
    });
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
  });

  it('compose-ha: the resolved standby type is recorded with its location, so a rerun reuses it', async () => {
    const env = await deployUntilFailure({
      ...gathered('compose-ha', true, { serverType: 'cpx22' }),
      standbyServerTypes: { serverType: 'cpx32' },
    });
    expect(env.ha.pendingStandby).toEqual({ region: 'nbg1', serverType: 'cpx32' });
    expect(env.servers).toBeUndefined();
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

  it('a rerun under -y keeps the recorded region, though another is now preselected', async () => {
    // The first deploy chose nbg1; the skeleton save records it before any
    // remote work. A rerun under -y must not take the new preselection (hel1,
    // where cx23 is now in stock) and move a half-built environment.
    const env = await deployUntilFailure({
      ...gathered('compose', false, { serverType: 'cpx22' }),
      region: 'nbg1',
    });
    expect(env.region).toBe('nbg1');

    restore = seedCatalog(HetznerProvider, 'flux-hetzner-cx23-hel1');
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
    // Positive control: a new project would preselect hel1 here.
    const fresh = await gatherDeploymentConfig({
      env: 'staging',
      provider: 'hetzner',
      yes: true,
    });
    expect(fresh.region).toBe('hel1');
    const rerun = await gatherDeploymentConfig({ env: 'prod', yes: true });
    expect(rerun.resuming).toBe(true);
    expect(rerun.region).toBe('nbg1');
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

  it('an env deployed before the top-level serverType keeps its server record type on a redeploy', async () => {
    // Before this record existed a compose env saved its size only on the
    // server entry. A redeploy reads it from there, not the new default
    // (cx23 in hel1 here), and the skeleton save records it.
    await deployUntilFailure(gathered('compose', false, { serverType: 'cpx22' }));
    store.current?.updateProjectConfig((config) => {
      const prod = (config.environments as Record<string, Record<string, unknown>>).prod;
      delete prod.serverType;
      prod.servers = [{ id: 7, ip: '203.0.113.10', serverType: 'cpx32' }];
    });

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
    expect(rerun.serverType).toBe('cpx32');
    const env = await deployUntilFailure(rerun as never);
    expect(env.serverType).toBe('cpx32');
  });
});

describe('a deploy resolves one version set at its start and records it', () => {
  const sizes = { serverType: 'cpx22', masterServerType: 'cpx22', dbServerType: 'cpx22' };
  const ref = (name: string, version: string) =>
    `ghcr.io/hyperformant/${name}:${version}@sha256:${'b'.repeat(64)}`;
  /** A channel list one patch ahead of the bundled copy on Traefik and k3s. */
  function channelFile() {
    const set = bundledImageSet();
    return {
      schema: CHANNEL_SCHEMA,
      images: { ...set.images, traefik: ref('traefik', 'v3.99.0') },
      kubernetes: { ...set.kubernetes, k3s: 'v1.37.99+k3s1' },
    };
  }
  const stubChannel = (body: unknown) => {
    const read = vi.fn(async () => new Response(JSON.stringify(body)));
    vi.stubGlobal('fetch', read);
    return read;
  };

  beforeEach(() => {
    store.current = projectConfigStore({
      projectName: 'sizeapp',
      bucketSalt: 'abc123',
      environments: {},
    });
  });
  afterEach(() => {
    activateImageSet(null);
    vi.unstubAllGlobals();
  });

  it('records the channel list and runs it', async () => {
    const read = stubChannel(channelFile());
    const env = await deployUntilFailure(gathered('compose', false, sizes));
    expect(read).toHaveBeenCalledTimes(1);
    expect(env.imageSet.images.traefik).toBe(ref('traefik', 'v3.99.0'));
    expect(traefikImageRef()).toBe(ref('traefik', 'v3.99.0'));
  });

  it('a bad channel falls back to the bundled copy with one quiet note, and the deploy goes on', async () => {
    const file = channelFile();
    file.images.traefik = `ghcr.io/evil/traefik:v3.99.0@sha256:${'b'.repeat(64)}`;
    stubChannel(file);
    clackMock.log.info.mockClear();
    const env = await deployUntilFailure(gathered('compose', false, sizes));
    expect(env.imageSet).toEqual(bundledImageSet());
    const notes = clackMock.log.info.mock.calls.map(([line]) => String(line));
    expect(notes.filter((line) => line.includes('version channel not used'))).toHaveLength(1);
    expect(notes.join('\n')).not.toContain('evil');
  });

  it.each([
    ['compose-ha', 'compose'],
    ['k8s-ha', 'kubernetes'],
  ])('%s: both sides of the pair run the one set, read once', async (_name, deployMode) => {
    const read = stubChannel(channelFile());
    const env = await deployUntilFailure(gathered(deployMode, true, sizes));
    // The list moves while the pair is being built. Neither side looks again.
    stubChannel({ ...channelFile(), images: { ...channelFile().images, traefik: 'moved' } });
    const primary = { socat: buildReplicationOverlay('10.10.0.1'), pull: bootPullImages() };
    const standby = { socat: buildReplicationOverlay('10.10.0.2'), pull: bootPullImages() };
    expect(read).toHaveBeenCalledTimes(1);
    expect(primary.pull).toEqual(standby.pull);
    expect(primary.pull).toContain(env.imageSet.images.traefik);
    const socatLine = (yaml: string) => yaml.match(/image: (.+)/)?.[1];
    expect(socatLine(standby.socat)).toBe(socatLine(primary.socat));
    expect(socatLine(primary.socat)).toBe(env.imageSet.images.socat);
    expect(k3sVersion()).toBe(env.imageSet.kubernetes.k3s);
  });

  it('an existing cluster keeps its Kubernetes set while its images move', async () => {
    stubChannel(channelFile());
    const old = bundledImageSet();
    const g = gathered('kubernetes', false, sizes);
    const env = await deployUntilFailure({
      ...g,
      envConfig: { deployMode: 'kubernetes', deployedAt: '2026-11-01', imageSet: old },
    });
    expect(env.imageSet.kubernetes).toEqual(old.kubernetes);
    expect(env.imageSet.images.traefik).toBe(ref('traefik', 'v3.99.0'));
    expect(k3sVersion()).toBe(old.kubernetes.k3s);
  });

  it('a new cluster takes the channel Kubernetes set', async () => {
    stubChannel(channelFile());
    const env = await deployUntilFailure(gathered('kubernetes', false, sizes));
    expect(env.imageSet.kubernetes.k3s).toBe('v1.37.99+k3s1');
  });
});
