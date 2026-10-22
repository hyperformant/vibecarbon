/**
 * Census: every image a deploy pulls on the core path comes from our ghcr
 * mirror, never from Docker Hub (cold-deploy-speed plan, Task 7; ruling D3).
 *
 * WHY: Docker Hub rate-limits anonymous pulls per source IP, and a fresh cloud
 * server often inherits an IP that has already spent its quota. A throttled
 * pull costs minutes or fails the deploy outright (a cloud-init pre-pull was
 * reverted over exactly this, 7babb8e). ghcr.io is already a hard dependency
 * of every deploy (app, db, autoscaler), so mirroring removes a registry from
 * the deploy path instead of adding one.
 *
 * This is a WALK, not a hand list: a new core-path image fails here until it
 * is mirrored. Swept:
 *   - carbon/docker-compose*.yml, minus the add-on overlays (derived from
 *     services/index.json names, `docker-compose.<addon>*.yml`) and the
 *     dev-only docker-compose.override.yml (local `up`, never on a server);
 *   - carbon/k8s/base/** /*.yaml, minus any add-on directory;
 *   - carbon/cloud-init/**;
 *   - every string literal and template-literal chunk in src/** /*.js
 *     (vite's parseAst, so comments never count).
 *
 * Rules:
 *   (b) every `image:` value, and every literal shaped `name:tag@sha256:...`,
 *       starts with ghcr.io/hyperformant/, `{{` or `${`, or is in the short
 *       ALLOWLIST below;
 *   (c) every ghcr.io/hyperformant/<name>:<tag>@<digest> names a MIRRORED_IMAGES
 *       entry exactly (name, tag AND digest), except this repo's own images.
 *
 * k3s's own system images (coredns, local-path-provisioner, metrics-server,
 * pause) are referenced by k3s itself, by tag, from docker.io. They reach the
 * mirror through a containerd docker.io mirror in /etc/rancher/k3s/registries.yaml
 * (the shared snippet below), asserted at the bottom against K3S_VERSION.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';
import { SOCAT_IMAGE } from '../../../src/lib/deploy/compose/ha.js';
import { BINFMT_IMAGE } from '../../../src/lib/deploy/platform.js';
import { loadCloudInit } from '../../../src/lib/iac/cloud-init.js';
import {
  CARBON_AUTOSCALER_IMAGE,
  CSI_UPSTREAM_IMAGE_PINS,
  csiSidecarSetImagePlan,
  DB_IMAGE,
  DEV_DB_IMAGE,
  DIAG_BUSYBOX_IMAGE,
  DIAG_NETSHOOT_IMAGE,
  DOCKERHUB_MIRRORS,
  DOCKERHUB_UPSTREAM_REGISTRY,
  K3S_SYSTEM_IMAGE_MIRRORS,
  k8sMirrorRef,
  MIRRORED_IMAGES,
  mirroredImageName,
  NODE_RUNTIME_IMAGE,
  TRAEFIK_MIRROR,
  traefikImageRef,
  upstreamRef,
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
    .filter((f) => f && existsSync(join(ROOT, f)));

const MIRROR_PREFIX = 'ghcr.io/hyperformant/';
const ADDONS = (JSON.parse(read('services/index.json')) as Array<{ name: string }>).map(
  (s) => s.name,
);

/** Refs that legitimately do not come from the mirror, each with its reason. */
const ALLOWLIST: Record<string, string> = {
  // The generated project's own app image, built per deploy by the project.
  'ghcr.io/{{GITHUB_OWNER}}/{{PROJECT_NAME}}:main': 'project-built app image',
  // `vibecarbon diagnose` probe pods: run by hand against a sick cluster,
  // never on the deploy path.
  [DIAG_BUSYBOX_IMAGE]: 'diagnose-only probe',
  [DIAG_NETSHOOT_IMAGE]: 'diagnose-only probe',
  // Runs on the operator's machine (the arm64 binfmt hint), never a server.
  [BINFMT_IMAGE]: 'operator-local binfmt hint',
};

/** This repo's own images: published by our workflows, not mirrors. */
const OWN_PACKAGES = new Set(
  [DB_IMAGE, DEV_DB_IMAGE, CARBON_AUTOSCALER_IMAGE, NODE_RUNTIME_IMAGE.split(/[:@]/)[0]].map((r) =>
    r.slice(MIRROR_PREFIX.length),
  ),
);

type Site = { where: string; ref: string };

const PINNED_LITERAL = /^[a-z0-9./-]+:[^@\s]+@sha256:[a-f0-9]{64}$/;
const PINNED_TOKEN = /[a-z0-9./-]+:[^@\s"'`]+@sha256:[a-f0-9]{64}/g;
const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

const isAddonCompose = (f: string) => {
  const base = f.slice(f.lastIndexOf('/') + 1);
  return ADDONS.some((a) => base.startsWith(`docker-compose.${a}.`));
};
const COMPOSE_FILES = gitFiles('carbon/docker-compose*.yml').filter(
  (f) => !isAddonCompose(f) && f !== 'carbon/docker-compose.override.yml',
);
const K8S_FILES = gitFiles('carbon/k8s/base').filter(
  (f) => /\.ya?ml$/.test(f) && !ADDONS.some((a) => f.startsWith(`carbon/k8s/base/${a}/`)),
);
const CLOUD_INIT_FILES = gitFiles('carbon/cloud-init');
const SRC_FILES = gitFiles('src').filter((f) => /\.m?js$/.test(f));

/** `image:` values plus every digest-pinned token, comments skipped. */
function textSites(rel: string, text = read(rel)): Site[] {
  const out: Site[] = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const where = `${rel}:${i + 1}`;
    const img = line.match(/^\s*(?:-\s*)?image:\s*(\S.*?)\s*(?:#.*)?$/);
    const seen = new Set<string>();
    if (img) {
      const ref = unquote(img[1]);
      seen.add(ref);
      out.push({ where, ref });
    }
    for (const m of line.matchAll(PINNED_TOKEN)) {
      if (!seen.has(m[0])) out.push({ where, ref: m[0] });
    }
  });
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes from vite's parseAst.
type Node = any;
function walk(node: Node, fn: (n: Node) => void) {
  fn(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    for (const child of Array.isArray(v) ? v : [v]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') walk(child, fn);
    }
  }
}

/** String literals and template chunks in a JS source, as image sites. */
function jsSites(rel: string, text = read(rel)): Site[] {
  const out: Site[] = [];
  walk(parseAst(text), (n) => {
    let value: string | undefined;
    if (n.type === 'Literal' && typeof n.value === 'string') value = n.value;
    if (n.type === 'TemplateElement') value = n.value.cooked ?? n.value.raw;
    if (value === undefined) return;
    if (PINNED_LITERAL.test(value)) {
      out.push({ where: rel, ref: value });
      return;
    }
    out.push(...textSites(rel, value).map((s) => ({ ...s, where: rel })));
  });
  return out;
}

const fromMirrorOrIndirect = (ref: string) =>
  ref.startsWith(MIRROR_PREFIX) || ref.startsWith('{{') || ref.startsWith('${') || ref in ALLOWLIST;

/** Rule (b). */
function dockerHubOffenders(sites: Site[]): string[] {
  return sites
    .filter(({ ref }) => !fromMirrorOrIndirect(ref))
    .map(
      ({ where, ref }) =>
        `${where}: core-path image ${ref} pulls from Docker Hub; mirror it in DOCKERHUB_MIRRORS`,
    );
}

const MIRROR_KEYS = new Set(MIRRORED_IMAGES.map((image) => k8sMirrorRef(image)));

/** Rule (c). */
function unknownMirrorRefs(sites: Site[]): string[] {
  return sites
    .filter(({ ref }) => ref.startsWith(MIRROR_PREFIX) && ref.includes('@sha256:'))
    .filter(({ ref }) => !OWN_PACKAGES.has(ref.slice(MIRROR_PREFIX.length).split(/[:@]/)[0]))
    .filter(({ ref }) => !MIRROR_KEYS.has(ref))
    .map(
      ({ where, ref }) => `${where}: ${ref} is not a MIRRORED_IMAGES entry (name, tag and digest)`,
    );
}

/**
 * Refs JS builds through the images.js helpers, evaluated: the AST walk sees
 * only literals, and a helper-built ref is exactly as core-path as one.
 */
const JS_EVALUATED: Site[] = [
  { where: 'js SOCAT_IMAGE', ref: SOCAT_IMAGE },
  ...Object.keys(CSI_UPSTREAM_IMAGE_PINS)
    .flatMap((p) => csiSidecarSetImagePlan(p))
    .flatMap(({ workload, setImageArgs }) =>
      setImageArgs.map((a) => ({ where: `js csi ${workload}`, ref: a.slice(a.indexOf('=') + 1) })),
    ),
];

/**
 * Servers run carbon/docker-compose.yml UNDER docker-compose.prod.yml
 * (COMPOSE_BASE_FILES, src/lib/deploy/bundle.js), so a base service whose
 * image the prod file replaces is a local-`up` pull only: base traefik stays
 * Docker Hub's multi-arch index so Apple Silicon `up` keeps working, and the
 * prod file swaps in the amd64 mirror. Those base sites are skipped here, and
 * the swap itself is asserted below.
 */
type ComposeDoc = { services?: Record<string, { image?: string }> };
// Compose's `!reset` / `!override` merge tags mean nothing to js-yaml; drop them.
const composeServices = (rel: string) =>
  (loadYaml(read(rel).replace(/!(?:reset|override)\b/g, '')) as ComposeDoc).services ?? {};
const PROD_IMAGES = Object.fromEntries(
  Object.entries(composeServices('carbon/docker-compose.prod.yml'))
    .filter(([, svc]) => svc?.image)
    .map(([name, svc]) => [name, svc.image as string]),
);
const SERVER_OVERRIDDEN_BASE_REFS = new Set(
  Object.entries(composeServices('carbon/docker-compose.yml'))
    .filter(([name, svc]) => svc?.image && name in PROD_IMAGES)
    .map(([, svc]) => svc.image as string),
);
const composeSites = (f: string) =>
  textSites(f).filter(
    (s) => !(f === 'carbon/docker-compose.yml' && SERVER_OVERRIDDEN_BASE_REFS.has(s.ref)),
  );

const ALL_SITES = [
  ...JS_EVALUATED,
  ...COMPOSE_FILES.flatMap(composeSites),
  ...K8S_FILES.flatMap((f) => textSites(f)),
  ...CLOUD_INIT_FILES.flatMap((f) => textSites(f)),
  ...SRC_FILES.flatMap((f) => jsSites(f)),
];

describe('core-path images come from our ghcr mirror', () => {
  it('found the files it walks (a moved directory must not empty the census)', () => {
    expect(COMPOSE_FILES).toEqual(
      expect.arrayContaining(['carbon/docker-compose.yml', 'carbon/docker-compose.prod.yml']),
    );
    expect(COMPOSE_FILES.some(isAddonCompose)).toBe(false);
    expect(gitFiles('carbon/docker-compose*.yml').some(isAddonCompose)).toBe(true);
    expect(K8S_FILES).toEqual(
      expect.arrayContaining([
        'carbon/k8s/base/traefik/deployment.yaml',
        'carbon/k8s/base/registry/local-registry.yaml',
        'carbon/k8s/base/repl-gateway/registry-relay.yaml',
        'carbon/k8s/base/backup/cronjob.yaml',
      ]),
    );
    expect(CLOUD_INIT_FILES.length).toBeGreaterThan(0);
    expect(SRC_FILES).toContain('src/lib/deploy/compose/ha.js');
    expect(ALL_SITES.length).toBeGreaterThan(15);
  });

  it('(b) no core-path image pulls from Docker Hub', () => {
    expect(dockerHubOffenders(ALL_SITES)).toEqual([]);
  });

  it('(b) bites: a bare Docker Hub ref is named with the fix', () => {
    const sites = textSites('probe.yml', `image: traefik:v3.6.11@sha256:${'a'.repeat(64)}`);
    expect(dockerHubOffenders(sites)).toEqual([
      `probe.yml:1: core-path image traefik:v3.6.11@sha256:${'a'.repeat(64)} pulls from Docker Hub; mirror it in DOCKERHUB_MIRRORS`,
    ]);
  });

  it('(c) every mirror ref names a MIRRORED_IMAGES entry on name, tag and digest', () => {
    expect(unknownMirrorRefs(ALL_SITES)).toEqual([]);
  });

  it('(c) bites: a mirror ref with a stray digest is refused', () => {
    const good = k8sMirrorRef(DOCKERHUB_MIRRORS[0]);
    const bad = `${good.split('@')[0]}@sha256:${'0'.repeat(64)}`;
    expect(unknownMirrorRefs([{ where: 'x', ref: good }])).toEqual([]);
    expect(unknownMirrorRefs([{ where: 'x', ref: bad }])).toHaveLength(1);
  });

  it('servers run the mirror of the very traefik tag local `up` runs', () => {
    const base = composeServices('carbon/docker-compose.yml').traefik?.image as string;
    expect(SERVER_OVERRIDDEN_BASE_REFS).toEqual(new Set([base]));
    expect(PROD_IMAGES.traefik).toBe(traefikImageRef());
    // A Dependabot bump of the base tag goes red here until the mirror moves.
    expect(base.split('@')[0]).toBe(`traefik:${TRAEFIK_MIRROR.tag}`);
  });

  it('every core-path image named in the plan is mirrored and reaches a deploy', () => {
    const repos = DOCKERHUB_MIRRORS.map((i) => i.repo);
    expect(repos).toEqual(
      expect.arrayContaining([
        'library/traefik',
        'tecnativa/docker-socket-proxy',
        'library/alpine',
        'library/registry',
        'alpine/socat',
        'alpine/k8s',
      ]),
    );
    const refs = new Set(ALL_SITES.map((s) => s.ref));
    for (const image of DOCKERHUB_MIRRORS.filter((i) => !K3S_SYSTEM_IMAGE_MIRRORS.includes(i))) {
      expect(upstreamRef(image)).toBe(`${DOCKERHUB_UPSTREAM_REGISTRY}/${image.repo}:${image.tag}`);
      expect(
        refs.has(k8sMirrorRef(image)),
        `${image.repo} is mirrored but no core-path site uses it`,
      ).toBe(true);
    }
  });
});

describe('k3s system images come from the mirror (ruling D3)', () => {
  /**
   * The system images k3s itself pulls, from the k3s-images.txt asset of the
   * pinned release (https://github.com/k3s-io/k3s/releases, v1.31.5+k3s1,
   * fetched 2026-10-22). traefik/klipper-helm (helm-controller's traefik
   * chart, `--disable traefik`), klipper-lb (`--disable servicelb`) and the
   * local-path helper busybox (only for a local-path PVC, which the deploy
   * refuses) are never pulled on our clusters and are not mirrored.
   */
  const K3S_IMAGES_TXT = {
    version: 'v1.31.5+k3s1',
    mirrored: [
      'docker.io/rancher/local-path-provisioner:v0.0.30',
      'docker.io/rancher/mirrored-coredns-coredns:1.12.0',
      'docker.io/rancher/mirrored-metrics-server:v0.7.2',
      'docker.io/rancher/mirrored-pause:3.6',
    ],
  };
  const SNIPPET = 'carbon/cloud-init/k3s/_k3s-system-image-mirror.yaml';
  const ROLE_SCRIPTS = [
    'master-init.sh',
    'worker-init.sh',
    'db-init.sh',
    'do-master-init.sh',
    'do-worker-init.sh',
    'do-db-init.sh',
  ];

  it('the mirrored set is exactly the pinned k3s release’s system images we pull', () => {
    const k3sVersion = read('src/lib/deploy/k8s/k3s.js').match(/K3S_VERSION = '([^']+)'/)?.[1];
    expect(k3sVersion, 'bump K3S_IMAGES_TXT from the new release’s k3s-images.txt').toBe(
      K3S_IMAGES_TXT.version,
    );
    expect(K3S_SYSTEM_IMAGE_MIRRORS.map(upstreamRef).sort()).toEqual(K3S_IMAGES_TXT.mirrored);
    for (const image of K3S_SYSTEM_IMAGE_MIRRORS) expect(MIRRORED_IMAGES).toContain(image);
  });

  const EXPECTED_HUB_MIRROR = {
    endpoint: ['https://ghcr.io'],
    rewrite: Object.fromEntries(
      K3S_SYSTEM_IMAGE_MIRRORS.map((i) => [
        `^${i.repo}$`,
        `hyperformant/${mirroredImageName(i.repo)}`,
      ]),
    ),
  };

  it('the registries.yaml snippet mirrors docker.io onto ghcr and rewrites exactly those repos', () => {
    const doc = loadYaml(`mirrors:\n${read(SNIPPET)}`) as {
      mirrors: Record<string, unknown>;
    };
    expect(doc.mirrors['docker.io']).toEqual(EXPECTED_HUB_MIRROR);
    // Nothing a shell would expand: the DO scripts write registries.yaml
    // through an UNQUOTED heredoc.
    expect(read(SNIPPET)).not.toMatch(/[`\\]|\$[\w{(]/);
  });

  it.each(ROLE_SCRIPTS)('%s writes the mirror into registries.yaml before k3s starts', (name) => {
    const script = loadCloudInit(name);
    const heredoc = script.match(
      /cat > \/etc\/rancher\/k3s\/registries\.yaml (<< '?REGEOF'?\n[\s\S]*?\nREGEOF)\n/,
    )?.[1];
    expect(heredoc, `${name} has no registries.yaml heredoc`).toBeDefined();
    // Run the heredoc through bash exactly as cloud-init will (quoted or not),
    // with the per-node local-registry address the script would know.
    const written = execFileSync('bash', ['-c', `cat ${heredoc}`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PRIVATE_IP: '10.0.0.9', master_ip: '10.0.0.1' },
    }).replace(/\$\{(\w+)\}/g, '10.0.0.1'); // renderScript's ${var}s in quoted heredocs
    const doc = loadYaml(written) as { mirrors: Record<string, unknown> };
    expect(doc.mirrors['docker.io']).toEqual(EXPECTED_HUB_MIRROR);
    expect(Object.keys(doc.mirrors)).toHaveLength(2);
    // k3s reads registries.yaml only at start, so it must exist before install.
    expect(script.indexOf('registries.yaml << ')).toBeLessThan(
      script.search(/curl[^\n]*get\.k3s\.io/),
    );
  });
});
