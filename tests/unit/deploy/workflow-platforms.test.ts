/**
 * Drift guard for the BUILD PLATFORM of every image this repo publishes.
 *
 * vibecarbon standardizes on x86-64 (amd64) servers — decision 2026-07-30.
 * DigitalOcean offers no ARM instances at all (and its CCM/CSI ship amd64-only
 * images regardless); Hetzner ARM is 4 SKUs in 3 of 6 locations behind a
 * "Cost-Optimized / Limited availability" tier. An image consumed ONLY on a
 * server the CLI provisions therefore publishes amd64 alone.
 *
 * This is a two-way guard, and that is the point:
 *
 *   - Adding `linux/arm64` to a server-only image fails here, so nobody
 *     silently pays for a build leg nothing pulls.
 *   - Removing `linux/amd64`, dropping arm64 from an image a developer machine
 *     pulls, or adding docker/setup-qemu-action to a workflow that has no
 *     reason to emulate, also fails here.
 *
 * THE arm64 IMAGES: ghcr.io/hyperformant/postgres, and the wal-g image it is
 * built from. Every mode PULLS the db image, local `vibecarbon up` included
 * (carbon/docker-compose.yml's `image: ${DB_IMAGE}:${DB_IMAGE_TAG}`), so an
 * Apple Silicon developer pulls its arm64 child. wal-g cross-compiles (GOARCH
 * from TARGETARCH on $BUILDPLATFORM); the db image compiles pg_cron inside the
 * target platform's postgres image, which is the one place QEMU is used. See
 * the comment above the build step in publish-db-image.yml.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Every workflow that runs docker/build-push-action, with the platform list it
 * is intended to publish and WHO pulls the result. If you are here because
 * this test failed, change the reasoning first — not just the string.
 */
const PUBLISHED_IMAGES = [
  {
    workflow: '.github/workflows/publish-db-image.yml',
    image: 'ghcr.io/hyperformant/wal-g (static wal-g binary)',
    platforms: 'linux/amd64,linux/arm64',
    consumers:
      'docker/postgres-walg COPY --froms this image in its own multi-arch build, so it needs ' +
      'both platforms. The Dockerfile cross-compiles on $BUILDPLATFORM (no QEMU for this leg).',
  },
  {
    workflow: '.github/workflows/publish-db-image.yml',
    image: 'ghcr.io/hyperformant/postgres (official postgres Alpine + pg_cron + wal-g)',
    platforms: 'linux/amd64,linux/arm64',
    consumers:
      'every mode pulls it: compose and compose-ha servers (docker-compose.yml pulls DB_IMAGE:DB_IMAGE_TAG from .env), ' +
      'k3s nodes (the chart values), and local `vibecarbon up` ' +
      'on developer machines, Apple Silicon included. That local pull is the arm64 consumer.',
  },
  {
    workflow: '.github/workflows/publish-images.yml',
    image: 'ghcr.io/hyperformant/carbon-autoscaler',
    platforms: 'linux/amd64',
    consumers:
      'k8s only — the `carbon-autoscaler` sidecar in ' +
      'carbon/k8s/base/cluster-autoscaler/deployment.yaml, nodeSelector-pinned to ' +
      'node-role.kubernetes.io/control-plane, image patched at deploy time from ' +
      'carbonAutoscalerImageRef(). Never runs on a developer machine.',
  },
  {
    workflow: 'carbon/.github/workflows/vibecarbon-build.yml',
    image: "the generated project's app image (ghcr.io/<owner>/<repo>)",
    platforms: 'linux/amd64',
    consumers:
      'servers only — pulled by `vibecarbon deploy` (compose push mode via APP_IMAGE, and the ' +
      'k8s app Deployment) onto provisioned x86-64 servers.',
  },
] as const;

// A workflow may publish more than one image (publish-db-image.yml builds the
// wal-g binary image, then the db image that COPY --froms it — `needs:` inside
// ONE workflow is what serializes that dependency), so assertions run per
// workflow over the multiset of its images' intended platform lists.
/**
 * Workflows allowed to set up QEMU, each with the reason. Only an image whose
 * build must EXECUTE target-platform code (compiling a C extension inside the
 * target's own postgres image) belongs here; a Go cross-compile never does.
 */
const QEMU_ALLOWED: Record<string, string> = {
  '.github/workflows/publish-db-image.yml':
    'the db image compiles pg_cron with PGXS inside the arm64 postgres image',
};

const WORKFLOWS = [...new Set(PUBLISHED_IMAGES.map((p) => p.workflow))].map((workflow) => ({
  workflow,
  images: PUBLISHED_IMAGES.filter((p) => p.workflow === workflow),
}));

describe.each(WORKFLOWS)('$workflow publishes its intended platforms', ({ workflow, images }) => {
  const wf = read(workflow);
  // Comments are ALLOWED to name arm64 and setup-qemu-action — that is where
  // the reasoning for their absence lives. Only executable YAML is checked.
  const code = wf
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const why = `\n\n${images
    .map((i) => `Image: ${i.image}\nConsumers: ${i.consumers}\nIntended platforms: ${i.platforms}`)
    .join('\n\n')}`;

  it('pins exactly the intended platform list per published image', () => {
    const found = [...code.matchAll(/^\s*platforms:\s*(\S.*?)\s*$/gm)].map((m) => m[1]);
    const intended = images.map((i) => i.platforms);
    expect(
      found.sort(),
      `${workflow} must declare exactly one \`platforms:\` line per published image.${why}`,
    ).toEqual(intended.sort());
  });

  it('sets up QEMU only where an image must emulate its build', () => {
    // setup-qemu-action only exists to register binfmt handlers for foreign
    // architectures. A Go image cross-compiles and needs none; the db image's
    // pg_cron builder is the one exception, and it is argued in QEMU_ALLOWED.
    const uses = [...code.matchAll(/setup-qemu-action/g)].length;
    if (QEMU_ALLOWED[workflow]) {
      expect(uses, `${workflow}: ${QEMU_ALLOWED[workflow]}, so it sets up QEMU once`).toBe(1);
    } else {
      expect(
        uses,
        `${workflow} added docker/setup-qemu-action. QEMU is only needed to EMULATE a ` +
          `foreign architecture, and nothing this workflow builds does.${why}`,
      ).toBe(0);
    }
  });

  it('references arm64 nowhere but intended platforms lines', () => {
    const withoutPlatformLines = code
      .split('\n')
      .filter((line) => !/^\s*platforms:/.test(line))
      .join('\n');
    const anyArmIntended = images.some((i) => i.platforms.includes('arm64'));
    expect(
      withoutPlatformLines,
      `${workflow} references arm64 outside a \`platforms:\` line${
        anyArmIntended ? '' : ' (and none of its images intend arm64 at all)'
      }.${why}`,
    ).not.toMatch(/arm64|aarch64/);
  });
});

describe('arm64 build support survives in the db image delivery chain', () => {
  // arm64 local dev works because the db image (and the wal-g image it copies
  // from) publish linux/arm64. The publish-platform half is pinned by the
  // PUBLISHED_IMAGES entries above; these pin the Dockerfile half. (Deeper
  // build-shape guards live in tests/unit/deploy/walg-dockerfile-arch.test.ts.)
  it('docker/wal-g/Dockerfile cross-compiles from TARGETARCH', () => {
    const dockerfile = read('docker/wal-g/Dockerfile');
    expect(dockerfile).toMatch(/ARG TARGETARCH/);
    expect(dockerfile).toMatch(/GOARCH=\$\{?TARGETARCH\}?/);
  });

  it('docker/postgres-walg/Dockerfile executes wal-g --version at build time', () => {
    // Executing the binary during the build (under QEMU for arm64) is the only
    // place a wrong-arch wal-g fails loudly instead of shipping a database
    // with silently dead backups behind green health checks.
    expect(read('docker/postgres-walg/Dockerfile')).toMatch(/wal-g --version/);
  });
});

describe('compose pulls the published db image rather than building one', () => {
  // This is the fact that makes arm64 publishing necessary for the db image:
  // local dev on Apple Silicon pulls it.
  // Slice the `db:` service body: from its key to the next top-level key.
  const dbServiceOf = (file: string) => {
    const compose = read(file);
    const start = compose.indexOf('\n  db:');
    if (start === -1) return '';
    const next = compose.slice(start + 1).search(/\n {2}[a-z_-]+:|\n[a-z]/);
    return compose.slice(start, next === -1 ? undefined : start + 1 + next);
  };
  const dbService = dbServiceOf('carbon/docker-compose.yml');

  it('the slice actually isolated the db service', () => {
    expect(dbService).toMatch(/^\n {2}db:/);
    expect(dbService).not.toMatch(/\n {2}app:/);
    expect(dbService).toMatch(/healthcheck:/);
  });

  it('db is image DB_IMAGE:DB_IMAGE_TAG from .env, with no build and no pull_policy', () => {
    expect(dbService).toMatch(/^\s+image: \$\{DB_IMAGE:\?[^}]*\}:\$\{DB_IMAGE_TAG:\?[^}]*\}\s*$/m);
    expect(dbService).not.toMatch(/^\s+build:/m);
    expect(dbService).not.toMatch(/pull_policy/);
  });

  it('no compose overlay reintroduces a db build or another db image', () => {
    for (const file of ['carbon/docker-compose.override.yml', 'carbon/docker-compose.prod.yml']) {
      const overlay = dbServiceOf(file);
      expect(overlay, `${file} has no db service to check`).toMatch(/^\n {2}db:/);
      expect(overlay, `${file} builds the db`).not.toMatch(/^\s+(build|image|pull_policy):/m);
    }
  });
});
