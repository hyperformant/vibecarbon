/**
 * The CSI driver manifests a master's cloud-init installs, as far as their
 * images go, and a way to run that master's own install rewrite
 * (csi_fetch_mirrored, carbon/cloud-init/k3s/_csi-image-mirror.sh) over a
 * manifest without a network or a node.
 *
 * The unit census (tests/unit/deploy/k8s-image-mirrors.test.ts) uses both to
 * prove the rewrite rendered into each master puts exactly the refs
 * csiSidecarSetImagePlan sets on exactly its containers; the Docker tier
 * (tests/integration/docker/csi-repin-noop.test.ts) applies the result to a
 * real k3s and shows the deploy's `kubectl set image` then changes nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';
import { cleanupTempDir, createTempDir } from './temp-dir.js';

/**
 * The images each pinned CSI release actually ships, captured from the
 * upstream manifests cloud-init installs:
 *   https://raw.githubusercontent.com/hetznercloud/csi-driver/v2.24.1/deploy/kubernetes/hcloud-csi.yml
 *   https://raw.githubusercontent.com/digitalocean/csi-digitalocean/v4.19.0/deploy/kubernetes/releases/csi-digitalocean-v4.19.0/driver.yaml
 *   https://github.com/linode/linode-blockstorage-csi-driver/releases/download/v1.1.5/linode-blockstorage-csi-driver-v1.1.5.yaml
 * (hetzner and digitalocean fetched 2026-11-05, linode 2026-11-07; all three
 * re-checked 2026-11-19). Keyed workload -> container -> image, exactly as
 * upstream spells them, because both seams address them that way: the
 * install rewrite matches the `image:` value verbatim, and `kubectl set
 * image` addresses containers BY NAME. A rename or retag upstream turns
 * either into a miss. If you bump a CSI version, re-derive this fixture from
 * the new manifest; do not hand-edit it.
 */
export const UPSTREAM_CSI_MANIFESTS = {
  hetzner: {
    version: 'v2.24.1',
    workloads: {
      'daemonset/hcloud-csi-node': {
        'csi-node-driver-registrar':
          'registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.18.0',
        'liveness-probe': 'registry.k8s.io/sig-storage/livenessprobe:v2.20.0',
        'hcloud-csi-driver': 'docker.io/hetznercloud/hcloud-csi-driver:v2.24.1',
      },
      'deployment/hcloud-csi-controller': {
        'csi-attacher': 'registry.k8s.io/sig-storage/csi-attacher:v4.13.0',
        'csi-resizer': 'registry.k8s.io/sig-storage/csi-resizer:v2.2.1',
        'csi-provisioner': 'registry.k8s.io/sig-storage/csi-provisioner:v6.3.0',
        'liveness-probe': 'registry.k8s.io/sig-storage/livenessprobe:v2.20.0',
        'hcloud-csi-driver': 'docker.io/hetznercloud/hcloud-csi-driver:v2.24.1',
      },
    },
  },
  digitalocean: {
    version: 'v4.19.0',
    workloads: {
      'statefulset/csi-do-controller': {
        'csi-provisioner': 'registry.k8s.io/sig-storage/csi-provisioner:v6.3.0',
        'csi-attacher': 'registry.k8s.io/sig-storage/csi-attacher:v4.13.0',
        'csi-snapshotter': 'registry.k8s.io/sig-storage/csi-snapshotter:v8.6.0',
        'csi-resizer': 'registry.k8s.io/sig-storage/csi-resizer:v2.2.1',
        'csi-do-plugin': 'digitalocean/do-csi-plugin:v4.19.0',
      },
      'daemonset/csi-do-node': {
        'automount-udev-deleter': 'alpine:3',
        'csi-node-driver-registrar':
          'registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.18.0',
        'csi-do-plugin': 'digitalocean/do-csi-plugin:v4.19.0',
      },
    },
  },
  linode: {
    version: 'v1.1.5',
    workloads: {
      'statefulset/csi-linode-controller': {
        'csi-provisioner': 'registry.k8s.io/sig-storage/csi-provisioner:v6.2.0',
        'csi-attacher': 'registry.k8s.io/sig-storage/csi-attacher:v4.11.0',
        'csi-resizer': 'registry.k8s.io/sig-storage/csi-resizer:v2.1.0',
        'csi-linode-plugin': 'linode/linode-blockstorage-csi-driver:v1.1.5',
      },
      'daemonset/csi-linode-node': {
        'csi-node-driver-registrar':
          'registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.16.0',
        'csi-linode-plugin': 'linode/linode-blockstorage-csi-driver:v1.1.5',
      },
    },
  },
} as const;

/** workload (`daemonset/<name>`) -> container -> image */
export type CsiWorkloads = Record<string, Record<string, string>>;

const KINDS: Record<string, string> = {
  daemonset: 'DaemonSet',
  deployment: 'Deployment',
  statefulset: 'StatefulSet',
};

/**
 * A manifest holding `workloads` in `namespace`: one valid apps/v1 object per
 * workload, its containers named and imaged as given and written the way the
 * three upstream manifests write theirs (block style, a bare `image:` value),
 * after a ServiceAccount that names no image. Deployments and StatefulSets
 * ask for no replicas: what matters is the pod template, not a pod.
 */
export function csiManifest(workloads: CsiWorkloads, namespace = 'kube-system'): string {
  const docs = [
    `apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: csi-images-sa\n  namespace: ${namespace}`,
    ...Object.entries(workloads).map(([workload, containers]) => {
      const [kind, name] = workload.split('/');
      return [
        'apiVersion: apps/v1',
        `kind: ${KINDS[kind]}`,
        'metadata:',
        `  name: ${name}`,
        `  namespace: ${namespace}`,
        'spec:',
        ...(kind === 'statefulset' ? [`  serviceName: ${name}`] : []),
        ...(kind === 'daemonset' ? [] : ['  replicas: 0']),
        '  selector:',
        '    matchLabels:',
        `      app: ${name}`,
        '  template:',
        '    metadata:',
        '      labels:',
        `        app: ${name}`,
        '    spec:',
        '      containers:',
        ...Object.entries(containers).flatMap(([container, image]) => [
          `        - name: ${container}`,
          `          image: ${image}`,
        ]),
      ].join('\n');
    }),
  ];
  return `${docs.join('\n---\n')}\n`;
}

type PodSpec = {
  containers?: { name: string; image: string }[];
  initContainers?: { name: string; image: string }[];
};
type Doc = {
  kind?: string;
  metadata?: { name?: string };
  spec?: { template?: { spec?: PodSpec } };
};

/** `<workload> <container>` -> image, for every container (init ones too) in `manifest`. */
export function imagesByContainer(manifest: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const doc of loadAll(manifest) as Doc[]) {
    const spec = doc?.spec?.template?.spec;
    if (!spec) continue;
    const workload = `${String(doc.kind).toLowerCase()}/${doc.metadata?.name}`;
    for (const { name, image } of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
      out[`${workload} ${name}`] = image;
    }
  }
  return out;
}

/**
 * The CSI install's rewrite as a rendered master carries it: from the
 * rendered `CSI_IMAGE_REWRITES` through the end of `csi_fetch_mirrored`.
 */
function csiInstallSnippet(rendered: string): string {
  const start = rendered.indexOf('CSI_IMAGE_REWRITES="');
  const fn = rendered.indexOf('csi_fetch_mirrored() {', start);
  const end = rendered.indexOf('\n}\n', fn);
  if (start < 0 || fn < 0 || end < 0) {
    throw new Error('the rendered master carries no CSI_IMAGE_REWRITES and csi_fetch_mirrored');
  }
  return rendered.slice(start, end + 3);
}

/** The "<upstream ref> <mirror ref>" pairs a rendered master carries, as [from, to]. */
export function renderedCsiRewrites(rendered: string): [string, string][] {
  const snippet = csiInstallSnippet(rendered);
  const value = snippet.slice('CSI_IMAGE_REWRITES="'.length, snippet.indexOf('"\n'));
  return value
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ') as [string, string]);
}

/**
 * Run csi_fetch_mirrored from `rendered` (a rendered master script) as the
 * install calls it, inside a condition, with `manifest` as what the URL
 * serves: a fake curl copies it to curl's `-o` target, or fails like a
 * download that never arrived when `downloadFails`. stdout ends with
 * `returned <n>` when the function returned and `continued` when the script
 * went on; an install that stopped (the FATAL exit) prints neither.
 * `installed` is the file the install would apply, null when none was
 * written.
 */
export function runCsiInstallRewrite(
  rendered: string,
  manifest: string,
  { downloadFails = false } = {},
): { status: number | null; stdout: string; stderr: string; installed: string | null } {
  const dir = createTempDir('vc-csi-rewrite-');
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'curl'),
      [
        '#!/bin/sh',
        '[ -n "$FAKE_FAIL" ] && exit 22',
        'out=""; prev=""',
        'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
        'cp "$FAKE_MANIFEST" "$out"',
      ].join('\n'),
      { mode: 0o755 },
    );
    const source = join(dir, 'upstream.yaml');
    writeFileSync(source, manifest);
    const out = join(dir, 'csi-driver.yaml');
    const script = [
      'set -euo pipefail',
      csiInstallSnippet(rendered),
      `if csi_fetch_mirrored https://example.invalid/csi.yaml "$OUT"; then echo "returned 0"; else echo "returned $?"; fi`,
      'echo continued',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_MANIFEST: source,
        FAKE_FAIL: downloadFails ? '1' : '',
        OUT: out,
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      installed: existsSync(out) ? readFileSync(out, 'utf8') : null,
    };
  } finally {
    cleanupTempDir(dir);
  }
}
