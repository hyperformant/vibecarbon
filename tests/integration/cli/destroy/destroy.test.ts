/**
 * vibecarbon destroy — flag matrix against a real project.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import { assertExitWith, destroyRealProject, realProject, runCli } from '../../_harness/index.js';

describe('vibecarbon destroy', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod'], withDeployedState: true });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('-orphans accepted by parser', () => {
    const r = runCli('destroy', ['prod', '-orphans', '-y'], { cwd: project, timeoutMs: 15_000 });
    assertExitWith(r, 1, 'No environments found in .vibecarbon.json');
  });

  it('-purge accepted by parser', () => {
    const r = runCli('destroy', ['prod', '-purge', '-y'], { cwd: project, timeoutMs: 15_000 });
    assertExitWith(r, 1, 'No environments found in .vibecarbon.json');
  });

  it('rejects --destroy-orphans (CLI sweep replaced with -orphans)', () => {
    const r = runCli('destroy', ['--destroy-orphans'], { cwd: project });
    assertExitWith(r, 1, 'unknown flag: --destroy-orphans');
  });

  it('rejects --purge-backups (CLI sweep replaced with -purge)', () => {
    const r = runCli('destroy', ['--purge-backups'], { cwd: project });
    assertExitWith(r, 1, 'unknown flag: --purge-backups');
  });

  it('rejects -e short form', () => {
    const r = runCli('destroy', ['-e', 'prod'], { cwd: project });
    assertExitWith(r, 1, 'unknown flag: -e');
  });

  it('off-TTY in multi-env without env arg refuses', () => {
    destroyRealProject(project);
    project = realProject({ envs: ['prod', 'staging'], withDeployedState: true });
    const r = runCli('destroy', [], { cwd: project, timeoutMs: 10_000 });
    if (r.exitCode === 0) {
      throw new Error('destroy succeeded off-TTY in multi-env without env');
    }
  });
});
