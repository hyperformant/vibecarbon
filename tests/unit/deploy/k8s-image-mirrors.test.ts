/**
 * Drift guards for the ghcr mirror set (registry.k8s.io and, since the
 * cold-deploy-speed plan Task 7, docker.io; src/lib/images.js,
 * scripts/mirror-matrix.mjs, .github/workflows/publish-images.yml).
 *
 * WHY THE MIRROR SET EXISTS — two incidents, same root cause. registry.k8s.io
 * is a REDIRECTOR, not a registry: it routes each client to a cloud-hosted
 * backend by client IP, and its GCP leg intermittently 403s datacenter ranges
 * (Hetzner's among them). Retries hit the same backend, so nothing on our side
 * can fix it.
 *
 *   2026-07-31 (e3)  `autoscaling/cluster-autoscaler:v1.32.7` 403'd x3 ->
 *                    BackOff x20 -> the 300s CA rollout wait failed the deploy.
 *                    Fixed by the mirror in #222.
 *   2026-08-05 (k8s-ha) the SAME 403 hit `sig-storage/csi-node-driver-registrar`
 *                    + `sig-storage/livenessprobe` on ONE node of three. The
 *                    hcloud-csi node plugin never registered -> "no topology key
 *                    found on CSINode" -> db PVCs unprovisionable -> helm
 *                    timeout -> deploy dead. Two sibling nodes pulled the same
 *                    images fine: it is per-node roulette.
 *
 * So EVERY registry.k8s.io image on a customer/e2e path is mirrored, and every
 * consuming reference resolves through src/lib/images.js. These tests pin:
 *
 *  (a) the mirror set's shape — flat under the org, upstream's tag plus its
 *      pinned amd64 digest, no dupes;
 *  (b) the CSI sidecar re-pin spec matches the CSI driver versions cloud-init
 *      actually installs (a version bump there without re-deriving the sidecar
 *      tags here would silently re-open the 403);
 *  (c) every re-pinned image is in the mirror set (nothing points at a package
 *      the publish workflow never mirrors);
 *  (d) no deploy-facing file references registry.k8s.io outside a comment;
 *  (e) the workflow mirrors exactly the set, via the same generator this test runs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  holdFor,
  NO_DRIFT_MARKER,
  newerTags,
  readK3sVersion,
  renderReport,
} from '../../../scripts/mirror-drift.mjs';
import {
  ALPINE_K8S_MIRROR,
  alpineImageRef,
  alpineK8sImageRef,
  assertDistinctPackageNames,
  CSI_SIDECAR_MIRRORS,
  CSI_UPSTREAM_IMAGE_PINS,
  clusterAutoscalerImageRef,
  clusterAutoscalerUpstreamRef,
  csiSidecarSetImagePlan,
  DO_CSI_VERSION,
  DOCKERHUB_MIRRORS,
  DOCKERHUB_UPSTREAM_REGISTRY,
  dockerSocketProxyImageRef,
  HETZNER_CSI_VERSION,
  K3S_SYSTEM_IMAGE_MIRRORS,
  K8S_MIRROR_ORG,
  K8S_UPSTREAM_REGISTRY,
  k8sMirrorRef,
  k8sMirrorTagRef,
  MIRRORED_IMAGES,
  mirroredImageName,
  mirroredPackageNames,
  pauseImageRef,
  REGISTRY_MIRROR,
  registryImageRef,
  socatImageRef,
  TRAEFIK_MIRROR,
  traefikImageRef,
  upstreamRef,
} from '../../../src/lib/images.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';
import { namesHost } from '../../_shared/hosts.js';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const WORKFLOW = '.github/workflows/publish-images.yml';
const MATRIX_SCRIPT = 'scripts/mirror-matrix.mjs';

/**
 * The registry.k8s.io images each pinned CSI release actually ships, captured
 * from the upstream manifests cloud-init applies:
 *   https://raw.githubusercontent.com/hetznercloud/csi-driver/v2.18.1/deploy/kubernetes/hcloud-csi.yml
 *   https://raw.githubusercontent.com/digitalocean/csi-digitalocean/master/deploy/kubernetes/releases/csi-digitalocean-v4.17.0/driver.yaml
 * (both fetched 2026-08-05). Keyed workload -> container -> image, exactly as
 * upstream spells them, because `kubectl set image` addresses containers BY
 * NAME: a rename upstream turns our re-pin into a silent no-op, and the 403
 * comes straight back. If you bump a CSI version, re-derive this fixture from
 * the new manifest — do not hand-edit it.
 */
const UPSTREAM_CSI_MANIFESTS = {
  hetzner: {
    version: 'v2.18.1',
    workloads: {
      'daemonset/hcloud-csi-node': {
        'csi-node-driver-registrar':
          'registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.15.0',
        'liveness-probe': 'registry.k8s.io/sig-storage/livenessprobe:v2.17.0',
        'hcloud-csi-driver': 'docker.io/hetznercloud/hcloud-csi-driver:v2.18.1',
      },
      'deployment/hcloud-csi-controller': {
        'csi-attacher': 'registry.k8s.io/sig-storage/csi-attacher:v4.10.0',
        'csi-resizer': 'registry.k8s.io/sig-storage/csi-resizer:v2.0.0',
        'csi-provisioner': 'registry.k8s.io/sig-storage/csi-provisioner:v6.0.0',
        'liveness-probe': 'registry.k8s.io/sig-storage/livenessprobe:v2.17.0',
        'hcloud-csi-driver': 'docker.io/hetznercloud/hcloud-csi-driver:v2.18.1',
      },
    },
  },
  digitalocean: {
    version: 'v4.17.0',
    workloads: {
      'statefulset/csi-do-controller': {
        'csi-provisioner': 'registry.k8s.io/sig-storage/csi-provisioner:v6.2.0',
        'csi-attacher': 'registry.k8s.io/sig-storage/csi-attacher:v4.11.0',
        'csi-snapshotter': 'registry.k8s.io/sig-storage/csi-snapshotter:v8.5.0',
        'csi-resizer': 'registry.k8s.io/sig-storage/csi-resizer:v2.1.0',
        'csi-do-plugin': 'digitalocean/do-csi-plugin:v4.17.0',
      },
      'daemonset/csi-do-node': {
        'automount-udev-deleter': 'alpine:3',
        'csi-node-driver-registrar':
          'registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.16.0',
        'csi-do-plugin': 'digitalocean/do-csi-plugin:v4.17.0',
      },
    },
  },
} as const;

describe('mirror set shape', () => {
  it('every entry mirrors registry.k8s.io or docker.io into our ghcr org', () => {
    expect(MIRRORED_IMAGES.length).toBeGreaterThanOrEqual(22);
    for (const image of MIRRORED_IMAGES) {
      const upstream = image.upstream ?? K8S_UPSTREAM_REGISTRY;
      expect([K8S_UPSTREAM_REGISTRY, DOCKERHUB_UPSTREAM_REGISTRY]).toContain(upstream);
      expect(upstreamRef(image)).toBe(`${upstream}/${image.repo}:${image.tag}`);
      expect(k8sMirrorRef(image)).toMatch(/^ghcr\.io\/hyperformant\//);
    }
    // Existing registry.k8s.io entries carry no field; the default keeps them there.
    expect(upstreamRef({ repo: 'pause', tag: '3.9', digest: 'sha256:x' })).toBe(
      'registry.k8s.io/pause:3.9',
    );
    for (const image of DOCKERHUB_MIRRORS) {
      expect(image.upstream).toBe(DOCKERHUB_UPSTREAM_REGISTRY);
      expect(MIRRORED_IMAGES).toContain(image);
    }
  });

  it('package names are flat basenames, and two different repos may never share one', () => {
    expect(mirroredImageName('library/traefik')).toBe('traefik');
    expect(mirroredImageName('alpine/k8s')).toBe('k8s');
    expect(mirroredImageName('library/alpine')).toBe('alpine');
    // The guard: a second repo mapping onto an existing package would make one
    // package hold two unrelated images.
    expect(() =>
      assertDistinctPackageNames([
        { repo: 'library/alpine', tag: '1', digest: 'sha256:a' },
        { repo: 'someone/alpine', tag: '1', digest: 'sha256:b' },
      ]),
    ).toThrow(/library\/alpine.*someone\/alpine|someone\/alpine.*library\/alpine/);
    // Same repo at two tags is one package, not a collision.
    expect(() =>
      assertDistinctPackageNames([
        { repo: 'sig-storage/csi-attacher', tag: 'v1', digest: 'sha256:a' },
        { repo: 'sig-storage/csi-attacher', tag: 'v2', digest: 'sha256:b' },
      ]),
    ).not.toThrow();
    expect(() => assertDistinctPackageNames(MIRRORED_IMAGES)).not.toThrow();
  });

  it('the per-image ref helpers return the digest-pinned mirror refs', () => {
    const byRepo = (repo: string) =>
      k8sMirrorRef(DOCKERHUB_MIRRORS.find((i) => i.repo === repo) as (typeof DOCKERHUB_MIRRORS)[0]);
    expect(traefikImageRef()).toBe(byRepo('library/traefik'));
    expect(dockerSocketProxyImageRef()).toBe(byRepo('tecnativa/docker-socket-proxy'));
    expect(alpineImageRef()).toBe(byRepo('library/alpine'));
    expect(registryImageRef()).toBe(byRepo('library/registry'));
    expect(socatImageRef()).toBe(byRepo('alpine/socat'));
    expect(alpineK8sImageRef()).toBe(byRepo('alpine/k8s'));
    expect(traefikImageRef()).toMatch(
      /^ghcr\.io\/hyperformant\/traefik:v3\.6\.11@sha256:[a-f0-9]{64}$/,
    );
  });

  it('mirror targets are FLAT under the org — upstream basename, upstream tag', () => {
    // The cluster-autoscaler precedent (#222): `autoscaling/cluster-autoscaler`
    // mirrors to `ghcr.io/hyperformant/cluster-autoscaler`, NOT to a nested
    // `.../autoscaling/cluster-autoscaler`. ghcr has no nested-path packages;
    // a slash in the name would create a package nobody can flip public.
    for (const image of MIRRORED_IMAGES) {
      const mirror = k8sMirrorRef(image);
      const afterOrg = mirror.slice(`${K8S_MIRROR_ORG}/`.length);
      expect(afterOrg).not.toContain('/');
      const basename = image.repo.slice(image.repo.lastIndexOf('/') + 1);
      expect(afterOrg).toBe(`${basename}:${image.tag}@${image.digest}`);
      expect(k8sMirrorTagRef(image)).toBe(`${K8S_MIRROR_ORG}/${basename}:${image.tag}`);
    }
  });

  it('tags never diverge from upstream, and every deployed ref pins the amd64 digest', () => {
    // The mirror is a digest-preserving manifest copy, so `v2.15.0` on ghcr
    // must mean the same bits as `v2.15.0` upstream. One tag field feeds both
    // refs, and one digest field (upstream's linux/amd64 manifest, which the
    // job copies verbatim) pins what clusters pull.
    for (const image of MIRRORED_IMAGES) {
      expect(image.tag).not.toContain('@');
      expect(image.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(k8sMirrorRef(image).endsWith(`@${image.digest}`)).toBe(true);
      expect(k8sMirrorTagRef(image).split(':').pop()).toBe(upstreamRef(image).split(':').pop());
    }
  });

  it('no two entries share a digest (a copy-paste pin would point one image at another)', () => {
    const digests = MIRRORED_IMAGES.map((i) => i.digest);
    expect(digests).toEqual([...new Set(digests)]);
  });

  it('has no duplicate (repo, tag) entries', () => {
    const refs = MIRRORED_IMAGES.map(upstreamRef);
    expect(refs).toEqual([...new Set(refs)]);
  });

  it('two packages legitimately carry MORE than one tag (Hetzner + DO disagree)', () => {
    // csi-provisioner is v6.0.0 on Hetzner and v6.2.0 on DO, etc. A dedupe
    // that collapsed by package NAME would drop one provider's tag and
    // reintroduce the 403 on that provider only — the nastiest possible shape.
    const byName = new Map<string, Set<string>>();
    for (const image of MIRRORED_IMAGES) {
      const name = image.repo.slice(image.repo.lastIndexOf('/') + 1);
      byName.set(name, (byName.get(name) ?? new Set()).add(image.tag));
    }
    const multiTag = [...byName.entries()].filter(([, tags]) => tags.size > 1).map(([n]) => n);
    expect(multiTag.sort()).toEqual([
      'csi-attacher',
      'csi-node-driver-registrar',
      'csi-provisioner',
      'csi-resizer',
    ]);
  });

  it('mirroredPackageNames() is the operator’s public-flip checklist', () => {
    // Every name here is a ghcr package that must be flipped PUBLIC by hand
    // after the first publish run — k3s nodes pull anonymously.
    const names = mirroredPackageNames();
    expect(names).toEqual([...new Set(names)].sort());
    expect(names).toEqual([
      'alpine',
      'cluster-autoscaler',
      'csi-attacher',
      'csi-node-driver-registrar',
      'csi-provisioner',
      'csi-resizer',
      'csi-snapshotter',
      'docker-socket-proxy',
      'k8s',
      'livenessprobe',
      'local-path-provisioner',
      'mirrored-coredns-coredns',
      'mirrored-library-busybox',
      'mirrored-metrics-server',
      'mirrored-pause',
      'pause',
      'registry',
      'socat',
      'traefik',
    ]);
  });

  it('folds in the cluster-autoscaler mirror #222 already proved', () => {
    // CA keeps its own named constants (deploy code references them directly),
    // but it must be mirrored by the SAME job as everything else — one
    // mechanism, not two. These assertions are what keep the list entry and
    // the named constants from drifting apart.
    const ca = MIRRORED_IMAGES.filter((i) => i.repo === 'autoscaling/cluster-autoscaler');
    expect(ca).toHaveLength(1);
    expect(upstreamRef(ca[0])).toBe(clusterAutoscalerUpstreamRef());
    expect(k8sMirrorRef(ca[0])).toBe(clusterAutoscalerImageRef());
  });

  it('mirrors pause — the scale-trigger + local-overlay placeholder image', () => {
    expect(pauseImageRef()).toBe(
      'ghcr.io/hyperformant/pause:3.9@sha256:8d4106c88ec0bd28001e34c975d65175d994072d65341f62a8ab0754b0fafe10',
    );
    expect(MIRRORED_IMAGES.some((i) => i.repo === 'pause' && i.tag === '3.9')).toBe(true);
  });
});

describe('CSI sidecar re-pin spec tracks the CSI releases cloud-init installs', () => {
  it.each([
    ['hetzner', 'carbon/cloud-init/k3s/master-init.sh', /csi-driver\/(v[\d.]+)\//],
    ['digitalocean', 'carbon/cloud-init/k3s/do-master-init.sh', /csi-digitalocean-(v[\d.]+)\//],
  ] as const)(
    '%s: the version in cloud-init matches the version the tags were derived from',
    (provider, initScript, pattern) => {
      // THE load-bearing guard. The sidecar tags below are hand-derived from a
      // specific upstream manifest. Bump the CSI release in cloud-init without
      // re-deriving them and `kubectl set image` would pin the OLD sidecar
      // versions over the new manifest — or, if a container was renamed, do
      // nothing at all and hand the deploy straight back to registry.k8s.io.
      const pinned = read(initScript).match(pattern)?.[1];
      const expected = provider === 'hetzner' ? HETZNER_CSI_VERSION : DO_CSI_VERSION;
      expect(pinned, `no CSI version found in ${initScript}`).toBeDefined();
      expect(pinned).toBe(expected);
      expect(expected).toBe(UPSTREAM_CSI_MANIFESTS[provider].version);
    },
  );

  it('hetzner: the CSI pin is inside upstream’s support ceiling for the pinned k3s minor', () => {
    // THE TRAP THIS EXISTS FOR — "bump the CSI driver" reads like "take the
    // newest release", and the newest release does not run on our Kubernetes.
    // hetznercloud/csi-driver supports the latest THREE k8s minors and drops
    // the rest; k3s is pinned at v1.31.x (k3s.js K3S_VERSION), and v2.18.2's
    // changelog entry is literally "drop Kubernetes v1.31 support". So v2.18.1
    // is the ceiling until K3S_VERSION moves — bumping past it would install a
    // driver upstream no longer tests against our API server.
    //
    // Table transcribed from upstream docs/kubernetes/reference/version-policy.md
    // @ v2.22.1 (fetched 2026-08-05); `null` = still on the supported line, no
    // ceiling. A k3s bump to a minor that is not listed fails HERE, on purpose:
    // the new row has to be read off upstream's matrix, not guessed.
    const UPSTREAM_K8S_CEILING: Record<string, string | null> = {
      '1.29': 'v2.13.0',
      '1.30': 'v2.17.0',
      '1.31': 'v2.18.1',
      '1.32': 'v2.20.2',
      '1.33': null,
      '1.34': null,
      '1.35': null,
      '1.36': null,
    };
    const k3sMinor = read('src/lib/deploy/k8s/k3s.js').match(
      /K3S_VERSION = 'v(\d+\.\d+)\.\d+\+k3s\d+'/,
    )?.[1];
    expect(k3sMinor, 'no K3S_VERSION pin found in k3s.js').toBeDefined();
    expect(
      Object.keys(UPSTREAM_K8S_CEILING),
      `k3s is pinned at v${k3sMinor} — add that row from upstream's version policy ` +
        'and re-derive the CSI pin + sidecar tags for it',
    ).toContain(k3sMinor);

    // The FLOOR is what makes master-init.sh's HCLOUD_VOLUME_EXTRA_LABELS line
    // real: volume labelling landed in v2.14.0, which upstream says not to
    // install ("install v2.15.0 or later instead"). Below v2.15.0 that line is
    // a silent no-op and CSI volumes leak unattributed (RCA 2026-08-05, #236).
    expect(
      compareVersions(HETZNER_CSI_VERSION, 'v2.15.0'),
      `${HETZNER_CSI_VERSION} is below v2.15.0 — HCLOUD_VOLUME_EXTRA_LABELS would be a no-op`,
    ).toBeGreaterThanOrEqual(0);

    const ceiling = UPSTREAM_K8S_CEILING[k3sMinor as string];
    if (ceiling) {
      expect(
        compareVersions(HETZNER_CSI_VERSION, ceiling),
        `${HETZNER_CSI_VERSION} is past ${ceiling}, the newest csi-driver upstream ` +
          `supports on Kubernetes v${k3sMinor}`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it('hetzner: cloud-init still stamps the project label the bumped driver honours', () => {
    // The env var only became load-bearing WITH the bump (v2.9.0's controller
    // read exactly one env var, HCLOUD_VOLUME_DEFAULT_LOCATION). Deleting this
    // line now would re-open the leak that #236 backstopped: destroy.js's
    // `project-label` match and the sweep both key off it.
    const initScript = read('carbon/cloud-init/k3s/master-init.sh');
    // Escaped `\${` so this asserts the cloud-init PLACEHOLDER, not a value.
    expect(initScript).toContain(`HCLOUD_VOLUME_EXTRA_LABELS="project=\${project_name}"`);
    expect(initScript).toContain('deployment/hcloud-csi-controller');
  });

  it.each(['hetzner', 'digitalocean'] as const)(
    '%s: re-pins EVERY registry.k8s.io container upstream ships, and no other',
    (provider) => {
      const upstream = UPSTREAM_CSI_MANIFESTS[provider].workloads as Record<
        string,
        Record<string, string>
      >;
      // What upstream ships from registry.k8s.io, flattened to workload/container.
      const expectedSites = Object.entries(upstream).flatMap(([workload, containers]) =>
        Object.entries(containers)
          .filter(([, image]) => image.startsWith('registry.k8s.io/'))
          .map(([container]) => `${workload} ${container}`),
      );
      const specSites = CSI_SIDECAR_MIRRORS[provider].flatMap(({ workload, containers }) =>
        Object.keys(containers).map((container) => `${workload} ${container}`),
      );
      expect(specSites.sort()).toEqual(expectedSites.sort());
    },
  );

  it.each(['hetzner', 'digitalocean'] as const)(
    '%s: each re-pin carries upstream’s exact tag (same bits, different host)',
    (provider) => {
      const upstream = UPSTREAM_CSI_MANIFESTS[provider].workloads as Record<
        string,
        Record<string, string>
      >;
      for (const { workload, containers } of CSI_SIDECAR_MIRRORS[provider]) {
        for (const [container, image] of Object.entries(containers)) {
          expect(upstreamRef(image), `${workload}/${container}`).toBe(
            upstream[workload][container],
          );
        }
      }
    },
  );

  it('every re-pinned image is actually in the mirror set', () => {
    // A re-pin pointing at a package the publish workflow never mirrors is
    // strictly worse than no re-pin: ImagePullBackOff on a 404 instead of a
    // working upstream pull.
    const mirrored = new Set(MIRRORED_IMAGES.map(upstreamRef));
    for (const specs of Object.values(CSI_SIDECAR_MIRRORS)) {
      for (const { workload, containers } of specs) {
        for (const [container, image] of Object.entries(containers)) {
          expect(mirrored, `${workload}/${container} is not mirrored`).toContain(
            upstreamRef(image),
          );
        }
      }
    }
  });

  it('workload names agree with each provider’s K8S_ASSETS.csiNodeDaemonSet', () => {
    // scale.js waits on this exact DaemonSet after a resize; if our re-pin
    // addressed a differently-named workload, one of the two would be wrong.
    for (const [providerId, specs] of Object.entries(CSI_SIDECAR_MIRRORS)) {
      const assets = (PROVIDERS as Record<string, { K8S_ASSETS: { csiNodeDaemonSet: string } }>)[
        providerId
      ].K8S_ASSETS;
      const workloads = specs.map((s) => s.workload);
      expect(workloads).toContain(assets.csiNodeDaemonSet);
    }
  });

  it('covers every provider that has a CSI node DaemonSet', () => {
    for (const [providerId, ProviderClass] of Object.entries(PROVIDERS)) {
      const daemonSet = (ProviderClass as unknown as { K8S_ASSETS: { csiNodeDaemonSet: string } })
        .K8S_ASSETS.csiNodeDaemonSet;
      if (!daemonSet) continue;
      expect(
        CSI_SIDECAR_MIRRORS[providerId as keyof typeof CSI_SIDECAR_MIRRORS],
        `provider ${providerId} installs a CSI driver but has no sidecar mirror spec`,
      ).toBeDefined();
    }
  });
});

describe('csiSidecarSetImagePlan()', () => {
  it('emits kubectl `set image` args pointing at the mirrors or an in-place pin, all by digest', () => {
    for (const providerId of Object.keys(CSI_SIDECAR_MIRRORS)) {
      const plan = csiSidecarSetImagePlan(providerId);
      expect(plan.length).toBeGreaterThan(0);
      const inPlace = new Set(
        (CSI_UPSTREAM_IMAGE_PINS[providerId as keyof typeof CSI_UPSTREAM_IMAGE_PINS] ?? []).flatMap(
          ({ containers }) => Object.entries(containers).map(([c, ref]) => `${c}=${ref}`),
        ),
      );
      for (const { workload, setImageArgs } of plan) {
        expect(workload).toMatch(/^(daemonset|deployment|statefulset)\//);
        expect(setImageArgs.length).toBeGreaterThan(0);
        for (const arg of setImageArgs) {
          expect(arg).toMatch(/@sha256:[a-f0-9]{64}$/);
          expect(arg).not.toContain('registry.k8s.io');
          if (inPlace.has(arg)) continue;
          expect(arg).toMatch(
            /^[a-z0-9-]+=ghcr\.io\/hyperformant\/[a-z0-9-]+:[\w.-]+@sha256:[a-f0-9]{64}$/,
          );
        }
      }
    }
  });

  it('re-pins DO’s floating alpine:3 init container in the same call as its node sidecar', () => {
    // Upstream's driver.yaml ships `automount-udev-deleter` as bare alpine:3.
    // It needs no mirror (Docker Hub, not registry.k8s.io), only a pin, and it
    // rides the csi-do-node `set image` that already happens.
    const upstream = UPSTREAM_CSI_MANIFESTS.digitalocean.workloads['daemonset/csi-do-node'];
    expect(upstream['automount-udev-deleter']).toBe('alpine:3');
    const node = csiSidecarSetImagePlan('digitalocean').filter(
      (p) => p.workload === 'daemonset/csi-do-node',
    );
    expect(node).toHaveLength(1);
    const arg = node[0].setImageArgs.find((a) => a.startsWith('automount-udev-deleter='));
    expect(arg).toMatch(/^automount-udev-deleter=alpine:3\.\d+\.\d+@sha256:[a-f0-9]{64}$/);
    // Every in-place pin addresses a container upstream actually ships.
    for (const [provider, specs] of Object.entries(CSI_UPSTREAM_IMAGE_PINS)) {
      const workloads = UPSTREAM_CSI_MANIFESTS[provider as keyof typeof UPSTREAM_CSI_MANIFESTS]
        .workloads as Record<string, Record<string, string>>;
      for (const { workload, containers } of specs) {
        for (const container of Object.keys(containers)) {
          expect(workloads[workload], `${provider} ${workload}`).toHaveProperty(container);
        }
      }
    }
  });

  it('is a no-op for a provider with no CSI spec (never throws mid-deploy)', () => {
    // applyK3sManifests runs this unconditionally; an unknown provider must
    // degrade to "do nothing", not fail a deploy.
    expect(csiSidecarSetImagePlan('some-future-provider')).toEqual([]);
    expect(csiSidecarSetImagePlan(undefined)).toEqual([]);
  });
});

describe('applyK3sManifests re-pins the CSI sidecars before the db StatefulSet is applied', () => {
  const whole = read('src/lib/deploy/k8s/k3s.js');
  // Scoped to applyK3sManifests' BODY: `renderK8sBase` is also defined
  // earlier in this file, and ordering assertions against the definition
  // rather than the call site would pass while proving nothing.
  const bodyStart = whole.indexOf('export async function applyK3sManifests({');
  const k3s = whole.slice(bodyStart);

  it('found the applyK3sManifests body to reason about', () => {
    expect(bodyStart).toBeGreaterThan(-1);
    expect(k3s).toContain('renderK8sBase(');
  });

  it('imports the plan builder from images.js', () => {
    expect(whole).toMatch(
      /import \{[^}]*csiSidecarSetImagePlan[^}]*\} from '\.\.\/\.\.\/images\.js'/,
    );
  });

  it('issues one `kubectl set image` per planned workload, in kube-system', () => {
    const call = k3s.match(/csiSidecarSetImagePlan\(providerId\)[\s\S]{0,900}?\n {2}\}/)?.[0];
    expect(call, 'no csiSidecarSetImagePlan(providerId) loop found in k3s.js').toBeDefined();
    expect(call).toMatch(/'kube-system'/);
    expect(call).toMatch(/'set',\s*\n?\s*'image'/);
    expect(call).toMatch(/\.\.\.setImageArgs/);
  });

  it('runs BEFORE the db StatefulSet is applied — the PVC it unblocks is the db’s', () => {
    // The 2026-08-05 incident died in the db install's wait: the db PVC could
    // not provision because the node plugin never registered. Re-pinning after
    // that point would fix nothing.
    const repinAt = k3s.indexOf('csiSidecarSetImagePlan(providerId)');
    const helmAt = k3s.indexOf('renderK8sBase(');
    expect(repinAt).toBeGreaterThan(-1);
    expect(helmAt).toBeGreaterThan(-1);
    expect(repinAt).toBeLessThan(helmAt);
  });

  it('runs before the cert-manager install too — earliest useful point', () => {
    // CSI registration is asynchronous: the DaemonSet rollout wants to overlap
    // with the ~minutes of cert-manager + traefik work that follow, not queue
    // behind it.
    const repinAt = k3s.indexOf('csiSidecarSetImagePlan(providerId)');
    const certManagerAt = k3s.indexOf("runKubectlWithRetry(['apply', '-f', CERT_MANAGER_URL]");
    expect(certManagerAt).toBeGreaterThan(-1);
    expect(repinAt).toBeLessThan(certManagerAt);
  });
});

describe('every consuming reference resolves through the mirror', () => {
  it('the e2e scale-trigger workload builds its image ref from images.js', () => {
    // Not a literal: this file is the one that proves the mirror works on a
    // real node, so it must pull the ref from the same constant the deploy does.
    const lifecycle = read('tests/e2e/scenarios/_run-lifecycle.ts');
    expect(lifecycle).toMatch(/import \{[^}]*pauseImageRef[^}]*\} from '.*images\.js'/);
    expect(lifecycle).toMatch(/image: \$\{pauseImageRef\(\)\}/);
  });

  it('no deploy-facing file references registry.k8s.io outside a comment', () => {
    // src/lib/images.js is the ONE place the upstream host may appear as a
    // literal — it is the mirror set's source of truth. Anywhere else it is a
    // pull that bypasses the mirror, i.e. the 403 back on the deploy path.
    // (Docs and plans are excluded on purpose: they narrate the incidents and
    // MUST be free to name the upstream refs.)
    const offenders: string[] = [];
    const files = sweepFiles();
    // Not vacuous: the listing reaches the manifests and the deploy code.
    expect(files).toContain(join('carbon', 'k8s', 'base', 'db', 'statefulset.yaml'));
    expect(files).toContain(join('src', 'lib', 'deploy', 'k8s', 'k3s.js'));
    expect(files.some((f) => f.split(sep).includes('node_modules'))).toBe(false);
    for (const rel of files) {
      if (rel === join('src', 'lib', 'images.js')) continue;
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          if (!namesHost(line, 'registry.k8s.io')) return;
          if (/^\s*(#|\/\/|\*|-\s*#)/.test(line)) return; // comments may name it
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders, 'these sites bypass the ghcr mirror').toEqual([]);
  });
});

describe('publish workflow mirrors exactly the set', () => {
  const workflow = read(WORKFLOW);
  // Executable YAML only; comments are where the reasoning lives.
  const code = workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

  it('generates its matrix by running the checked-in generator script', () => {
    // The generator is a real file rather than an inline `node -e`, precisely
    // so this test can execute THE SAME program the workflow does instead of a
    // paraphrase of it.
    expect(code).toContain(`node ${MATRIX_SCRIPT}`);
  });

  it('the generator emits one src/dst/digest entry per mirror-set entry', () => {
    const out = execFileSync('node', [join(ROOT, MATRIX_SCRIPT)], { encoding: 'utf8' });
    const matrix = JSON.parse(out);
    expect(matrix).toEqual(
      MIRRORED_IMAGES.map((image) => ({
        src: upstreamRef(image),
        dst: k8sMirrorTagRef(image),
        digest: image.digest,
        index: image.index ?? '',
      })),
    );
    // Docker Hub mirrors ride the same matrix: the copy reads docker.io.
    expect(matrix).toContainEqual({
      src: 'docker.io/library/traefik:v3.6.11',
      dst: 'ghcr.io/hyperformant/traefik:v3.6.11',
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      index: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    // Every destination is a distinct tag under the org — the mirror job runs
    // one matrix leg per entry and must never have two legs racing one ref.
    const dsts = matrix.map((m: { dst: string }) => m.dst);
    expect(dsts).toEqual([...new Set(dsts)]);
  });

  it('copies manifests — never rebuilds, never multi-arch', () => {
    expect(code).toMatch(/docker buildx imagetools create/);
    expect(code).toMatch(/architecture\s*==\s*"amd64"/);
    expect(code).not.toMatch(/arm64|aarch64/);
    expect(code).not.toMatch(/mirror-cluster-autoscaler/); // folded into the matrix
  });

  it('every job is bound to the environment holding the ghcr PAT', () => {
    const jobEnvironments = [...workflow.matchAll(/^\s{4}environment:\s*(\S+)/gm)].map((m) => m[1]);
    expect(jobEnvironments.length).toBeGreaterThanOrEqual(2);
    for (const env of jobEnvironments) expect(env).toBe('e2e-infra');
  });

  it('the mirror job logs in to Docker Hub with the CI credential before copying', () => {
    const steps = (workflow.split('  mirror-upstream-images:')[1] ?? '').split(
      '\n  mirror-upstream-drift:',
    )[0];
    const hub = steps.indexOf('vars.DOCKER_HUB_USERNAME');
    expect(hub).toBeGreaterThan(-1);
    expect(steps).toContain('secrets.DOCKER_HUB_TOKEN');
    expect(hub).toBeLessThan(steps.indexOf('imagetools create'));
  });

  it('a weekly drift job reports newer upstream tags and never publishes', () => {
    const wf = loadYaml(workflow) as {
      on: { schedule?: Array<{ cron: string }> };
      jobs: Record<
        string,
        { if?: string; permissions?: unknown; environment?: string; steps: Array<{ run?: string }> }
      >;
    };
    expect(wf.on.schedule?.length).toBe(1);
    const drift = wf.jobs['mirror-upstream-drift'];
    // Schedule only: its lookup failure must never turn a dispatched publish red.
    expect(drift.if).toBe("github.event_name == 'schedule'");
    // Least privilege: read the repo, write issues, nothing else.
    expect(drift.permissions).toEqual({ contents: 'read', issues: 'write' });
    expect(drift.environment).toBeUndefined();
    const runs = drift.steps.map((st) => st.run ?? '').join('\n');
    expect(runs).toMatch(/node scripts\/mirror-drift\.mjs > "\$RUNNER_TEMP\/drift\.md"/);
    expect(runs).toContain('$GITHUB_STEP_SUMMARY');
    // A failed lookup still reaches the summary, then fails the job.
    expect(runs).toMatch(
      /drift\.md" \|\| rc=\$\?\n\s*cat "\$RUNNER_TEMP\/drift\.md" >> "\$GITHUB_STEP_SUMMARY"\n\s*exit "\$rc"/,
    );
    // One issue, fixed title: updated when open, created otherwise, untouched
    // when the report carries the no-drift marker.
    expect(runs).toContain(`grep -q '^${NO_DRIFT_MARKER}$'`);
    expect(runs).toMatch(/gh issue edit "\$NUM" --body-file/);
    expect(runs).toMatch(/gh issue create --title "\$TITLE" --body-file/);
    expect(runs).toContain('map(select(.title == env.TITLE))[0].number');
    // A schedule must never push to ghcr: every other job skips it.
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === 'mirror-upstream-drift' || name === 'mirror-upstream-images') continue;
      expect(job.if, name).toBe("github.event_name != 'schedule'");
    }
    // mirror-upstream-images needs mirror-matrix, so it skips with it.
    expect(code).toMatch(/mirror-upstream-images:\n\s+needs: mirror-matrix/);
  });

  it('the drift report holds back tags we must not take, and marks a report with nothing to take', () => {
    const k3s = readK3sVersion();
    expect(k3s).toMatch(/^v1\.\d+\.\d+\+k3s\d+$/);
    const [, minor] = k3s.replace(/^v/, '').split('.').map(Number);
    const kubectl = holdFor(ALPINE_K8S_MIRROR, k3s);
    expect(kubectl?.allows(`1.${minor + 1}.0`)).toBe(true);
    expect(kubectl?.allows(`1.${minor + 2}.0`)).toBe(false);
    const registry = holdFor(REGISTRY_MIRROR, k3s);
    expect(registry?.allows('2.8.4')).toBe(true);
    expect(registry?.allows('3.0.0')).toBe(false);
    for (const image of K3S_SYSTEM_IMAGE_MIRRORS)
      expect(holdFor(image, k3s)?.allows('9.9.9')).toBe(false);
    for (const spec of CSI_SIDECAR_MIRRORS.hetzner) {
      for (const image of Object.values(spec.containers))
        expect(holdFor(image, k3s)?.allows('v99.0.0')).toBe(false);
    }
    expect(holdFor(TRAEFIK_MIRROR, k3s)).toBeNull();
    const none = renderReport([
      { upstream: 'docker.io/library/traefik', pinned: 'v3.6.11', newer: [], hold: null },
    ]);
    expect(none).toContain(NO_DRIFT_MARKER);
    const some = renderReport([
      { upstream: 'docker.io/library/traefik', pinned: 'v3.6.11', newer: ['v3.6.12'], hold: null },
      {
        upstream: 'docker.io/library/registry',
        pinned: '2.8.3',
        newer: [],
        hold: 'registry stays on 2.x',
      },
    ]);
    expect(some).not.toContain(NO_DRIFT_MARKER);
    expect(some).toContain('| docker.io/library/traefik | v3.6.11 | v3.6.12 |');
    expect(some).toContain('- docker.io/library/registry (2.8.3): registry stays on 2.x');
    // A lookup failure is a row, never a silent "no drift".
    const failed = renderReport([
      { upstream: 'x/y', pinned: '1.0', newer: [], hold: null, error: '503' },
    ]);
    expect(failed).not.toContain(NO_DRIFT_MARKER);
  });

  it('the mirror leg reads the child from the pinned index, skips when already mirrored, and checks the tag', () => {
    const leg = code.slice(
      code.indexOf('mirror-upstream-images:'),
      code.indexOf('mirror-upstream-drift:'),
    );
    expect(leg).toMatch(/INDEX: \$\{\{ matrix\.index \}\}/);
    expect(leg).toMatch(/READ="\$\{SRC%:\*\}@\$INDEX"/);
    expect(leg).toMatch(/DIGEST=\$\(amd64_child "\$READ"\)/);
    // Idempotent: a re-run that finds $DST@$PINNED (and the tag naming it)
    // exits before any upstream read.
    const skip = leg.indexOf('nothing to copy');
    expect(leg).toMatch(/imagetools inspect "\$DST@\$PINNED" > \/dev\/null 2>&1/);
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(leg.indexOf('READ="$SRC"'));
    // The verify step: the ghcr TAG's amd64 child is the pin (k3s pulls by tag).
    expect(leg).toMatch(/TAGGED=\$\(docker buildx imagetools inspect --raw "\$DST"/);
    expect(leg).toContain('if [ "$TAGGED" != "$PINNED" ]; then');
  });

  it('every Docker Hub entry pins its upstream index (tags there move)', () => {
    for (const image of DOCKERHUB_MIRRORS) {
      expect(image.index, image.repo).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(image.index).not.toBe(image.digest);
    }
    // socat keeps the bits pinned before the mirror: the old index and its child.
    const socat = DOCKERHUB_MIRRORS.find((i) => i.repo === 'alpine/socat');
    expect(socat?.index).toBe(
      'sha256:fb3862c949af7c79996d0e514ee96128644d840835ed5368eeecb14a869de361',
    );
    expect(socat?.digest).toBe(
      'sha256:99316fc7e1e8b5f40308105c54c9bed5a45891acee6480e8f0f9d2f4e69dee02',
    );
  });

  it('the drift filter keeps only same-shape tags newer than the pin', () => {
    expect(
      newerTags('v3.6.11', ['v3.6.10', 'v3.6.12', 'v3.7.0', '3.6.13', 'v3.6.12-rc1', 'latest']),
    ).toEqual(['v3.6.12', 'v3.7.0']);
    expect(newerTags('1.8.1.3', ['1.8.1.4', '1.8.2', '1.8.1.3', '1.10.0.0'])).toEqual([
      '1.8.1.4',
      '1.10.0.0',
    ]);
    expect(newerTags('3.6', ['3.10', '3.7', '3.6.1'])).toEqual(['3.7', '3.10']);
    expect(newerTags('main', ['v1'])).toEqual([]);
  });

  it('re-runs on any change to the mirror set or its generator', () => {
    const paths = workflow.match(/paths:\n([\s\S]*?)\n {2}workflow_dispatch/)?.[1] ?? '';
    expect(paths).toContain('src/lib/images.js');
    expect(paths).toContain(MATRIX_SCRIPT);
  });
});

/** `vX.Y.Z` ordering: <0 when a precedes b, 0 when equal, >0 when a follows b. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Every deploy-facing source file, for the registry.k8s.io sweep above. Unit
 * tests are excluded (this file names the upstream refs in its own fixture);
 * docs and plans are excluded because they narrate the incidents. Listed by
 * git (tracked plus untracked-not-ignored), so a new file is swept before its
 * first commit and carbon/node_modules is never walked.
 */
function sweepFiles(): string[] {
  const dirs = ['src', 'carbon', 'scripts', 'tests/e2e', '.github/workflows'];
  const exts = new Set(['.js', '.mjs', '.ts', '.yaml', '.yml', '.json', '.sh']);
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...dirs],
    { cwd: ROOT, encoding: 'utf-8' },
  )
    .split('\n')
    .filter((rel) => rel && exts.has(extname(rel)) && existsSync(join(ROOT, rel)))
    .map((rel) => rel.split('/').join(sep));
}
