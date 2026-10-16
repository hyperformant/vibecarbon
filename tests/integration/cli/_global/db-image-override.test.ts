/**
 * VIBECARBON_DB_IMAGE at the CLI boundary (cli.js checkDbImageOverride).
 *
 * Help and version always print, even with a malformed override: the check
 * runs after top-level `-h`/`-v` and is skipped for a command's own `-h`/`-v`.
 * Its output (the malformed-ref error and the "using dev db image" warning)
 * is a diagnostic, so it goes to stderr and never into a command's stdout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  destroyRealProject,
  type ExecStubs,
  installExecStubs,
  realProject,
  runCli,
} from '../../_harness/index.js';

const BAD = { VIBECARBON_DB_IMAGE: 'ghcr.io/hyperformant/postgres-dev' };
const GOOD = {
  VIBECARBON_DB_IMAGE: 'ghcr.io/hyperformant/postgres-dev:17.11-walg3.0.9-r1-0123456789ab',
};

describe('VIBECARBON_DB_IMAGE check ordering', () => {
  it('top-level -v prints the version despite a malformed override', () => {
    const r = runCli('-v', [], { env: BAD });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/vibecarbon v\d/);
  });

  it('top-level -h prints help despite a malformed override', () => {
    const r = runCli('-h', [], { env: BAD });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/COMMANDS|Usage|USAGE/);
  });

  it("a command's -h prints its help despite a malformed override", () => {
    const r = runCli('down', ['-h'], { env: BAD });
    expect(r.exitCode).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/must be a full image ref/);
  });

  it("a -v after -- is not the command's own: shell still refuses a malformed override", () => {
    const r = runCli('shell', ['--', 'psql', '-v', 'ON_ERROR_STOP=1'], { env: BAD });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/VIBECARBON_DB_IMAGE must be a full image ref/);
  });

  it('a real command still refuses a malformed override, on stderr', () => {
    const r = runCli('down', [], { env: BAD });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/VIBECARBON_DB_IMAGE must be a full image ref/);
    expect(r.stdout).not.toMatch(/must be a full image ref/);
  });
});

describe('the dev-image warning goes to stderr', () => {
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

  it('down with a valid override: warning on stderr only', () => {
    const r = runCli('down', [], { cwd: project, execStubs: stubs, env: GOOD, timeoutMs: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/using dev db image .*; not for production/);
    expect(r.stdout).not.toMatch(/using dev db image/);
  });
});
