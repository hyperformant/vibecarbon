/**
 * Image digest census: every container image ref this repo ships is pinned
 * as `name:tag@sha256:<digest>`, so a floating tag (`latest`, `alpine:3`,
 * `registry:2`) can never decide which bits run, and a retagged upstream
 * cannot reach a server unreviewed. The tag stays for humans (and for
 * Dependabot, which reads it to propose bumps); the digest is what pulls.
 *
 * Swept, wherever an image ref can live:
 *   - compose files (template, add-on services, the ACME isolation harness)
 *   - Kubernetes manifests and Helm values (carbon/k8s, services/STAR/k8s),
 *     including kustomize `newTag:` overrides
 *   - cloud-init (carbon/cloud-init): `image:` lines and docker/ctr pulls
 *   - every Dockerfile: FROM lines and `ARG *_IMAGE=` defaults
 *   - GitHub workflows: job containers, service containers, `docker://` steps
 *   - JavaScript: the ref constants in src/lib/images.js and the other modules
 *     that hold one (registered below), plus a sweep of src/ for `image:` YAML
 *     lines in template literals and `--image=` arguments, so a new
 *     hard-coded ref cannot appear unregistered.
 *
 * ALLOWLIST: refs that cannot carry a digest at commit time, each with its
 * reason. Keep it this small. Everything third-party is pinned.
 *
 * Dependabot reach (.github/dependabot.yml) is asserted at the bottom: every
 * directory holding a pinned ref is watched, and the JS-held pins are
 * mirrored byte-for-byte in .github/image-pins/Dockerfile so Dependabot can
 * propose their bumps too.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SOCAT_IMAGE } from '../../../src/lib/deploy/compose/ha.js';
import { REGISTRY_IMAGE } from '../../../src/lib/deploy/compose/registry-config.js';
import {
  CSI_SIDECAR_MIRRORS,
  CSI_UPSTREAM_IMAGE_PINS,
  carbonAutoscalerImageRef,
  clusterAutoscalerImageRef,
  csiSidecarSetImagePlan,
  DIAG_BUSYBOX_IMAGE,
  DIAG_NETSHOOT_IMAGE,
  dbImageRef,
  k8sMirrorRef,
  MIRRORED_K8S_IMAGES,
  pauseImageRef,
} from '../../../src/lib/images.js';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const gitFiles = (...pathspecs: string[]) =>
  execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);

/** `name[:tag]@sha256:<64 hex>`: the one accepted shape. */
const PINNED = /^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/;

/**
 * Refs that deliberately carry no digest. Each is produced by a build whose
 * digest does not exist until after the commit that names it.
 */
const ALLOWLIST: Record<string, string> = {
  // The generated project's own app image: built by the project's CI (or on
  // the server) from its own code on every push, so its digest is new every
  // deploy and the deploy flow sets the exact image it just built.
  'ghcr.io/{{GITHUB_OWNER}}/{{PROJECT_NAME}}:main': 'project-built app image',
  '${APP_IMAGE:-ghcr.io/{{GITHUB_OWNER}}/{{PROJECT_NAME}}:latest}': 'project-built app image',
  'newTag: main': 'project-built app image (kustomize override)',
  // vibecarbon's db image: built from docker/postgres-walg by
  // publish-db-image.yml AFTER the commit that names the tag merges. The tag
  // is revisioned (-r<N>, moved whenever an input changes, enforced by
  // db-image-fingerprint.test.ts), so a tag names one build.
  '${DB_IMAGE:?DB_IMAGE missing, run vibecarbon upgrade to write it to .env}:${DB_IMAGE_TAG:?DB_IMAGE_TAG missing, run vibecarbon upgrade to write it to .env}':
    'db image, published by this repo after merge',
  '{{DB_IMAGE}}:{{DB_IMAGE_TAG}}': 'db image, published by this repo after merge',
  [dbImageRef()]: 'db image, published by this repo after merge',
  // The carbon-autoscaler sidecar: built by publish-images.yml AFTER merge at
  // the tag in src/lib/images.js, which must move with any content change.
  '{{CARBON_AUTOSCALER_IMAGE}}': 'carbon-autoscaler, published by this repo after merge',
  [carbonAutoscalerImageRef()]: 'carbon-autoscaler, published by this repo after merge',
};

type Site = { where: string; ref: string };

const isComment = (line: string) => /^\s*#/.test(line);
const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/** `image:` values (and kustomize `newTag:`) from a YAML-ish file, line-based. */
function yamlImageSites(rel: string): Site[] {
  const out: Site[] = [];
  read(rel)
    .split('\n')
    .forEach((line, i) => {
      if (isComment(line)) return;
      const img = line.match(/^\s*(?:-\s*)?image:\s*(\S.*?)\s*(?:#.*)?$/);
      if (img) out.push({ where: `${rel}:${i + 1}`, ref: unquote(img[1]) });
      const tag = line.match(/^\s*newTag:\s*(\S+)/);
      if (tag) out.push({ where: `${rel}:${i + 1}`, ref: `newTag: ${unquote(tag[1])}` });
    });
  return out;
}

const COMPOSE_FILES = gitFiles(
  'carbon/docker-compose*.yml',
  'services/*/compose/*.yml',
  'scripts/**/docker-compose*.yml',
);
const K8S_FILES = gitFiles('carbon/k8s/**/*.yaml', 'carbon/k8s/**/*.yml', 'services/*/k8s/*.yaml');
const CLOUD_INIT_FILES = gitFiles('carbon/cloud-init/**');
const DOCKERFILES = gitFiles('**/Dockerfile', '**/Dockerfile.*').filter(
  (f) => !f.includes('node_modules'),
);
const WORKFLOWS = gitFiles('.github/workflows/*.yml', 'carbon/.github/workflows/*.yml');

/** FROM refs and ARG *_IMAGE defaults; stage names, scratch and `${ARG}` are indirection. */
function dockerfileSites(rel: string): Site[] {
  const out: Site[] = [];
  const stages = new Set<string>();
  read(rel)
    .split('\n')
    .forEach((line, i) => {
      const from = line.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i);
      if (from) {
        const [, ref, stage] = from;
        if (stage) stages.add(stage);
        if (ref === 'scratch' || stages.has(ref) || ref.startsWith('${')) return;
        out.push({ where: `${rel}:${i + 1}`, ref });
      }
      const arg = line.match(/^ARG\s+(\w*IMAGE\w*)=(\S+)/);
      if (arg && !arg[2].startsWith('${')) out.push({ where: `${rel}:${i + 1}`, ref: arg[2] });
    });
  return out;
}

function cloudInitSites(rel: string): Site[] {
  const out = yamlImageSites(rel);
  read(rel)
    .split('\n')
    .forEach((line, i) => {
      if (isComment(line)) return;
      const pull = line.match(
        /\b(?:docker|nerdctl|crictl|ctr\b.*?images?)\s+pull\s+(?:-\S+\s+)*([^\s;&|]+)/,
      );
      if (pull) out.push({ where: `${rel}:${i + 1}`, ref: pull[1] });
    });
  return out;
}

/** Job containers, service containers and `docker://` step actions. */
function workflowSites(rel: string): Site[] {
  const doc = loadYaml(read(rel)) as {
    jobs?: Record<
      string,
      {
        container?: string | { image?: string };
        services?: Record<string, { image?: string }>;
        steps?: Array<{ uses?: string }>;
      }
    >;
  };
  const out: Site[] = [];
  for (const [name, job] of Object.entries(doc?.jobs ?? {})) {
    const container = typeof job.container === 'string' ? job.container : job.container?.image;
    if (container) out.push({ where: `${rel} jobs.${name}.container`, ref: container });
    for (const [svc, def] of Object.entries(job.services ?? {})) {
      if (def?.image) out.push({ where: `${rel} jobs.${name}.services.${svc}`, ref: def.image });
    }
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('docker://')) {
        out.push({ where: `${rel} jobs.${name} step`, ref: step.uses.slice('docker://'.length) });
      }
    }
  }
  return out;
}

/**
 * Every JS-held ref, evaluated (not grepped), by the name a src/ template
 * interpolates it under. A new constant must be registered here; the src/
 * sweep below fails on an interpolation it cannot resolve to this map.
 */
const JS_REFS: Record<string, string[]> = {
  SOCAT_IMAGE: [SOCAT_IMAGE],
  REGISTRY_IMAGE: [REGISTRY_IMAGE],
  DIAG_BUSYBOX_IMAGE: [DIAG_BUSYBOX_IMAGE],
  DIAG_NETSHOOT_IMAGE: [DIAG_NETSHOOT_IMAGE],
  'clusterAutoscalerImageRef()': [clusterAutoscalerImageRef()],
  'carbonAutoscalerImageRef()': [carbonAutoscalerImageRef()],
  'pauseImageRef()': [pauseImageRef()],
  'k8sMirrorRef(MIRRORED_K8S_IMAGES)': MIRRORED_K8S_IMAGES.map(k8sMirrorRef),
  'csiSidecarSetImagePlan()': Object.keys({ ...CSI_SIDECAR_MIRRORS, ...CSI_UPSTREAM_IMAGE_PINS })
    .flatMap((p) => csiSidecarSetImagePlan(p))
    .flatMap(({ setImageArgs }) => setImageArgs.map((a) => a.slice(a.indexOf('=') + 1))),
  'dbImageRef()': [dbImageRef()],
};

function jsSites(): Site[] {
  return Object.entries(JS_REFS).flatMap(([name, refs]) =>
    refs.map((ref) => ({ where: `js ${name}`, ref })),
  );
}

/** src/ lines that put an image into YAML or a CLI flag. */
function srcSweepSites(): Site[] {
  const out: Site[] = [];
  for (const rel of gitFiles('src/**/*.js', 'src/**/*.mjs')) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        // YAML inside a template literal: no quotes and no trailing comma,
        // which is what separates it from a JS `image: value,` property.
        const yaml = line.match(/^\s*(?:-\s*)?image:\s+([^'"\s,]+)\s*$/);
        const flag = line.match(/--image=([^'"`\s,]+)/);
        const value = yaml?.[1] ?? flag?.[1];
        if (value) out.push({ where: `${rel}:${i + 1}`, ref: value });
      });
  }
  return out;
}

const offenders = (sites: Site[]) =>
  sites
    .filter(({ ref }) => !PINNED.test(ref) && !(ref in ALLOWLIST))
    .map(({ where, ref }) => `${where}: ${ref}`);

describe('every shipped image ref is pinned by digest', () => {
  it('found the files it sweeps (a moved directory must not empty the census)', () => {
    expect(COMPOSE_FILES.length).toBeGreaterThanOrEqual(20);
    expect(K8S_FILES.length).toBeGreaterThanOrEqual(10);
    expect(CLOUD_INIT_FILES.length).toBeGreaterThan(0);
    expect(DOCKERFILES).toEqual(
      expect.arrayContaining([
        'carbon/Dockerfile',
        'docker/carbon-autoscaler/Dockerfile',
        'docker/postgres-walg/Dockerfile',
        'docker/wal-g/Dockerfile',
        '.github/image-pins/Dockerfile',
      ]),
    );
    expect(WORKFLOWS.length).toBeGreaterThan(5);
  });

  it('compose files', () => {
    const sites = COMPOSE_FILES.flatMap(yamlImageSites);
    expect(sites.length).toBeGreaterThan(10);
    expect(offenders(sites)).toEqual([]);
  });

  it('Kubernetes manifests and Helm values', () => {
    const sites = K8S_FILES.flatMap(yamlImageSites);
    expect(sites.length).toBeGreaterThan(5);
    expect(offenders(sites)).toEqual([]);
  });

  it('cloud-init', () => {
    expect(offenders(CLOUD_INIT_FILES.flatMap(cloudInitSites))).toEqual([]);
  });

  it('Dockerfiles', () => {
    const sites = DOCKERFILES.flatMap(dockerfileSites);
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(offenders(sites)).toEqual([]);
  });

  it('GitHub workflows', () => {
    expect(offenders(WORKFLOWS.flatMap(workflowSites))).toEqual([]);
  });

  it('JavaScript ref constants (src/lib/images.js and registered modules)', () => {
    expect(offenders(jsSites())).toEqual([]);
  });

  it('src/ has no image literal or interpolation outside the registered constants', () => {
    const known = new Set(Object.keys(JS_REFS));
    const unknown = srcSweepSites().filter(({ ref }) => {
      const interp = ref.match(/^\$\{([^}]+)\}$/);
      if (interp) return !known.has(interp[1]);
      return !PINNED.test(ref) && !(ref in ALLOWLIST);
    });
    expect(unknown.map(({ where, ref }) => `${where}: ${ref}`)).toEqual([]);
  });

  it('the allowlist holds only refs that still exist (no stale exemptions)', () => {
    const all = [
      ...COMPOSE_FILES.flatMap(yamlImageSites),
      ...K8S_FILES.flatMap(yamlImageSites),
      ...jsSites(),
    ].map((s) => s.ref);
    for (const ref of Object.keys(ALLOWLIST)) expect(all, ref).toContain(ref);
  });

  it('every pinned third-party ref resolves to a single index digest per name:tag', () => {
    // Two sites naming the same tag with different digests means one of them
    // was bumped and the other forgotten.
    const byTag = new Map<string, Set<string>>();
    const sites = [
      ...COMPOSE_FILES.flatMap(yamlImageSites),
      ...K8S_FILES.flatMap(yamlImageSites),
      ...DOCKERFILES.flatMap(dockerfileSites),
      ...jsSites(),
    ];
    for (const { ref } of sites) {
      if (!PINNED.test(ref)) continue;
      const [nameTag, digest] = ref.split('@');
      byTag.set(nameTag, (byTag.get(nameTag) ?? new Set()).add(digest));
    }
    const split = [...byTag].filter(([, d]) => d.size > 1).map(([t]) => t);
    expect(split).toEqual([]);
  });
});

describe('Dependabot can bump every pinned location', () => {
  const PINS_DOCKERFILE = '.github/image-pins/Dockerfile';
  const dependabot = loadYaml(read('.github/dependabot.yml')) as {
    updates: Array<{ 'package-ecosystem': string; directory?: string; directories?: string[] }>;
  };
  const dirsFor = (ecosystem: string) =>
    dependabot.updates
      .filter((u) => u['package-ecosystem'] === ecosystem)
      .flatMap((u) => u.directories ?? (u.directory ? [u.directory] : []));
  /** Dependabot directory globs (`*` = one path segment) as a matcher. */
  const covered = (globs: string[], dir: string) =>
    globs.some((g) =>
      new RegExp(`^${g.replace(/^\//, '').replace(/\./g, '\\.').replace(/\*/g, '[^/]+')}$`).test(
        dir,
      ),
    );

  it('the docker ecosystem watches every Dockerfile directory', () => {
    const dirs = dirsFor('docker');
    const missing = DOCKERFILES.map(dirname).filter((d) => !covered(dirs, d));
    expect(missing).toEqual([]);
  });

  it('the docker ecosystem watches every Kubernetes manifest directory with a pinned image', () => {
    const dirs = dirsFor('docker');
    const withPins = [
      ...new Set(
        K8S_FILES.filter((f) => yamlImageSites(f).some(({ ref }) => PINNED.test(ref))).map(dirname),
      ),
    ];
    expect(withPins.length).toBeGreaterThan(5);
    expect(withPins.filter((d) => !covered(dirs, d))).toEqual([]);
  });

  it('the docker-compose ecosystem watches every compose directory', () => {
    const dirs = dirsFor('docker-compose');
    const missing = [...new Set(COMPOSE_FILES.map(dirname))].filter((d) => !covered(dirs, d));
    expect(missing).toEqual([]);
  });

  it('github-actions is watched (workflow actions are SHA-pinned)', () => {
    expect(dirsFor('github-actions')).toContain('/');
  });

  it(`${PINS_DOCKERFILE} mirrors exactly the JS-held third-party pins`, () => {
    // JS constants are invisible to Dependabot. The never-built Dockerfile
    // carries the same refs so Dependabot proposes their bumps; this keeps
    // the two byte-identical in both directions.
    const fromPins = dockerfileSites(PINS_DOCKERFILE)
      .map((s) => s.ref)
      .sort();
    const jsThirdParty = [
      SOCAT_IMAGE,
      REGISTRY_IMAGE,
      DIAG_BUSYBOX_IMAGE,
      DIAG_NETSHOOT_IMAGE,
      ...Object.values(CSI_UPSTREAM_IMAGE_PINS).flatMap((specs) =>
        specs.flatMap((s) => Object.values(s.containers)),
      ),
    ];
    expect(fromPins).toEqual([...new Set(jsThirdParty)].sort());
  });

  it('the k8s repl-gateway runs the same socat ref as the compose-ha overlay', () => {
    const k8s = yamlImageSites('carbon/k8s/base/repl-gateway/repl-gateway.yaml').map((s) => s.ref);
    expect(k8s).toEqual([SOCAT_IMAGE]);
  });

  it('the k8s local registry runs the same registry ref as the compose registry', () => {
    const k8s = yamlImageSites('carbon/k8s/base/registry/local-registry.yaml').map((s) => s.ref);
    expect(new Set(k8s)).toEqual(new Set([REGISTRY_IMAGE]));
  });
});
