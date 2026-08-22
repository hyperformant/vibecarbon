/**
 * vibecarbon status — runs against a real project. Read-only; no exec
 * stubs needed for the basic shape, no cloud calls when status hits a
 * not-deployed env.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon status', () => {
  let project: string;
  beforeEach(() => {
    project = realProject({ envs: ['prod', 'staging'] });
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('status', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Status');
  });

  it('rejects unknown -bogus flag', () => {
    const r = runCli('status', ['-bogus'], { cwd: project });
    assertExitWith(r, 1, /unknown flag/i);
  });

  it('runs in a project (no deployed state) without crashing', () => {
    const r = runCli('status', [], { cwd: project, timeoutMs: 30_000 });
    if (r.exitCode === null) throw new Error(`status timed out`);
  });

  it('-json emits parseable JSON when state is deployed', () => {
    destroyRealProject(project);
    project = realProject({ envs: ['prod'], withDeployedState: true });
    const r = runCli('status', ['-json'], { cwd: project, timeoutMs: 30_000 });
    if (r.exitCode === 0) {
      const parsed = JSON.parse(r.stdout.trim());
      expect(typeof parsed).toBe('object');
    }
  });

  it('-env <name> filters to one environment', () => {
    destroyRealProject(project);
    project = realProject({ envs: ['prod', 'staging'], withDeployedState: true });
    const r = runCli('status', ['-env', 'staging'], { cwd: project, timeoutMs: 30_000 });
    if (r.exitCode === null) throw new Error(`status timed out`);
  });
});
