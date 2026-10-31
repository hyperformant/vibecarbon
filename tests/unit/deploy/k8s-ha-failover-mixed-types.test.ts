/**
 * k8s-ha across a failover when the two sides run different types.
 *
 * On the DigitalOcean 2026-10-22 catalog, sfo3 sells only the -amd Basic
 * droplets and tor1 only the plain ones. A primary in sfo3 on
 * s-2vcpu-4gb-amd / s-1vcpu-2gb-amd therefore gets a tor1 standby on
 * s-2vcpu-4gb / s-1vcpu-2gb. After a failover the roles swap, and the
 * reconverge deploy must build each side on the types it already runs:
 * the new primary (tor1) never on the top-level -amd types, and the new
 * standby (sfo3) never on the old standby's plain worker.
 *
 * Drives the real chain: the fan-out (haK8sProvisionClusters, with deployK3s
 * stubbed), the success save's per-side record (haSidesRecord), the failover
 * role swap (swapHaRoles) and the redeploy's read-back (haStacksFrom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalog } from '../helpers/catalog-fixtures.js';
import { type Config, projectConfigStore } from '../helpers/project-config-store.js';

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof projectConfigStore> | null }));
vi.mock('../../../src/lib/config.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  loadProjectConfig: () => structuredClone(store.current?.state.disk ?? null),
  updateProjectConfig: (fn: (c: Record<string, unknown>) => unknown) =>
    store.current?.updateProjectConfig(fn),
}));

const deployK3s = vi.fn(async (opts: Record<string, unknown>) => {
  const cluster = {
    masterIp: opts.role === 'primary' ? '1.1.1.1' : '2.2.2.1',
    dbIp: opts.role === 'primary' ? '1.1.1.2' : '2.2.2.2',
    dbPrivateIp: '10.0.1.2',
    masterPrivateIp: '10.0.1.11',
    floatingIp: opts.role === 'primary' ? '9.9.9.1' : '9.9.9.2',
  };
  (opts.onInfraReady as (i: unknown) => void)(cluster);
  (opts.onNamespaceReady as () => void)();
  if (opts.role === 'primary') (opts.onImageBuilt as (t: string) => void)('ref');
  return { ...cluster, kubeconfig: `/tmp/kc-${opts.role}` };
});
vi.mock('../../../src/lib/deploy/k8s/k3s.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/k8s/k3s.js')>()),
  deployK3s,
}));
vi.mock('../../../src/lib/deploy/k8s/ha/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/deploy/k8s/ha/index.js')>()),
  prepareReplicationTransport: vi.fn(async () => {}),
  configurePrimaryForReplication: vi.fn(async () => {}),
}));
vi.mock('../../../src/lib/deploy/k8s/ha/image-copy.js', () => ({
  copyAppImageToStandby: vi.fn(async () => ({ digest: 'sha256:aa', skipped: false })),
}));
vi.mock('@clack/prompts', async (orig) => ({
  ...(await orig<typeof import('@clack/prompts')>()),
  log: { info: vi.fn(), warn: vi.fn(), step: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const { DigitalOceanProvider } = await import('../../../src/lib/providers/digitalocean.js');
const { K8S_HA_EFFECTS } = await import('../../../src/lib/deploy/effects/k8s-ha.js');
const { haSidesRecord } = await import('../../../src/lib/deploy/orchestrator.js');
const { haStacksFrom } = await import('../../../src/lib/deploy/standby-types.js');
const { swapHaRoles } = await import('../../../src/failover.js');
const { SCALE_EFFECTS } = await import('../../../src/scale.js');
const { envIdentityOf } = await import('../../../src/lib/env-identity.js');

const AMD = { master: 's-2vcpu-4gb-amd', db: 's-1vcpu-2gb-amd', worker: 's-2vcpu-4gb-amd' };
const PLAIN = { master: 's-2vcpu-4gb', db: 's-1vcpu-2gb', worker: 's-2vcpu-4gb' };

type Side = { masterServerType: string; dbServerType: string; workerServerType: string };

/** One fan-out with this env on disk, as the deploy wizard hands it over. */
async function fanOut(env: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  deployK3s.mockClear();
  const ctx: Record<string, unknown> = {
    s: { start: vi.fn(), stop: vi.fn(), message: vi.fn() },
    sharedSshKeyPath: '/k/deploy_key_prod',
    options: {
      provider: 'digitalocean',
      environment: 'prod',
      region: env.region,
      secondaryRegion: env.secondaryRegion,
      // The wizard's types: the env's top-level record, which a failover
      // leaves describing the side that was primary at the first deploy.
      masterServerType: env.masterServerType,
      dbServerType: env.dbServerType,
      workerServerType: env.workerServerType,
      serverType: env.workerServerType,
      minWorkers: 1,
      maxWorkers: 3,
      haStacks: haStacksFrom(env),
      ...extra,
    },
  };
  await K8S_HA_EFFECTS.haK8sProvisionClusters(ctx);
  const built = (role: string) => {
    const opts = deployK3s.mock.calls.find(([o]) => o.role === role)?.[0] as Record<string, string>;
    return {
      region: opts.region,
      masterServerType: opts.masterServerType,
      dbServerType: opts.dbServerType,
      workerServerType: opts.workerServerType,
    };
  };
  return {
    ctx,
    primary: built('primary'),
    standby: built('standby'),
  };
}

/** Persist the fan-out the way the success save does. */
function saveSuccess(ctx: Record<string, unknown>) {
  store.current?.updateProjectConfig((config: Config) => {
    const env = config.environments.prod;
    const result = { primary: ctx.primaryResult, standby: ctx.standbyResult };
    env.ha = {
      ...(env.ha ?? {}),
      enabled: true,
      ...haSidesRecord(result as never, {
        region: env.region,
        secondaryRegion: env.secondaryRegion,
        minWorkers: 1,
      }),
    };
  });
}

const sold = (region: string, type: string) =>
  Boolean(DigitalOceanProvider._locationTypes?.[region]?.has(type));

function expectSoldWhereBuilt(side: Side & { region: string }) {
  for (const type of [side.masterServerType, side.dbServerType, side.workerServerType]) {
    expect(sold(side.region, type), `${type} sold in ${side.region}`).toBe(true);
  }
}

describe('k8s-ha failover with mixed standby types (DigitalOcean sfo3 + tor1)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    // The fan-out's dispatch diagnostics.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.current = projectConfigStore({
      projectName: 'myapp',
      environments: {
        prod: {
          provider: 'digitalocean',
          deployMode: 'kubernetes',
          region: 'sfo3',
          secondaryRegion: 'tor1',
          masterServerType: AMD.master,
          dbServerType: AMD.db,
          workerServerType: AMD.worker,
        },
      },
    });
  });
  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it('first deploy: each side on types its own location sells', async () => {
    const first = await fanOut(store.current?.state.disk.environments.prod);
    expect(first.primary).toEqual({ region: 'sfo3', ...typesOf(AMD) });
    expect(first.standby).toEqual({ region: 'tor1', ...typesOf(PLAIN) });
  });

  it('after swapHaRoles the reconverge deploy changes no type on either side', async () => {
    const first = await fanOut(store.current?.state.disk.environments.prod);
    saveSuccess(first.ctx);
    swapHaRoles('prod');

    const env = store.current?.state.disk.environments.prod;
    // The worker records moved with the roles.
    expect(env.ha.primary.workerServerType).toBe(PLAIN.worker);
    expect(env.ha.standbyWorkerSpec.serverType).toBe(AMD.worker);

    const second = await fanOut(env);
    // The old standby (tor1) now serves; the old primary (sfo3) is the standby.
    expect(second.primary).toEqual({ ...first.standby });
    expect(second.standby).toEqual({ ...first.primary });
    expectSoldWhereBuilt(second.primary);
    expectSoldWhereBuilt(second.standby);

    // The record the next save writes keeps every type sold where it runs.
    saveSuccess(second.ctx);
    const after = store.current?.state.disk.environments.prod.ha;
    expectSoldWhereBuilt({
      region: after.primary.region,
      masterServerType: after.primary.masterServerType,
      dbServerType: after.primary.dbServerType,
      workerServerType: after.primary.workerServerType,
    });
    expectSoldWhereBuilt({
      region: after.standby.region,
      masterServerType: after.standby.masterServerType,
      dbServerType: after.standby.dbServerType,
      workerServerType: after.standbyWorkerSpec.serverType,
    });
  });

  it('destroy after a failover, then a redeploy: each side on its own types again', async () => {
    const first = await fanOut(store.current?.state.disk.environments.prod);
    saveSuccess(first.ctx);
    swapHaRoles('prod');
    // The top level now describes the serving primary.
    const env = store.current?.state.disk.environments.prod;
    expect(env).toMatchObject({
      region: 'tor1',
      masterServerType: PLAIN.master,
      dbServerType: PLAIN.db,
      workerServerType: PLAIN.worker,
    });
    // destroy keeps the identity only (no ha record); the redeploy starts from it.
    const identity = envIdentityOf(env);
    expect(identity).not.toHaveProperty('ha');
    const rebuilt = await fanOut(identity);
    expect(rebuilt.primary).toEqual({ ...first.standby });
    expect(rebuilt.standby).toEqual({ ...first.primary });
    expectSoldWhereBuilt(rebuilt.primary);
    expectSoldWhereBuilt(rebuilt.standby);
  });

  it('a type scale sticks: no redeploy, before or after a failover, resizes either side back', async () => {
    const first = await fanOut(store.current?.state.disk.environments.prod);
    saveSuccess(first.ctx);
    // `scale -type`: every role on both clusters, to a type both locations sell.
    const X = 's-2vcpu-4gb-intel';
    const scaled = { region: '', masterServerType: X, dbServerType: X, workerServerType: X };
    await SCALE_EFFECTS.scaleUpdateK8sConfig({
      environment: 'prod',
      envConfig: store.current?.state.disk.environments.prod,
      newValues: { masterType: X, dbType: X, workerType: X },
      isHA: true,
    });

    const redeploy = await fanOut(store.current?.state.disk.environments.prod);
    expect(redeploy.primary).toEqual({ ...scaled, region: 'sfo3' });
    expect(redeploy.standby).toEqual({ ...scaled, region: 'tor1' });
    saveSuccess(redeploy.ctx);

    swapHaRoles('prod');
    const after = await fanOut(store.current?.state.disk.environments.prod);
    expect(after.primary).toEqual({ ...scaled, region: 'tor1' });
    expect(after.standby).toEqual({ ...scaled, region: 'sfo3' });
  });

  it('failover -server-type: the new primary records the worker type it was provisioned with', () => {
    store.current?.updateProjectConfig((config: Config) => {
      config.environments.prod.ha = {
        primary: { stack: 'prod-primary', region: 'sfo3', workerServerType: AMD.worker },
        standby: { stack: 'prod-standby', region: 'tor1' },
        standbyWorkerSpec: { count: 1, serverType: PLAIN.worker },
      };
    });
    swapHaRoles('prod', { workerServerType: 's-4vcpu-8gb-intel' });
    const ha = store.current?.state.disk.environments.prod.ha;
    expect(ha.primary.workerServerType).toBe('s-4vcpu-8gb-intel');
    expect(ha.standbyWorkerSpec).toEqual({ count: 1, serverType: AMD.worker });
  });

  it('a record without ha.primary.workerServerType swaps the top-level worker into the standby spec', () => {
    store.current?.updateProjectConfig((config: Config) => {
      config.environments.prod.ha = {
        primary: { stack: 'prod-primary', region: 'sfo3', masterServerType: AMD.master },
        standby: { stack: 'prod-standby', region: 'tor1', masterServerType: PLAIN.master },
        standbyWorkerSpec: { count: 1, serverType: PLAIN.worker },
      };
    });
    swapHaRoles('prod');
    const ha = store.current?.state.disk.environments.prod.ha;
    expect(ha.primary.workerServerType).toBe(PLAIN.worker);
    expect(ha.standby).not.toHaveProperty('workerServerType');
    expect(ha.standbyWorkerSpec).toEqual({ count: 1, serverType: AMD.worker });
  });
});

describe('k8s-ha first-deploy rerun with a different -standby-region', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = seedCatalog(DigitalOceanProvider, '2026-10-22/digitalocean');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it('the fan-out re-resolves the standby for the new location, as the wizard did', async () => {
    // The skeleton save recorded the sfo3 standby types; no stack exists yet.
    const env = {
      region: 'nyc3',
      secondaryRegion: 'tor1',
      masterServerType: 's-2vcpu-4gb',
      dbServerType: 's-1vcpu-2gb',
      workerServerType: 's-2vcpu-4gb',
      ha: {
        standby: { masterServerType: AMD.master, dbServerType: AMD.db },
        standbyWorkerSpec: { serverType: AMD.worker },
      },
    };
    const run = await fanOut(env, { standbyRetargeted: true });
    expect(run.standby).toEqual({ region: 'tor1', ...typesOf(PLAIN) });
  });
});

function typesOf(t: { master: string; db: string; worker: string }) {
  return { masterServerType: t.master, dbServerType: t.db, workerServerType: t.worker };
}
