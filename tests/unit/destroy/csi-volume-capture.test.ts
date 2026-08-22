import { describe, expect, it, vi } from 'vitest';

import {
  captureClusterCsiVolumes,
  isCsiVolumeName,
  parseCsiPersistentVolumes,
} from '../../../src/lib/csi-volumes.js';

/**
 * Layer 1 of the CSI-volume destroy leak fix: capture the PROVIDER volume ids
 * from the cluster's own PersistentVolumes while the API server is still up.
 *
 * Fixtures below are the real wire shapes of the two drivers this repo pins
 * (hcloud csi-driver v2.18.1 via carbon/cloud-init/k3s/master-init.sh,
 * csi-digitalocean v4.17.0 via do-master-init.sh) — including the details that
 * actually bite: Hetzner's volumeHandle is the numeric volume id rendered as a
 * STRING, and its topology key is `csi.hetzner.cloud/location` while DO's is a
 * bare `region`. Both survived the v2.9.0 -> v2.18.1 bump verbatim
 * (`VolumeId: strconv.FormatInt(volume.ID, 10)` and
 * `TopologySegmentLocation = PluginName + "/location"`), which is why these
 * fixtures did not move with it.
 */

const hetznerPv = (name: string, handle: string, location = 'nbg1') => ({
  kind: 'PersistentVolume',
  metadata: {
    name,
    annotations: { 'pv.kubernetes.io/provisioned-by': 'csi.hetzner.cloud' },
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    capacity: { storage: '10Gi' },
    csi: {
      driver: 'csi.hetzner.cloud',
      fsType: 'ext4',
      volumeHandle: handle,
      volumeAttributes: {
        'storage.kubernetes.io/csiProvisionerIdentity': '1754300000000-8081-csi.hetzner.cloud',
      },
    },
    nodeAffinity: {
      required: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              { key: 'csi.hetzner.cloud/location', operator: 'In', values: [location] },
            ],
          },
        ],
      },
    },
    persistentVolumeReclaimPolicy: 'Delete',
    storageClassName: 'hcloud-volumes',
    volumeMode: 'Filesystem',
  },
  status: { phase: 'Bound' },
});

const doPv = (name: string, handle: string, region = 'nyc3') => ({
  kind: 'PersistentVolume',
  metadata: {
    name,
    annotations: { 'pv.kubernetes.io/provisioned-by': 'dobs.csi.digitalocean.com' },
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    capacity: { storage: '10Gi' },
    csi: {
      driver: 'dobs.csi.digitalocean.com',
      fsType: 'ext4',
      volumeHandle: handle,
      volumeAttributes: {
        'storage.kubernetes.io/csiProvisionerIdentity':
          '1754300000000-8081-dobs.csi.digitalocean.com',
      },
    },
    nodeAffinity: {
      required: {
        nodeSelectorTerms: [
          { matchExpressions: [{ key: 'region', operator: 'In', values: [region] }] },
        ],
      },
    },
    persistentVolumeReclaimPolicy: 'Delete',
    storageClassName: 'do-block-storage',
    volumeMode: 'Filesystem',
  },
  status: { phase: 'Bound' },
});

const PVC_A = 'pvc-1c3f8b2a-4d5e-4f60-9a1b-2c3d4e5f6071';
const PVC_B = 'pvc-2d4e9c3b-5e6f-4071-8b2c-3d4e5f607182';

describe('parseCsiPersistentVolumes — hcloud csi-driver v2.18.1 fixtures', () => {
  it('extracts the numeric Hetzner volume id from spec.csi.volumeHandle as a string', () => {
    const { volumes } = parseCsiPersistentVolumes({
      items: [hetznerPv(PVC_A, '100604631')],
    });

    expect(volumes).toEqual([
      {
        pvName: PVC_A,
        driver: 'csi.hetzner.cloud',
        providerId: 'hetzner',
        // Hetzner's CreateVolume returns strconv.FormatInt(volume.ID, 10) —
        // a string handle that must later be compared to a NUMBER volume.id.
        volumeId: '100604631',
        regions: ['nbg1'],
        phase: 'Bound',
        reclaimPolicy: 'Delete',
      },
    ]);
  });

  it('reads the region from the csi.hetzner.cloud/location topology key', () => {
    const { volumes } = parseCsiPersistentVolumes({
      items: [hetznerPv(PVC_A, '1', 'hel1'), hetznerPv(PVC_B, '2', 'nbg1')],
    });

    expect(volumes.map((v) => v.regions)).toEqual([['hel1'], ['nbg1']]);
  });

  it('accepts a raw JSON string (kubectl stdout) as well as a parsed object', () => {
    const { volumes } = parseCsiPersistentVolumes(
      JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [hetznerPv(PVC_A, '7')] }),
    );

    expect(volumes.map((v) => v.volumeId)).toEqual(['7']);
  });
});

describe('parseCsiPersistentVolumes — csi-digitalocean v4.17.0 fixtures', () => {
  it('extracts the DO volume UUID and the bare `region` topology key', () => {
    const { volumes } = parseCsiPersistentVolumes({
      items: [doPv(PVC_A, 'e2ba5a3c-c714-11e8-bc0c-0a58ac14421e', 'sfo3')],
    });

    expect(volumes).toEqual([
      {
        pvName: PVC_A,
        driver: 'dobs.csi.digitalocean.com',
        providerId: 'digitalocean',
        volumeId: 'e2ba5a3c-c714-11e8-bc0c-0a58ac14421e',
        regions: ['sfo3'],
        phase: 'Bound',
        reclaimPolicy: 'Delete',
      },
    ]);
  });

  it('also accepts the well-known topology.kubernetes.io/region key', () => {
    const pv = doPv(PVC_A, 'vol-1');
    pv.spec.nodeAffinity.required.nodeSelectorTerms = [
      {
        matchExpressions: [
          { key: 'topology.kubernetes.io/region', operator: 'In', values: ['ams3'] },
        ],
      },
    ];

    const { volumes } = parseCsiPersistentVolumes({ items: [pv] });

    expect(volumes[0].regions).toEqual(['ams3']);
  });
});

describe('parseCsiPersistentVolumes — what it deliberately does NOT claim', () => {
  it('ignores non-CSI PVs (hostPath / local-path) — there is no provider volume to delete', () => {
    const { volumes } = parseCsiPersistentVolumes({
      items: [
        { metadata: { name: 'local-pv' }, spec: { hostPath: { path: '/data' } } },
        hetznerPv(PVC_A, '11'),
      ],
    });

    expect(volumes.map((v) => v.volumeId)).toEqual(['11']);
  });

  it('reports an unknown CSI driver instead of guessing at its volumeHandle', () => {
    const { volumes, skippedDrivers } = parseCsiPersistentVolumes({
      items: [
        {
          metadata: { name: 'longhorn-pv' },
          spec: { csi: { driver: 'driver.longhorn.io', volumeHandle: 'lh-1' } },
        },
        hetznerPv(PVC_A, '11'),
      ],
    });

    expect(volumes.map((v) => v.volumeId)).toEqual(['11']);
    expect(skippedDrivers).toEqual(['driver.longhorn.io']);
  });

  it('survives malformed items rather than throwing away the whole listing', () => {
    const { volumes } = parseCsiPersistentVolumes({
      items: [null, {}, { spec: {} }, { spec: { csi: {} } }, hetznerPv(PVC_A, '11')],
    });

    expect(volumes.map((v) => v.volumeId)).toEqual(['11']);
  });

  it('returns nothing (not a throw) for unparseable stdout', () => {
    expect(parseCsiPersistentVolumes('<html>gateway timeout</html>')).toEqual({
      volumes: [],
      skippedDrivers: [],
    });
  });

  it('de-duplicates PVs that share a volumeHandle', () => {
    const { volumes } = parseCsiPersistentVolumes({
      items: [hetznerPv(PVC_A, '11'), hetznerPv(PVC_B, '11')],
    });

    expect(volumes).toHaveLength(1);
  });
});

describe('captureClusterCsiVolumes', () => {
  const okDeps = (payload: unknown) => ({
    existsSync: () => true,
    runCommand: vi.fn(() => JSON.stringify(payload)),
  });

  it('captures ids and regions from a live cluster, attached or not', () => {
    const deps = okDeps({
      items: [hetznerPv(PVC_A, '100604631', 'nbg1'), hetznerPv(PVC_B, '100604632', 'hel1')],
    });

    const result = captureClusterCsiVolumes('/tmp/kubeconfig-prod', deps);

    expect(result.ok).toBe(true);
    expect(result.volumeIds).toEqual(['100604631', '100604632']);
    expect(result.regions.sort()).toEqual(['hel1', 'nbg1']);
    expect(result.reason).toBeNull();
  });

  it('asks kubectl for PVs with an explicit kubeconfig and request timeout', () => {
    const deps = okDeps({ items: [] });

    captureClusterCsiVolumes('/tmp/kubeconfig-prod', deps);

    expect(deps.runCommand).toHaveBeenCalledWith(
      [
        'kubectl',
        '--kubeconfig',
        '/tmp/kubeconfig-prod',
        'get',
        'pv',
        '-o',
        'json',
        '--request-timeout=60s',
      ],
      { silent: true, returnOutput: true },
    );
  });

  it('a cluster with zero PVs is a SUCCESSFUL capture (nothing to reap), not a failure', () => {
    const result = captureClusterCsiVolumes('/tmp/kubeconfig-prod', okDeps({ items: [] }));

    expect(result.ok).toBe(true);
    expect(result.volumeIds).toEqual([]);
  });

  // Every branch below leaves the destroy UNABLE to prove it cleaned up. Each
  // one must say so — `ok: false` is what switches the caller into its loud,
  // degraded backstop instead of printing "No orphaned volumes found".
  it('reports a missing kubeconfig (cluster never came up / already cleaned)', () => {
    const result = captureClusterCsiVolumes('/tmp/kubeconfig-prod', {
      existsSync: () => false,
      runCommand: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no kubeconfig');
  });

  it('reports a dead cluster (kubectl throws) without throwing itself', () => {
    const result = captureClusterCsiVolumes('/tmp/kubeconfig-prod', {
      existsSync: () => true,
      runCommand: () => {
        throw new Error('Unable to connect to the server: dial tcp i/o timeout');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('kubectl get pv failed');
    expect(result.volumeIds).toEqual([]);
  });

  it('reports non-JSON stdout rather than treating it as an empty cluster', () => {
    const result = captureClusterCsiVolumes('/tmp/kubeconfig-prod', {
      existsSync: () => true,
      runCommand: () => 'error: the server doesn\'t have a resource type "pv"',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not JSON');
  });

  it('reports a JSON payload with no items array rather than claiming zero PVs', () => {
    const result = captureClusterCsiVolumes('/tmp/kubeconfig-prod', {
      existsSync: () => true,
      runCommand: () => JSON.stringify({ kind: 'Status', status: 'Failure', code: 401 }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no items array');
  });

  it('reports empty stdout', () => {
    const result = captureClusterCsiVolumes('/tmp/kubeconfig-prod', {
      existsSync: () => true,
      runCommand: () => '',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no output');
  });
});

describe('isCsiVolumeName', () => {
  it('matches the pvc-<uuid> names both drivers generate', () => {
    expect(isCsiVolumeName(PVC_A)).toBe(true);
  });

  it('does not match an operator-named volume that merely starts with pvc-', () => {
    // The loose `startsWith('pvc-')` test is what makes a name heuristic
    // dangerous; the anchored UUID form is what makes it merely imprecise.
    expect(isCsiVolumeName('pvc-backups')).toBe(false);
    expect(isCsiVolumeName('pvc-')).toBe(false);
    expect(isCsiVolumeName('supabase-db-data')).toBe(false);
    expect(isCsiVolumeName(undefined)).toBe(false);
  });
});
