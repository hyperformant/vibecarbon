/**
 * The version set is the one place a deploy's image refs come from, and only a
 * deploy may change it. These rules cover whole families, so a new template or
 * a new command is held to them with no edit here.
 *
 * (a) No image in a template bypasses the resolved set: every `image:` in the
 *     k8s tree, the server compose files and cloud-init is a set token or a
 *     named exception, and the set's packages never appear as a literal.
 * (b) Every image token a template carries is one a deploy fills.
 * (c) The channel is read in one place: the deploy. Every other command that
 *     acts on an environment runs what it recorded.
 * (d) The set is activated in one place, after validation.
 *
 * The file's own validation and the choice are proved behaviorally in
 * tests/unit/lib/version-channel.test.ts, the deploy's record and the HA pair
 * in tests/unit/deploy/skeleton-env-persists-types.test.ts, and restore in
 * tests/unit/restore/restore-resolves-base-first.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_IMAGES,
  CHANNEL_KUBERNETES_IMAGES,
  manifestImageValues,
  mirroredImageName,
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

/** What a server runs: compose under prod, the k8s tree, cloud-init. */
const ADDONS = (JSON.parse(read('services/index.json')) as Array<{ name: string }>).map(
  (s) => s.name,
);
const isAddon = (f: string) =>
  ADDONS.some((a) => f.includes(`/k8s/base/${a}/`) || f.includes(`docker-compose.${a}.`));
const TEMPLATES = [
  'carbon/docker-compose.prod.yml',
  ...gitFiles('carbon/k8s').filter((f) => /\.ya?ml$/.test(f)),
  ...gitFiles('carbon/cloud-init'),
].filter((f) => !isAddon(f));

/** The env-var form compose takes the set's refs in, by name. */
const COMPOSE_SET_VAR = /^\$\{(TRAEFIK_IMAGE|DOCKER_SOCKET_PROXY_IMAGE):\?[^}]*\}$/;

/** Template images the set does not hold, each with why. */
const OUTSIDE_THE_SET: Record<string, string> = {
  'ghcr.io/{{GITHUB_OWNER}}/{{PROJECT_NAME}}:main': 'the project builds its own app image',
  '${APP_IMAGE:-ghcr.io/{{GITHUB_OWNER}}/{{PROJECT_NAME}}:latest}':
    'the project builds its own app image',
  '{{DB_IMAGE}}:{{DB_IMAGE_TAG}}': 'ours, moves with the data format, stays with the CLI',
  '{{CARBON_AUTOSCALER_IMAGE}}': 'ours, moves with the CLI',
};

type Site = { where: string; ref: string };

function imageSites(rel: string, text = read(rel)): Site[] {
  const out: Site[] = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const m = line.match(/^\s*(?:-\s*)?image:\s*(\S.*?)\s*(?:#.*)?$/);
    if (m) out.push({ where: `${rel}:${i + 1}`, ref: m[1].replace(/^(['"])(.*)\1$/, '$2') });
  });
  return out;
}

const SET_TOKENS = new Set(
  Object.keys(manifestImageValues())
    .filter((name) => name.endsWith('_IMAGE'))
    .map((name) => `{{${name}}}`),
);

/** Rule (a), per site. */
function bypasses({ where, ref }: Site): string[] {
  const allowed = SET_TOKENS.has(ref) || COMPOSE_SET_VAR.test(ref) || ref in OUTSIDE_THE_SET;
  return allowed ? [] : [`${where}: ${ref} bypasses the version set; use its token`];
}

const SET_PACKAGES = Object.values({ ...CHANNEL_IMAGES, ...CHANNEL_KUBERNETES_IMAGES }).map(
  (image) => `ghcr.io/hyperformant/${mirroredImageName(image.repo)}`,
);

/** Rule (a), anywhere in the text: a set package as a literal, image: or not. */
function literalPackages(rel: string, text = read(rel)): string[] {
  return text
    .split('\n')
    .flatMap((line, i) =>
      /^\s*#/.test(line)
        ? []
        : SET_PACKAGES.filter((pkg) => new RegExp(`${pkg}[:@]`).test(line)).map(
            (pkg) => `${rel}:${i + 1}: ${pkg} is a literal`,
          ),
    );
}

const SRC = gitFiles('src').filter((f) => /\.m?js$/.test(f));
const importersOf = (name: string) =>
  SRC.filter((f) => new RegExp(`\\b${name}\\b`).test(read(f))).sort();

describe('no template image bypasses the resolved set', () => {
  it('walked the templates (a moved directory must not empty the census)', () => {
    expect(TEMPLATES).toEqual(
      expect.arrayContaining([
        'carbon/docker-compose.prod.yml',
        'carbon/k8s/base/traefik/deployment.yaml',
        'carbon/k8s/infra/traefik-crds/kustomization.yaml',
        'carbon/cloud-init/k3s/master-init.sh',
      ]),
    );
    expect(TEMPLATES.flatMap((f) => imageSites(f)).length).toBeGreaterThan(10);
    expect(SET_TOKENS.size).toBe(5);
  });

  it('every image is a set token or a named exception', () => {
    expect(TEMPLATES.flatMap((f) => imageSites(f)).flatMap(bypasses)).toEqual([]);
  });

  it('no set package appears as a literal', () => {
    expect(TEMPLATES.flatMap((f) => literalPackages(f))).toEqual([]);
  });

  it('bites: a literal mirror ref and an upstream ref are both named', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    for (const value of [
      `ghcr.io/hyperformant/traefik:v3.7.17@${digest}`,
      `traefik:v3@${digest}`,
    ]) {
      expect(imageSites('t.yml', `image: ${value}`).flatMap(bypasses)).toHaveLength(1);
    }
    expect(
      literalPackages('t.yml', `command: [ctr, pull, ghcr.io/hyperformant/socat:1@${digest}]`),
    ).toHaveLength(1);
  });

  it('a new exception needs a reason, and carries no set package', () => {
    for (const [ref, why] of Object.entries(OUTSIDE_THE_SET)) {
      expect(why, ref).not.toBe('');
      expect(literalPackages('x', ref)).toEqual([]);
    }
  });
});

describe('every image token in a template is one a deploy fills', () => {
  it('the set tokens are filled, and only the two named outsiders remain', () => {
    const known = new Set([
      ...Object.keys(manifestImageValues()),
      'CARBON_AUTOSCALER_IMAGE',
      'DB_IMAGE',
    ]);
    const tokens = TEMPLATES.flatMap((f) =>
      [...read(f).matchAll(/\{\{([A-Z0-9_]*(?:_IMAGE|_VERSION))\}\}/g)].map((m) => m[1]),
    );
    expect(tokens.length).toBeGreaterThan(5);
    expect([...new Set(tokens)].filter((token) => !known.has(token))).toEqual([]);
  });

  it('the renderer refuses a leftover image token', () => {
    const k3s = read('src/lib/deploy/k8s/k3s.js');
    expect(k3s).toContain("[REGISTRY_MANIFEST, 'a registry with an unresolved image");
    expect(k3s).toMatch(/\[TRAEFIK_MANIFEST,/);
    expect(k3s).toMatch(
      /backup\/cronjob\.yaml', 'a backup CronJob with an unresolved schedule or image/,
    );
  });

  it('a project .env is filled by every bundle, over whatever the project carries', () => {
    const bundle = read('src/lib/deploy/bundle.js');
    expect(bundle).toContain('envOverrides.TRAEFIK_IMAGE = traefikImageRef();');
    expect(bundle).toContain(
      'envOverrides.DOCKER_SOCKET_PROXY_IMAGE = dockerSocketProxyImageRef();',
    );
  });
});

describe('only a deploy reads the channel', () => {
  it('one module calls the resolver, and nothing else can reach a read', () => {
    expect(importersOf('resolveDeployImageSet')).toEqual([
      'src/lib/deploy/orchestrator.js',
      'src/lib/version-channel.js',
    ]);
    expect(importersOf('readChannel')).toEqual(['src/lib/version-channel.js']);
    expect(importersOf('CHANNEL_URL')).toEqual(['src/lib/version-channel.js']);
    const calls = read('src/lib/deploy/orchestrator.js').match(/resolveDeployImageSet\(/g);
    expect(calls).toHaveLength(1);
  });

  it.each(['src/restore.js', 'src/failover.js', 'src/scale.js', 'src/configure.js'])(
    '%s runs the recorded set',
    (rel) => {
      expect(read(rel)).toMatch(/useRecordedImageSet\(envConfig/);
    },
  );

  it('the commands that use a set are exactly the deploy and those four', () => {
    expect(importersOf('useRecordedImageSet')).toEqual([
      'src/configure.js',
      'src/failover.js',
      'src/lib/version-channel.js',
      'src/restore.js',
      'src/scale.js',
    ]);
  });

  it('the read cannot be pointed elsewhere from the environment', () => {
    const reader = read('src/lib/version-channel.js');
    expect(reader).not.toMatch(/process\.env/);
    expect(reader).toContain("redirect: 'error'");
  });
});

describe('the set is activated in one place', () => {
  it('only version-channel.js calls activateImageSet', () => {
    expect(importersOf('activateImageSet')).toEqual([
      'src/lib/images.js',
      'src/lib/version-channel.js',
    ]);
  });

  it('only images.js names a k3s version', () => {
    expect(SRC.filter((f) => /K3S_VERSION = /.test(read(f)))).toEqual(['src/lib/images.js']);
  });

  it('a step that does not re-run on an unchanged set sees the set in its inputs', () => {
    expect(read('src/lib/deploy/k8s/k3s.js')).toMatch(/imageSetDigest: createHash/);
  });
});
