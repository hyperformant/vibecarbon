/**
 * Drift guard for the BUILD PLATFORM of every image this repo publishes.
 *
 * vibecarbon standardizes on x86-64 (amd64) servers — decision 2026-07-30.
 * DigitalOcean offers no ARM instances at all (and its CCM/CSI ship amd64-only
 * images regardless); Hetzner ARM is 4 SKUs in 3 of 6 locations behind a
 * "Cost-Optimized / Limited availability" tier. Every image below is consumed
 * ONLY on a server the CLI provisions, so arm64 has no consumer and building
 * it is pure QEMU tax.
 *
 * This is a two-way guard, and that is the point:
 *
 *   - Re-adding `linux/arm64` fails here, so nobody silently pays for an
 *     emulated build leg nothing pulls.
 *   - Removing `linux/amd64`, or re-adding docker/setup-qemu-action, also
 *     fails here.
 *
 * THE ONE arm64 IMAGE: ghcr.io/hyperformant/wal-g. A developer running the
 * generated project's compose stack (including on an Apple Silicon Mac) never
 * pulls ghcr.io/hyperformant/postgres — carbon/docker-compose.yml's `db`
 * service is `build: {context: ./db}` with `pull_policy: build`, so it builds
 * from carbon/db/Dockerfile for the host arch. Since the PG17/Alpine move,
 * that build's FIRST step is pulling ghcr.io/hyperformant/wal-g, which
 * therefore MUST publish linux/arm64 — the one image with an arm64 consumer.
 * Its Dockerfile cross-compiles (GOARCH from TARGETARCH on $BUILDPLATFORM),
 * so even that multi-arch publish needs no QEMU, and the no-QEMU guard below
 * stays absolute. The in-consumer `wal-g --version` exec is what catches a
 * wrong-arch binary at build time. See the `arm64 build support` block at the
 * bottom.
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
      'BOTH consumer Dockerfiles COPY --from this image: docker/postgres-walg (built amd64 in ' +
      'CI) AND carbon/db, which builds on target servers (x86-64) and on developer machines — ' +
      'Apple Silicon included. That local-dev pull is the arm64 consumer. The Dockerfile ' +
      'cross-compiles on $BUILDPLATFORM, so no QEMU even for this multi-arch publish.',
  },
  {
    workflow: '.github/workflows/publish-db-image.yml',
    image: 'ghcr.io/hyperformant/postgres (supabase/postgres + wal-g)',
    platforms: 'linux/amd64',
    consumers:
      "k8s only — carbon/k8s/values/supabase.values.yaml's {{DB_IMAGE}}/{{DB_IMAGE_TAG}} " +
      'placeholders, substituted by installSupabase in src/lib/deploy/k8s/k3s.js and pulled by ' +
      'k3s nodes. The compose path (local dev AND compose deploys) BUILDS carbon/db instead of ' +
      'pulling this, so no developer machine ever pulls it.',
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

  it('does not set up QEMU (nothing is ever emulated — multi-arch cross-compiles)', () => {
    // setup-qemu-action only exists to register binfmt handlers for foreign
    // architectures. Even the multi-arch wal-g image needs none: its
    // Dockerfile builds on $BUILDPLATFORM and targets GOARCH directly.
    expect(
      code,
      `${workflow} re-added docker/setup-qemu-action. QEMU is only needed to EMULATE a ` +
        `foreign architecture — every multi-arch image this repo publishes cross-compiles ` +
        `instead.${why}`,
    ).not.toMatch(/setup-qemu-action/);
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

describe('arm64 build support survives in the wal-g delivery chain', () => {
  // arm64 local dev works because carbon/db/Dockerfile pulls the multi-arch
  // ghcr.io/hyperformant/wal-g image (carbon/docker-compose.yml's db service
  // uses `build: {context: ./db}` with `pull_policy: build`, so an Apple
  // Silicon developer builds it natively). A future "consistency" cleanup
  // that drops linux/arm64 from that image's publish — or the TARGETARCH
  // cross-compile that makes it QEMU-free — breaks ARM laptops silently.
  // The publish-platform half is pinned by the PUBLISHED_IMAGES entry above;
  // these pin the Dockerfile half. (Deeper build-shape guards live in
  // tests/unit/deploy/walg-dockerfile-arch.test.ts.)
  it('docker/wal-g/Dockerfile cross-compiles from TARGETARCH', () => {
    const dockerfile = read('docker/wal-g/Dockerfile');
    expect(dockerfile).toMatch(/ARG TARGETARCH/);
    expect(dockerfile).toMatch(/GOARCH=\$\{?TARGETARCH\}?/);
  });

  it.each(['carbon/db/Dockerfile', 'docker/postgres-walg/Dockerfile'])(
    '%s executes wal-g --version at build time',
    (path) => {
      // Executing the binary during the build is the only place a wrong-arch
      // wal-g fails loudly instead of shipping a database with silently dead
      // backups behind green health checks.
      expect(read(path)).toMatch(/wal-g --version/);
    },
  );
});

describe('compose keeps BUILDING the db image rather than pulling the published one', () => {
  // This is the fact that makes amd64-only publishing safe for the db image.
  // If the `db` service ever switches to `image: ghcr.io/hyperformant/postgres`,
  // local dev on Apple Silicon starts PULLING it and arm64 must go back into
  // .github/workflows/publish-db-image.yml.
  const compose = read('carbon/docker-compose.yml');
  // Slice the `db:` service body: from its key to the next top-level service.
  const dbStart = compose.indexOf('\n  db:');
  const nextService = compose.slice(dbStart + 1).search(/\n {2}[a-z_-]+:/);
  const dbService = compose.slice(dbStart, dbStart + 1 + nextService);

  it('the slice actually isolated the db service', () => {
    expect(dbStart).toBeGreaterThan(-1);
    expect(nextService).toBeGreaterThan(-1);
    expect(dbService).toMatch(/^\n {2}db:/);
    expect(dbService).not.toMatch(/\n {2}kong:/);
  });

  it('db builds from ./db with pull_policy: build', () => {
    expect(dbService).toMatch(/build:\s*\n\s*context:\s*\.\/db/);
    expect(dbService).toMatch(/pull_policy:\s*build/);
  });

  it('no compose file points the db service at the published ghcr image', () => {
    for (const file of [
      'carbon/docker-compose.yml',
      'carbon/docker-compose.override.yml',
      'carbon/docker-compose.prod.yml',
    ]) {
      expect(
        read(file),
        `${file} references the published db image. If any compose path PULLS it, local dev on ` +
          `an arm64 Mac breaks unless linux/arm64 is restored in publish-db-image.yml.`,
      ).not.toMatch(/ghcr\.io\/hyperformant\/postgres/);
    }
  });
});
