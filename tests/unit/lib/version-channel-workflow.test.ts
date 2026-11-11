/**
 * The workflow cannot run until it is on main, and it runs once a day after
 * that, so its shape is what can be proved before then. Each check is a way it
 * could publish something it should not, or stop publishing unnoticed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { amd64Child, planOutputs } from '../../../scripts/version-channel.mjs';
import { bundledImageSet } from '../../../src/lib/images.js';
import { CHANNEL_SCHEMA } from '../../../src/lib/version-channel.js';

const PATH = '.github/workflows/version-channel.yml';

type Step = {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  uses?: string;
  secrets?: string;
  with?: Record<string, string>;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string };
  jobs: Record<string, Job>;
};

const text = readFileSync(PATH, 'utf-8');
const workflow = loadYaml(text) as Workflow;
const { jobs } = workflow;
const needs = (job: Job) => [job.needs ?? []].flat();
const runs = (job: Job) => (job.steps ?? []).map((s) => s.run ?? '').join('\n');
const allRuns = Object.values(jobs).map(runs).join('\n');

describe('version-channel workflow', () => {
  it('runs on its schedule or by hand, and never from an event a stranger can raise', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('runs one at a time', () => {
    expect(workflow.concurrency.group).toBe('version-channel');
  });

  it('holds main only: every job needs the gated plan, or carries the gate itself', () => {
    expect(jobs.plan.if).toBe("github.ref == 'refs/heads/main'");
    expect(jobs.escalate.if).toContain("github.ref == 'refs/heads/main'");
    const reachesPlan = (name: string): boolean =>
      name === 'plan' || needs(jobs[name]).some(reachesPlan);
    for (const name of Object.keys(jobs)) {
      expect(reachesPlan(name), name).toBe(true);
    }
    // A job with always() in its `if` runs past a skipped plan unless it says so.
    for (const [name, job] of Object.entries(jobs)) {
      if (job.if?.includes('always()')) expect(name).toBe('escalate');
    }
  });

  it('every write is scoped to the one job that needs it', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const writers = Object.fromEntries(
      Object.entries(jobs).flatMap(([name, job]) =>
        Object.entries(job.permissions ?? {})
          .filter(([, level]) => level === 'write')
          .map(([scope]) => [`${name}:${scope}`, true]),
      ),
    );
    expect(Object.keys(writers).sort()).toEqual([
      'compose-smoke:issues',
      'escalate:issues',
      'mirror:packages',
      'publish:contents',
    ]);
  });

  it('nothing is published before the copies exist and every smoke test passed', () => {
    expect(needs(jobs.publish).sort()).toEqual([
      'compose-smoke',
      'k3s-smoke',
      'plan',
      'pull-check',
    ]);
    // No status function, so GitHub's implicit success() applies: a failed or
    // skipped smoke test skips the publish.
    expect(jobs.publish.if).toBeUndefined();
    for (const smoke of ['pull-check', 'compose-smoke', 'k3s-smoke']) {
      expect(needs(jobs[smoke])).toContain('mirror');
      expect(jobs[smoke].if).toBeUndefined();
    }
    expect(jobs.mirror.if).toBe("needs.plan.outputs.changed == 'true'");
  });

  it('reuses the one mirror job rather than a copy of it', () => {
    expect(jobs.mirror.uses).toBe('./.github/workflows/mirror-images.yml');
    expect(jobs.mirror.secrets).toBe('inherit');
    expect(jobs.mirror.with?.include).toContain('needs.plan.outputs.include');
    expect(text).not.toContain('imagetools');
  });

  it('reuses the compose smoke test, with the refs it is about to publish', () => {
    const job = jobs['compose-smoke'];
    expect(job.uses).toBe('./.github/workflows/docker-newest.yml');
    expect(job.permissions?.issues).toBe('write');
    expect(job.with?.traefik_image).toContain('needs.plan.outputs.traefik_image');
    expect(job.with?.docker_socket_proxy_image).toContain(
      'needs.plan.outputs.docker_socket_proxy_image',
    );
  });

  it('the pull check has no login, so it proves a node can pull', () => {
    const job = jobs['pull-check'];
    expect(JSON.stringify(job.steps)).not.toMatch(/login/i);
    expect(runs(job)).toContain('docker pull --platform linux/amd64 "$ref"');
    expect(job.steps?.[0].env?.REFS).toContain('needs.plan.outputs.refs');
  });

  const k3sSmokeStep = () => jobs['k3s-smoke'].steps?.find((s) => s.run?.includes('vitest'));
  const k3sSmokeTests = () =>
    [...(k3sSmokeStep()?.run ?? '').matchAll(/tests\/integration\/docker\/\S+\.test\.ts/g)].map(
      ([test]) => test,
    );

  it('the k3s smoke tests exist and each runs the versions about to go out', () => {
    const step = k3sSmokeStep();
    expect(step?.env?.DOCKER_INTEGRATION).toBe('true');
    expect(step?.env?.VC_K3S_VERSION).toContain('needs.plan.outputs.k3s');
    const tests = k3sSmokeTests();
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      expect(existsSync(test), test).toBe(true);
      expect(readFileSync(test, 'utf-8'), test).toMatch(/process\.env\.VC_K3S_VERSION/);
    }
  });

  it('every Docker test on the k3s release the CLI installs runs in the k3s smoke', () => {
    // A test that boots k3sVersion() proves something about that release, so
    // it has to prove it about the next one before the list names it.
    const dir = 'tests/integration/docker';
    const onRelease = readdirSync(dir, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => `${dir}/${f}`)
      .filter((f) => /\bk3sVersion\(\)/.test(readFileSync(f, 'utf-8')));
    expect(onRelease.length).toBeGreaterThan(0);
    expect(k3sSmokeTests().sort()).toEqual(onRelease.sort());
  });

  it('only publish writes the branch, without force, after the CLI validator', () => {
    const others = Object.entries(jobs).filter(([name]) => name !== 'publish');
    for (const [name, job] of others) expect(runs(job), name).not.toContain('git push');
    const script = runs(jobs.publish);
    expect(script).toContain('git push origin HEAD:channel');
    expect(script).not.toMatch(/--force|-f\b/);
    expect(script.indexOf('version-channel.mjs write')).toBeLessThan(script.indexOf('git push'));
  });

  it('a value from the plan reaches a shell only through env', () => {
    expect(allRuns).not.toContain('${{');
  });

  it('every action is pinned by commit', () => {
    const uses = Object.values(jobs).flatMap((job) => (job.steps ?? []).map((s) => s.uses ?? ''));
    expect(uses.filter(Boolean).length).toBeGreaterThan(3);
    for (const ref of uses.filter(Boolean)) expect(ref).toMatch(/@[a-f0-9]{40}$/);
  });

  it('a new major gets one issue, a failed run gets one issue, and neither is a new one each day', () => {
    const script = runs(jobs.escalate);
    expect(needs(jobs.escalate).sort()).toEqual(
      ['plan', 'mirror', 'pull-check', 'compose-smoke', 'k3s-smoke', 'publish'].sort(),
    );
    expect(jobs.escalate.steps?.[0].env?.MAJORS).toContain('needs.plan.outputs.majors');
    expect(jobs.escalate.steps?.[0].env?.FAILED).toContain("contains(needs.*.result, 'failure')");
    expect(script).toContain('gh issue edit "$number"');
    expect(script).toContain('gh issue create --title "$1"');
    expect(script).toContain('map(select(.title == env.TITLE))[0].number');
    expect(script).toContain('open_or_update ');
  });

  it("the plan's outputs are the ones its script writes", () => {
    const out = planOutputs({
      file: { schema: CHANNEL_SCHEMA, ...bundledImageSet() },
      changed: false,
      include: [],
      refs: ['a', 'b'],
      majors: [{ name: 'x/y', current: '1.0', newest: '2.0' }],
      notes: [],
    });
    expect(Object.keys(out).sort()).toEqual(Object.keys(jobs.plan.outputs ?? {}).sort());
    for (const [key, value] of Object.entries(out)) expect(value, key).not.toContain('\n');
    expect(out.majors).toBe('x/y 1.0 to 2.0');
  });
});

describe("the plan's read of an upstream index", () => {
  const AMD64 = `sha256:${'a'.repeat(64)}`;
  const index = (manifests: unknown[]) => new TextEncoder().encode(JSON.stringify({ manifests }));

  it('takes the amd64 child, and digests the bytes rather than a header', () => {
    const bytes = index([
      { digest: `sha256:${'b'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
      { digest: `sha256:${'c'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' } },
      { digest: AMD64, platform: { os: 'linux', architecture: 'amd64' } },
    ]);
    expect(amd64Child('x', bytes).digest).toBe(AMD64);
    expect(amd64Child('x', bytes).index).toBe(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    );
  });

  it('refuses an index with no amd64, naming the image', () => {
    expect(() => amd64Child('x/y:1', index([]))).toThrow('no linux/amd64 in x/y:1');
  });
});
