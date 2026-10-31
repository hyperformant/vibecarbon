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
 * local dev included, pulls that image). Both build natively per arch on
 * GitHub's ubuntu-24.04 / ubuntu-24.04-arm runners through one reusable
 * workflow (native-multiarch-image.yml), each arch smoke-tested on its own
 * hardware before its digest is pushed, and a merge job joins the two digests
 * under one tag. No workflow sets up QEMU, and no build step leans on the
 * runner's preinstalled binfmt to execute a foreign-arch binary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type Step = {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  'runs-on'?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; matrix?: { include?: Array<Record<string, string>> } };
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
    workflow: '.github/workflows/native-multiarch-image.yml',
    job: 'build',
    image:
      'ghcr.io/hyperformant/postgres and ghcr.io/hyperformant/wal-g (release, via ' +
      'publish-db-image.yml), both into ghcr.io/hyperformant/postgres-dev (branches, via ' +
      'publish-db-image-dev.yml), and ghcr.io/hyperformant/node-runtime (release, via ' +
      'publish-node-runtime-image.yml)',
    platforms: ['linux/amd64', 'linux/arm64'],
    consumers:
      'servers (amd64 only, src/lib/deploy/platform.js) pull the db amd64 child; the arm64 child ' +
      'exists solely for local `vibecarbon up` on Apple Silicon, which pulls this image too. ' +
      'wal-g is consumed only by the db build (COPY --from, both arches). The dev channel is the ' +
      'same build, selected only by VIBECARBON_DB_IMAGE. node-runtime is the base every app ' +
      'image builds FROM: servers and amd64 CI pull the amd64 child, and the arm64 child lets ' +
      'local `vibecarbon up` on Apple Silicon build and run the app natively.',
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

  it('a failed leg stops the other: fail-fast, so no lone digest waits for a merge', () => {
    expect(build.strategy?.['fail-fast']).toBe(true);
  });

  it('the pushed image is proven to be the smoke-tested one (same config digest)', () => {
    const steps = build.steps ?? [];
    const loadAt = steps.findIndex(
      (s) => isBuildPush(s) && s.id === 'load' && s.with?.load === true,
    );
    const pushAt = steps.findIndex((s) => isBuildPush(s) && s.id === 'push');
    const checkAt = steps.findIndex((s) => /"\$SMOKED" != "\$PUSHED"/.test(s.run ?? ''));
    expect(loadAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(loadAt);
    expect(checkAt, 'no config-digest check after the push').toBeGreaterThan(pushAt);
    const recordAt = steps.findIndex((s) => /digests\/\$ARCH/.test(s.run ?? ''));
    expect(recordAt, 'the digest is recorded only once it is proven').toBeGreaterThan(checkAt);
    // One emptiness guard per digest, each its own exit: `test -n a && test
    // -n b` does not stop `set -e`, and two empty digests compare equal.
    const check = steps[checkAt].run ?? '';
    expect(check).toMatch(/if \[ -z "\$SMOKED" \]; then[\s\S]*?exit 1/);
    expect(check).toMatch(/if \[ -z "\$DIGEST" \]; then[\s\S]*?exit 1/);
    expect(check).toMatch(/if \[ -z "\$PUSHED" \]; then[\s\S]*?exit 1/);
    expect(check).not.toMatch(/test -n "\$\w+" &&/);
    // The smoke side comes from the load build's metadata (docker exporter:
    // one manifest, no attestations). The push side can NOT: the push build
    // carries the default provenance attestation, so its result is an index
    // and buildx reports no `containerimage.config.digest` for it (the first
    // real run failed exactly so). It is read from the registry instead, by
    // the digest the push reported.
    expect(steps[checkAt].env).toEqual({
      SMOKED: expr("fromJSON(steps.load.outputs.metadata)['containerimage.config.digest']"),
      DIGEST: expr('steps.push.outputs.digest'),
      NAME: expr('inputs.image'),
      PLATFORM: expr('matrix.platform'),
    });
    expect(JSON.stringify(steps[checkAt].env)).not.toMatch(/steps\.push\.outputs\.metadata/);
    expect(check).toMatch(/docker buildx imagetools inspect --raw "\$NAME@\$DIGEST"/);
    expect(check).toContain('"attestation-manifest"');
    expect(check).toMatch(/PUSHED=\$\(jq -r '\.config\.digest/);
  });

  it('the push keeps its provenance attestation: the guard reads through it, never around it', () => {
    const push = (build.steps ?? []).find((s) => isBuildPush(s) && s.id === 'push');
    expect(push?.with?.provenance).toBeUndefined();
    expect(push?.with?.attests).toBeUndefined();
    expect(JSON.stringify(build.steps)).not.toMatch(/BUILDX_NO_DEFAULT_ATTESTATIONS/);
  });

  it('digest artifacts are named per run attempt, so a partial re-run never clashes', () => {
    const upload = (build.steps ?? []).find((s) => /actions\/upload-artifact@/.test(s.uses ?? ''));
    expect(upload?.with?.name).toBe(
      `${expr('inputs.name')}-digest-${expr('steps.ref.outputs.arch')}-${expr('github.run_attempt')}`,
    );
    const download = (merge.steps ?? []).find((s) =>
      /actions\/download-artifact@/.test(s.uses ?? ''),
    );
    expect(download?.with?.pattern).toBe(`${expr('inputs.name')}-digest-*`);
    // Per-artifact directories: the merge picks each arch's newest attempt.
    expect(download?.with?.['merge-multiple']).toBeUndefined();
    expect(runsOf(merge)).toMatch(/sort -V \| tail -n 1/);
  });

  it("each digest's platform is verified BEFORE the tag is created", () => {
    const run = runsOf(merge);
    const check = run.indexOf('if [ "$got" != "linux/$arch" ]');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(run.indexOf('docker buildx imagetools create'));
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

const WALG_SMOKE = '.github/scripts/smoke-walg-image.sh';
const DB_WORKFLOWS = [
  '.github/workflows/publish-db-image.yml',
  '.github/workflows/publish-db-image-dev.yml',
] as const;

describe('wal-g builds natively per arch in both channels (arch audit F6)', () => {
  // wal-g's Dockerfile executes the binary in a TARGETPLATFORM smoke stage.
  // Built for both arches on one amd64 runner, that RUN only worked through the
  // runner image's preinstalled binfmt. Each arch now builds on its own runner
  // via the shared workflow, so nothing depends on emulation.
  it.each(DB_WORKFLOWS)(
    '%s builds no image itself: every build goes through the shared workflow',
    (file) => {
      for (const [id, job] of Object.entries(workflowOf(file).jobs)) {
        expect((job.steps ?? []).some(isBuildPush), `${file}#${id} runs build-push itself`).toBe(
          false,
        );
      }
      const code = read(file)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      expect(code).not.toMatch(/setup-qemu-action/);
      expect(code, `${file}: pin runners (ubuntu-24.04), never ubuntu-latest`).not.toMatch(
        /ubuntu-latest/,
      );
    },
  );

  it('the smoke script executes wal-g', () => {
    expect(read(WALG_SMOKE)).toMatch(/--entrypoint \/usr\/local\/bin\/wal-g "\$IMAGE" --version/);
  });

  it('release: publish-walg is the shared workflow, gated on a wal-g change, never feeding the db build', () => {
    const wf = workflowOf('.github/workflows/publish-db-image.yml');
    const walg = wf.jobs['publish-walg'] as CallerJob;
    expect(walg.uses).toBe(REUSABLE);
    expect(walg.needs).toBe('walg-ref');
    expect(walg.with).toMatchObject({
      context: 'docker/wal-g',
      image: 'ghcr.io/hyperformant/wal-g',
      tag: expr('needs.walg-ref.outputs.tag'),
      smoke: WALG_SMOKE,
      environment: 'e2e-infra',
    });
    expect(wf.jobs['walg-ref']['runs-on']).toBe('ubuntu-24.04');
    expect(runsOf(wf.jobs['walg-ref'])).toMatch(/ARG WALG_VERSION=v/);
    // Republished only when docker/wal-g changed in the push (or the tag is
    // missing, or by hand): an unchanged rebuild would move the tag's digest
    // for nothing, since the build is not byte-reproducible.
    expect(runsOf(wf.jobs['walg-ref'])).toMatch(
      /git diff --quiet "\$BEFORE" HEAD -- docker\/wal-g/,
    );
    expect((walg as CallerJob & { if?: string }).if).toBe(
      "needs.walg-ref.outputs.publish == 'true'",
    );
    // The db image COPY --froms the wal-g digest its Dockerfile pins, so it
    // must not wait on (or consume) this run's wal-g publish.
    expect((wf.jobs['build-db'] as CallerJob).needs).not.toContain('publish-walg');
  });

  it('dev: build-walg is the shared workflow, consumed by digest by the db build', () => {
    const wf = workflowOf('.github/workflows/publish-db-image-dev.yml');
    const walg = wf.jobs['build-walg'] as CallerJob;
    const db = wf.jobs['build-db'] as CallerJob;
    expect(walg.uses).toBe(REUSABLE);
    expect(walg.with).toMatchObject({
      context: 'docker/wal-g',
      image: expr('needs.plan.outputs.image'),
      tag: expr('needs.plan.outputs.walg-tag'),
      smoke: WALG_SMOKE,
      immutable: true,
    });
    // Like build-db, dev needs no e2e-infra secrets: no environment.
    expect(walg.with?.environment).toBeUndefined();
    expect(runsOf(wf.jobs.plan)).toMatch(/echo "walg-tag=walg-\$\{SHA:0:\$LEN\}"/);
    expect(db.needs).toEqual(['plan', 'build-walg']);
    // The db legs resolve FROM <walg-from> to the reusable workflow's
    // digest-pinned `ref` output, never to the walg-<sha> tag.
    const ctx = String(db.with?.['build-contexts']);
    expect(ctx).toMatch(/needs\.build-walg\.result == 'success'/);
    expect(ctx).toContain(
      "format('{0}=docker-image://{1}', needs.plan.outputs.walg-from, needs.build-walg.outputs.ref)",
    );
    expect(ctx).not.toMatch(/walg-tag/);
  });

  it('the shared workflow exposes the digest-pinned ref the dev db build consumes', () => {
    const wf = workflowOf('.github/workflows/native-multiarch-image.yml');
    const call = (wf.on as { workflow_call: { outputs: Record<string, { value: string }> } })
      .workflow_call;
    expect(call.outputs.ref.value).toBe(expr('jobs.merge.outputs.ref'));
    expect(runsOf(jobsOf('.github/workflows/native-multiarch-image.yml').merge)).toMatch(
      /echo "ref=\$NAME@\$\(jq -r \.digest manifest\.json\)"/,
    );
  });
});

describe('packages: write only on the jobs that publish', () => {
  // OpenSSF Token-Permissions: the workflow default is read-only, and only a
  // job that pushes to ghcr (or calls the shared workflow that does) gets
  // packages: write. A planning job never does.
  const PUBLISHING: Record<string, string[]> = {
    '.github/workflows/native-multiarch-image.yml': ['build', 'merge'],
    '.github/workflows/publish-db-image.yml': ['build-db', 'publish-walg'],
    '.github/workflows/publish-db-image-dev.yml': ['build-db', 'build-walg'],
    '.github/workflows/publish-node-runtime-image.yml': ['build-runtime'],
  };

  it.each(Object.entries(PUBLISHING))('%s', (file, publishing) => {
    const wf = workflowOf(file) as Workflow & { permissions?: unknown };
    expect(wf.permissions, `${file}: workflow default must be read-only`).toEqual({
      contents: 'read',
    });
    const writers = Object.entries(wf.jobs)
      .filter(([, job]) => job.permissions?.packages === 'write')
      .map(([id]) => id)
      .sort();
    expect(writers).toEqual(publishing);
    for (const [id, job] of Object.entries(wf.jobs)) {
      expect(job.permissions, `${file}#${id} declares no permissions`).toBeDefined();
      const extra = Object.keys(job.permissions ?? {}).filter(
        (k) => !['contents', 'packages'].includes(k),
      );
      expect(extra, `${file}#${id} asks for more than contents/packages`).toEqual([]);
    }
  });
});

describe('the release db publish is unchanged by the dev channel', () => {
  const wf = workflowOf('.github/workflows/publish-db-image.yml');
  const build = wf.jobs['build-db'] as CallerJob;

  it('runs only on pushes to main (and by hand), never on pull requests', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect((wf.on.push as { branches: string[] }).branches).toEqual(['main']);
  });

  it('builds the release ref through the shared workflow, from the pinned wal-g digest', () => {
    expect(build.uses).toBe(REUSABLE);
    expect(build.needs).toBe('db-ref');
    expect(build.with).toMatchObject({
      context: 'docker/postgres-walg',
      image: expr('needs.db-ref.outputs.image'),
      tag: expr('needs.db-ref.outputs.tag'),
      smoke: SMOKE,
      environment: 'e2e-infra',
    });
    expect(build.with?.['build-contexts']).toBeUndefined();
    // Anchored on DB_IMAGE itself: DEV_DB_IMAGE must never satisfy the grep.
    const ref = runsOf(wf.jobs['db-ref']);
    expect(ref).toMatch(/grep -oP "\^export const DB_IMAGE\\s\*=/);
    expect(ref).toMatch(/grep -oP "\^export const DB_IMAGE_TAG\\s\*=/);
    expect(read('.github/workflows/publish-db-image.yml')).not.toMatch(/postgres-dev|DEV_DB_IMAGE/);
  });

  it('never re-mints an existing release tag (a wal-g-only push builds no db image)', () => {
    // The tag's -r<N> revision moves with every input change, so a tag that
    // already exists IS this build. db-ref looks it up and build-db is
    // skipped when it is there: a push touching only docker/wal-g (which still
    // triggers this workflow) leaves the release image alone. `immutable`
    // re-checks after the builds so a racing run cannot move it either.
    const ref = runsOf(wf.jobs['db-ref']);
    expect(ref).toMatch(/docker buildx imagetools inspect "\$IMG:\$TAG"/);
    expect(ref).toMatch(/grep -q 'not found'/);
    expect((build as CallerJob & { if?: string }).if).toBe("needs.db-ref.outputs.exists != 'true'");
    expect(build.with?.immutable).toBe(true);
    expect((wf.on.push as { paths: string[] }).paths).toContain('docker/wal-g/**');
  });
});

describe('the node runtime base publishes on merge, once per revision tag', () => {
  const FILE = '.github/workflows/publish-node-runtime-image.yml';
  const wf = workflowOf(FILE);
  const build = wf.jobs['build-runtime'] as CallerJob;
  const ref = runsOf(wf.jobs['runtime-ref']);

  it('runs only on pushes to main that touch its inputs (and by hand), never on pull requests', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch']);
    const push = wf.on.push as { branches: string[]; paths: string[] };
    expect(push.branches).toEqual(['main']);
    expect(push.paths).toEqual(
      expect.arrayContaining(['docker/node-runtime/**', 'src/lib/images.js', FILE]),
    );
    // The README is not an image input (the fingerprint skips it too).
    expect(push.paths).toContain('!docker/node-runtime/README.md');
  });

  it('builds amd64 + arm64 natively through the shared workflow, smoke-tested per arch', () => {
    expect(build.uses).toBe(REUSABLE);
    expect(build.needs).toBe('runtime-ref');
    expect(build.with).toMatchObject({
      context: 'docker/node-runtime',
      image: expr('needs.runtime-ref.outputs.image'),
      tag: expr('needs.runtime-ref.outputs.tag'),
      smoke: '.github/scripts/smoke-node-runtime-image.sh',
    });
    // The shared workflow's matrix is the one that names both platforms.
    expect(builtPlatforms(jobsOf(REUSABLE).build)).toEqual(['linux/amd64', 'linux/arm64']);
  });

  it('reads the ref from NODE_RUNTIME_IMAGE in src/lib/images.js, the CLI authority', () => {
    expect(ref).toMatch(/grep -oP "\^export const NODE_RUNTIME_IMAGE\\s\*=/);
    // A post-publish ref carries @sha256; the tag is split off it first.
    const strip = ref.search(/REF=\$\{REF%@\*\}/);
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(ref.search(/IMG=\$\{REF%:\*\}/));
  });

  it('never re-mints an existing tag: skipped when present, immutable when racing', () => {
    expect(ref).toMatch(/docker buildx imagetools inspect "\$IMG:\$TAG"/);
    expect(ref).toMatch(/grep -q 'not found'/);
    expect(build.if).toBe("needs.runtime-ref.outputs.exists != 'true'");
    expect(build.with?.immutable).toBe(true);
  });

  it('the smoke script runs node, checks the hono user, and refuses npm', () => {
    const smoke = read('.github/scripts/smoke-node-runtime-image.sh');
    expect(smoke).toMatch(/node --version|node -e/);
    expect(smoke).toMatch(/id -u hono/);
    expect(smoke).toMatch(/command -v npm/);
    expect(smoke).toMatch(/< \.nvmrc/);
  });
});

describe("test.yml builds the app FROM this commit's node runtime base", () => {
  const job = jobsOf('.github/workflows/test.yml')['app-image'];
  const steps = job?.steps ?? [];
  const at = (re: RegExp) => steps.findIndex((s) => re.test(s.run ?? ''));

  it('exists, reading the ref from src/lib/images.js', () => {
    expect(job).toBeDefined();
    expect(runsOf(job)).toContain("import('./src/lib/images.js')");
    expect(runsOf(job)).toContain("m.NODE_RUNTIME_IMAGE.split('@')[0]");
  });

  it('builds the runtime from docker/node-runtime, then carbon FROM it, then runs node', () => {
    const runtime = at(/docker build -t "\$NODE_RUNTIME_TAG_REF" docker\/node-runtime/);
    const app = at(
      /docker build --build-arg RUNTIME_IMAGE="\$NODE_RUNTIME_TAG_REF" -t vibecarbon-app:ci carbon/,
    );
    const run = at(/docker run --rm vibecarbon-app:ci node -e 1/);
    expect(runtime).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(runtime);
    expect(run).toBeGreaterThan(app);
  });

  it('needs no secret and no login (it runs on fork and Dependabot PRs)', () => {
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|docker\/login-action|docker login/);
  });
});

describe('release.yml refuses a release whose pinned db image users cannot pull', () => {
  // Every mode pulls DB_IMAGE:DB_IMAGE_TAG, local `up` included. A release
  // cut before publish-db-image finished (or with a private package, or a
  // missing arch) breaks create/up/deploy for every user at once.
  const jobs = jobsOf('.github/workflows/release.yml') as Record<string, Job & { needs?: string }>;
  const gate = jobs['db-image'];
  const run = runsOf(gate);

  it('the release job needs the db-image and mirrored-images gates', () => {
    expect(gate).toBeDefined();
    expect(jobs.release.needs).toEqual(['db-image', 'mirrored-images']);
  });

  it('reads the pair from src/lib/images.js, the CLI authority', () => {
    expect(run).toContain("import('./src/lib/images.js')");
    expect(run).toContain('$GITHUB_ENV');
  });

  it('verifies the node runtime base the app image builds FROM the same way', () => {
    // A generated project's first build pulls NODE_RUNTIME_IMAGE; a release
    // naming an unpublished or private tag breaks every `up` and deploy.
    expect(run).toContain("'NODE_RUNTIME_IMAGE=' + m.NODE_RUNTIME_IMAGE");
    expect(run).toMatch(/for ref in "\$DB_IMAGE:\$DB_IMAGE_TAG" "\$NODE_RUNTIME_IMAGE"; do/);
  });

  it('refuses while the runtime base is pinned by tag alone, or the carbon ARG drifts', () => {
    // A tag is mutable by whoever can push the package; a release must name
    // the exact image every generated project will run on.
    expect(run).toMatch(/case "\$NODE_RUNTIME_IMAGE" in\s+\*@sha256:\*\) ;;/);
    expect(run).toMatch(/is not pinned by digest/);
    expect(run).toContain("grep -oP '^ARG RUNTIME_IMAGE=\\K\\S+' carbon/Dockerfile");
    expect(run).toContain('if [ "$runtime_arg" != "$NODE_RUNTIME_IMAGE" ]; then');
    expect(run.indexOf('is not pinned by digest')).toBeLessThan(run.indexOf('for ref in'));
  });

  it('refuses unless the pinned digest is what the tag resolves to anonymously', () => {
    expect(run).toMatch(/runtime_tag=\$\{NODE_RUNTIME_IMAGE%@\*\}/);
    expect(run).toContain('docker buildx imagetools inspect "$runtime_tag"');
    expect(run).toContain('if [ "$runtime_resolved" != "$runtime_pinned" ]; then');
    expect(run.indexOf('export DOCKER_CONFIG')).toBeLessThan(run.indexOf('"$runtime_tag"'));
  });

  it('every refusal exits non-zero', () => {
    const refusals = run.match(/::error::refusing to release/g)?.length ?? 0;
    expect(refusals).toBe(5);
    expect(run.match(/exit 1/g)?.length).toBe(refusals);
  });

  it('inspects anonymously: an empty DOCKER_CONFIG and no login anywhere in the job', () => {
    expect(run).toMatch(/DOCKER_CONFIG="\$RUNNER_TEMP\/[^"]+"/);
    expect(run).toMatch(/docker buildx imagetools inspect "\$ref"/);
    expect(run.indexOf('export DOCKER_CONFIG')).toBeLessThan(run.indexOf('imagetools inspect'));
    expect(JSON.stringify(gate)).not.toMatch(/docker\/login-action|docker login|secrets\./);
  });

  it('requires both linux/amd64 and linux/arm64 children and refuses otherwise', () => {
    expect(run).toMatch(/for want in linux\/amd64 linux\/arm64; do/);
    expect(run).toMatch(/grep -qx "\$want"/);
    expect(run.match(/::error::refusing to release: \$ref /g)?.length).toBe(2);
  });
});

describe('release.yml refuses a release while any ghcr mirror ref is not anonymously pullable', () => {
  // Servers pull every mirror (MIRRORED_IMAGES) with no login. A new mirror
  // package starts private, so merging refs before publishing and flipping
  // them public breaks every deploy at the first pull.
  const jobs = jobsOf('.github/workflows/release.yml') as Record<string, Job>;
  const gate = jobs['mirrored-images'];
  const run = runsOf(gate);

  it('reads every mirror ref from src/lib/images.js, the CLI authority', () => {
    expect(run).toContain("import('./src/lib/images.js')");
    expect(run).toContain("m.MIRRORED_IMAGES.map((i) => m.k8sMirrorTagRef(i) + ' ' + i.digest)");
    expect(run).toContain('test -n "$pairs"');
  });

  it('inspects each digest-pinned ref anonymously and refuses on any miss', () => {
    expect(run).toMatch(/DOCKER_CONFIG="\$RUNNER_TEMP\/[^"]+"/);
    expect(run.indexOf('export DOCKER_CONFIG')).toBeLessThan(run.indexOf('imagetools inspect'));
    expect(run).toContain('docker buildx imagetools inspect "$ref"');
    expect(run).toMatch(/::error::refusing to release/);
    expect(run).toMatch(/exit 1/);
    expect(JSON.stringify(gate)).not.toMatch(/docker\/login-action|docker login|secrets\./);
  });

  it('refuses when a mirror TAG’s amd64 child is not the pinned digest (k3s pulls by tag)', () => {
    expect(run).toContain('docker buildx imagetools inspect --raw "$tag"');
    expect(run).toMatch(/architecture == "amd64"/);
    expect(run).toContain('if [ "$tagged" != "$pinned" ]; then');
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
    // dependabot/**: those pushes get a read-only token and no secrets, so
    // every db-image bump ran red here (final review M6).
    expect(push['branches-ignore']).toEqual(['main', 'dependabot/**']);
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
    expect((wf.jobs['build-walg'] as CallerJob).with?.image).toBe(expr('needs.plan.outputs.image'));
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
