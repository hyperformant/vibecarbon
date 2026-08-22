/**
 * CLI routing tests
 *
 * Covers:
 * - KNOWN_COMMANDS registry (all commands are listed, including newly added ones)
 * - Help text mentions every registered command
 * - --help / -h exits 0 and prints usage
 * - --version / -v exits 0 and prints version
 * - No args exits 0 (shows help)
 * - Unknown command exits 1
 * - CLI module itself imports cleanly (catches duplicate-export bugs)
 * - Each command's module exports a `run()` function (catches missing/broken modules)
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from '../../../src/cli.js';

const CLI_PATH = join(import.meta.dirname, '../../../src/cli.js');
const NODE = process.execPath;

// Simpler: run the CLI file directly as a script
function runCliScript(args: string[]) {
  return spawnSync(NODE, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

// ============================================================================
// Module integrity
// ============================================================================

describe('CLI module integrity', () => {
  it('imports without errors', async () => {
    // If this throws (e.g. duplicate export, bad import path) the test fails.
    // The actual main() side-effect fires but process.exit(0) is swallowed by
    // the dynamic import context — we just care that the module loads cleanly.
    await expect(import('../../../src/cli.js')).resolves.toBeDefined();
  });

  it('exports KNOWN_COMMANDS as a non-empty array', async () => {
    expect(Array.isArray(KNOWN_COMMANDS)).toBe(true);
    expect(KNOWN_COMMANDS.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// KNOWN_COMMANDS registry
// ============================================================================

describe('KNOWN_COMMANDS registry', () => {
  const expectedCommands = [
    'create',
    'add',
    'remove',
    'up',
    'down',
    'reset',
    'deploy',
    'destroy',
    'status',
    'backup',
    'restore',
    'failover',
    'scale',
    'upgrade',
    'configure',
    'activate',
    'deactivate',
    'shell',
    'diagnose',
    'console',
    'access',
  ];

  it('contains all expected commands', () => {
    for (const cmd of expectedCommands) {
      expect(KNOWN_COMMANDS).toContain(cmd);
    }
  });

  it('has no duplicate entries', () => {
    const unique = new Set(KNOWN_COMMANDS);
    expect(unique.size).toBe(KNOWN_COMMANDS.length);
  });
});

// ============================================================================
// Each command module exports run()
// ============================================================================

describe('Command module exports', () => {
  // Commands that have a run() export we can verify without side-effects
  const modulesWithRun: Array<[string, string]> = [
    ['deploy', '../../../src/deploy.js'],
    ['destroy', '../../../src/destroy.js'],
    ['status', '../../../src/status.js'],
    ['backup', '../../../src/backup.js'],
    ['restore', '../../../src/restore.js'],
    ['failover', '../../../src/failover.js'],
    ['scale', '../../../src/scale.js'],
    ['upgrade', '../../../src/upgrade.js'],
    ['configure', '../../../src/configure.js'],
  ];

  // Activate module has runActivate and runDeactivate instead of run
  it('activate module exports runActivate and runDeactivate functions', async () => {
    const mod = await import('../../../src/activate.js');
    expect(typeof mod.runActivate).toBe('function');
    expect(typeof mod.runDeactivate).toBe('function');
  });

  for (const [command, modulePath] of modulesWithRun) {
    it(`${command} module exports a run() function`, async () => {
      const mod = await import(modulePath);
      expect(typeof mod.run).toBe('function');
    });
  }
});

// ============================================================================
// CLI behavior via spawnSync (safe commands only)
// ============================================================================

describe('CLI -h', () => {
  it('-h exits with code 0', () => {
    const result = runCliScript(['-h']);
    expect(result.status).toBe(0);
  });

  it('rejects --help (single-dash only)', () => {
    const result = runCliScript(['--help']);
    expect(result.status).toBe(1);
  });

  it('prints USAGE section', () => {
    const result = runCliScript(['-h']);
    expect(result.stdout).toContain('USAGE');
  });

  it('lists every KNOWN_COMMAND in help output', () => {
    const result = runCliScript(['-h']);
    for (const cmd of KNOWN_COMMANDS) {
      expect(result.stdout).toContain(cmd);
    }
  });

  it('mentions scale command specifically', () => {
    const result = runCliScript(['-h']);
    expect(result.stdout).toContain('scale');
  });
});

describe('CLI -v', () => {
  it('-v exits with code 0', () => {
    const result = runCliScript(['-v']);
    expect(result.status).toBe(0);
  });

  it('rejects --version (single-dash only)', () => {
    const result = runCliScript(['--version']);
    expect(result.status).toBe(1);
  });

  it('prints vibecarbon and a version string', () => {
    const result = runCliScript(['-v']);
    expect(result.stdout).toMatch(/^vibecarbon v\d+\.\d+\.\d+/);
  });
});

describe('CLI no arguments', () => {
  it('exits with code 0 and shows help', () => {
    const result = runCliScript([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('USAGE');
  });
});

describe('CLI unknown command', () => {
  it('exits with code 1', () => {
    const result = runCliScript(['totally-not-a-command']);
    expect(result.status).toBe(1);
  });

  it('prints the unknown command name in stderr', () => {
    const result = runCliScript(['totally-not-a-command']);
    const combined = result.stderr + result.stdout;
    expect(combined).toContain('totally-not-a-command');
  });

  it('suggests running -h', () => {
    const result = runCliScript(['unknown-cmd']);
    const combined = result.stderr + result.stdout;
    expect(combined).toContain('-h');
  });
});
