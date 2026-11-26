/**
 * What reads the provider API token on a k8s cluster: every Secret reference
 * (a container env var's secretKeyRef, an envFrom secretRef, a secret or
 * projected volume) in the upstream manifests each provider's master boot
 * script applies, in the order it applies them. The cloud-secrets census
 * (tests/unit/deploy/k8s-cloud-secrets.test.ts) holds k8sCloudSecrets to the
 * required ones: a Secret or key nothing reads is one more copy of the
 * token, and one something reads that the CLI never writes leaves its
 * reader waiting.
 *
 * Recorded 2026-11-11 from the manifests at these URLs: for each document
 * with a pod template, every container and init container's env and envFrom
 * and every volume, kind and name lowercased as `kubectl rollout restart`
 * takes them. Every reference is an env var from a secretKeyRef; the CCM's
 * robot-user and robot-password are optional, for Hetzner's dedicated
 * servers. Bump a version in a master boot script and the census fails until
 * `manifests` names the new URL: re-derive `refs` from the new manifest, do
 * not hand-edit them.
 */

export type SecretRef = {
  /** The reader, `kind/name`. */
  workload: string;
  namespace: string;
  secret: string;
  key: string;
  /** `optional: true` on the ref: the pod starts without it. */
  optional?: boolean;
};

export const CLOUD_SECRET_READERS: Record<string, { manifests: string[]; refs: SecretRef[] }> = {
  hetzner: {
    manifests: [
      'https://github.com/hetznercloud/hcloud-cloud-controller-manager/releases/download/v1.39.2/ccm.yaml',
      'https://raw.githubusercontent.com/hetznercloud/csi-driver/v2.24.1/deploy/kubernetes/hcloud-csi.yml',
    ],
    refs: [
      {
        workload: 'deployment/hcloud-cloud-controller-manager',
        namespace: 'kube-system',
        secret: 'hcloud',
        key: 'token',
      },
      {
        workload: 'deployment/hcloud-cloud-controller-manager',
        namespace: 'kube-system',
        secret: 'hcloud',
        key: 'robot-password',
        optional: true,
      },
      {
        workload: 'deployment/hcloud-cloud-controller-manager',
        namespace: 'kube-system',
        secret: 'hcloud',
        key: 'robot-user',
        optional: true,
      },
      {
        workload: 'deployment/hcloud-csi-controller',
        namespace: 'kube-system',
        secret: 'hcloud',
        key: 'token',
      },
    ],
  },
  digitalocean: {
    manifests: [
      'https://raw.githubusercontent.com/digitalocean/digitalocean-cloud-controller-manager/v0.1.72/releases/digitalocean-cloud-controller-manager/v0.1.72.yml',
      'https://raw.githubusercontent.com/digitalocean/csi-digitalocean/v4.19.0/deploy/kubernetes/releases/csi-digitalocean-v4.19.0/crds.yaml',
      'https://raw.githubusercontent.com/digitalocean/csi-digitalocean/v4.19.0/deploy/kubernetes/releases/csi-digitalocean-v4.19.0/driver.yaml',
    ],
    refs: [
      {
        workload: 'deployment/digitalocean-cloud-controller-manager',
        namespace: 'kube-system',
        secret: 'digitalocean',
        key: 'access-token',
      },
      {
        workload: 'statefulset/csi-do-controller',
        namespace: 'kube-system',
        secret: 'digitalocean',
        key: 'access-token',
      },
    ],
  },
  linode: {
    manifests: [
      'https://github.com/linode/linode-blockstorage-csi-driver/releases/download/v1.1.5/linode-blockstorage-csi-driver-v1.1.5.yaml',
    ],
    refs: [
      {
        workload: 'statefulset/csi-linode-controller',
        namespace: 'kube-system',
        secret: 'linode',
        key: 'token',
      },
    ],
  },
  // Recorded 2026-11-26. The release manifest holds two VolumeSnapshotClasses,
  // so the snapshot CRDs upstream's install docs name are applied first; they
  // run no pod and read no Secret.
  vultr: {
    manifests: [
      'https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.4.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml',
      'https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.4.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml',
      'https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.4.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml',
      'https://raw.githubusercontent.com/vultr/vultr-csi/v0.19.1/docs/releases/v0.19.1.yml',
    ],
    refs: [
      {
        workload: 'statefulset/csi-vultr-controller',
        namespace: 'kube-system',
        secret: 'vultr-csi',
        key: 'api-key',
      },
    ],
  },
};

/**
 * The manifests a master boot script applies by URL, in its order: straight
 * from the URL, or a CSI driver's through `csi_fetch_mirrored`, which
 * downloads it and moves its images onto the mirrors before the apply.
 */
export const manifestUrls = (script: string) =>
  [...script.matchAll(/(?:kubectl apply -f|csi_fetch_mirrored) (https:\/\/[^\s;]+)/g)].map(
    ([, url]) => url,
  );
