/**
 * Spawn the vibecarbon CLI as a child process and capture its result.
 *
 * The harness deliberately uses spawn/spawnSync (not exec) so child stdio is
 * piped — no shell-quoting hazards. ANSI is stripped from stdout/stderr
 * for stable assertions across local + CI.
 *
 * `runCli` is the synchronous default. `runCliAsync` is the same call without
 * blocking the event loop, which is mandatory for any test that points the
 * CLI at the in-process licence stub — see its doc comment.
 *
 * NO_COLOR=1 + FORCE_COLOR=0 forces clack/pico-colors to emit plain
 * text; otherwise some prompt screens still color even when stdout
 * isn't a TTY.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.js');

/**
 * Per-process fake HOME, so CLI children never read or write the developer's
 * real ~/.vibecarbon. No licence is seeded: a key alone entitles nothing now
 * — the binding lives on vibecarbon.com, and tests that need a verdict point
 * the CLI at the local licence stub (see tests/e2e/utils/license-stub.js)
 * through `apiBase`.
 */
let FAKE_HOME: string | null = null;
function getFakeHome(): string {
  if (FAKE_HOME) return FAKE_HOME;
  FAKE_HOME = mkdtempSync(join(tmpdir(), 'vibecarbon-fake-home-'));
  mkdirSync(join(FAKE_HOME, '.vibecarbon'), { recursive: true });
  return FAKE_HOME;
}

export interface RunOptions {
  /** Working directory the CLI sees as cwd. Default: process.cwd(). */
  cwd?: string;
  /** Extra env vars on top of the parent process env. */
  env?: Record<string, string>;
  /** Stdin content for the CLI. Default: none. */
  stdin?: string;
  /** Hard timeout in ms. Default 60s. */
  timeoutMs?: number;
  /**
   * Optional ExecStubs from installExecStubs(). Prepends the stub
   * binPath to PATH so calls to ssh/docker/kubectl/pulumi/etc. land in
   * the stub log instead of going to real binaries.
   */
  execStubs?: { binPath: string };
  /**
   * Base URL for vibecarbon.com's licence API. Defaults to a closed port so
   * no test ever reaches the real network by accident; point it at a
   * startLicenseStub() baseUrl to serve real signed verdicts.
   */
  apiBase?: string;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping is intentional.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string | undefined): string {
  return (s ?? '').replace(ANSI_RE, '');
}

/**
 * Top-level flags like -h / -v are passed alone — they don't take a verb. For
 * everything else, prepend the verb.
 */
function argvFor(verb: string, flags: string[]): string[] {
  return verb === '-h' || verb === '-v' ? [verb] : [verb, ...flags];
}

function childEnv(opts: RunOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    // The licence stub holds the signing key and signs in-process; a CLI
    // child verifies against its EMBEDDED public key and never needs the
    // private one. `...process.env` spreads whatever the shell or CI job
    // exported, so blank it here. Blanked, not deleted: an empty value is
    // unambiguous in the child.
    VIBECARBON_LICENSE_PRIVATE_KEY: '',
    // Point HOME at a per-process tmp so CLI children never touch the
    // developer's real ~/.vibecarbon.
    HOME: getFakeHome(),
    // A closed port by default: an unstubbed licence call fails fast as
    // 'unreachable' instead of hitting production vibecarbon.com.
    VIBECARBON_API_BASE: opts.apiBase ?? 'http://127.0.0.1:9',
    // Prepend exec stub binPath so calls to ssh/docker/kubectl/etc.
    // hit the stub log, not real binaries.
    ...(opts.execStubs ? { PATH: `${opts.execStubs.binPath}:${process.env.PATH ?? ''}` } : {}),
    ...(opts.env ?? {}),
  };
}

export function runCli(verb: string, flags: string[], opts: RunOptions = {}): RunResult {
  const result = spawnSync(process.execPath, [CLI_PATH, ...argvFor(verb, flags)], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf-8',
    env: childEnv(opts),
    input: opts.stdin,
    timeout: opts.timeoutMs ?? 60_000,
  });

  return {
    exitCode: result.status,
    stdout: stripAnsi(result.stdout),
    stderr: stripAnsi(result.stderr),
  };
}

/**
 * runCli, asynchronously. Same argv, env, HOME and ANSI handling; the only
 * difference is that this one does not block the event loop.
 *
 * That difference is load-bearing for anything pointed at the licence stub.
 * `startLicenseStub()` listens IN THIS PROCESS, and spawnSync parks the event
 * loop for the whole child run — so the stub can never accept the child's
 * connection, the CLI's fetch times out, and the stub records no call at all.
 * Every case that passes `apiBase: stub.baseUrl` must therefore await this
 * instead of calling runCli.
 */
export function runCliAsync(
  verb: string,
  flags: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argvFor(verb, flags)], {
      cwd: opts.cwd ?? process.cwd(),
      env: childEnv(opts),
      timeout: opts.timeoutMs ?? 60_000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    // A CLI that exits before reading stdin (a flag error, `-h`) makes the
    // write fail with EPIPE, which arrives as an unhandled 'error' on the
    // stream and would take the whole test process down.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');

    // Spawn itself failing (a bad path, a fork limit) is a harness fault, not
    // a CLI outcome: surface it instead of hanging until the test times out.
    // A no-op once 'close' has already settled the promise.
    child.on('error', rejectResult);
    child.on('close', (code) => {
      resolveResult({ exitCode: code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
    });
  });
}
