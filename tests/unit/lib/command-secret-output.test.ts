/**
 * A command that reads a secret keeps it out of the log and the error.
 *
 * Under CI or DEBUG, a failed command has its captured stdout printed to
 * stderr and attached to its error as `err.stdout`. A read that captures a
 * secret (a Secret's data, a server's .env or docker login file) can fail
 * after the child printed it all: ssh exits 255 when the link or its mux
 * drops at close, and the timer's SIGTERM leaves no exit code. The read's
 * own `|| true` fixes only the remote status. A review reproduced the leak
 * with a real child under CI=1 that exits 255.
 *
 * `secret: true` holds the stdout back. Without it the echo stays as it was,
 * so a failed command that reads nothing secret still prints what it said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand, runCommandAsync } from '../../../src/lib/command.js';

const SENTINEL = 'vc-sentinel-7f3a91';
/** The child builds the sentinel, so the argv a failure message names does not spell it. */
const PRINT_SENTINEL = "process.stdout.write(['vc', 'sentinel', '7f3a91'].join('-') + '\\n');";

/** Prints the sentinel, then exits 255: the exit ssh gives when the link drops at close. */
const PRINTS_THEN_255 = [
  process.execPath,
  '-e',
  `${PRINT_SENTINEL} process.stderr.write('Connection closed\\n'); process.exit(255);`,
];

/** Prints the sentinel, then hangs until the timer stops it (exit code null). */
const PRINTS_THEN_HANGS = [
  process.execPath,
  '-e',
  `${PRINT_SENTINEL} setInterval(() => {}, 1000);`,
];

function errorText(err: unknown): string {
  const e = err as Record<string, unknown>;
  return [e?.message, e?.stdout, e?.stderr].map((v) => String(v ?? '')).join('\n');
}

describe('runCommandAsync: secret output under CI', () => {
  let printed: string[];
  const saved = { CI: process.env.CI, DEBUG: process.env.DEBUG };
  beforeEach(() => {
    process.env.CI = '1';
    delete process.env.DEBUG;
    printed = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a secret read that exits 255 after printing leaves the output in no log and no error', async () => {
    const err = await runCommandAsync(PRINTS_THEN_255, { silent: true, secret: true }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(255);
    expect(err.stdout).toBeUndefined();
    expect(errorText(err)).not.toContain(SENTINEL);
    expect(printed.join('\n')).not.toContain(SENTINEL);
    // The echo still says what failed and why, and that stdout was held back.
    expect(printed.join('\n')).toContain('Connection closed');
    expect(printed.join('\n')).toContain('this command reads a secret');
  });

  it('a secret read the timer stops leaves the output in no log and no error', async () => {
    const err = await runCommandAsync(PRINTS_THEN_HANGS, {
      silent: true,
      secret: true,
      timeout: 1_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.timedOut).toBe(true);
    expect(err.stdout).toBeUndefined();
    expect(errorText(err)).not.toContain(SENTINEL);
    expect(printed.join('\n')).not.toContain(SENTINEL);
  });

  it('without secret, a failed command still echoes its stdout and carries it on the error', async () => {
    const err = await runCommandAsync(PRINTS_THEN_255, { silent: true }).catch((e) => e);
    expect(err.stdout).toContain(SENTINEL);
    expect(printed.join('\n')).toContain(SENTINEL);
  });
});

describe('runCommand: secret output under CI', () => {
  let printed: string[];
  const saved = { CI: process.env.CI, DEBUG: process.env.DEBUG };
  beforeEach(() => {
    process.env.CI = '1';
    delete process.env.DEBUG;
    printed = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a secret read that exits 255 after printing leaves the output in no log and no error', () => {
    let err: unknown;
    try {
      runCommand(PRINTS_THEN_255, { silent: true, secret: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { stdout?: unknown }).stdout).toBeUndefined();
    expect(errorText(err)).not.toContain(SENTINEL);
    expect(printed.join('\n')).not.toContain(SENTINEL);
    expect(printed.join('\n')).toContain('this command reads a secret');
  });

  it('without secret, a failed command still echoes its stdout', () => {
    let err: unknown;
    try {
      runCommand(PRINTS_THEN_255, { silent: true });
    } catch (e) {
      err = e;
    }
    expect(String((err as { stdout?: unknown }).stdout)).toContain(SENTINEL);
    expect(printed.join('\n')).toContain(SENTINEL);
  });
});
