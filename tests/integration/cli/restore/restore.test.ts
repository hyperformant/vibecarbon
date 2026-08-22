/**
 * vibecarbon restore — flag matrix against a real project.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon restore', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod'], withDeployedState: true });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('restore', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Restore');
  });

  it('-l (list) accepted by parser', () => {
    const r = runCli('restore', ['-l', 'prod'], { cwd: project, timeoutMs: 15_000 });
    if (/unknown flag: -l/.test(r.stderr)) {
      throw new Error(`-l rejected:\n${r.stderr}`);
    }
  });

  it('-source latest accepted by parser', () => {
    const r = runCli('restore', ['prod', '-source', 'latest', '-y'], {
      cwd: project,
      timeoutMs: 15_000,
    });
    if (/unknown flag: -source/.test(r.stderr)) {
      throw new Error(`-source rejected:\n${r.stderr}`);
    }
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('restore', ['prod', '-y'], { cwd: '/tmp', timeoutMs: 15_000 });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });
});
