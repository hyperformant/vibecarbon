/**
 * vibecarbon diagnose — section matrix with kubectl/hcloud stubs.
 */
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  type ExecStubs,
  installExecStubs,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon diagnose', () => {
  let project: string;
  let stubs: ExecStubs;
  beforeEach(() => {
    project = realProject({ deployMode: 'k8s', envs: ['prod'], withDeployedState: true });
    stubs = installExecStubs([
      {
        command: 'kubectl',
        respond: { stdout: JSON.stringify({ items: [] }), exitCode: 0 },
      },
      { command: 'hcloud', respond: { stdout: '', exitCode: 0 } },
      { command: 'curl', respond: { stdout: '', exitCode: 0 } },
    ]);
  });
  afterEach(() => {
    destroyRealProject(project);
    stubs.teardown();
  });

  it('prints help with all section names', () => {
    const r = runCli('diagnose', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'nodes');
    assertExitWith(r, 0, 'pods');
    assertExitWith(r, 0, 'flux');
    assertExitWith(r, 0, 'egress');
  });

  it.each(['nodes', 'pods', 'network', 'flux', 'hcloud', 'egress', 'all'])(
    'accepts known section "%s"',
    (section) => {
      const r = runCli('diagnose', ['prod', section], {
        cwd: project,
        execStubs: stubs,
        timeoutMs: 30_000,
      });
      if (/unknown section|invalid section/i.test(r.stderr)) {
        throw new Error(`section "${section}" misread:\n${r.stderr}`);
      }
    },
  );

  it('rejects unknown section', () => {
    const r = runCli('diagnose', ['prod', 'garbage-section'], {
      cwd: project,
      execStubs: stubs,
      timeoutMs: 15_000,
    });
    if (r.exitCode === 0) {
      throw new Error('diagnose accepted unknown section');
    }
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('diagnose', [], { cwd: '/tmp' });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });
});
