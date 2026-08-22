import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CI-only gates on the published performance surfaces — the two guards that
 * keep LOCAL e2e runs from (a) writing laptop-measured numbers into
 * docs/perf-data.json / README / the carbon copy (2026-08-08 policy: a
 * degraded local uplink once inflated sideload-bearing cells 20-40×) and
 * (b) opening the docs(perf) stat PR at all.
 *
 * Both guards are policy, not incidental structure — losing either one
 * silently turns every local `pnpm test:e2e:batch` into a publisher. These
 * are source-shape pins because the behaviors live at the top of two long
 * entrypoints (runner tail, publish CLI) that a unit harness can't cheaply
 * execute end-to-end.
 */

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('local e2e runs never publish performance surfaces', () => {
  it('runner.ts gates the whole perf-surface pass on GITHUB_ACTIONS', () => {
    const runner = read('tests/e2e/runner.ts');
    const gate = runner.indexOf('if (!process.env.GITHUB_ACTIONS)');
    expect(gate, 'the CI-only gate is gone from runner.ts').toBeGreaterThan(-1);
    // The surface writes must sit AFTER the gate (inside its else branch) —
    // a write hoisted above the gate would run locally.
    for (const write of [
      'updatePerfDataFromRun(',
      'patchReadmeUnifiedPerfTable(',
      'patchInlinePerfMarkers(',
      'syncCarbonPerfData(',
    ]) {
      const idx = runner.indexOf(write);
      expect(idx, `${write} not found in runner.ts — update this pin`).toBeGreaterThan(-1);
      expect(idx, `${write} runs before the GITHUB_ACTIONS gate`).toBeGreaterThan(gate);
    }
  });

  it('runner.ts never shells a PR into existence itself', () => {
    const runner = read('tests/e2e/runner.ts');
    expect(runner).not.toMatch(/gh pr create|publishPr\(/);
  });

  it('publish-perf-pr.ts refuses to publish off any ref that is not main (local = unset = not main)', () => {
    const publisher = read('tests/e2e/metrics/publish-perf-pr.ts');
    const guard = publisher.indexOf("if (ref !== 'main')");
    expect(guard, 'the GITHUB_REF_NAME main-gate is gone').toBeGreaterThan(-1);
    const publish = publisher.indexOf('publishPr(result.changedFiles)');
    expect(publish, 'publishPr call site not found — update this pin').toBeGreaterThan(-1);
    expect(publish, 'publishPr runs before the main-ref guard').toBeGreaterThan(guard);
  });

  it('nothing local invokes publish-perf-pr — the CI workflow is its only caller', () => {
    // Census over every locally-runnable entry surface: npm scripts and the
    // scripts/ helpers. The workflow file is the one allowed caller.
    const pkg = read('package.json');
    expect(pkg).not.toContain('publish-perf-pr');
    const offenders: string[] = [];
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    for (const f of readdirSync(join(ROOT, 'scripts'))) {
      if (read(join('scripts', f)).includes('publish-perf-pr')) offenders.push(`scripts/${f}`);
    }
    expect(offenders, 'local scripts must not invoke the stat-PR publisher').toEqual([]);
    // Sanity: the allowed CI call site still exists (otherwise this census
    // is guarding a publisher nothing runs).
    expect(read('.github/workflows/e2e-us-perf.yml')).toContain(
      'tsx tests/e2e/metrics/publish-perf-pr.ts',
    );
  });
});

describe('hook-bearing git publishers carry the license key', () => {
  // CLASS (run 32309395314's perf publish, 2026-08-19): a workflow step that
  // git-commits/pushes WITHOUT --no-verify runs the repo's husky hooks —
  // pre-push spawns the INTEGRATION suite, whose harness reads
  // process.env.VIBECARBON_TEST_LICENSE_KEY directly (run-cli.ts). The perf
  // job materialized ~/.vibecarbon/license for the pre-commit unit suite but
  // never exported the env var to the publishing step, so the push died on
  // 131 integration failures. The license FILE is not enough; the ENV VAR
  // must reach the step that runs git.
  it('every workflow step that runs a hook-bearing git publisher exports VIBECARBON_TEST_LICENSE_KEY', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const dir = join(ROOT, '.github', 'workflows');
    // The publishers that git-commit/push through husky hooks. Grown, not
    // shrunk: add new hook-bearing publishers here when they appear.
    const HOOK_BEARING = /publish-perf-pr\.ts|semantic-release/;
    const found: string[] = [];
    const missing: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
      const body = read(join('.github', 'workflows', f));
      // Steps start at "- name:" / "- uses:" under jobs.<id>.steps.
      for (const step of body.split(/\n\s+- (?=name:|uses:)/)) {
        // CODE references only — comment lines don't count (the raw-ssh-opts
        // census was fooled by exactly this once; a doc comment naming
        // publish-perf-pr.ts is not an invocation).
        const code = step
          .split('\n')
          .filter((l) => !l.trim().startsWith('#'))
          .join('\n');
        if (!/\brun:/.test(code) || !HOOK_BEARING.test(code)) continue;
        const label = `${f}: ${step.split('\n', 1)[0].replace(/^name:\s*/, '')}`;
        found.push(label);
        if (!step.includes('VIBECARBON_TEST_LICENSE_KEY')) missing.push(label);
      }
    }
    // Sanity: the census must actually see both known publishers, or it is
    // guarding nothing (a refactor moved them and this walk went blind).
    expect(found.join('\n')).toMatch(/publish-perf-pr|perf/i);
    expect(found.join('\n')).toMatch(/release/i);
    expect(
      missing,
      'these steps run a hook-bearing git publisher without exporting VIBECARBON_TEST_LICENSE_KEY — ' +
        'the pre-push integration suite will fail the push (see run 32309395314 perf publish)',
    ).toEqual([]);
  });
});
