/**
 * vibecarbon backup — flag matrix against a real project.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon backup', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod'], withDeployedState: true });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('backup', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Backup');
  });

  it('-l (list) accepted by parser', () => {
    const r = runCli('backup', ['-l', 'prod'], { cwd: project, timeoutMs: 15_000 });
    if (/unknown flag: -l/.test(r.stderr)) {
      throw new Error(`-l rejected:\n${r.stderr}`);
    }
  });

  it.each(['create', 'list', 'download'])('-action %s accepted by parser', (action) => {
    const r = runCli('backup', ['prod', '-action', action, '-y'], {
      cwd: project,
      timeoutMs: 15_000,
    });
    if (/unknown flag|invalid argument/.test(r.stderr)) {
      throw new Error(`-action ${action} rejected:\n${r.stderr}`);
    }
  });

  it('rejects -action wipe (not in enum)', () => {
    const r = runCli('backup', ['prod', '-action', 'wipe', '-y'], {
      cwd: project,
      timeoutMs: 15_000,
    });
    if (r.exitCode === 0) {
      throw new Error('backup accepted -action wipe');
    }
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('backup', ['prod', '-y'], { cwd: '/tmp', timeoutMs: 15_000 });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });
});
