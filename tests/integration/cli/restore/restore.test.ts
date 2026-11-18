/**
 * vibecarbon restore — flag matrix against a real project.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import { assertExitWith, destroyRealProject, realProject, runCli } from '../../_harness/index.js';

describe('vibecarbon restore', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod'], withDeployedState: true });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('-l (list) accepted by parser', () => {
    const r = runCli('restore', ['-l', 'prod'], { cwd: project, timeoutMs: 15_000 });
    assertExitWith(r, 1, 'No deployed environments to restore.');
  });

  it('-source latest accepted by parser', () => {
    const r = runCli('restore', ['prod', '-source', 'latest', '-y'], {
      cwd: project,
      timeoutMs: 15_000,
    });
    assertExitWith(r, 1, 'No deployed environments to restore.');
  });
});
