/**
 * vibecarbon destroy — flag matrix against a real project.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon destroy', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod'], withDeployedState: true });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('destroy', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Destroy');
    assertExitWith(r, 0, '-orphans');
    assertExitWith(r, 0, '-purge');
  });

  it('-orphans accepted by parser', () => {
    const r = runCli('destroy', ['prod', '-orphans', '-y'], { cwd: project, timeoutMs: 15_000 });
    if (/unknown flag: -orphans/.test(r.stderr)) {
      throw new Error(`-orphans rejected:\n${r.stderr}`);
    }
  });

  it('-purge accepted by parser', () => {
    const r = runCli('destroy', ['prod', '-purge', '-y'], { cwd: project, timeoutMs: 15_000 });
    if (/unknown flag: -purge/.test(r.stderr)) {
      throw new Error(`-purge rejected:\n${r.stderr}`);
    }
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

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('destroy', ['prod', '-y'], { cwd: '/tmp', timeoutMs: 10_000 });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
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
