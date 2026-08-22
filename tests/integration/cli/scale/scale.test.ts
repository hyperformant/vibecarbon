/**
 * vibecarbon scale — flag matrix.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon scale', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ deployMode: 'k8s', envs: ['prod'], withDeployedState: true });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('scale', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Scale');
  });

  it('-type cx33 accepted by parser', () => {
    const r = runCli('scale', ['prod', '-type', 'cx33', '-y'], {
      cwd: project,
      timeoutMs: 15_000,
    });
    if (/unknown flag: -type/.test(r.stderr)) {
      throw new Error(`-type rejected:\n${r.stderr}`);
    }
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('scale', ['prod', '-y'], { cwd: '/tmp', timeoutMs: 15_000 });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });
});
