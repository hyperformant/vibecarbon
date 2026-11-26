/**
 * A PersistentVolume as vultr-csi v0.19.1 writes it, for the destroy tests.
 * Shared so no test file imports another.
 */

// vultr-csi v0.19.1: the volumeHandle is the block storage id, a UUID
// (`VolumeId: volume.ID`, driver/controller.go), and the topology segment
// key is a bare `region` (driver/node.go NodeGetInfo). The volume's label is
// the CSI request name, `pvc-<16 hex>` (--volume-name-uuid-length=16).
export const vultrPv = (name: string, handle: string, region = 'ewr') => ({
  kind: 'PersistentVolume',
  metadata: {
    name,
    annotations: { 'pv.kubernetes.io/provisioned-by': 'block.csi.vultr.com' },
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    capacity: { storage: '10Gi' },
    csi: { driver: 'block.csi.vultr.com', fsType: 'ext4', volumeHandle: handle },
    nodeAffinity: {
      required: {
        nodeSelectorTerms: [
          { matchExpressions: [{ key: 'region', operator: 'In', values: [region] }] },
        ],
      },
    },
    persistentVolumeReclaimPolicy: 'Delete',
    storageClassName: 'vultr-block-storage-vibecarbon',
    volumeMode: 'Filesystem',
  },
  status: { phase: 'Bound' },
});
