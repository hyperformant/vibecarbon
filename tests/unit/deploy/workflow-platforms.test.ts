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
 * DELIBERATELY NOT COVERED: the db image's LOCAL-DEV path. A developer running
 * the generated project's compose stack (including on an Apple Silicon Mac)
 * never pulls ghcr.io/hyperformant/postgres — carbon/docker-compose.yml's `db`
 * service is `build: {context: ./db}` with `pull_policy: build`, so it builds
 * from carbon/db/Dockerfile for the host arch. That Dockerfile's TARGETARCH
 * case statement (and docker/postgres-walg/Dockerfile's) MUST keep its arm64
 * branch — it is what makes arm64 local dev work, and its `wal-g --version`
 * line is what catches a wrong-arch binary on amd64 too. Publishing a single
 * platform while keeping arch-correct Dockerfiles is intentional, not
 * inconsistent. See the `arm64 build support` block at the bottom.
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

describe.each(PUBLISHED_IMAGES)(
  '$workflow publishes $platforms',
  ({ workflow, image, platforms, consumers }) => {
    const wf = read(workflow);
    // Comments are ALLOWED to name arm64 and setup-qemu-action — that is where
    // the reasoning for their absence lives. Only executable YAML is checked.
    const code = wf
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const why = `\n\nImage: ${image}\nConsumers: ${consumers}\nIntended platforms: ${platforms}`;

    it('pins exactly the intended platform list', () => {
      const found = [...code.matchAll(/^\s*platforms:\s*(\S.*?)\s*$/gm)].map((m) => m[1]);
      expect(found, `${workflow} must declare exactly one \`platforms:\` line.${why}`).toHaveLength(
        1,
      );
      expect(
        found[0],
        `${workflow} publishes "${found[0]}" but should publish "${platforms}".${why}`,
      ).toBe(platforms);
    });

    it('does not set up QEMU (nothing is emulated in an amd64-only build)', () => {
      // setup-qemu-action only exists to register binfmt handlers for foreign
      // architectures. On an amd64-only build it is dead weight on every run.
      expect(
        code,
        `${workflow} re-added docker/setup-qemu-action. QEMU is only needed to build a ` +
          `foreign architecture — if you added it back, you almost certainly also added an ` +
          `arm64 platform that nothing pulls.${why}`,
      ).not.toMatch(/setup-qemu-action/);
    });

    it('has no stray arm64 reference in a build input', () => {
      expect(code, `${workflow} references arm64 outside a comment.${why}`).not.toMatch(
        /arm64|aarch64/,
      );
    });
  },
);

describe('arm64 build support survives in the Dockerfiles', () => {
  // The publish workflows go single-platform; the Dockerfiles do NOT. Their
  // TARGETARCH branches are what let a developer build the db image natively
  // on an arm64 laptop, and the `wal-g --version` exec is what catches a
  // wrong-arch or glibc-mismatched binary on amd64 too. A future "consistency"
  // cleanup that strips these because publishing is amd64-only would break
  // arm64 local dev silently — hence this guard.
  it.each(['carbon/db/Dockerfile', 'docker/postgres-walg/Dockerfile'])(
    '%s still selects the wal-g asset from TARGETARCH, arm64 branch included',
    (path) => {
      const dockerfile = read(path);
      expect(dockerfile).toMatch(/ARG TARGETARCH/);
      expect(dockerfile).toMatch(/amd64\)\s*WALG_ASSET=/);
      expect(
        dockerfile,
        `${path} lost its arm64 branch. Publishing is amd64-only, but this Dockerfile is ` +
          `BUILT locally — carbon/docker-compose.yml's db service uses \`build: {context: ./db}\` ` +
          `with \`pull_policy: build\`, so an Apple Silicon developer builds arm64 here. ` +
          `Removing this branch breaks local dev on ARM laptops.`,
      ).toMatch(/arm64\)\s*WALG_ASSET=/);
      // Executing the binary during the build is the only place a wrong-arch
      // or glibc-mismatched wal-g fails loudly instead of shipping a database
      // with silently dead backups behind green health checks.
      expect(dockerfile).toMatch(/wal-g --version/);
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
