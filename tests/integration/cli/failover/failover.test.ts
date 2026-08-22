/**
 * vibecarbon failover — flag matrix.
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

describe('vibecarbon failover', () => {
  let project: string;
  let stubs: ExecStubs;
  beforeEach(() => {
    project = realProject({
      deployMode: 'compose-ha',
      envs: ['prod'],
      withDeployedState: true,
    });
    stubs = installExecStubs([
      { command: 'ssh', respond: { stdout: '', exitCode: 0 } },
      { command: 'hcloud', respond: { stdout: '', exitCode: 0 } },
    ]);
  });
  afterEach(() => {
    destroyRealProject(project);
    stubs.teardown();
  });

  it('prints help', () => {
    const r = runCli('failover', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Failover');
  });

  it('-dry accepted by parser and skips ssh entirely', () => {
    const r = runCli('failover', ['prod', '-dry', '-y'], {
      cwd: project,
      execStubs: stubs,
      timeoutMs: 15_000,
    });
    if (/unknown flag: -dry/.test(r.stderr)) {
      throw new Error(`-dry rejected:\n${r.stderr}`);
    }
    expect(stubs.callsTo('ssh').length).toBe(0);
  });

  it('refuses on non-HA mode', () => {
    destroyRealProject(project);
    project = realProject({ deployMode: 'compose', envs: ['prod'], withDeployedState: true });
    const r = runCli('failover', ['prod', '-y'], {
      cwd: project,
      execStubs: stubs,
      timeoutMs: 15_000,
    });
    if (r.exitCode === 0) {
      throw new Error('failover succeeded on non-HA mode');
    }
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('failover', ['prod', '-y'], { cwd: '/tmp', timeoutMs: 15_000 });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });
});
