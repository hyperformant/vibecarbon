/**
 * A PersistentVolume as linode-blockstorage-csi-driver v1.1.5 writes it, for
 * the destroy tests. Shared so no test file imports another.
 */

// linode-blockstorage-csi-driver v1.1.5: the volumeHandle is the driver's
// volume key, `<volume id>-<label>` (pkg/linode-volumes/utils.go
// GetVolumeKey, `fmt.Sprintf("%d-%s", key.VolumeID, volumeName)`), parsed
// back with `strings.SplitN(key, "-", 2)`. Live 2026-11-08: destroy took the
// whole key for the id, matched none of a cluster's 3 volumes, and deferred
// every one as "not ours".
export const linodePv = (name: string, handle: string, region = 'us-iad') => ({
  kind: 'PersistentVolume',
  metadata: {
    name,
    annotations: { 'pv.kubernetes.io/provisioned-by': 'linodebs.csi.linode.com' },
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    capacity: { storage: '10Gi' },
    csi: { driver: 'linodebs.csi.linode.com', fsType: 'ext4', volumeHandle: handle },
    nodeAffinity: {
      required: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              { key: 'topology.linode.com/region', operator: 'In', values: [region] },
            ],
          },
        ],
      },
    },
    persistentVolumeReclaimPolicy: 'Delete',
    storageClassName: 'linode-block-storage',
    volumeMode: 'Filesystem',
  },
  status: { phase: 'Bound' },
});
