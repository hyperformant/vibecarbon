/**
 * Drift guards for the registry.k8s.io -> ghcr mirror set (src/lib/images.js,
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
 *  (a) the mirror set's shape — flat under the org, tags never digests, no dupes;
 *  (b) the CSI sidecar re-pin spec matches the CSI driver versions cloud-init
 *      actually installs (a version bump there without re-deriving the sidecar
 *      tags here would silently re-open the 403);
 *  (c) every re-pinned image is in the mirror set (nothing points at a package
 *      the publish workflow never mirrors);
 *  (d) no deploy-facing file references registry.k8s.io outside a comment;
 *  (e) the workflow mirrors exactly the set, via the same generator this test runs.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CSI_SIDECAR_MIRRORS,
  clusterAutoscalerImageRef,
  clusterAutoscalerUpstreamRef,
  csiSidecarSetImagePlan,
  DO_CSI_VERSION,
  HETZNER_CSI_VERSION,
  K8S_MIRROR_ORG,
  K8S_UPSTREAM_REGISTRY,
  k8sMirrorRef,
  k8sUpstreamRef,
  MIRRORED_K8S_IMAGES,
  mirroredK8sPackageNames,
  pauseImageRef,
} from '../../../src/lib/images.js';
import { PROVIDERS } from '../../../src/lib/providers/index.js';

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
  it('every entry mirrors registry.k8s.io into our ghcr org', () => {
    expect(MIRRORED_K8S_IMAGES.length).toBeGreaterThanOrEqual(12);
    for (const image of MIRRORED_K8S_IMAGES) {
      expect(k8sUpstreamRef(image)).toBe(`${K8S_UPSTREAM_REGISTRY}/${image.repo}:${image.tag}`);
      expect(k8sUpstreamRef(image)).toMatch(/^registry\.k8s\.io\//);
      expect(k8sMirrorRef(image)).toMatch(/^ghcr\.io\/hyperformant\//);
    }
  });

  it('mirror targets are FLAT under the org — upstream basename, upstream tag', () => {
    // The cluster-autoscaler precedent (#222): `autoscaling/cluster-autoscaler`
    // mirrors to `ghcr.io/hyperformant/cluster-autoscaler`, NOT to a nested
    // `.../autoscaling/cluster-autoscaler`. ghcr has no nested-path packages;
    // a slash in the name would create a package nobody can flip public.
    for (const image of MIRRORED_K8S_IMAGES) {
      const mirror = k8sMirrorRef(image);
      const afterOrg = mirror.slice(`${K8S_MIRROR_ORG}/`.length);
      expect(afterOrg).not.toContain('/');
      const basename = image.repo.slice(image.repo.lastIndexOf('/') + 1);
      expect(afterOrg).toBe(`${basename}:${image.tag}`);
    }
  });

  it('tags never diverge from upstream, and are never digest pins', () => {
    // The mirror is a digest-preserving manifest copy, so `v2.15.0` on ghcr
    // must mean the same bits as `v2.15.0` upstream. One tag field feeds both
    // refs, which is what makes that structurally true.
    for (const image of MIRRORED_K8S_IMAGES) {
      expect(image.tag).not.toContain('@');
      expect(k8sMirrorRef(image)).not.toContain('@sha256:');
      expect(k8sMirrorRef(image).split(':').pop()).toBe(k8sUpstreamRef(image).split(':').pop());
    }
  });

  it('has no duplicate (repo, tag) entries', () => {
    const refs = MIRRORED_K8S_IMAGES.map(k8sUpstreamRef);
    expect(refs).toEqual([...new Set(refs)]);
  });

  it('two packages legitimately carry MORE than one tag (Hetzner + DO disagree)', () => {
    // csi-provisioner is v6.0.0 on Hetzner and v6.2.0 on DO, etc. A dedupe
    // that collapsed by package NAME would drop one provider's tag and
    // reintroduce the 403 on that provider only — the nastiest possible shape.
    const byName = new Map<string, Set<string>>();
    for (const image of MIRRORED_K8S_IMAGES) {
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

  it('mirroredK8sPackageNames() is the operator’s public-flip checklist', () => {
    // Every name here is a ghcr package that must be flipped PUBLIC by hand
    // after the first publish run — k3s nodes pull anonymously.
    const names = mirroredK8sPackageNames();
    expect(names).toEqual([...new Set(names)].sort());
    expect(names).toEqual([
      'cluster-autoscaler',
      'csi-attacher',
      'csi-node-driver-registrar',
      'csi-provisioner',
      'csi-resizer',
      'csi-snapshotter',
      'livenessprobe',
      'pause',
    ]);
  });

  it('folds in the cluster-autoscaler mirror #222 already proved', () => {
    // CA keeps its own named constants (deploy code references them directly),
    // but it must be mirrored by the SAME job as everything else — one
    // mechanism, not two. These assertions are what keep the list entry and
    // the named constants from drifting apart.
    const ca = MIRRORED_K8S_IMAGES.filter((i) => i.repo === 'autoscaling/cluster-autoscaler');
    expect(ca).toHaveLength(1);
    expect(k8sUpstreamRef(ca[0])).toBe(clusterAutoscalerUpstreamRef());
    expect(k8sMirrorRef(ca[0])).toBe(clusterAutoscalerImageRef());
  });

  it('mirrors pause — the scale-trigger + local-overlay placeholder image', () => {
    expect(pauseImageRef()).toBe('ghcr.io/hyperformant/pause:3.9');
    expect(MIRRORED_K8S_IMAGES.some((i) => i.repo === 'pause' && i.tag === '3.9')).toBe(true);
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
          expect(k8sUpstreamRef(image), `${workload}/${container}`).toBe(
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
    const mirrored = new Set(MIRRORED_K8S_IMAGES.map(k8sUpstreamRef));
    for (const specs of Object.values(CSI_SIDECAR_MIRRORS)) {
      for (const { workload, containers } of specs) {
        for (const [container, image] of Object.entries(containers)) {
          expect(mirrored, `${workload}/${container} is not mirrored`).toContain(
            k8sUpstreamRef(image),
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
  it('emits kubectl `set image` args pointing only at the mirrors', () => {
    for (const providerId of Object.keys(CSI_SIDECAR_MIRRORS)) {
      const plan = csiSidecarSetImagePlan(providerId);
      expect(plan.length).toBeGreaterThan(0);
      for (const { workload, setImageArgs } of plan) {
        expect(workload).toMatch(/^(daemonset|deployment|statefulset)\//);
        expect(setImageArgs.length).toBeGreaterThan(0);
        for (const arg of setImageArgs) {
          expect(arg).toMatch(/^[a-z0-9-]+=ghcr\.io\/hyperformant\/[a-z0-9-]+:[\w.-]+$/);
          expect(arg).not.toContain('registry.k8s.io');
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

describe('applyK3sManifests re-pins the CSI sidecars before Supabase installs', () => {
  const whole = read('src/lib/deploy/k8s/k3s.js');
  // Scoped to applyK3sManifests' BODY: `installSupabase` is also defined
  // earlier in this file, and ordering assertions against the definition
  // rather than the call site would pass while proving nothing.
  const bodyStart = whole.indexOf('export async function applyK3sManifests({');
  const k3s = whole.slice(bodyStart);

  it('found the applyK3sManifests body to reason about', () => {
    expect(bodyStart).toBeGreaterThan(-1);
    expect(k3s).toContain('installSupabase({');
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

  it('runs BEFORE installSupabase — the PVCs it unblocks are that helm release’s', () => {
    // The 2026-08-05 incident died in `helm upgrade --wait`: the db PVC could
    // not provision because the node plugin never registered. Re-pinning after
    // that point would fix nothing.
    const repinAt = k3s.indexOf('csiSidecarSetImagePlan(providerId)');
    const helmAt = k3s.indexOf('installSupabase({');
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
  it('the local overlay’s placeholder app image is the mirrored pause', () => {
    expect(read('carbon/k8s/overlays/local/kustomization.yaml')).toContain(
      `value: ${pauseImageRef()}`,
    );
  });

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
    for (const rel of sweepFiles()) {
      if (rel === join('src', 'lib', 'images.js')) continue;
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          if (!line.includes('registry.k8s.io')) return;
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

  it('the generator emits one src/dst pair per mirror-set entry', () => {
    const out = execFileSync('node', [join(ROOT, MATRIX_SCRIPT)], { encoding: 'utf8' });
    const matrix = JSON.parse(out);
    expect(matrix).toEqual(
      MIRRORED_K8S_IMAGES.map((image) => ({
        src: k8sUpstreamRef(image),
        dst: k8sMirrorRef(image),
      })),
    );
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
 * docs and plans are excluded because they narrate the incidents.
 */
function sweepFiles(): string[] {
  const dirs = ['src', 'carbon', 'scripts', join('tests', 'e2e'), join('.github', 'workflows')];
  const exts = new Set(['.js', '.mjs', '.ts', '.yaml', '.yml', '.json', '.sh']);
  const files: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = relative(ROOT, join(entry.parentPath, entry.name));
      if (rel.split(sep).includes('node_modules')) continue;
      if (!exts.has(extname(entry.name))) continue;
      files.push(rel);
    }
  }
  return files;
}
