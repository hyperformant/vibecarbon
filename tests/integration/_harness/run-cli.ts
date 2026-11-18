/**
 * Spawn the vibecarbon CLI as a child process and capture its result.
 *
 * The harness deliberately uses spawnSync (not exec) so child stdio is
 * piped — no shell-quoting hazards. ANSI is stripped from stdout/stderr
 * for stable assertions across local + CI.
 *
 * `runCli` is the synchronous default. `runCliAsync` is the same call without
 * blocking the event loop, which is mandatory for any test that points the
 * CLI at an in-process server — see its doc comment.
 *
 * NO_COLOR=1 + FORCE_COLOR=0 forces clack/pico-colors to emit plain
 * text; otherwise some prompt screens still color even when stdout
 * isn't a TTY.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

const CLI_PATH = join(REPO_ROOT, 'src', 'cli.js');

/**
 * Per-process fake HOME, so CLI children never read or write the developer's
 * real ~/.vibecarbon.
 */
let FAKE_HOME: string | null = null;
function getFakeHome(): string {
  if (FAKE_HOME) return FAKE_HOME;
  FAKE_HOME = createTempDir('vibecarbon-fake-home-');
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
   * Base URL the CLI sends its telemetry and update check to. Defaults to a
   * closed port so no test ever reaches production by accident; point it at
   * a local server to observe which requests the CLI makes.
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
    // Point HOME at a per-process tmp so CLI children never touch the
    // developer's real ~/.vibecarbon.
    HOME: getFakeHome(),
    // A closed port by default: the CLI's telemetry and update-check calls
    // fail fast and are swallowed, instead of reporting test runs to
    // production vibecarbon.com.
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
