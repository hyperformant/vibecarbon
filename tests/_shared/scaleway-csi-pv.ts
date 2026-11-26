/**
 * A PersistentVolume as scaleway-csi v0.3.6 writes it, for the destroy tests.
 * Shared so no test file imports another.
 */

// scaleway-csi v0.3.6: the volumeHandle is `<zone>/<volume uuid>` and the
// topology segment key is `topology.csi.scaleway.com/zone`
// (pkg/driver/helpers.go:38-61). The Block volume it creates is named
// `pvc-<uuid>` and carries no tags.
export const scalewayPv = (name: string, handle: string, zone = 'fr-par-1') => ({
  kind: 'PersistentVolume',
  metadata: {
    name,
    annotations: { 'pv.kubernetes.io/provisioned-by': 'csi.scaleway.com' },
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    capacity: { storage: '5Gi' },
    csi: { driver: 'csi.scaleway.com', fsType: 'ext4', volumeHandle: handle },
    nodeAffinity: {
      required: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              { key: 'topology.csi.scaleway.com/zone', operator: 'In', values: [zone] },
            ],
          },
        ],
      },
    },
    persistentVolumeReclaimPolicy: 'Delete',
    storageClassName: 'scaleway-block-vibecarbon',
    volumeMode: 'Filesystem',
  },
  status: { phase: 'Bound' },
});
