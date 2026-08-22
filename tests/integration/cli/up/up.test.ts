/**
 * vibecarbon up — runs against a real project + exec-stubbed pnpm/docker.
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

describe('vibecarbon up', () => {
  let project: string;
  let stubs: ExecStubs;
  beforeEach(() => {
    project = realProject();
    stubs = installExecStubs([
      { command: 'docker', respond: { stdout: '', exitCode: 0 } },
      { command: 'pnpm', respond: { stdout: '', exitCode: 0 } },
      { command: 'npm', respond: { stdout: '', exitCode: 0 } },
      { command: 'bun', respond: { stdout: '', exitCode: 0 } },
    ]);
  });
  afterEach(() => {
    destroyRealProject(project);
    stubs.teardown();
  });

  describe('help', () => {
    it('prints help', () => {
      const r = runCli('up', ['-h'], { cwd: project });
      assertSuccess(r);
      assertExitWith(r, 0, 'Vibecarbon Up');
    });
  });

  describe('not in a project', () => {
    it('refuses outside a vibecarbon project', () => {
      const r = runCli('up', [], { cwd: '/tmp' });
      assertExitWith(r, 1, /Not in a Vibecarbon project/i);
    });
  });

  describe('orchestration', () => {
    it('invokes docker compose ps for the port probe', () => {
      const r = runCli('up', [], { cwd: project, execStubs: stubs, timeoutMs: 30_000 });
      if (r.exitCode === null) throw new Error(`up timed out:\n${r.stderr}`);
      const dockerCalls = stubs.callsTo('docker');
      expect(dockerCalls.length).toBeGreaterThan(0);
      // `up` fail-fast preflights the daemon with `docker info` before booting
      // the stack, so the compose port-probe is not necessarily the first call.
      expect(dockerCalls[0].argv).toEqual(['info']);
      expect(dockerCalls.some((c) => c.argv.includes('compose'))).toBe(true);
    });

    it('invokes the package manager with dev:start', () => {
      const r = runCli('up', [], { cwd: project, execStubs: stubs, timeoutMs: 30_000 });
      if (r.exitCode === null) throw new Error(`up timed out:\n${r.stderr}`);
      // The real project is npm-based, so the script needs the `run` prefix —
      // `npm dev:start` is not a thing.
      const npmCalls = stubs.callsTo('npm');
      const startCall = npmCalls.find((c) => c.argv.includes('dev:start'));
      expect(startCall).toBeDefined();
      expect(startCall?.argv).toContain('run');
    });
  });
});
