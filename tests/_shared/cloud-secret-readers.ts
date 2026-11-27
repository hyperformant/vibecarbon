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
 * takes them. Every reference but Scaleway's is an env var from a
 * secretKeyRef; the CCM's robot-user and robot-password are optional, for
 * Hetzner's dedicated servers. Bump a version in a master boot script and the
 * census fails until `manifests` names the new URL: re-derive `refs` from the
 * new manifest, do not hand-edit them.
 *
 * A manifest committed to the repo (a render the master carries in its user
 * data, EMBEDDED_CSI_MANIFESTS) is named by its repo path. An envFrom reader
 * takes every key of its Secret, so the manifest says nothing of which ones
 * it needs: its ref is recorded as `(envFrom)`, as the Docker takeover test
 * reads it off the cluster, and `envFromKeys` holds the keys the reader
 * requires, from its upstream docs.
 */
import { vi } from 'vitest';
import { EMBEDDED_CSI_MANIFESTS } from '../../src/lib/iac/cloud-init.js';
import { EMBEDDED_CSI_FILES } from './csi-install-rewrite.js';

export type SecretRef = {
  /** The reader, `kind/name`. */
  workload: string;
  namespace: string;
  secret: string;
  key: string;
  /** `optional: true` on the ref: the pod starts without it. */
  optional?: boolean;
};

export type CloudSecretReaders = {
  manifests: string[];
  refs: SecretRef[];
  /** `<namespace>/<secret>` to the keys an `(envFrom)` ref of it requires. */
  envFromKeys?: Record<string, string[]>;
};

export const CLOUD_SECRET_READERS: Record<string, CloudSecretReaders> = {
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
  // Recorded 2026-11-26 from the committed render of scaleway-csi v0.3.6
  // (chart 0.2.2). Only the controller reads the Secret, through envFrom;
  // the node plugin reads none. The four keys are the chart's values.yaml
  // ("must be provided") and the driver's README.
  scaleway: {
    manifests: ['carbon/cloud-init/k3s/_scaleway-csi.yaml'],
    refs: [
      {
        workload: 'deployment/scaleway-csi-controller',
        namespace: 'kube-system',
        secret: 'scaleway-csi-secret',
        key: '(envFrom)',
      },
    ],
    envFromKeys: {
      'kube-system/scaleway-csi-secret': [
        'SCW_ACCESS_KEY',
        'SCW_DEFAULT_PROJECT_ID',
        'SCW_DEFAULT_ZONE',
        'SCW_SECRET_KEY',
      ],
    },
  },
};

/**
 * The manifests a master boot script applies by URL, in its order: straight
 * from the URL, or a CSI driver's through `csi_fetch_mirrored`, which
 * downloads it and moves its images onto the mirrors before the apply. A
 * `file://` URL is a manifest the master decoded from its user data: it is
 * named by the committed file it came from (EMBEDDED_CSI_MANIFESTS' path, to
 * EMBEDDED_CSI_FILES' repo path), and one the table does not hold throws.
 */
export const manifestUrls = (script: string) =>
  [...script.matchAll(/(?:kubectl apply -f|csi_fetch_mirrored) ((?:https|file):\/\/[^\s;]+)/g)].map(
    ([, url]) => {
      if (url.startsWith('https://')) return url;
      const path = url.slice('file://'.length);
      const provider = Object.keys(EMBEDDED_CSI_MANIFESTS).find(
        (id) => EMBEDDED_CSI_MANIFESTS[id].path === path,
      );
      const file = Object.keys(EMBEDDED_CSI_FILES).find((f) => EMBEDDED_CSI_FILES[f] === provider);
      if (!file) throw new Error(`no EMBEDDED_CSI_MANIFESTS entry decodes to ${path}`);
      return file;
    },
  );

/**
 * The zone the census hands Scaleway's k8sCloudSecrets: what `REGIONS` keys,
 * and what a deploy passes as `region`. Every other provider ignores it.
 */
export const CLOUD_SECRETS_ZONE = 'fr-par-1';

/**
 * The operator variables a provider's cloud Secrets carry besides the token:
 * Scaleway's CSI controller takes the access key and project id with the
 * secret key, and k8sCloudSecrets refuses without them. Test values only.
 */
export const OPERATOR_COMPANIONS = {
  SCALEWAY_ACCESS_KEY: 'SCWTESTACCESSKEY00000',
  SCALEWAY_DEFAULT_PROJECT_ID: '00000000-0000-4000-8000-000000000001',
} as const;

/** Stub OPERATOR_COMPANIONS into the env; vi.unstubAllEnvs takes them out. */
export function stubOperatorCompanions() {
  for (const [key, value] of Object.entries(OPERATOR_COMPANIONS)) vi.stubEnv(key, value);
}

/** A provider's cloud Secrets for `token`, in the census's zone. */
export const cloudSecretsOf = (
  Provider: {
    k8sCloudSecrets: (values: {
      token: string;
      region: string;
    }) => { namespace: string; name: string; stringData: Record<string, string> }[];
  },
  token: string,
) => Provider.k8sCloudSecrets({ token, region: CLOUD_SECRETS_ZONE });

/**
 * The values a provider's Secret keys hold that are not the token, by
 * provider and key: every other key holds the token.
 */
export const COMPANION_VALUES: Record<string, Record<string, string>> = {
  scaleway: {
    SCW_ACCESS_KEY: OPERATOR_COMPANIONS.SCALEWAY_ACCESS_KEY,
    SCW_DEFAULT_PROJECT_ID: OPERATOR_COMPANIONS.SCALEWAY_DEFAULT_PROJECT_ID,
    SCW_DEFAULT_ZONE: CLOUD_SECRETS_ZONE,
  },
};
