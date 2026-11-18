/**
 * vibecarbon backup — flag matrix against a real project.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import { destroyRealProject, realProject, runCli } from '../../_harness/index.js';

describe('vibecarbon backup', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod'], withDeployedState: true });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('-l (list) accepted by parser', () => {
    const r = runCli('backup', ['-l', 'prod'], { cwd: project, timeoutMs: 15_000 });
    if (/unknown flag: -l/.test(r.stderr)) {
      throw new Error(`-l rejected:\n${r.stderr}`);
    }
  });

  it.each(['create', 'list'])('-action %s accepted by parser', (action) => {
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
});
