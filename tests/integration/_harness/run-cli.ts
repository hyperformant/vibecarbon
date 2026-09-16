/**
 * Spawn the vibecarbon CLI as a child process and capture its result.
 *
 * The harness deliberately uses spawnSync (not exec) so child stdio is
 * piped — no shell-quoting hazards. ANSI is stripped from stdout/stderr
 * for stable assertions across local + CI.
 *
 * NO_COLOR=1 + FORCE_COLOR=0 forces clack/pico-colors to emit plain
 * text; otherwise some prompt screens still color even when stdout
 * isn't a TTY.
 */

import { spawnSync } from 'node:child_process';
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

export function runCli(verb: string, flags: string[], opts: RunOptions = {}): RunResult {
  // Top-level flags like -h / -v are passed alone — they don't take
  // a verb. For everything else, prepend the verb.
  const argv = verb === '-h' || verb === '-v' ? [verb] : [verb, ...flags];
  const result = spawnSync(process.execPath, [CLI_PATH, ...argv], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
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
    },
    input: opts.stdin,
    timeout: opts.timeoutMs ?? 60_000,
  });

  return {
    exitCode: result.status,
    stdout: (result.stdout ?? '').replace(ANSI_RE, ''),
    stderr: (result.stderr ?? '').replace(ANSI_RE, ''),
  };
}
