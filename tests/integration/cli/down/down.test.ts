/**
 * vibecarbon down — runs against a real project + exec-stubbed npm.
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

describe('vibecarbon down', () => {
  let project: string;
  let stubs: ExecStubs;
  beforeEach(() => {
    project = realProject();
    stubs = installExecStubs([
      { command: 'npm', respond: { stdout: '', exitCode: 0 } },
      { command: 'docker', respond: { stdout: '', exitCode: 0 } },
    ]);
  });
  afterEach(() => {
    destroyRealProject(project);
    stubs.teardown();
  });

  it('prints help', () => {
    const r = runCli('down', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, /Vibecarbon Down|down/i);
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('down', [], { cwd: '/tmp' });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });

  it('invokes npm run dev:stop', () => {
    const r = runCli('down', [], { cwd: project, execStubs: stubs, timeoutMs: 30_000 });
    if (r.exitCode === null) throw new Error(`down timed out`);
    const stopCall = stubs.callsTo('npm').find((c) => c.argv.includes('dev:stop'));
    expect(stopCall).toBeDefined();
    expect(stopCall?.argv).toContain('run');
  });
});
