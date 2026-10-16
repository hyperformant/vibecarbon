/**
 * vibecarbon reset — runs against a real project + exec-stubbed npm.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  type ExecStubs,
  installExecStubs,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon reset', () => {
  let project: string;
  let stubs: ExecStubs;
  beforeEach(() => {
    project = realProject();
    stubs = installExecStubs([{ command: 'npm', respond: { stdout: '', exitCode: 0 } }]);
  });
  afterEach(() => {
    destroyRealProject(project);
    stubs.teardown();
  });

  it('prints help', () => {
    const r = runCli('reset', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, /Vibecarbon Reset|reset/i);
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('reset', ['-y'], { cwd: '/tmp' });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });

  // Final review M9: without a TTY and without -y the confirm prompt had
  // nobody to ask and the run crashed with exit 70. Now: exit 1, name -y,
  // and never run dev:reset.
  it('refuses without a TTY and without -y: pass -y, exit 1, nothing reset', () => {
    const r = runCli('reset', [], { cwd: project, execStubs: stubs, timeoutMs: 30_000 });
    assertExitWith(r, 1, 'needs an interactive terminal');
    assertExitWith(r, 1, /-y\s+confirm deleting all local database data/);
    expect(stubs.callsTo('npm').some((c) => c.argv.includes('dev:reset'))).toBe(false);
  });

  it('invokes npm run dev:reset with -y', () => {
    const r = runCli('reset', ['-y'], { cwd: project, execStubs: stubs, timeoutMs: 30_000 });
    if (r.exitCode === null) throw new Error(`reset timed out`);
    const resetCall = stubs.callsTo('npm').find((c) => c.argv.includes('dev:reset'));
    expect(resetCall).toBeDefined();
    expect(resetCall?.argv).toContain('run');
  });
});
