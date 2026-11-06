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
    // Recursive: scripts/ may have subdirectories — a
    // helper nested one level down is exactly as locally-runnable as a
    // top-level one, so the census walks files at every depth.
    const walk = (rel: string): void => {
      for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const childRel = join(rel, entry.name);
        if (entry.isDirectory()) walk(childRel);
        else if (read(childRel).includes('publish-perf-pr')) offenders.push(childRel);
      }
    };
    walk('scripts');
    expect(offenders, 'local scripts must not invoke the stat-PR publisher').toEqual([]);
    // Sanity: the allowed CI call site still exists (otherwise this census
    // is guarding a publisher nothing runs).
    expect(read('.github/workflows/e2e-us-perf.yml')).toContain(
      'tsx tests/e2e/metrics/publish-perf-pr.ts',
    );
  });
});
