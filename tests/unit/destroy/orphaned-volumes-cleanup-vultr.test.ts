import { describe, expect, it, vi } from 'vitest';
import { cleanupOrphanedVolumes, DESTROY_EFFECTS } from '../../../src/destroy.js';
import { parseCsiPersistentVolumes } from '../../../src/lib/csi-volumes.js';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { VultrProvider } from '../../../src/lib/providers/vultr.js';
import { teardownProvider } from '../../_shared/teardown-provider.js';
import { vultrPv } from '../../_shared/vultr-csi-pv.js';

// The teardown effect below reaches the provider through providerFor (the
// real one until a test sets the fake: destroy.js asks it at load), and its
// stack destroy is out of scope here.
const holder = vi.hoisted(() => ({ Provider: null as unknown }));
vi.mock('../../../src/lib/providers/index.js', async (orig) => {
  const real = (await orig()) as { providerFor: (...a: unknown[]) => unknown };
  return { ...real, providerFor: (...a: unknown[]) => holder.Provider ?? real.providerFor(...a) };
});
vi.mock('../../../src/lib/deploy/k8s/index.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    destroyK8s: async () => ({ destroyed: true, resourcesDeleted: 1, summary: { delete: 1 } }),
  };
});

/**
 * A Vultr CSI volume is labelled `pvc-<16 hex>` and carries no tags: Vultr
 * block storage takes none. So the only proof that a volume is this
 * environment's is its id in the capture of the cluster's PersistentVolumes.
 * The `pvc-*` in-cluster-region heuristic, which deletes a detached CSI
 * volume in one of the cluster's regions when the capture failed, would on
 * Vultr delete any cluster's in that region (ORPHAN_VOLUME_REGION_GUESS is
 * false): such a volume is reported and fails the destroy instead.
 */
const VOLUME_ID = '6d3a8f2e-1b4c-4e5f-9a7b-0c1d2e3f4a5b';
const volume = (label: string, over: Record<string, unknown> = {}) => ({
  id: VOLUME_ID,
  label,
  region: 'ewr',
  attached_to_instance: '',
  date_created: '2026-11-26T10:00:00+00:00',
  ...over,
});

function setup(volumes: Array<ReturnType<typeof volume>>) {
  const provider = new VultrProvider('token');
  vi.spyOn(provider, 'listVolumesDetailed').mockResolvedValue({ items: volumes, complete: true });
  const deleteVolume = vi.spyOn(provider, 'deleteVolume').mockResolvedValue(true);
  return { provider, deleteVolume };
}
// A real destroy passes the cluster's regions, which arms the region heuristic.
const run = (provider: VultrProvider, knownIds: string[], identityComplete: boolean) =>
  cleanupOrphanedVolumes(provider, 'proj', 'prod', knownIds, ['ewr'], {
    identityComplete,
    report: () => {},
  });

describe('cleanupOrphanedVolumes on Vultr', () => {
  it('deletes a detached pvc volume whose id the capture listed', async () => {
    const { volumes: pvs } = parseCsiPersistentVolumes({
      items: [vultrPv('pvc-01234567-89ab-cdef-0123-456789abcdef', VOLUME_ID)],
    });
    const { provider, deleteVolume } = setup([volume('pvc-0123456789abcdef')]);
    const { deleted, deferred } = await run(
      provider,
      pvs.map((v) => v.volumeId),
      true,
    );
    expect(deferred).toEqual([]);
    expect(deleteVolume).toHaveBeenCalledExactlyOnceWith(VOLUME_ID);
    expect(deleted).toEqual(['pvc-0123456789abcdef']);
  });

  it('with no capture and an incomplete identity, defers it as no-owner-signal and never deletes it', async () => {
    const { provider, deleteVolume } = setup([volume('pvc-0123456789abcdef')]);
    const { deleted, deferred } = await run(provider, [], false);
    expect(deleteVolume).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
    expect(deferred).toEqual([
      {
        id: VOLUME_ID,
        name: 'pvc-0123456789abcdef',
        region: 'ewr',
        createdAt: '2026-11-26T10:00:00+00:00',
        match: 'pvc-in-cluster-region',
        blockedBy: 'no-owner-signal',
        blocked:
          "Vultr CSI volumes carry no tags, so only a captured id proves one is this environment's",
      },
    ]);
  });

  it('with a complete identity, defers it as identity-complete (proven not ours)', async () => {
    const { provider, deleteVolume } = setup([volume('pvc-0123456789abcdef')]);
    const { deferred } = await run(provider, [], true);
    expect(deleteVolume).not.toHaveBeenCalled();
    expect(deferred.map((d) => d.blockedBy)).toEqual(['identity-complete']);
  });

  it('never matches a hand-named pvc-backups volume', async () => {
    for (const identityComplete of [false, true]) {
      const { provider, deleteVolume } = setup([volume('pvc-backups')]);
      const { deleted, deferred } = await run(provider, [], identityComplete);
      expect(deleteVolume).not.toHaveBeenCalled();
      expect(deleted).toEqual([]);
      expect(deferred).toEqual([]);
    }
  });
});

// The caller's verdict: a no-owner-signal deferral is unverified, so it is
// reported and fails the destroy's exit code, as a foreign-region one does.
describe('a Vultr k8s destroy whose PersistentVolume capture failed', () => {
  const spinner = { start: () => {}, stop: () => {}, message: () => {} };

  /** The k8s teardown effect over one detached pvc volume in the cluster's region. */
  async function destroyWith(regionGuess: boolean) {
    const deleted: string[] = [];
    const accessors = new VultrProvider('token');
    const read = (name: keyof VultrProvider) =>
      (accessors[name] as (...a: unknown[]) => unknown).bind(accessors);
    function FakeVultr() {
      return teardownProvider({
        ctor: FakeVultr,
        methods: {
          listServersDetailed: async () => ({ items: [], complete: true }),
          listVolumesDetailed: async () => ({
            items: [volume('pvc-0123456789abcdef')],
            complete: true,
          }),
          deleteVolume: async (id: string) => {
            deleted.push(id);
            return true;
          },
          deleteReservedIpsByLabels: async () => ({ deleted: [], failed: [] }),
          volumeName: read('volumeName'),
          volumeRegion: read('volumeRegion'),
          volumeLabels: read('volumeLabels'),
          volumeCreatedAt: read('volumeCreatedAt'),
          volumeAttachedServerIds: read('volumeAttachedServerIds'),
          labelValue: read('labelValue'),
        },
        serverIdsEmpty: true,
        deleted: () => ({ deleted: false, everExisted: false, apiError: null, removed: true }),
      });
    }
    Object.assign(FakeVultr, {
      NAME: VultrProvider.NAME,
      K8S_DESTROY_BACKSTOP: true,
      ORPHAN_VOLUME_REGION_GUESS: regionGuess,
      getPublicIP: () => null,
    });
    holder.Provider = FakeVultr;
    const leaks = createLeakLedger();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await (
        DESTROY_EFFECTS as Record<string, (c: unknown, a: unknown) => Promise<void>>
      ).destroyK8sInfra(
        {
          plan: {
            tier: 'k8s',
            stackEnvs: ['prod'],
            hasPulumiStack: true,
            clusterNames: ['proj-prod'],
            ownedIps: [],
          },
          // The master is on record but no kubeconfig was fetched: the deploy
          // died before the cluster was ready, so the capture fails.
          envConfig: {
            provider: 'vultr',
            tier: 'k8s',
            region: 'ewr',
            servers: [{ role: 'master', name: 'master', ip: '203.0.113.7', id: 'inst-1' }],
          },
          projectConfig: { projectName: 'proj' },
          environment: 'prod',
          providerToken: 'tok',
          results: {
            leaks,
            servers: [],
            firewalls: [],
            sshKeys: [],
            dns: [],
            healthChecks: [],
            volumes: [],
            loadBalancers: [],
            unreleasedReservedIps: [],
          },
          spinner,
          tracker: { spinner: () => spinner },
          cwd: '/tmp/vibecarbon-vultr-orphan-volume-nowhere',
        },
        {},
      );
    } finally {
      vi.mocked(console.log).mockRestore();
    }
    return { deleted, leaks };
  }

  it('reports the volume as unverified, failing the exit code, and never deletes it', async () => {
    expect(VultrProvider.ORPHAN_VOLUME_REGION_GUESS).toBe(false);
    const { deleted, leaks } = await destroyWith(VultrProvider.ORPHAN_VOLUME_REGION_GUESS);
    expect(deleted).toEqual([]);
    const entry = leaks.entries.find(
      (e: { resourceClass: string }) => e.resourceClass === 'volume-deferred',
    );
    expect(entry).toMatchObject({ severity: 'unverified' });
    expect(entry?.resource).toContain('pvc-0123456789abcdef');
    expect(entry?.reason).toContain(
      "Vultr CSI volumes carry no tags, so only a captured id proves one is this environment's",
    );
    expect(leaks.exitCode()).not.toBe(0);
  });

  it('control: with the region guess on, the same teardown deletes it', async () => {
    const { deleted, leaks } = await destroyWith(true);
    expect(deleted).toEqual([VOLUME_ID]);
    expect(
      leaks.entries.filter((e: { resourceClass: string }) => e.resourceClass === 'volume-deferred'),
    ).toEqual([]);
  });
});
