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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadE2EEnvFile } from '../../e2e/utils/e2e-env-file.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const CLI_PATH = join(REPO_ROOT, 'src', 'cli.js');

/**
 * The real, Ed25519-signed Fullerene key these tests activate.
 *
 * This used to be the literal `vc-f-deadbeef-fakefakefakefakefake` paired
 * with VIBECARBON_DEV_LICENSE=true, which made validateLicenseKey skip
 * signature verification. That switch shipped inside the npm package (the
 * tarball is src/ verbatim, no build step), so it doubled as a free Fullerene
 * grant for any customer who opened validator.js. It is gone; the harness now
 * activates a genuine key, which is also the path a customer walks.
 *
 * Mint one with:
 *   VIBECARBON_LICENSE_PRIVATE_KEY=... node scripts/generate-license.js --email you@example.com
 */
export function testLicenseKey(): string {
  if (!process.env.VIBECARBON_TEST_LICENSE_KEY) {
    // Same gitignored operator file the e2e harness reads; real env wins.
    loadE2EEnvFile(join(REPO_ROOT, 'tests', '.env.e2e'), process.env);
  }

  const key = process.env.VIBECARBON_TEST_LICENSE_KEY;
  if (!key) {
    throw new Error(
      'VIBECARBON_TEST_LICENSE_KEY is not set.\n' +
        'Integration tests spawn paid commands (deploy/backup/restore/scale/failover)\n' +
        'which gate on a real license — there is no dev bypass any more.\n\n' +
        'Set it in your shell or in tests/.env.e2e:\n' +
        '  VIBECARBON_TEST_LICENSE_KEY=vc-f-...\n\n' +
        'Mint one with:\n' +
        '  VIBECARBON_LICENSE_PRIVATE_KEY=... node scripts/generate-license.js --email you@example.com',
    );
  }
  return key;
}

/**
 * Per-process fake HOME with a Fullerene-tier license activated, so tests
 * reach the off-TTY guard / arg-parse logic that's actually under test
 * instead of stopping at requireLicense().
 */
let FAKE_HOME: string | null = null;
function getFakeHome(): string {
  if (FAKE_HOME) return FAKE_HOME;
  const key = testLicenseKey();
  FAKE_HOME = mkdtempSync(join(tmpdir(), 'vibecarbon-fake-home-'));
  mkdirSync(join(FAKE_HOME, '.vibecarbon'), { recursive: true });
  // File path is ~/.vibecarbon/license (no .json extension — see
  // src/lib/licensing/index.js LICENSE_FILE).
  writeFileSync(
    join(FAKE_HOME, '.vibecarbon', 'license'),
    JSON.stringify(
      {
        key,
        customerId: key.split('-')[2],
        activatedAt: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
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
      // Point HOME at a per-process tmp with a real Fullerene license
      // activated, so paid commands clear requireLicense() and tests reach
      // the off-TTY/arg-parse logic actually under test.
      HOME: getFakeHome(),
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
