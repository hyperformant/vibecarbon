import { describe, expect, it, vi } from 'vitest';
import { cleanupOrphanedVolumes, DESTROY_EFFECTS } from '../../../src/destroy.js';
import { parseCsiPersistentVolumes } from '../../../src/lib/csi-volumes.js';
import { createLeakLedger } from '../../../src/lib/destroy/leak-ledger.js';
import { ScalewayProvider } from '../../../src/lib/providers/scaleway.js';
import { scalewayPv } from '../../_shared/scaleway-csi-pv.js';
import { teardownProvider } from '../../_shared/teardown-provider.js';

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
 * scaleway-csi names its Block volume `pvc-<uuid>` and gives it no tags, so
 * the only proof that one is this environment's is its id in the capture of
 * the cluster's PersistentVolumes (the volumeHandle is `<zone>/<uuid>`). The
 * `pvc-*` in-cluster-region heuristic, which deletes a detached CSI volume in
 * one of the cluster's zones when the capture failed, would on Scaleway
 * delete any cluster's in that zone (ORPHAN_VOLUME_REGION_GUESS is false):
 * such a volume is reported and fails the destroy instead.
 */
const VOLUME_ID = '6d3a8f2e-1b4c-4e5f-9a7b-0c1d2e3f4a5b';
const PV_NAME = 'pvc-01234567-89ab-cdef-0123-456789abcdef';
/** A Block API volume as listVolumesDetailed returns it (zone-stamped), detached. */
const volume = (name: string, over: Record<string, unknown> = {}) => ({
  id: VOLUME_ID,
  name,
  zone: 'fr-par-1',
  references: [],
  tags: [],
  created_at: '2026-11-26T10:00:00Z',
  ...over,
});
const NO_OWNER =
  "Scaleway CSI volumes carry no tags, so only a captured id proves one is this environment's";

function setup(volumes: Array<ReturnType<typeof volume>>) {
  const provider = new ScalewayProvider('token');
  vi.spyOn(provider, 'listVolumesDetailed').mockResolvedValue({ items: volumes, complete: true });
  const deleteVolume = vi.spyOn(provider, 'deleteVolume').mockResolvedValue(true);
  return { provider, deleteVolume };
}
// A real destroy passes the cluster's zones, which arms the region heuristic.
const run = (provider: ScalewayProvider, knownIds: string[], identityComplete: boolean) =>
  cleanupOrphanedVolumes(provider, 'proj', 'prod', knownIds, ['fr-par-1'], {
    identityComplete,
    report: () => {},
  });

describe('cleanupOrphanedVolumes on Scaleway', () => {
  it('deletes a detached pvc-<uuid> volume whose id the capture listed', async () => {
    const { volumes: pvs } = parseCsiPersistentVolumes({
      items: [scalewayPv(PV_NAME, `fr-par-1/${VOLUME_ID}`)],
    });
    expect(pvs.map((v) => v.volumeId)).toEqual([VOLUME_ID]);
    const { provider, deleteVolume } = setup([volume(PV_NAME)]);
    const { deleted, deferred } = await run(
      provider,
      pvs.map((v) => v.volumeId),
      true,
    );
    expect(deferred).toEqual([]);
    expect(deleteVolume).toHaveBeenCalledExactlyOnceWith(VOLUME_ID);
    expect(deleted).toEqual([PV_NAME]);
  });

  it('with no capture and an incomplete identity, defers it as no-owner-signal and never deletes it', async () => {
    const { provider, deleteVolume } = setup([volume(PV_NAME)]);
    const { deleted, deferred } = await run(provider, [], false);
    expect(deleteVolume).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
    expect(deferred).toEqual([
      {
        id: VOLUME_ID,
        name: PV_NAME,
        region: 'fr-par-1',
        createdAt: '2026-11-26T10:00:00Z',
        match: 'pvc-in-cluster-region',
        blockedBy: 'no-owner-signal',
        blocked: NO_OWNER,
      },
    ]);
  });

  it('with a complete identity, defers it as identity-complete (proven not ours)', async () => {
    const { provider, deleteVolume } = setup([volume(PV_NAME)]);
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
// reported and fails the destroy's exit code.
describe('a Scaleway k8s destroy whose PersistentVolume capture failed', () => {
  const spinner = { start: () => {}, stop: () => {}, message: () => {} };

  it('reports the volume as unverified, failing the exit code, and never deletes it', async () => {
    const deleted: string[] = [];
    const accessors = new ScalewayProvider('token');
    const read = (name: keyof ScalewayProvider) =>
      (accessors[name] as (...a: unknown[]) => unknown).bind(accessors);
    function FakeScaleway() {
      return teardownProvider({
        ctor: FakeScaleway,
        methods: {
          listServersDetailed: async () => ({ items: [], complete: true }),
          listVolumesDetailed: async () => ({ items: [volume(PV_NAME)], complete: true }),
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
    Object.assign(FakeScaleway, {
      NAME: ScalewayProvider.NAME,
      K8S_DESTROY_BACKSTOP: ScalewayProvider.K8S_DESTROY_BACKSTOP,
      ORPHAN_VOLUME_REGION_GUESS: ScalewayProvider.ORPHAN_VOLUME_REGION_GUESS,
      getPublicIP: () => null,
    });
    holder.Provider = FakeScaleway;
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
            provider: 'scaleway',
            tier: 'k8s',
            region: 'fr-par-1',
            servers: [{ role: 'master', name: 'master', ip: '203.0.113.7', id: 'srv-1' }],
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
          cwd: '/tmp/vibecarbon-scaleway-orphan-volume-nowhere',
        },
        {},
      );
    } finally {
      vi.mocked(console.log).mockRestore();
    }
    expect(deleted).toEqual([]);
    const entry = leaks.entries.find(
      (e: { resourceClass: string }) => e.resourceClass === 'volume-deferred',
    );
    expect(entry).toMatchObject({ severity: 'unverified' });
    expect(entry?.resource).toContain(PV_NAME);
    expect(entry?.reason).toContain(NO_OWNER);
    expect(leaks.exitCode()).not.toBe(0);
  });
});
