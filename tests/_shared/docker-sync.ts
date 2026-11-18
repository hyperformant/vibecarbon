/**
 * Synchronous process helpers for the Docker integration tier
 * (tests/integration/docker). Those tests drive docker, kubectl and k3s
 * step by step from vitest hooks, so they spawn synchronously and poll with
 * a blocking sleep.
 */
import { spawnSync } from 'node:child_process';

export interface RunOptions {
  /** Written to the child's stdin. */
  input?: string | Buffer;
  /** The child's whole environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this long. */
  timeoutMs?: number;
  /** Largest stdout or stderr kept, in bytes. */
  maxBuffer?: number;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface BinaryRunResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface DockerRunner {
  /** Run a command; never throws on a non-zero exit. */
  run(cmd: string, args: string[], opts?: RunOptions): RunResult;
  /** As run, with stdout kept as bytes (a `docker save` tarball). */
  runBinary(cmd: string, args: string[], opts?: RunOptions): BinaryRunResult;
  /** Run a command and return its stdout; throw on a non-zero exit. */
  must(cmd: string, args: string[], opts?: RunOptions): string;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * run, runBinary and must with one file's defaults (a timeout, a buffer
 * size); a call's own options win.
 */
export function dockerRunner(defaults: RunOptions = {}): DockerRunner {
  const spawn = (cmd: string, args: string[], opts: RunOptions) => {
    const o = { ...defaults, ...opts };
    return spawnSync(cmd, args, {
      input: o.input,
      env: o.env,
      timeout: o.timeoutMs,
      maxBuffer: o.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });
  };
  const run = (cmd: string, args: string[], opts: RunOptions = {}): RunResult => {
    const r = spawn(cmd, args, opts);
    return {
      status: r.status,
      stdout: r.stdout?.toString('utf-8') ?? '',
      stderr: r.stderr?.toString('utf-8') ?? '',
    };
  };
  const runBinary = (cmd: string, args: string[], opts: RunOptions = {}): BinaryRunResult => {
    const r = spawn(cmd, args, opts);
    return {
      status: r.status,
      stdout: r.stdout ?? Buffer.alloc(0),
      stderr: r.stderr?.toString('utf-8') ?? '',
    };
  };
  const must = (cmd: string, args: string[], opts: RunOptions = {}): string => {
    const r = run(cmd, args, opts);
    if (r.status !== 0) {
      throw new Error(
        `${cmd} ${args.slice(0, 6).join(' ')} exited ${r.status}: ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
    return r.stdout;
  };
  return { run, runBinary, must };
}

/** Block this thread for `ms` (the hooks here are synchronous). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Poll `probe` until it holds, or throw naming `what` after `timeoutMs`. */
export function waitFor(
  what: string,
  probe: () => boolean,
  timeoutMs = 120_000,
  intervalMs = 1000,
): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    sleepSync(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * null when the Docker tier is on (DOCKER_INTEGRATION=true, as
 * `pnpm test:docker` sets it); otherwise the reason to skip, printed once
 * under the test's name. Pass it to describe.skipIf.
 */
export function dockerTierSkip(name: string, needs: string): string | null {
  if (process.env.DOCKER_INTEGRATION === 'true') return null;
  const reason = `skipped: needs ${needs}; run it with DOCKER_INTEGRATION=true (pnpm test:docker)`;
  console.info(`${name}: ${reason}`);
  return reason;
}
