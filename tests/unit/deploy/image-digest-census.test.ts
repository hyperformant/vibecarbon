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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SOCAT_IMAGE } from '../../../src/lib/deploy/compose/ha.js';
import { BINFMT_IMAGE } from '../../../src/lib/deploy/platform.js';
import { bootPullImages } from '../../../src/lib/iac/compose-cloud-init.js';
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
  MIRRORED_IMAGES,
  NODE_RUNTIME_IMAGE,
  pauseImageRef,
  registryImageRef,
} from '../../../src/lib/images.js';
import { escapeRegExp } from '../../_shared/regexp.js';

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
  // The node runtime base the app image builds FROM: built from
  // docker/node-runtime by publish-node-runtime-image.yml AFTER the commit
  // that names the tag merges. Revisioned like the db image (-r<N>, enforced
  // by node-runtime-image-fingerprint.test.ts), so a tag names one build.
  // Exempt only while the tag is unpublished: the post-publish commit appends
  // its @sha256 (release.yml refuses to release until it does), and from then
  // on the ref is pinned like any other and needs no exemption.
  // The compose boot pull's loop variable (carbon/cloud-init/docker-ce-setup.yaml
  // boot-pull.sh): the CLI fills its list from bootPullImages() in
  // src/lib/iac/compose-cloud-init.js, which the test below holds to this
  // same rule (pinned, or the allowlisted db image).
  '"$ref"': 'boot pull loop variable, refs from bootPullImages() (checked below)',
  ...(PINNED.test(NODE_RUNTIME_IMAGE)
    ? {}
    : { [NODE_RUNTIME_IMAGE]: 'node runtime base, published by this repo after merge' }),
};

type Site = { where: string; ref: string };

const isComment = (line: string) => /^\s*#/.test(line);
const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * `image:` values, kustomize `newTag:` and Helm-style `repository:` + `tag:`
 * pairs (joined as `repository:tag`) from a YAML-ish file, line-based.
 */
function yamlImageSites(rel: string): Site[] {
  const out: Site[] = [];
  let repo: { value: string; indent: number; line: number } | null = null;
  read(rel)
    .split('\n')
    .forEach((line, i) => {
      if (isComment(line)) return;
      const img = line.match(/^\s*(?:-\s*)?image:\s*(\S.*?)\s*(?:#.*)?$/);
      if (img) out.push({ where: `${rel}:${i + 1}`, ref: unquote(img[1]) });
      const tag = line.match(/^\s*newTag:\s*(\S+)/);
      if (tag) out.push({ where: `${rel}:${i + 1}`, ref: `newTag: ${unquote(tag[1])}` });
      const helmRepo = line.match(/^(\s*)repository:\s*(\S.*?)\s*(?:#.*)?$/);
      if (helmRepo) {
        repo = { value: unquote(helmRepo[2]), indent: helmRepo[1].length, line: i + 1 };
        return;
      }
      const helmTag = line.match(/^(\s*)tag:\s*(\S.*?)\s*(?:#.*)?$/);
      if (repo && helmTag && helmTag[1].length === repo.indent) {
        out.push({ where: `${rel}:${repo.line}`, ref: `${repo.value}:${unquote(helmTag[2])}` });
        repo = null;
      }
    });
  if (repo) {
    const r = repo as { value: string; line: number };
    out.push({ where: `${rel}:${r.line}`, ref: `${r.value} (repository with no tag)` });
  }
  return out;
}

/** Every file in the checkout (tracked or new, never ignored or vendored). */
const ALL_FILES = gitFiles().filter(
  (f) => !f.split('/').includes('node_modules') && existsSync(join(ROOT, f)),
);
const isYaml = (f: string) => /\.ya?ml$/i.test(f);
const base = (f: string) => f.slice(f.lastIndexOf('/') + 1);

/** Compose files by name, anywhere: docker-compose*.y(a)ml and compose*.y(a)ml. */
const COMPOSE_FILES = ALL_FILES.filter((f) =>
  /^(docker-)?compose([.-][^/]*)?\.ya?ml$/i.test(base(f)),
);
const K8S_FILES = ALL_FILES.filter(
  (f) => isYaml(f) && (f.startsWith('carbon/k8s/') || /^services\/[^/]+\/k8s\//.test(f)),
);
const CLOUD_INIT_FILES = ALL_FILES.filter((f) => f.startsWith('carbon/cloud-init/'));
const DOCKERFILES = ALL_FILES.filter((f) => /^(Dockerfile|Containerfile)(\..+)?$/.test(base(f)));
const WORKFLOWS = ALL_FILES.filter(
  (f) => isYaml(f) && /^(carbon\/)?\.github\/workflows\/[^/]+$/.test(f),
);
const KNOWN_YAML = new Set([...COMPOSE_FILES, ...K8S_FILES, ...CLOUD_INIT_FILES, ...WORKFLOWS]);
/** The backstop: every other YAML file in the repo. */
const OTHER_YAML = ALL_FILES.filter((f) => isYaml(f) && !KNOWN_YAML.has(f));

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
  'registryImageRef()': [registryImageRef()],
  DIAG_BUSYBOX_IMAGE: [DIAG_BUSYBOX_IMAGE],
  DIAG_NETSHOOT_IMAGE: [DIAG_NETSHOOT_IMAGE],
  BINFMT_IMAGE: [BINFMT_IMAGE],
  'clusterAutoscalerImageRef()': [clusterAutoscalerImageRef()],
  'carbonAutoscalerImageRef()': [carbonAutoscalerImageRef()],
  'pauseImageRef()': [pauseImageRef()],
  'k8sMirrorRef(MIRRORED_IMAGES)': MIRRORED_IMAGES.map(k8sMirrorRef),
  'csiSidecarSetImagePlan()': Object.keys({ ...CSI_SIDECAR_MIRRORS, ...CSI_UPSTREAM_IMAGE_PINS })
    .flatMap((p) => csiSidecarSetImagePlan(p))
    .flatMap(({ setImageArgs }) => setImageArgs.map((a) => a.slice(a.indexOf('=') + 1))),
  'dbImageRef()': [dbImageRef()],
  NODE_RUNTIME_IMAGE: [NODE_RUNTIME_IMAGE],
};

function jsSites(): Site[] {
  return Object.entries(JS_REFS).flatMap(([name, refs]) =>
    refs.map((ref) => ({ where: `js ${name}`, ref })),
  );
}

/** An image-ref-shaped literal token (not a path, flag, port map or `${}`). */
const IMAGE_TOKEN =
  /^(?:[a-z0-9][a-z0-9._-]*(?::\d+)?\/)*[a-z0-9][a-z0-9._-]*(?::[\w][\w.-]*)?(?:@sha256:[a-f0-9]{64})?$/;

/**
 * Literal image refs on `docker run|pull` / `nerdctl run|pull` and
 * `ctr|crictl ... pull` lines in src/ and scripts/ (comments skipped). The
 * image is the first argument that is not a flag, a flag's value, or an
 * interpolation; a `${...}` image is a runtime value or a registered constant
 * and is covered by the JS checks instead.
 */
function pullLiteralSites(
  sources: Array<{ rel: string; text: string }> = ALL_FILES.filter((f) =>
    /^(src|scripts)\/.*\.(m?js|ts|sh)$/.test(f),
  ).map((rel) => ({ rel, text: read(rel) })),
): Site[] {
  const out: Site[] = [];
  const FLAGS_WITH_VALUE = new Set([
    '--name',
    '-p',
    '-v',
    '-e',
    '--env',
    '--network',
    '--platform',
    '-n',
    '--namespace',
    '-w',
    '--user',
    '-u',
    '--entrypoint',
    '--restart',
    '--mount',
    '--label',
    '-l',
  ]);
  for (const { rel, text } of sources) {
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/|#)/.test(line)) return;
      const m = line.match(
        /\b(?:docker|nerdctl)\s+(?:run|pull)\s+(.*)$|\b(?:ctr|crictl)\b.*?\bpull\s+(.*)$/,
      );
      if (!m) return;
      const tokens = (m[1] ?? m[2]).split(/\s+/).map((t) => t.replace(/^[`'"]+|[`'".,;)]+$/g, ''));
      for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k];
        if (!t) continue;
        if (t.startsWith('-')) {
          if (FLAGS_WITH_VALUE.has(t)) k++;
          continue;
        }
        if (t.includes('${') || t.includes('$')) break; // runtime / registered
        if (IMAGE_TOKEN.test(t) && (t.includes('/') || t.includes(':'))) {
          out.push({ where: `${rel}:${i + 1}`, ref: t });
        }
        break;
      }
    });
  }
  return out;
}

/** src/ lines that put an image into YAML or a CLI flag. */
function srcSweepSites(): Site[] {
  const out: Site[] = [];
  // git pathspec `*` crosses `/`, so this is recursive; `src/**/*.js` would
  // skip the top-level src/*.js commands.
  for (const rel of gitFiles('src/*.js', 'src/*.mjs')) {
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
        'docker/node-runtime/Dockerfile',
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

  it('the compose boot pull refs (filled into cloud-init at render)', () => {
    const bad = bootPullImages().filter((ref) => !PINNED.test(ref) && !(ref in ALLOWLIST));
    expect(bad).toEqual([]);
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

  it('backstop: no YAML anywhere else in the repo carries an unpinned image', () => {
    // Everything the globs above do not classify (tests, docs, scripts,
    // tool config). A new compose/k8s location lands here until it is
    // given a proper home in the census and in .github/dependabot.yml.
    expect(OTHER_YAML.length).toBeGreaterThan(0);
    expect(offenders(OTHER_YAML.flatMap(yamlImageSites))).toEqual([]);
  });

  it('src/ and scripts/ have no unpinned literal on a docker/ctr/crictl run or pull', () => {
    expect(offenders(pullLiteralSites())).toEqual([]);
  });

  it('the run/pull sweep sees literals (it would catch an unpinned one)', () => {
    // Self-check of the real sweep on the shapes it exists for: an unpinned
    // literal on each verb is reported, a pinned one and an interpolated one
    // are not, and comment lines are skipped.
    const sites = pullLiteralSites([
      {
        rel: 'src/probe.js',
        text: [
          'docker run --privileged --rm tonistiigi/binfmt --install amd64',
          'docker pull registry:2',
          'ctr -n k8s.io images pull docker.io/library/busybox:1.36',
          `docker pull ${BINFMT_IMAGE}`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the probe is source text with an interpolated image
          'docker run --rm ${IMAGE} true',
          '// docker pull alpine:3.20',
        ].join('\n'),
      },
    ]);
    expect(sites).toEqual([
      { where: 'src/probe.js:1', ref: 'tonistiigi/binfmt' },
      { where: 'src/probe.js:2', ref: 'registry:2' },
      { where: 'src/probe.js:3', ref: 'docker.io/library/busybox:1.36' },
      { where: 'src/probe.js:4', ref: BINFMT_IMAGE },
    ]);
    expect(offenders(sites)).toEqual([
      'src/probe.js:1: tonistiigi/binfmt',
      'src/probe.js:2: registry:2',
      'src/probe.js:3: docker.io/library/busybox:1.36',
    ]);
  });

  it('the db StatefulSet is scanned: its deploy-time image placeholder is an allowlisted site', () => {
    const db = K8S_FILES.flatMap(yamlImageSites).filter(({ ref }) =>
      ref.startsWith('{{DB_IMAGE}}:'),
    );
    expect(db.some(({ where }) => where.startsWith('carbon/k8s/base/db/statefulset.yaml:'))).toBe(
      true,
    );
    expect(
      K8S_FILES.flatMap(yamlImageSites).filter(({ ref }) =>
        ref.includes('(repository with no tag)'),
      ),
    ).toEqual([]);
  });

  it('the app image runs on the CLI-pinned node runtime base, and only on it', () => {
    // carbon/Dockerfile's runner is FROM ${RUNTIME_IMAGE}, whose default is
    // byte-for-byte NODE_RUNTIME_IMAGE (src/lib/images.js, the one CLI pin
    // the deploy reads to pre-pull the base). The runner adds only the app's
    // own layers: anything the base provides (libstdc++, the hono user, the
    // node binary) re-added here would ride in every deploy's delta.
    const df = read('carbon/Dockerfile');
    expect(df).toMatch(new RegExp(`^ARG RUNTIME_IMAGE=${escapeRegExp(NODE_RUNTIME_IMAGE)}$`, 'm'));
    expect(df).toMatch(/^FROM \$\{RUNTIME_IMAGE\} AS runner$/m);
    const runner = df.slice(df.indexOf('AS runner'));
    expect(runner).not.toMatch(
      /\bapk\b|\badduser\b|\baddgroup\b|COPY[^\n]*\/usr\/local\/bin\/node/,
    );
    expect(runner).toMatch(/^USER hono$/m);
  });

  it('the app is built with the very node the runtime base runs', () => {
    // carbon's builder and deps stages compile and install against
    // NODE_IMAGE; the runner executes the result on the node binary
    // docker/node-runtime copied out of ITS NODE_IMAGE. Same index digest,
    // so build and run are one Node release on one alpine.
    const nodeImage = (rel: string) => read(rel).match(/^ARG NODE_IMAGE=(\S+)$/m)?.[1];
    expect(nodeImage('carbon/Dockerfile')).toMatch(PINNED);
    expect(nodeImage('carbon/Dockerfile')).toBe(nodeImage('docker/node-runtime/Dockerfile'));
  });

  it('an image used in both compose and k8s runs the same tag in both', () => {
    // Dependabot moves them in one `images` PR; this catches a hand edit
    // that bumps one tier and forgets the other.
    const tagsOf = (sites: Site[]) => {
      const m = new Map<string, Set<string>>();
      for (const { ref } of sites) {
        if (!PINNED.test(ref)) continue;
        const nameTag = ref.split('@')[0];
        const colon = nameTag.lastIndexOf(':');
        if (colon <= nameTag.lastIndexOf('/')) continue;
        const name = nameTag.slice(0, colon);
        m.set(name, (m.get(name) ?? new Set()).add(nameTag.slice(colon + 1)));
      }
      return m;
    };
    const compose = tagsOf(COMPOSE_FILES.flatMap(yamlImageSites));
    const k8s = tagsOf(K8S_FILES.flatMap(yamlImageSites));
    const shared = [...compose.keys()].filter((n) => k8s.has(n));
    expect(shared.length).toBeGreaterThanOrEqual(5);
    const drift = shared.filter(
      (n) =>
        [...(compose.get(n) as Set<string>)].sort().join() !==
        [...(k8s.get(n) as Set<string>)].sort().join(),
    );
    expect(drift).toEqual([]);
  });

  it('the allowlist holds only refs that still exist (no stale exemptions)', () => {
    const all = [
      ...COMPOSE_FILES.flatMap(yamlImageSites),
      ...K8S_FILES.flatMap(yamlImageSites),
      ...CLOUD_INIT_FILES.flatMap(cloudInitSites),
      ...jsSites(),
    ].map((s) => s.ref);
    for (const ref of Object.keys(ALLOWLIST)) expect(all, ref).toContain(ref);
  });

  it('every pinned third-party ref resolves to a single index digest per name:tag', () => {
    // Two sites naming the same tag with different digests means one of them
    // was bumped and the other forgotten. Scope: the files Dependabot moves
    // together in its `images` PR. The JS-held pins and their mirror
    // (.github/image-pins) move in their own hand-sync PR, with explicit
    // parity checks below, so they may briefly differ from a compose copy.
    const byTag = new Map<string, Set<string>>();
    const sites = [
      ...COMPOSE_FILES.flatMap(yamlImageSites),
      ...K8S_FILES.flatMap(yamlImageSites),
      ...DOCKERFILES.filter((f) => f !== '.github/image-pins/Dockerfile').flatMap(dockerfileSites),
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
      new RegExp(`^${escapeRegExp(g.replace(/^\//, '')).replace(/\\\*/g, '[^/]+')}$`).test(dir),
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

  it('every compose file that holds an image matches Dependabot’s compose filename pattern', () => {
    // dependabot-core docker/lib/dependabot/docker_compose/file_fetcher.rb
    // FILENAME_REGEX (Ruby atomic group; `[\w-]` cannot eat the `.`, so the
    // plain group below is equivalent). It allows ONE dotted segment, so
    // `docker-compose.n8n.prod.yml` is invisible to Dependabot. Those
    // overlays hold no images today; this fails the day one gains one.
    const DEPENDABOT_COMPOSE = /(docker-)?compose(-[\w]+)?(?:\.[\w-]+)?\.ya?ml/i;
    // Unanchored, like Ruby's `match?`, which is how the fetcher applies it.
    expect(DEPENDABOT_COMPOSE.test('docker-compose.n8n.yml')).toBe(true);
    expect(DEPENDABOT_COMPOSE.test('docker-compose.n8n.prod.yml')).toBe(false);
    const unseen = COMPOSE_FILES.filter(
      (f) => yamlImageSites(f).length > 0 && !DEPENDABOT_COMPOSE.test(base(f)),
    );
    expect(unseen).toEqual([]);
  });

  it('every k8s file that holds a pinned image is one Dependabot parses (apiVersion + kind)', () => {
    // The docker ecosystem only reads YAML whose documents carry apiVersion
    // and kind (shared_file_fetcher.rb); a values file or fragment would be
    // silently skipped.
    const skipped = K8S_FILES.filter((f) => {
      if (!yamlImageSites(f).some(({ ref }) => PINNED.test(ref))) return false;
      const text = read(f);
      return !(/^apiVersion:/m.test(text) && /^kind:/m.test(text));
    });
    expect(skipped).toEqual([]);
  });

  it('hand-sync classes get their own Dependabot PRs; the rest share one `images` PR', () => {
    const cfg = dependabot as unknown as {
      updates: Array<{
        'package-ecosystem': string;
        directory?: string;
        directories?: string[];
        'multi-ecosystem-group'?: string;
        groups?: Record<string, unknown>;
        ignore?: Array<{ 'dependency-name': string; 'update-types'?: string[] }>;
      }>;
      'multi-ecosystem-groups'?: Record<string, unknown>;
    };
    const entryFor = (dir: string) =>
      cfg.updates.filter(
        (u) =>
          u['package-ecosystem'] === 'docker' &&
          (u.directory === dir || u.directories?.includes(dir)),
      );
    for (const dir of ['/.github/image-pins', '/docker/postgres-walg', '/docker/node-runtime']) {
      const entries = entryFor(dir);
      expect(entries, dir).toHaveLength(1);
      expect(entries[0].directories ?? [entries[0].directory]).toEqual([dir]);
      expect(entries[0]['multi-ecosystem-group'], dir).toBeUndefined();
      expect(Object.keys(entries[0].groups ?? {}), dir).toHaveLength(1);
    }
    expect(cfg['multi-ecosystem-groups']).toHaveProperty('images');
    const inImages = cfg.updates.filter((u) => u['multi-ecosystem-group'] === 'images');
    expect(inImages.map((u) => u['package-ecosystem']).sort()).toEqual([
      'docker',
      'docker-compose',
    ]);
    // Our ghcr mirrors pin upstream's amd64 CHILD digest, not the mirror
    // tag's index digest, so a Dependabot "update" of one would only break
    // the mirror census. Each entry ignores exactly the mirror names its
    // files carry (images.js owns them), plus our node runtime base.
    const ignoredBy = (eco: string) =>
      new Set(
        (inImages.find((u) => u['package-ecosystem'] === eco)?.ignore ?? [])
          .filter((i) => !i['update-types'])
          .map((i) => i['dependency-name']),
      );
    const mirrorNamesIn = (sites: Site[]) =>
      sites
        .map(({ ref }) => ref.split(/[:@]/)[0])
        .filter((name) => name.startsWith('ghcr.io/hyperformant/'))
        .filter((name) => !name.endsWith('/node-runtime'));
    expect(ignoredBy('docker')).toEqual(
      new Set([
        ...mirrorNamesIn(K8S_FILES.flatMap(yamlImageSites)),
        'ghcr.io/hyperformant/node-runtime',
      ]),
    );
    expect(ignoredBy('docker')).toContain('ghcr.io/hyperformant/cluster-autoscaler');
    expect(ignoredBy('docker-compose')).toEqual(
      new Set(mirrorNamesIn(COMPOSE_FILES.flatMap(yamlImageSites))),
    );
    expect(ignoredBy('docker-compose')).toContain('ghcr.io/hyperformant/traefik');
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
    // socat, registry and the DO CSI alpine moved onto our ghcr mirror
    // (MirroredImage entries, bumped by hand like the registry.k8s.io set),
    // so only the Docker Hub refs JS still holds remain here.
    const jsThirdParty = [DIAG_BUSYBOX_IMAGE, DIAG_NETSHOOT_IMAGE, BINFMT_IMAGE];
    expect(fromPins).toEqual([...new Set(jsThirdParty)].sort());
    const mirrored = [
      SOCAT_IMAGE,
      registryImageRef(),
      ...Object.values(CSI_UPSTREAM_IMAGE_PINS).flatMap((specs) =>
        specs.flatMap((s) => Object.values(s.containers)),
      ),
    ];
    for (const ref of mirrored) expect(ref).toMatch(/^ghcr\.io\/hyperformant\//);
  });

  it('the k8s repl-gateway runs the same socat ref as the compose-ha overlay', () => {
    const k8s = yamlImageSites('carbon/k8s/base/repl-gateway/repl-gateway.yaml').map((s) => s.ref);
    expect(k8s).toEqual([SOCAT_IMAGE]);
  });

  it('the k8s local registry runs registryImageRef()', () => {
    const k8s = yamlImageSites('carbon/k8s/base/registry/local-registry.yaml').map((s) => s.ref);
    expect(new Set(k8s)).toEqual(new Set([registryImageRef()]));
  });
});
