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
 * built from. Servers stay amd64; the db image's arm64 child exists solely so
 * local `vibecarbon up` on Apple Silicon runs Postgres natively (every mode,
 * local dev included, pulls that image). wal-g cross-compiles (GOARCH from
 * TARGETARCH on $BUILDPLATFORM); the db image builds natively per arch on
 * GitHub's ubuntu-24.04 / ubuntu-24.04-arm runners and a merge job joins the
 * two digests under one tag. No workflow sets up QEMU.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  'runs-on'?: string;
  needs?: string | string[];
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps?: Step[];
};
const jobsOf = (workflow: string) =>
  (loadYaml(read(workflow)) as { jobs: Record<string, Job> }).jobs;
/** A literal GitHub expression, without tripping the template-string lint. */
const expr = (inner: string) => `$${'{{'} ${inner} }}`;
const isBuildPush = (step: Step) => /docker\/build-push-action@/.test(step.uses ?? '');

/**
 * The platforms a job builds, with `${{ matrix.platform }}` expanded over the
 * job's matrix legs. Sorted and de-duplicated: the db legs build twice (once
 * to load for the smoke test, once to push), which is still one platform.
 */
function builtPlatforms(job: Job): string[] {
  const legs = job.strategy?.matrix?.include ?? [{}];
  const out = new Set<string>();
  for (const step of (job.steps ?? []).filter(isBuildPush)) {
    const raw = String(step.with?.platforms ?? '');
    for (const leg of legs) {
      const value = raw.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, k) => leg[k] ?? '');
      for (const p of value.split(',')) if (p) out.add(p.trim());
    }
  }
  return [...out].sort();
}

/**
 * Every job that runs docker/build-push-action, with the platforms it is
 * intended to publish and WHO pulls the result. If you are here because this
 * test failed, change the reasoning first — not just the string.
 */
const PUBLISHED_IMAGES = [
  {
    workflow: '.github/workflows/publish-db-image.yml',
    job: 'publish-walg',
    image: 'ghcr.io/hyperformant/wal-g (static wal-g binary)',
    platforms: ['linux/amd64', 'linux/arm64'],
    consumers:
      'docker/postgres-walg COPY --froms this image in both of its native per-arch builds. ' +
      'The Dockerfile cross-compiles on $BUILDPLATFORM, so no QEMU.',
  },
  {
    workflow: '.github/workflows/publish-db-image.yml',
    job: 'build-db',
    image: 'ghcr.io/hyperformant/postgres (official postgres Alpine + pg_cron + wal-g)',
    platforms: ['linux/amd64', 'linux/arm64'],
    consumers:
      'servers (amd64 only, src/lib/deploy/platform.js) pull the amd64 child; the arm64 child ' +
      'exists solely for local `vibecarbon up` on Apple Silicon, which pulls this image too.',
  },
  {
    workflow: '.github/workflows/publish-images.yml',
    job: 'publish',
    image: 'ghcr.io/hyperformant/carbon-autoscaler',
    platforms: ['linux/amd64'],
    consumers:
      'k8s only — the `carbon-autoscaler` sidecar in ' +
      'carbon/k8s/base/cluster-autoscaler/deployment.yaml, nodeSelector-pinned to ' +
      'node-role.kubernetes.io/control-plane, image patched at deploy time from ' +
      'carbonAutoscalerImageRef(). Never runs on a developer machine.',
  },
  {
    workflow: 'carbon/.github/workflows/vibecarbon-build.yml',
    job: 'build',
    image: "the generated project's app image (ghcr.io/<owner>/<repo>)",
    platforms: ['linux/amd64'],
    consumers:
      'servers only — pulled by `vibecarbon deploy` (compose push mode via APP_IMAGE, and the ' +
      'k8s app Deployment) onto provisioned x86-64 servers.',
  },
] as const;

const WORKFLOWS = [...new Set(PUBLISHED_IMAGES.map((p) => p.workflow))].map((workflow) => ({
  workflow,
  images: PUBLISHED_IMAGES.filter((p) => p.workflow === workflow),
}));

describe.each(WORKFLOWS)('$workflow publishes its intended platforms', ({ workflow, images }) => {
  const jobs = jobsOf(workflow);
  // Comments are ALLOWED to name setup-qemu-action — that is where the
  // reasoning for its absence lives. Only executable YAML is checked.
  const code = read(workflow)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const why = `\n\n${images
    .map(
      (i) =>
        `Image: ${i.image} (job ${i.job})\nConsumers: ${i.consumers}\n` +
        `Intended platforms: ${i.platforms.join(',')}`,
    )
    .join('\n\n')}`;

  it('every image-building job is registered here', () => {
    const building = Object.entries(jobs)
      .filter(([, job]) => (job.steps ?? []).some(isBuildPush))
      .map(([id]) => id)
      .sort();
    expect(building, `${workflow}: unregistered build-push job.${why}`).toEqual(
      images.map((i) => i.job).sort(),
    );
  });

  it.each(images.map((i) => [i.job, i] as const))(
    'job %s builds exactly its intended platforms',
    (_, image) => {
      expect(builtPlatforms(jobs[image.job]), `${workflow}#${image.job}.${why}`).toEqual(
        [...image.platforms].sort(),
      );
    },
  );

  it('never sets up QEMU (multi-arch is cross-compiled or built natively per arch)', () => {
    expect(
      code,
      `${workflow} added docker/setup-qemu-action. QEMU is only needed to EMULATE a foreign ` +
        `architecture: Go images cross-compile, and the db image builds on a native runner ` +
        `per arch.${why}`,
    ).not.toMatch(/setup-qemu-action/);
  });
});

describe('the db image builds natively per arch and merges into one tag', () => {
  const WORKFLOW = '.github/workflows/publish-db-image.yml';
  const jobs = jobsOf(WORKFLOW);
  const build = jobs['build-db'];
  const merge = jobs.publish;

  it('one matrix leg per arch, each on its own native runner', () => {
    expect(build['runs-on']).toBe(expr('matrix.runner'));
    expect(build.strategy?.matrix?.include).toEqual([
      { platform: 'linux/amd64', runner: 'ubuntu-24.04' },
      { platform: 'linux/arm64', runner: 'ubuntu-24.04-arm' },
    ]);
  });

  it('each leg builds ONE platform, smoke-tests it, then pushes by digest only', () => {
    const steps = build.steps ?? [];
    const pushes = steps.filter(isBuildPush);
    for (const step of pushes) expect(step.with?.platforms).toBe(expr('matrix.platform'));
    const smokeAt = steps.findIndex((s) => /CREATE EXTENSION pg_cron/.test(s.run ?? ''));
    const pushAt = steps.findIndex(
      (s) => isBuildPush(s) && /push-by-digest=true/.test(String(s.with?.outputs ?? '')),
    );
    expect(smokeAt, 'no smoke step that loads pg_cron').toBeGreaterThan(-1);
    expect(pushAt, 'no push-by-digest step').toBeGreaterThan(smokeAt);
    const smoke = steps[smokeAt].run ?? '';
    expect(smoke).toMatch(/postgres db-smoke:local --version/);
    expect(smoke).toMatch(/wal-g db-smoke:local --version/);
    expect(smoke).toMatch(/initdb -D \/tmp\//);
    // The leg never tags: only the merge job names the image.
    for (const step of pushes) expect(step.with?.tags ?? 'db-smoke:local').toBe('db-smoke:local');
  });

  it('the merge job creates the multi-arch tag from both digests after both legs', () => {
    expect(merge.needs).toBe('build-db');
    expect(build.needs).toBe('publish-walg');
    const run = (merge.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(run).toMatch(/docker buildx imagetools create -t "\$IMAGE"/);
    expect(run).toMatch(/-eq 2/);
    expect((merge.steps ?? []).some(isBuildPush)).toBe(false);
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
    // Executing the binary during the build (natively on each arch) is the only
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
