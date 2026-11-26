/**
 * A k8s destroy deletes, detaches or releases no cluster volume before
 * `pulumi destroy` has deleted the cluster's servers. The volumes are deleted
 * afterwards, by the ids captured from the cluster's PersistentVolumes.
 *
 * Evidence (e2e run 44653733007, DigitalOcean k8s, 2026-11-19): destroy
 * released the CSI volume through the cluster (namespace delete, so the CSI
 * driver deleted the volume), read every droplet and saw it no longer
 * attached, and ~3 s later `pulumi destroy` failed on `Droplet db`:
 *
 *   Error detaching the volumes from the droplet (621457295): Error detaching
 *   volume "ee78e318-..." ... POST .../v2/volumes/ee78e318-.../actions: 404
 *
 * terraform-provider-digitalocean's Droplet delete re-reads `volume_ids` from
 * DigitalOcean, detaches every listed volume and fails the whole delete on
 * any error, a 404 for a volume that no longer exists included
 * (detachVolumesFromDroplet, digitalocean/droplet/resource_droplet.go). DO's
 * read is not consistent, so a volume deleted before the droplet can be
 * listed again. Deleting volumes only after the servers are gone removes the
 * race on every provider: the server delete detaches volumes that still
 * exist.
 *
 * Behavioral census: the real k8s teardown effect runs for each provider with
 * k8s modes and both k8s tiers. The cloud, kubectl and the Pulumi stack
 * destroy share one ordered event log, and the fake cloud keeps DO's stale
 * read: a db server lists its volume for as long as the server exists, and
 * its delete (the Pulumi fake) fails on a listed volume that is gone. Every
 * cloud and kubectl call awaits a tick, so an interleave would show.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teardownProvider } from '../../_shared/teardown-provider.js';
import { createTempDir } from '../../_shared/temp-dir.js';

vi.mock('@clack/prompts', async (orig) =>
  (await import('../../_shared/clack-fake.js')).quietClack(await orig(), {
    log: ['warn', 'error', 'info', 'success', 'message', 'step'],
  }),
);

const REGION = 'nyc3';
const tick = () => new Promise<void>((r) => setTimeout(r, 2));

type Server = { id: number; name: string; stackEnv: string; role: string; listed: string[] };
type Volume = { id: string; name: string; stackEnv: string; attachedTo: number[] };

/** The fake cloud, the ordered event log, and which kubeconfig is whose. */
const cloud = { servers: [] as Server[], volumes: [] as Volume[] };
const events: string[] = [];
const kubeconfigs = new Map<string, string>();

// A namespace or PVC delete reaches the cloud through the CSI driver, which
// deletes the cluster's volumes. Nothing else in the teardown runs kubectl
// against the fake kubeconfigs.
vi.mock('../../../src/lib/command.js', async (orig) => {
  const real = (await orig()) as Record<string, (...a: unknown[]) => unknown>;
  return {
    ...real,
    runCommand: (cmd: string[], opts?: unknown) => {
      if (cmd[0] !== 'kubectl') return real.runCommand(cmd, opts);
      const verb = cmd.indexOf('delete');
      if (verb !== -1) {
        events.push(`kubectl:${cmd.slice(verb).join(' ')}`);
        const stackEnv = kubeconfigs.get(cmd[cmd.indexOf('--kubeconfig') + 1]);
        cloud.volumes = cloud.volumes.filter((v) => v.stackEnv !== stackEnv);
      }
      return '';
    },
  };
});

vi.mock('../../../src/lib/csi-volumes.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    captureClusterCsiVolumes: (kubeconfigPath: string) => {
      const stackEnv = kubeconfigs.get(kubeconfigPath);
      return {
        ok: true,
        volumes: [],
        volumeIds: cloud.volumes.filter((v) => v.stackEnv === stackEnv).map((v) => v.id),
        regions: [REGION],
        skippedDrivers: [],
        reason: null,
      };
    },
  };
});

// `pulumi destroy` of one stack: each server's delete detaches every volume
// the server lists, failing on one that no longer exists, the way
// terraform-provider-digitalocean's Droplet delete does.
vi.mock('../../../src/lib/deploy/k8s/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyK8s: async ({ environment }: { environment: string }) => {
      events.push(`pulumi:start:${environment}`);
      await tick();
      for (const server of cloud.servers.filter((sv) => sv.stackEnv === environment)) {
        for (const id of server.listed) {
          const volume = cloud.volumes.find((v) => v.id === id);
          if (!volume) {
            throw new Error(
              `pulumi destroy for stack "${environment}" failed: Error detaching the volumes from the droplet (${server.id}): ` +
                `Error detaching volume "${id}": POST /v2/volumes/${id}/actions: 404`,
            );
          }
          volume.attachedTo = volume.attachedTo.filter((sid) => sid !== server.id);
        }
      }
      cloud.servers = cloud.servers.filter((sv) => sv.stackEnv !== environment);
      events.push(`pulumi:end:${environment}`);
      return { destroyed: true, resourceCount: 5 };
    },
  };
});

let current = { NAME: 'DigitalOcean', backstop: true };
function FakeProvider() {
  return teardownProvider({
    ctor: FakeProvider,
    methods: {
      listNetworks: async () =>
        [...new Set(cloud.servers.map((sv) => sv.stackEnv))].map((stackEnv) => ({
          id: `net-${stackEnv}`,
          name: `proj-${stackEnv}-network`,
        })),
      listServers: async () => [...cloud.servers],
      listServersDetailed: async () => ({ items: [...cloud.servers], complete: true }),
      serverNetworkIds: (sv: Server) => [`net-${sv.stackEnv}`],
      serverVolumeIds: (sv: Server) => [...sv.listed],
      // A Pulumi role and no managed-by label: neither the autoscaler sweep
      // nor the orphaned-server sweep claims these servers.
      serverLabels: (sv: Server) => ({ role: sv.role }),
      serverRegion: () => REGION,
      labelValue: (_key: string, value: string) => value,
      listVolumesDetailed: async () => ({ items: [...cloud.volumes], complete: true }),
      volumeName: (v: Volume) => v.name,
      volumeRegion: () => REGION,
      volumeCreatedAt: () => null,
      volumeLabels: () => ({}),
      volumeAttachedServerIds: (v: Volume) => [...v.attachedTo],
      deleteVolume: async (id: string) => {
        await tick();
        events.push(`volume:delete:${id}`);
        const volume = cloud.volumes.find((v) => v.id === id);
        if (volume && volume.attachedTo.length > 0) return false;
        cloud.volumes = cloud.volumes.filter((v) => v.id !== id);
        return true;
      },
      deleteFirewallByName: async () => ({ deleted: false, apiError: null }),
      deleteSSHKeyByName: async () => false,
      deleteNetworkByName: async () => ({ deleted: false, apiError: null }),
      deleteReservedIpsByLabels: async () => ({ deleted: [], failed: [] }),
      reservedIpLabelMatch: undefined,
    },
    // Any other delete, detach, release or remove is logged, so one that
    // touches a volume before the servers are gone shows up in the order.
    deleted: async (method: string, ...args: unknown[]) => {
      await tick();
      events.push(`cloud:${method}:${String(args[0])}`);
      return { deleted: false, apiError: null };
    },
  });
}
Object.assign(FakeProvider, { getPublicIP: () => null });
Object.defineProperty(FakeProvider, 'NAME', { get: () => current.NAME });
Object.defineProperty(FakeProvider, 'K8S_DESTROY_BACKSTOP', { get: () => current.backstop });

vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, providerFor: () => FakeProvider };
});

const { createLeakLedger } = await import('../../../src/lib/destroy/leak-ledger.js');
const { DESTROY_EFFECTS } = await import('../../../src/destroy.js');
const { localKubeconfigPath } = await import('../../../src/lib/kubeconfig.js');

const spinner = { start: () => {}, stop: () => {}, message: () => {}, error: () => {} };

/** A live cluster per stack: master, db, and the db's CSI volume. */
function seedClusters(stackEnvs: string[], cwd: string) {
  stackEnvs.forEach((stackEnv, i) => {
    const volumeId = `${i}e78e318-d60c-11f1-bea2-2258243ee23f`;
    const db = 621457295 + i * 10;
    cloud.servers.push(
      { id: db - 1, name: `proj-${stackEnv}-master`, stackEnv, role: 'master', listed: [] },
      { id: db, name: `proj-${stackEnv}-db`, stackEnv, role: 'db', listed: [volumeId] },
    );
    cloud.volumes.push({
      id: volumeId,
      name: `pvc-${i}c3f8b2a-4d5e-4f60-9a1b-2c3d4e5f6071`,
      stackEnv,
      attachedTo: [db],
    });
    const path = localKubeconfigPath(cwd, stackEnv);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'apiVersion: v1\n');
    kubeconfigs.set(path, stackEnv);
  });
}

function makeCtx(provider: string, tier: 'k8s' | 'k8s-ha', cwd: string) {
  const stackEnvs = tier === 'k8s-ha' ? ['cid3-primary', 'cid3-standby'] : ['cid3'];
  return {
    plan: {
      tier,
      stackEnvs,
      hasPulumiStack: true,
      clusterNames: stackEnvs.map((e) => `proj-${e}`),
      ownedIps: [],
    },
    envConfig: {
      provider,
      tier,
      region: REGION,
      servers: [{ role: 'master', name: 'master', ip: '203.0.113.7', id: 1 }],
    },
    projectConfig: { projectName: 'proj' },
    environment: 'cid3',
    args: {},
    providerToken: 'tok',
    results: {
      leaks: createLeakLedger(),
      servers: [] as string[],
      firewalls: [] as string[],
      sshKeys: [] as string[],
      dns: [] as string[],
      healthChecks: [] as string[],
      volumes: [] as string[],
      loadBalancers: [] as string[],
      pulumiDestroyFailed: false,
    },
    spinner,
    tracker: { spinner: () => spinner },
    cwd,
  };
}

/** An event that deletes, detaches or releases a volume, directly or through the cluster. */
const touchesVolume = (e: string) =>
  e.startsWith('volume:') || e.startsWith('kubectl:') || /^cloud:[a-z]*(detach|volume)/i.test(e);

let dir: string;
beforeEach(() => {
  dir = createTempDir('csi-volumes-after-servers-');
  cloud.servers = [];
  cloud.volumes = [];
  events.length = 0;
  kubeconfigs.clear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const PROVIDERS: Array<[string, string, boolean]> = [
  ['digitalocean', 'DigitalOcean', true],
  ['hetzner', 'Hetzner', false],
  ['linode', 'Linode', true],
  ['vultr', 'Vultr', true],
];

// The rows stand for the real classes: every provider with k8s code, with its
// K8S_DESTROY_BACKSTOP, so a new one cannot skip this census. (The NAME is
// only what the fake reports in its lines.)
it('the table is every k8s provider, with its backstop flag', async () => {
  const { k8sCensusProviders } = await import('../../_shared/k8s-built-ahead.js');
  const real = (
    k8sCensusProviders() as unknown as Array<[string, { K8S_DESTROY_BACKSTOP?: boolean }]>
  ).map(([id, P]) => `${id} ${P.K8S_DESTROY_BACKSTOP === true}`);
  expect(PROVIDERS.map(([id, , backstop]) => `${id} ${backstop}`).sort()).toEqual(real.sort());
});

describe.each(PROVIDERS)('%s', (providerId, NAME, backstop) => {
  it.each(['k8s', 'k8s-ha'] as const)(
    '%s: no volume is touched before pulumi destroy ends, and every captured volume is deleted after it',
    async (tier) => {
      current = { NAME, backstop };
      const ctx = makeCtx(providerId, tier, dir);
      seedClusters(ctx.plan.stackEnvs, dir);
      const captured = cloud.volumes.map((v) => v.id);

      await (
        DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>
      ).destroyK8sInfra(ctx, {});

      const log = events.join(', ');
      const pulumiEnds = ctx.plan.stackEnvs.map((e) => events.indexOf(`pulumi:end:${e}`));
      expect(Math.min(...pulumiEnds), `a pulumi destroy did not finish: ${log}`).toBeGreaterThan(
        -1,
      );
      const firstVolumeEvent = events.findIndex(touchesVolume);
      expect(firstVolumeEvent, log).toBeGreaterThan(Math.max(...pulumiEnds));

      for (const id of captured) expect(events, log).toContain(`volume:delete:${id}`);
      expect(cloud.volumes).toEqual([]);
      expect(ctx.results.volumes).toHaveLength(captured.length);
      expect(ctx.results.pulumiDestroyFailed).toBe(false);
      expect(ctx.results.leaks.entries).toEqual([]);
    },
  );
});
