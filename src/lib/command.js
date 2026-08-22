/**
 * Unified command execution utility.
 *
 * SECURITY: No local shell is ever invoked from this module. Array-form
 * callers route through spawn/spawnSync directly (argv → execve, no shell).
 * String-form callers are wrapped into `['sh', '-c', str]` so the ONLY
 * shell in the pipeline is the remote `sh -c` (on this machine), never a
 * local shell interpolating template-literals before exec.
 *
 * Prefer array form; use runShellScript for genuine shell pipelines.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import which from 'which';
import { scrubPackageManagerEnv } from './package-manager-env.js';

/**
 * Track active child processes for graceful shutdown on SIGINT/SIGTERM.
 *
 * NOTE: cli.js registers its own SIGINT handler first (and calls
 * process.exit(130)), so this handler typically does not run — Node invokes
 * handlers in registration order and the first process.exit() wins. The
 * registry is kept for future consolidation and for unusual code paths
 * that import command.js without going through cli.js.
 */
const activeChildren = new Set();

function handleShutdown(signal) {
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already dead
    }
  }
  activeChildren.clear();
  process.exit(signal === 'SIGTERM' ? 143 : 130);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

/**
 * Normalize cmd input to an argv array. Strings become ['sh', '-c', str].
 * Local shell is never invoked; sh is exec'd as a child process.
 */
function toArgv(cmd) {
  if (Array.isArray(cmd)) {
    if (cmd.length === 0) throw new Error('Command array cannot be empty');
    if (!cmd.every((a) => typeof a === 'string')) {
      throw new Error('Command array must contain only strings');
    }
    return cmd;
  }
  if (typeof cmd === 'string') {
    return ['sh', '-c', cmd];
  }
  throw new Error('runCommand requires a string or argv array');
}

/**
 * Execute a command synchronously.
 * Array form is preferred (no shell parsing at all). Strings are wrapped
 * into `sh -c` via argv — no local-shell interpolation is possible.
 *
 * @param {string|string[]} cmd
 * @param {object} [options]
 * @returns {string|boolean|null}
 */
/**
 * Environment for `cleanEnv: true` spawns: drops vars that make a child
 * process behave as if it were still inside OUR runtime context.
 *
 * - NODE_OPTIONS / VITEST*: test-runner context (pre-existing).
 * - GIT_* repo-context vars: git exports these while running hooks. A
 *   `vibecarbon create` invoked from any git hook (our pre-push runs the
 *   integration suite; users have husky/lefthook) leaked GIT_DIR into the
 *   generated project's `git init`, so the new repo landed at $GIT_DIR —
 *   the HOST repo — instead of <project>/.git (2026-07-08 release push:
 *   all 23 create-based integration suites ENOENT'd on .git/hooks).
 *   Identity/transport vars (GIT_AUTHOR_*, GIT_SSH_*) are deliberately
 *   kept — they are user config, not repo context.
 * - the lowercase `npm_`, `pnpm_`, `bun_` and `yarn_` namespaces: the
 *   package-manager run context — see PM_RUN_CONTEXT_RE below.
 */
const CONTEXT_ENV_VARS = [
  'NODE_OPTIONS',
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  // pnpm's run context; the lowercase namespace below covers the rest.
  'PNPM_PACKAGE_NAME',
];

function scrubbedEnv(env) {
  // The package-manager run context is defined once, in lib/package-manager-env
  // — the test harnesses scrub the same namespace when they spawn a manager.
  const clean = scrubPackageManagerEnv(env);
  for (const v of CONTEXT_ENV_VARS) delete clean[v];
  return clean;
}

/**
 * The same scrub, for callers that spawn git DIRECTLY (execFileSync/spawnSync)
 * and so cannot opt in via `cleanEnv: true`.
 *
 * GIT_DIR overrides cwd, so passing `cwd` is NOT protection. Any git probe
 * reached from inside a hook — this repo's own pre-push runs the integration
 * suite, and users run husky/lefthook/pre-commit — reads the HOST repo instead
 * of the project and answers confidently about the wrong tree. #234 fixed one
 * such probe by scrubbing GIT_* for that single call; this exports the scrub so
 * every direct git spawn shares it rather than each rediscovering the bug.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function gitSafeEnv(env = process.env) {
  return scrubbedEnv({ ...env });
}

export function runCommand(cmd, options = {}) {
  const argv = toArgv(cmd);
  const commandStr = argv.join(' ');

  if (options.input !== undefined && !options.silent) {
    throw new Error(
      "runCommand: options.input requires options.silent: true (stdin pipe is unavailable with 'inherit' stdio)",
    );
  }

  try {
    let env = options.env || process.env;
    if (options.cleanEnv) {
      env = scrubbedEnv(env);
    }

    const formatOutput = (out) => (Buffer.isBuffer(out) ? out.toString('utf-8') : out);
    const isCapturing = options.silent || options.stdio?.includes('pipe') || options.returnOutput;

    const [executable, ...args] = argv;
    const res = spawnSync(executable, args, {
      encoding: 'utf-8',
      env,
      cwd: options.cwd,
      timeout: options.timeout,
      input: options.input,
      stdio: options.silent ? 'pipe' : (options.stdio ?? 'inherit'),
    });

    if (res.error) throw res.error;

    if (res.status !== 0) {
      const stderrStr = res.stderr?.toString?.().trim() || '';
      const msg = stderrStr
        ? `Command failed with exit code ${res.status}: ${commandStr}\n${stderrStr}`
        : `Command failed with exit code ${res.status}: ${commandStr}`;
      const err = new Error(msg);
      err.status = res.status;
      err.stdout = res.stdout;
      err.stderr = res.stderr;
      throw err;
    }

    const result = formatOutput(res.stdout);
    return isCapturing && options.returnOutput !== false ? result : true;
  } catch (error) {
    if (error.signal === 'SIGINT' || error.status === 130) {
      process.exit(130);
    }

    if (options.ignoreError) return null;

    if (process.env.CI || process.env.DEBUG) {
      console.error(`Command failed: ${commandStr}`);
      console.error('stdout:', error.stdout?.toString?.() || '');
      console.error('stderr:', error.stderr?.toString?.() || '');
    }

    if (options.returnOutput !== false && options.silent) throw error;
    return false;
  }
}

/**
 * Execute a command asynchronously (non-blocking).
 * Same argv-vs-string rules as runCommand. No local shell ever.
 *
 * @param {string|string[]} cmd
 * @param {object} [options]
 * @returns {Promise<string|boolean|null>}
 */
export function runCommandAsync(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    let argv;
    try {
      argv = toArgv(cmd);
    } catch (e) {
      return reject(e);
    }
    const commandStr = argv.join(' ');

    let env = options.env || process.env;
    if (options.cleanEnv) {
      env = scrubbedEnv(env);
    }

    const stdio = options.silent ? 'pipe' : 'inherit';
    const [executable, ...args] = argv;
    const child = spawn(executable, args, {
      stdio,
      env,
      cwd: options.cwd,
    });

    activeChildren.add(child);

    if (options.input !== undefined) {
      if (!options.silent) {
        return reject(
          new Error(
            "runCommandAsync: options.input requires options.silent: true (stdin pipe is unavailable with 'inherit' stdio)",
          ),
        );
      }
      if (child.stdin) {
        child.stdin.write(options.input);
        child.stdin.end();
      }
    }

    let stdout = '';
    let stderr = '';
    if (options.silent) {
      child.stdout?.on('data', (data) => {
        stdout += data;
      });
      child.stderr?.on('data', (data) => {
        stderr += data;
      });
    }

    let timedOut = false;
    let timer;
    if (options.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeout);
    }

    child.on('close', (code, signal) => {
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);

      if (signal === 'SIGINT' || code === 130) {
        process.exit(130);
      }

      if (code !== 0) {
        if (options.ignoreError) return resolve(null);

        const stderrTrimmed = stderr.trim();
        const msg = stderrTrimmed
          ? `Command failed: ${commandStr}\n${stderrTrimmed}`
          : `Command failed: ${commandStr}`;
        const error = new Error(msg);
        error.stdout = stdout;
        error.stderr = stderr;
        error.status = code;
        error.timedOut = timedOut;

        if (process.env.CI || process.env.DEBUG) {
          console.error(`Command failed: ${commandStr}`);
          console.error('stdout:', stdout);
          console.error('stderr:', stderr);
        }

        if (options.returnOutput !== false && options.silent) return reject(error);
        return resolve(false);
      }

      resolve(options.returnOutput !== false && options.silent ? stdout : true);
    });

    child.on('error', (error) => {
      activeChildren.delete(child);
      if (timer) clearTimeout(timer);
      if (options.ignoreError) return resolve(null);
      reject(error);
    });
  });
}

/**
 * Execute a bash script via a temp file.
 * Use for legitimate shell pipelines (heredocs, `| gzip`, `&&` chains)
 * that need shell features. Callers MUST inline values literally or use
 * shEscape() from src/lib/shell.js first — this helper does not escape.
 *
 * @param {string} bashScript
 * @param {object} [options]
 */
export function runShellScript(bashScript, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vibecarbon-script-'));
  const file = join(dir, 'script.sh');
  try {
    writeFileSync(file, bashScript, { mode: 0o700 });
    return runCommand(['bash', file], options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run a finite command and stream its stdout/stderr through a clack `taskLog`
 * block so output renders inside the prompt gutter. On success the visible
 * buffer collapses to the title; on failure the full retained log stays
 * visible for debugging. Use for finite commands (install, build, teardown);
 * do NOT use for long-running foreground processes like a dev server —
 * taskLog clears on exit and only shows the last `limit` lines while running.
 *
 * @param {string|string[]} cmd
 * @param {object} options
 * @param {string} options.title  Heading shown above the streaming block.
 * @param {string} [options.successMessage]  Replaces `title` on success.
 * @param {string} [options.errorMessage]    Replaces `title` on failure.
 * @param {number} [options.limit=10]        Visible-buffer line cap.
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @returns {Promise<void>}  Resolves on exit 0; rejects with stderr-tail
 *                           Error on non-zero. SIGINT exits the process.
 */
export function runCommandThroughTaskLog(cmd, options) {
  return new Promise((resolve, reject) => {
    let argv;
    try {
      argv = toArgv(cmd);
    } catch (e) {
      return reject(e);
    }
    const commandStr = argv.join(' ');
    const title = options.title;
    if (!title) {
      return reject(new Error('runCommandThroughTaskLog: options.title is required'));
    }

    const log = p.taskLog({
      title,
      limit: options.limit ?? 10,
      retainLog: true,
    });

    const [executable, ...args] = argv;
    const baseEnv = options.env || process.env;
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.cleanEnv ? scrubbedEnv(baseEnv) : baseEnv,
      cwd: options.cwd,
    });

    activeChildren.add(child);

    child.stdout?.on('data', (chunk) => {
      log.message(chunk.toString(), { raw: true });
    });
    child.stderr?.on('data', (chunk) => {
      log.message(chunk.toString(), { raw: true });
    });

    child.on('close', (code, signal) => {
      activeChildren.delete(child);
      if (signal === 'SIGINT' || code === 130) {
        process.exit(130);
      }
      if (code === 0) {
        log.success(options.successMessage ?? title);
        return resolve();
      }
      const msg = options.errorMessage ?? `Command failed: ${commandStr} (exit ${code})`;
      log.error(msg, { showLog: true });
      const error = new Error(msg);
      error.status = code;
      reject(error);
    });

    child.on('error', (error) => {
      activeChildren.delete(child);
      log.error(error.message, { showLog: true });
      reject(error);
    });
  });
}

/**
 * Check if a command exists on the system.
 *
 * @param {string} cmd
 * @returns {boolean}
 */
export function checkDependency(cmd) {
  return which.sync(cmd, { nothrow: true }) !== null;
}

/**
 * Write a file that contains secrets (rendered helm values, credentials, etc.)
 * with owner-only 0o600 permissions, ALWAYS — even when overwriting an existing
 * file (writeFileSync only applies `mode` on creation, so we chmod after).
 *
 * SECURITY: use this for any temp file holding secret material. A plain
 * writeFileSync defaults to 0o644 (world-readable), which leaks credentials to
 * every local user for the lifetime of the file (e.g. a rendered helm values
 * file lives for the whole `helm upgrade --wait` window).
 *
 * @param {string} path
 * @param {string | NodeJS.ArrayBufferView} data
 */
export function writeSecretFile(path, data) {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}
