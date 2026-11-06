/**
 * Which lifecycle steps a scenario may skip, and which none may.
 *
 * - Warm deploys run in every scenario of a batch: nothing in the lifecycle,
 *   the dependency table, the `--minimal` preset or a registry row may drop
 *   `warm-deploy`. (A warm deploy is what the push-to-deploy loop customers
 *   live in costs; a batch without it publishes no such number.)
 * - No registry row skips a step: every provider runs the same lifecycle, so a
 *   gap in one shows up as a failure rather than a blank column.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../config.js';
import { expandSkippedSteps, STEP_DEPENDENTS } from '../../e2e/scenarios/step-dependencies.js';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const registry = testConfig.e2e.providers as unknown as Record<
  string,
  { scenarios: { mode: string; skipSteps?: readonly string[] }[] }
>;

describe('warm-deploy runs in every scenario', () => {
  it('no lifecycle filter drops it', () => {
    const src = read('../../e2e/scenarios/_run-lifecycle.ts');
    expect(src).toContain("name: 'warm-deploy',");
    expect(src).not.toMatch(/s\.name !== 'warm-deploy'/);
    expect(src).not.toMatch(/name === 'warm-deploy'\s*\)\s*(continue|return)/);
  });

  it('is in no step dependency, so skipping another step never takes it along', () => {
    for (const [step, dependents] of Object.entries(STEP_DEPENDENTS)) {
      expect(dependents, step).not.toContain('warm-deploy');
    }
    for (const step of ['scale', 'verify-scale', 'failover', 'backup', 'destroy']) {
      expect([...expandSkippedSteps(new Set([step]))]).not.toContain('warm-deploy');
    }
  });

  it('the --minimal preset keeps it', () => {
    const src = read('../../e2e/runner.ts');
    const preset = src.slice(src.indexOf("args.includes('--minimal')"));
    const list = preset.slice(0, preset.indexOf(']'));
    expect(list).not.toContain('warm-deploy');
  });

  it('no registry scenario skips it', () => {
    for (const [provider, entry] of Object.entries(registry)) {
      for (const s of entry.scenarios) {
        expect(s.skipSteps ?? [], `${provider}/${s.mode}`).not.toContain('warm-deploy');
      }
    }
  });
});

describe('every provider runs the same steps', () => {
  it('no scenario skips anything', () => {
    for (const [provider, entry] of Object.entries(registry)) {
      for (const s of entry.scenarios) {
        expect(s.skipSteps ?? [], `${provider}/${s.mode}`).toEqual([]);
      }
    }
  });

  it('the lifecycle applies the scenario skips on top of the flag', () => {
    const src = read('../../e2e/scenarios/_run-lifecycle.ts');
    expect(src).toContain('...(config.skipSteps ?? [])');
  });
});
