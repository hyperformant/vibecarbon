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

  it('invokes npm run dev:reset with -y', () => {
    const r = runCli('reset', ['-y'], { cwd: project, execStubs: stubs, timeoutMs: 30_000 });
    if (r.exitCode === null) throw new Error(`reset timed out`);
    const resetCall = stubs.callsTo('npm').find((c) => c.argv.includes('dev:reset'));
    expect(resetCall).toBeDefined();
    expect(resetCall?.argv).toContain('run');
  });
});
