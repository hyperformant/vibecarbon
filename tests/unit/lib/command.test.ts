/**
 * Tests for src/lib/command.js
 *
 * Covers:
 * - checkDependency() uses the `which` package for cross-platform PATH lookup
 * - runCommand / runCommandAsync string-form wraps in sh -c (no local shell)
 * - runShellScript writes a temp file and runs it via bash
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import which from 'which';

vi.mock('which');

import {
  checkDependency,
  runCommand,
  runCommandAsync,
  runShellScript,
  writeSecretFile,
} from '../../../src/lib/command.js';

describe('checkDependency', () => {
  beforeEach(() => {
    vi.mocked(which.sync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when the command is found on PATH', () => {
    vi.mocked(which.sync).mockReturnValue('/usr/bin/docker');

    const result = checkDependency('docker');

    expect(result).toBe(true);
    expect(which.sync).toHaveBeenCalledWith('docker', { nothrow: true });
  });

  it('returns false when the command is not found on PATH', () => {
    vi.mocked(which.sync).mockReturnValue(null);

    const result = checkDependency('not-a-real-command');

    expect(result).toBe(false);
  });

  it('calls which.sync with nothrow so missing commands return null instead of throwing', () => {
    vi.mocked(which.sync).mockReturnValue(null);

    checkDependency('anything');

    expect(which.sync).toHaveBeenCalledWith('anything', { nothrow: true });
  });
});

describe('runCommand string-form is wrapped in sh -c (no local shell)', () => {
  it('executes a static string command successfully', () => {
    const out = runCommand('echo hello-string', { silent: true, returnOutput: true });
    expect(String(out)).toContain('hello-string');
  });

  it('throws on empty argv array', () => {
    expect(() => runCommand([] as unknown as string[])).toThrow(/empty/);
  });

  it('throws on non-string/array input', () => {
    expect(() => runCommand(42 as unknown as string)).toThrow(/string or argv array/);
  });
});

describe('runCommandAsync string-form is wrapped in sh -c (no local shell)', () => {
  it('executes a static string command successfully', async () => {
    const out = await runCommandAsync('echo hello-async-string', {
      silent: true,
      returnOutput: true,
    });
    expect(String(out)).toContain('hello-async-string');
  });

  it('rejects on empty argv array', async () => {
    await expect(runCommandAsync([] as unknown as string[])).rejects.toThrow(/empty/);
  });
});

describe('runShellScript', () => {
  it('executes a bash script through a temp file and returns stdout', () => {
    const out = runShellScript(`echo hello-from-script`, { silent: true, returnOutput: true });
    expect(String(out)).toContain('hello-from-script');
  });

  it('supports shell pipelines with && chains', () => {
    const out = runShellScript(`echo a && echo b`, { silent: true, returnOutput: true });
    const lines = String(out).split('\n').filter(Boolean);
    expect(lines).toEqual(['a', 'b']);
  });

  it('propagates non-zero exit from the script', () => {
    expect(() => runShellScript(`exit 3`, { silent: true })).toThrow();
  });
});

describe('toArgv validation', () => {
  it('rejects arrays containing non-string elements with a helpful message', () => {
    expect(() => runCommand([42, 'foo'] as unknown as string[])).toThrow(/only strings/);
    expect(() => runCommand([null, 'foo'] as unknown as string[])).toThrow(/only strings/);
  });
});

describe('options.input requires silent', () => {
  it('runCommand throws when input is set without silent', () => {
    expect(() => runCommand(['cat'], { input: 'hello' })).toThrow(/silent: true/);
  });

  it('runCommandAsync rejects when input is set without silent', async () => {
    await expect(runCommandAsync(['cat'], { input: 'hello' })).rejects.toThrow(/silent: true/);
  });

  it('runCommand with silent + input captures stdin correctly', () => {
    const out = runCommand(['cat'], { input: 'piped-input', silent: true, returnOutput: true });
    expect(String(out)).toBe('piped-input');
  });

  it('runCommandAsync with silent + input captures stdin correctly', async () => {
    const out = await runCommandAsync(['cat'], {
      input: 'piped-async',
      silent: true,
      returnOutput: true,
    });
    expect(String(out)).toBe('piped-async');
  });
});

describe('stdio override protection', () => {
  it('silent: true is respected even when a caller passes conflicting stdio', () => {
    // With silent: true we always use 'pipe'. Passing stdio:'inherit' in opts
    // must NOT flip us back to inherit (previous behavior via ...options spread).
    const out = runCommand(['echo', 'no-leak'], {
      silent: true,
      returnOutput: true,
      // @ts-expect-error intentional — verifying stray stdio can't override.
      stdio: 'inherit',
    });
    expect(String(out)).toContain('no-leak');
  });
});

describe('writeSecretFile', () => {
  it('writes with 0o600 (owner-only) permissions', async () => {
    const { mkdtempSync, statSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'vb-secret-'));
    const f = join(dir, 'values.yaml');
    try {
      writeSecretFile(f, 'ADMIN_PASSWORD: hunter2\n');
      expect(readFileSync(f, 'utf-8')).toBe('ADMIN_PASSWORD: hunter2\n');
      expect(statSync(f).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces 0o600 even when overwriting a pre-existing world-readable file', async () => {
    const { mkdtempSync, statSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'vb-secret-'));
    const f = join(dir, 'values.yaml');
    try {
      writeFileSync(f, 'old');
      chmodSync(f, 0o644);
      writeSecretFile(f, 'new-secret');
      expect(statSync(f).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cleanEnv git-context stripping', () => {
  const GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

  it('strips git hook context vars so spawned git targets the generated repo, not the host repo', () => {
    // Live RCA (2026-07-08 release push): the repo pre-push hook runs the
    // integration suite; git exports GIT_DIR while running hooks, `vibecarbon
    // create`'s spawned `git init` inherited it, and every generated project
    // repo landed at $GIT_DIR (the HOST repo) — .git/hooks/pre-commit ENOENT
    // in all 23 create-based suites. cleanEnv must drop the git-context vars.
    const saved: Record<string, string | undefined> = {};
    for (const v of GIT_VARS) {
      saved[v] = process.env[v];
      process.env[v] = v === 'GIT_PREFIX' ? 'sub/' : `/tmp/somewhere/${v}`;
    }
    try {
      const out = runCommand(
        [
          'node',
          '-e',
          'console.log(JSON.stringify(["GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_COMMON_DIR","GIT_PREFIX"].filter((v)=>v in process.env)))',
        ],
        { silent: true, returnOutput: true, cleanEnv: true },
      );
      expect(JSON.parse(String(out).trim())).toEqual([]);
    } finally {
      for (const v of GIT_VARS) {
        if (saved[v] === undefined) delete process.env[v];
        else process.env[v] = saved[v];
      }
    }
  });
});

/**
 * The package-manager run-context leak.
 *
 * npm, pnpm and bun all publish their resolved config into child processes as
 * lowercase `npm_config_*` (plus `npm_command`, `npm_execpath`,
 * `npm_lifecycle_*`, `npm_package_*`, and pnpm's own `pnpm_config_*`). So a
 * `vibecarbon` invoked through `pnpm dlx` / `bunx` — or by any script the user
 * ran with `pnpm run` — hands the WRAPPER's config dialect to the npm we spawn
 * inside the generated project.
 *
 * Live incident (2026-08-05, k8s-ha record run + reproduced offline): the host
 * npm went 11.16.0 -> 12.0.2, and `~/.npmrc` carried `allow-scripts=vibecarbon`.
 * pnpm resolved that and injected `npm_config_allow_scripts`; npm 11 merely
 * warned "Unknown env config", npm 12 recognises the setting, forbids it in a
 * project-scoped install, and HARD-ERRORS:
 *
 *   npm error code EALLOWSCRIPTS
 *   npm error --allow-scripts is not allowed in project-scoped installs.
 *
 * `create` died in its lockfile pass. The specific setting is incidental — the
 * class is that ANY inherited PM config can become the next release's error, so
 * the whole injected namespace goes, not a list of known-bad names.
 */
describe('cleanEnv package-manager run-context stripping', () => {
  const INJECTED = {
    // The exact var that broke the run, plus the three npm warned about.
    npm_config_allow_scripts: 'vibecarbon',
    npm_config_verify_deps_before_run: 'false',
    npm_config_npm_globalconfig: '/home/someone/.nvm/etc/npmrc',
    npm_config__jsr_registry: 'https://npm.jsr.io/',
    // Parent script/run context — `npm_execpath` points at the WRAPPER's own
    // entry point, and `npm_config_local_prefix` (bun) at the wrapper's project
    // root, so both re-aim a child at the parent project.
    npm_config_local_prefix: '/home/someone/other-project',
    npm_config_user_agent: 'pnpm/10.32.1 npm/? node/v24.18.1 linux x64',
    npm_command: 'run-script',
    npm_execpath: '/home/someone/.pnpm/pnpm.cjs',
    npm_lifecycle_event: 'test:e2e:batch',
    npm_package_name: 'vibecarbon',
    pnpm_config_verify_deps_before_run: 'false',
    PNPM_PACKAGE_NAME: 'vibecarbon',
  };

  const readChildEnv = (names: string[]): string[] => {
    const out = runCommand(
      [
        'node',
        '-e',
        `console.log(JSON.stringify(${JSON.stringify(names)}.filter((v)=>v in process.env)))`,
      ],
      { silent: true, returnOutput: true, cleanEnv: true },
    );
    return JSON.parse(String(out).trim());
  };

  const withEnv = (vars: Record<string, string>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it('strips the whole injected namespace, not a list of known-bad names', () => {
    withEnv(INJECTED, () => {
      expect(readChildEnv(Object.keys(INJECTED))).toEqual([]);
    });
  });

  it('strips an npm_config_* name nobody has invented yet', () => {
    // The point of scrubbing by namespace: the next pnpm-ism, or the next npm
    // release that promotes an unknown config into a hard error, needs no code
    // change here. A name-by-name list would pass this only after an incident.
    withEnv({ npm_config_some_future_setting_2027: 'boom' }, () => {
      expect(readChildEnv(['npm_config_some_future_setting_2027'])).toEqual([]);
    });
  });

  it('keeps UPPERCASE NPM_CONFIG_* — that spelling is the user, not the wrapper', () => {
    // npm/pnpm/bun inject lowercase; exporting `NPM_CONFIG_REGISTRY` is the
    // documented way a human or CI job configures a private registry. Scrubbing
    // it would break installs behind an internal mirror, so the case carries
    // the intent. (Lowercase config set by hand is still dropped — npm re-reads
    // the same settings from .npmrc, which is where they belong.)
    withEnv(
      { NPM_CONFIG_REGISTRY: 'https://registry.internal/', NPM_CONFIG_STRICT_SSL: 'false' },
      () => {
        expect(readChildEnv(['NPM_CONFIG_REGISTRY', 'NPM_CONFIG_STRICT_SSL'])).toEqual([
          'NPM_CONFIG_REGISTRY',
          'NPM_CONFIG_STRICT_SSL',
        ]);
      },
    );
  });

  it('keeps the tool-location vars that are user environment, not run context', () => {
    // PNPM_HOME / BUN_INSTALL say where the binary lives; dropping them can
    // make the very manager we are about to spawn unresolvable.
    withEnv(
      { PNPM_HOME: '/home/someone/.local/share/pnpm', BUN_INSTALL: '/home/someone/.bun' },
      () => {
        expect(readChildEnv(['PNPM_HOME', 'BUN_INSTALL'])).toEqual(['PNPM_HOME', 'BUN_INSTALL']);
      },
    );
  });
});
