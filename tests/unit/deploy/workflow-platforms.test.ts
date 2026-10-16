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
    workflow: '.github/workflows/native-multiarch-image.yml',
    job: 'build',
    image:
      'ghcr.io/hyperformant/postgres (release, via publish-db-image.yml) and ' +
      'ghcr.io/hyperformant/postgres-dev (branches, via publish-db-image-dev.yml)',
    platforms: ['linux/amd64', 'linux/arm64'],
    consumers:
      'servers (amd64 only, src/lib/deploy/platform.js) pull the amd64 child; the arm64 child ' +
      'exists solely for local `vibecarbon up` on Apple Silicon, which pulls this image too. ' +
      'The dev channel is the same build, selected only by VIBECARBON_DB_IMAGE.',
  },
  {
    workflow: '.github/workflows/publish-db-image-dev.yml',
    job: 'build-walg',
    image: 'a wal-g build pushed by digest into ghcr.io/hyperformant/postgres-dev',
    platforms: ['linux/amd64', 'linux/arm64'],
    consumers:
      "only that dev run's own db legs (both arches), via a named build context, and only " +
      'when the branch changed docker/wal-g. Cross-compiled like publish-walg, so no QEMU.',
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

type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
type CallerJob = Job & { uses?: string; with?: Record<string, string>; if?: string };
const workflowOf = (file: string) => loadYaml(read(file)) as Workflow;
const REUSABLE = './.github/workflows/native-multiarch-image.yml';
const SMOKE = '.github/scripts/smoke-db-image.sh';
/** A job's run: scripts, joined, for regex checks. */
const runsOf = (job: Job | undefined) => (job?.steps ?? []).map((s) => s.run ?? '').join('\n');

describe('the db image builds natively per arch and merges into one tag', () => {
  const jobs = jobsOf('.github/workflows/native-multiarch-image.yml');
  const build = jobs.build;
  const merge = jobs.merge;

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
    const smokeAt = steps.findIndex((s) => /bash "\$SMOKE" smoke:local/.test(s.run ?? ''));
    const pushAt = steps.findIndex(
      (s) => isBuildPush(s) && /push-by-digest=true/.test(String(s.with?.outputs ?? '')),
    );
    expect(smokeAt, 'no smoke step before the push').toBeGreaterThan(-1);
    expect(pushAt, 'no push-by-digest step').toBeGreaterThan(smokeAt);
    // The leg never tags: only the merge job names the image.
    for (const step of pushes) expect(step.with?.tags ?? 'smoke:local').toBe('smoke:local');
  });

  it('the smoke script really starts postgres and loads pg_cron', () => {
    const smoke = read(SMOKE);
    expect(smoke).toMatch(/--entrypoint postgres "\$IMAGE" --version/);
    expect(smoke).toMatch(/--entrypoint wal-g "\$IMAGE" --version/);
    expect(smoke).toMatch(/initdb -D \/tmp\//);
    expect(smoke).toMatch(/CREATE EXTENSION pg_cron/);
  });

  it('the environment is an input with an empty default, used by both jobs', () => {
    const wf = workflowOf('.github/workflows/native-multiarch-image.yml');
    const call = (wf.on as { workflow_call: { inputs: Record<string, { default?: unknown }> } })
      .workflow_call;
    expect(call.inputs.environment.default).toBe('');
    expect(call.inputs.immutable.default).toBe(false);
    for (const job of [build, merge]) {
      expect((job as Job & { environment?: string }).environment).toBe(expr('inputs.environment'));
    }
  });

  it('an immutable tag is re-checked right before create and never moved', () => {
    const run = runsOf(merge);
    expect(run.indexOf('if [ "$IMMUTABLE" = true ]')).toBeGreaterThan(-1);
    expect(run.indexOf('if [ "$IMMUTABLE" = true ]')).toBeLessThan(
      run.indexOf('docker buildx imagetools create'),
    );
    expect(run).toMatch(/grep -q 'not found'/);
  });

  it('the merge job creates the tag from both digests, then verifies and smokes it', () => {
    expect(merge.needs).toBe('build');
    const run = runsOf(merge);
    expect(run).toMatch(/docker buildx imagetools create -t "\$IMAGE"/);
    expect(run).toMatch(/-eq 2/);
    expect(run).toMatch(/for arch in amd64 arm64/);
    expect(run).toMatch(/bash "\$SMOKE" "\$IMAGE"/);
    expect((merge.steps ?? []).some(isBuildPush)).toBe(false);
  });
});

describe('the release db publish is unchanged by the dev channel', () => {
  const wf = workflowOf('.github/workflows/publish-db-image.yml');
  const build = wf.jobs['build-db'] as CallerJob;

  it('runs only on pushes to main (and by hand), never on pull requests', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect((wf.on.push as { branches: string[] }).branches).toEqual(['main']);
  });

  it('builds the release ref through the shared workflow, after wal-g publishes', () => {
    expect(build.uses).toBe(REUSABLE);
    expect(build.needs).toEqual(['publish-walg', 'db-ref']);
    expect(build.with).toMatchObject({
      context: 'docker/postgres-walg',
      image: expr('needs.db-ref.outputs.image'),
      tag: expr('needs.db-ref.outputs.tag'),
      smoke: SMOKE,
      environment: 'e2e-infra',
    });
    expect(build.with?.immutable).toBeUndefined();
    expect(build.with?.['build-contexts']).toBeUndefined();
    // Anchored on DB_IMAGE itself: DEV_DB_IMAGE must never satisfy the grep.
    const ref = runsOf(wf.jobs['db-ref']);
    expect(ref).toMatch(/grep -oP "\^export const DB_IMAGE\\s\*=/);
    expect(ref).toMatch(/grep -oP "\^export const DB_IMAGE_TAG\\s\*=/);
    expect(read('.github/workflows/publish-db-image.yml')).not.toMatch(/postgres-dev|DEV_DB_IMAGE/);
  });
});

describe('the db image dev channel (publish-db-image-dev.yml)', () => {
  const FILE = '.github/workflows/publish-db-image-dev.yml';
  const wf = workflowOf(FILE);
  const plan = runsOf(wf.jobs.plan);
  const build = wf.jobs['build-db'] as CallerJob;

  it('runs on branch pushes and by hand, NEVER on pull_request*', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    const push = wf.on.push as { 'branches-ignore': string[]; paths: string[] };
    expect(push['branches-ignore']).toEqual(['main']);
    expect(push.paths).toEqual(
      expect.arrayContaining(['docker/postgres-walg/**', 'docker/wal-g/**']),
    );
    expect(read(FILE)).not.toMatch(/^\s*pull_request/m);
  });

  it('publishes only to postgres-dev, refusing any other name', () => {
    expect(plan).toMatch(/grep -oP "\^export const DEV_DB_IMAGE\\s\*=/);
    expect(plan).toMatch(/case "\$IMG" in \*\/postgres-dev\) ;;/);
    expect(build.uses).toBe(REUSABLE);
    expect(build.with?.image).toBe(expr('needs.plan.outputs.image'));
    const walgPush = (wf.jobs['build-walg'].steps ?? []).find(isBuildPush);
    expect(String(walgPush?.with?.outputs)).toMatch(
      /^type=image,name=\$\{\{ needs\.plan\.outputs\.image \}\},push-by-digest=true,/,
    );
    // Nothing names the release package as a push target.
    const code = read(FILE)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/hyperformant\/postgres(?!-dev)\b/);
  });

  it('tags are <DB_IMAGE_TAG>-<sha> of the last image-input commit, never rebuilt', () => {
    expect(build.with?.tag).toBe(expr('needs.plan.outputs.tag'));
    expect(plan).toMatch(/DEV_TAG="\$TAG-\$\{SHA:0:\$LEN\}"/);
    expect(plan).toMatch(/SHA=\$\(git log -1 --format=%H HEAD -- /);
    expect(build.if).toMatch(/needs\.plan\.outputs\.exists != 'true'/);
    expect(build.with?.immutable).toBe(true);
    // Two runs for one tag queue rather than race imagetools create.
    expect((build as CallerJob & { concurrency?: unknown }).concurrency).toEqual({
      group: `publish-db-image-dev-${expr('needs.plan.outputs.tag')}`,
      'cancel-in-progress': false,
    });
    // Dev needs no e2e-infra secrets: the shared jobs run with no environment.
    expect(build.with?.environment).toBeUndefined();
    expect(wf.jobs['build-walg'] as CallerJob).toMatchObject({
      if: expect.stringMatching(/needs\.plan\.outputs\.walg-changed == 'true'/),
    });
  });

  it('the plan pathspec and the push trigger paths are the e2e harness pathspec', async () => {
    const { DB_IMAGE_INPUT_PATHSPEC } = await import('../../e2e/utils/db-image-select.js');
    expect(DB_IMAGE_INPUT_PATHSPEC).toContain('src/lib/images.js');
    const asTrigger = DB_IMAGE_INPUT_PATHSPEC.map((p: string) =>
      p.startsWith(':(exclude)')
        ? `!${p.slice(':(exclude)'.length)}`
        : p.endsWith('.js')
          ? p
          : `${p}/**`,
    );
    expect((wf.on.push as { paths: string[] }).paths).toEqual(asTrigger);
    const quoted = DB_IMAGE_INPUT_PATHSPEC.map((p: string) =>
      p.startsWith(':') ? `'${p}'` : p,
    ).join(' ');
    expect(plan).toContain(`git log -1 --format=%H HEAD -- ${quoted}`);
  });
});

describe('the dev channel cleanup (cleanup-db-image-dev.yml)', () => {
  const FILE = '.github/workflows/cleanup-db-image-dev.yml';
  const wf = workflowOf(FILE);
  const jobs = Object.entries(wf.jobs);

  it('runs daily, one job, scoped to postgres-dev with packages: write only there', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(jobs.map(([id]) => id)).toEqual(['prune']);
    const prune = wf.jobs.prune as Job & {
      permissions?: Record<string, string>;
      env?: Record<string, string>;
    };
    expect(prune.permissions).toEqual({ packages: 'write' });
    expect((wf as unknown as { permissions: unknown }).permissions).toEqual({ contents: 'read' });
    expect(prune.env).toMatchObject({ PACKAGE: 'postgres-dev', MAX_AGE_DAYS: '14' });
    const del = (prune.steps ?? []).filter((s) =>
      /actions\/delete-package-versions@/.test(s.uses ?? ''),
    );
    expect(del).toHaveLength(1);
    expect(del[0].with).toMatchObject({
      'package-name': 'postgres-dev',
      'package-type': 'container',
    });
    // With no ids the action deletes the oldest version regardless of age.
    expect((del[0] as Step & { if?: string }).if).toBe("steps.old.outputs.ids != ''");
    expect(read(FILE)).not.toMatch(/package-name:\s*postgres\s*$/m);
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
