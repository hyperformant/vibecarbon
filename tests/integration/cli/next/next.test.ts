/**
 * vibecarbon ? / vibecarbon next — the "what's next" guide.
 *
 * The harness spawns the CLI with piped stdin, so `process.stdin.isTTY` is
 * always false in these runs: every case here exercises the off-TTY,
 * print-only branch (src/next.js never prompts or launches a child when it
 * isn't interactive). That keeps the whole suite hermetic — no clack input
 * to script, no child process to stub beyond docker.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  installExecStubs,
  realProject,
  runCli,
} from '../../_harness/index.js';

// A `docker compose ps --format json` stub that reports no running
// services (docker reachable, stack down). Used wherever the test doesn't
// care about local-dev state, so the real `docker` binary on the host is
// never invoked.
function dockerNotRunningStub() {
  return installExecStubs([
    { command: 'docker', matches: /compose ps/, respond: { stdout: '', exitCode: 0 } },
  ]);
}

// A `docker compose ps --format json` stub that reports one running
// service, as `docker compose ps --format json` emits it: one NDJSON
// object per line.
function dockerRunningStub() {
  return installExecStubs([
    {
      command: 'docker',
      matches: /compose ps/,
      respond: { stdout: '{"Service":"db","State":"running"}\n', exitCode: 0 },
    },
  ]);
}

describe('vibecarbon ? / vibecarbon next', () => {
  let project: string | null = null;
  let stubs: ReturnType<typeof installExecStubs> | null = null;

  afterEach(() => {
    if (project) destroyRealProject(project);
    project = null;
    stubs?.teardown();
    stubs = null;
  });

  it('next -h prints help mentioning vibecarbon ?', () => {
    const r = runCli('next', ['-h'], { cwd: process.cwd() });
    assertSuccess(r);
    assertExitWith(r, 0, 'vibecarbon ?');
  });

  it('? -h exits 0', () => {
    const r = runCli('?', ['-h'], { cwd: process.cwd() });
    assertExitWith(r, 0);
  });

  it('rejects unknown -bogus flag', () => {
    const r = runCli('next', ['-bogus'], { cwd: process.cwd() });
    assertExitWith(r, 1, /unknown flag/i);
  });

  it('in an empty directory, points at vibecarbon create and never the generic project-guard message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-next-empty-'));
    try {
      const r = runCli('?', [], { cwd: dir, timeoutMs: 30_000 });
      assertSuccess(r);
      expect(r.stdout).toContain('vibecarbon create');
      expect(r.stdout).not.toContain('Not in a Vibecarbon project directory.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a project with docker unreachable points at vibecarbon up', () => {
    project = realProject();
    stubs = installExecStubs([{ command: 'docker', respond: { exitCode: 1 } }]);
    const r = runCli('next', [], {
      cwd: project,
      timeoutMs: 30_000,
      execStubs: { binPath: stubs.binPath },
    });
    assertSuccess(r);
    expect(r.stdout).toContain('vibecarbon up');
  });

  it('a project with a running local stack points at vibecarbon configure', () => {
    project = realProject();
    stubs = dockerRunningStub();
    const r = runCli('next', [], {
      cwd: project,
      timeoutMs: 30_000,
      execStubs: { binPath: stubs.binPath },
    });
    assertSuccess(r);
    expect(r.stdout).toContain('vibecarbon configure');
  });

  it('a running stack plus a configured feature (SMTP) points at vibecarbon deploy', () => {
    project = realProject();
    stubs = dockerRunningStub();
    appendFileSync(join(project, '.env.local'), '\nSMTP_HOST=smtp.example.com\nSMTP_PASS=x\n');
    const r = runCli('next', [], {
      cwd: project,
      timeoutMs: 30_000,
      execStubs: { binPath: stubs.binPath },
    });
    assertSuccess(r);
    expect(r.stdout).toContain('vibecarbon deploy');
  });

  it('a deployed environment shows the operations menu (status, destroy prod)', () => {
    project = realProject();
    stubs = dockerNotRunningStub();
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    // realProject() only ever writes the legacy `envs` key; the guide reads
    // `environments`, so it has to be set explicitly here.
    config.environments = {
      prod: { status: 'deployed', deployMode: 'compose', region: 'nbg1' },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const r = runCli('next', [], {
      cwd: project,
      timeoutMs: 30_000,
      execStubs: { binPath: stubs.binPath },
    });
    assertSuccess(r);
    expect(r.stdout).toContain('vibecarbon status');
    expect(r.stdout).toContain('vibecarbon destroy prod');
  });

  it('? and next print identical output for the same project state', () => {
    project = realProject();
    stubs = dockerRunningStub();
    const opts = {
      cwd: project,
      timeoutMs: 30_000,
      execStubs: { binPath: stubs.binPath },
    };
    const question = runCli('?', [], opts);
    const spelled = runCli('next', [], opts);
    assertSuccess(question);
    assertSuccess(spelled);
    expect(question.stdout).toBe(spelled.stdout);
  });
});
