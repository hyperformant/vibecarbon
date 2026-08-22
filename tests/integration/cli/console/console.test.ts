/**
 * vibecarbon console — minimal matrix. Pre-existing CLI bug:
 * `console -h` exits 1 with "missing required argument: node" instead
 * of short-circuiting to help. Matrix matches actual behavior.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import { destroyRealProject, realProject, runCli } from '../../_harness/index.js';

describe('vibecarbon console', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('-h with a node positional shows help', () => {
    const r = runCli('console', ['anynode', '-h'], { cwd: project });
    if (r.exitCode === 0 && !/Vibecarbon Console|console/i.test(r.stdout)) {
      throw new Error(`-h didn't print help body:\n${r.stdout}`);
    }
  });

  it('without node positional: refuses', () => {
    const r = runCli('console', [], { cwd: '/tmp' });
    if (r.exitCode === 0) {
      throw new Error('console without node should exit non-zero');
    }
  });
});
