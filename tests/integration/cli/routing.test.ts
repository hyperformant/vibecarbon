/**
 * CLI routing tests
 *
 * Covers:
 * - KNOWN_COMMANDS registry (all commands are listed, including newly added ones)
 * - Help text mentions every registered command
 * - -h exits 0 and prints usage, and --help is rejected
 * - <command> -h prints that command's exact title, for every command
 * - -v and --version exit 0 and print version
 * - No args exits 0 (shows help)
 * - Unknown command exits 1
 * - CLI module itself imports cleanly (catches duplicate-export bugs)
 * - Each command's module exports a `run()` function (catches missing/broken modules)
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KNOWN_COMMANDS } from '../../../src/cli.js';
import { assertSuccess, destroyRealProject, realProject, runCli } from '../_harness/index.js';

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
    'next',
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
    'update',
    'upgrade',
    'configure',
    'shell',
    'diagnose',
    'console',
    'access',
    'telemetry',
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
    ['next', '../../../src/next.js'],
    ['deploy', '../../../src/deploy.js'],
    ['destroy', '../../../src/destroy.js'],
    ['status', '../../../src/status.js'],
    ['backup', '../../../src/backup.js'],
    ['restore', '../../../src/restore.js'],
    ['failover', '../../../src/failover.js'],
    ['scale', '../../../src/scale.js'],
    ['update', '../../../src/update.js'],
    ['upgrade', '../../../src/upgrade.js'],
    ['configure', '../../../src/configure.js'],
    ['telemetry', '../../../src/telemetry.js'],
  ];

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

// Every command's own -h, run inside a real project as a user would. The
// first line must be that command's exact title and summary: a loose match
// such as /down/i passes on almost any output, including another command's
// help. `also` holds the extra lines a command's help must carry. This table
// replaces the per-command "prints help" tests.
const HELP_TITLES: Array<{ command: string; title: string; also?: string[] }> = [
  {
    command: 'access',
    title: 'Vibecarbon Access - Manage the SSH and k8s-API operator-CIDR allowlist',
  },
  {
    command: 'add',
    title: 'Vibecarbon Add - Add features (observability, redis)',
    also: ['observability'],
  },
  { command: 'backup', title: 'Vibecarbon Backup - Create or list database backups' },
  {
    command: 'configure',
    title:
      'Vibecarbon Configure - Configure external services and settings: billing, OAuth, SMTP, CI/CD, globalization, and more',
  },
  { command: 'console', title: "Vibecarbon Console - Open Hetzner's web VNC console for a node" },
  {
    command: 'create',
    title: 'Vibecarbon Create - Create a new Vibecarbon project',
    also: ['-pm'],
  },
  {
    command: 'deploy',
    title: 'Vibecarbon Deploy - Deploy an environment (interactive picker for mode and region)',
    // -allow-degraded: the HA replication gate opt-out is documented (finding #1).
    also: ['-mode', '-region', '-full', '-allow-degraded'],
  },
  {
    command: 'destroy',
    title: 'Vibecarbon Destroy - Tear down a cloud environment',
    also: ['-orphans', '-purge'],
  },
  {
    command: 'diagnose',
    title:
      'Vibecarbon Diagnose - Dump cluster state (nodes, pods, Flux, network) to ~/.vibecarbon/diag-*',
    // The section names.
    also: ['nodes', 'pods', 'tls', 'flux', 'egress'],
  },
  { command: 'down', title: 'Vibecarbon Down - Stop the local development environment' },
  { command: 'failover', title: 'Vibecarbon Failover - Initiate failover to the standby region' },
  { command: 'next', title: 'Vibecarbon Next - Tell me what to do next, and offer to run it' },
  { command: 'remove', title: 'Vibecarbon Remove - Remove features from a project' },
  { command: 'reset', title: 'Vibecarbon Reset - Reset the local environment (removes all data)' },
  { command: 'restore', title: 'Vibecarbon Restore - Restore the database from a backup' },
  { command: 'scale', title: 'Vibecarbon Scale - Scale worker nodes and instance sizes' },
  {
    command: 'shell',
    title:
      'Vibecarbon Shell - Open an interactive bash with KUBECONFIG and cloud credentials exported',
  },
  { command: 'status', title: 'Vibecarbon Status - Show project and deployment status' },
  {
    command: 'telemetry',
    title: 'Vibecarbon Telemetry - Control anonymous usage analytics (status by default)',
  },
  { command: 'up', title: 'Vibecarbon Up - Start the local development environment' },
  {
    command: 'update',
    title: 'Vibecarbon Update - Install system updates and restart servers when needed',
    also: ['Looking for vibecarbon upgrade?'],
  },
  {
    command: 'upgrade',
    title: 'Vibecarbon Upgrade - Upgrade infrastructure files to the latest template',
  },
];

describe('<command> -h prints that command’s help', () => {
  let project: string;
  beforeAll(() => {
    project = realProject();
  });
  afterAll(() => {
    destroyRealProject(project);
  });

  it('has a row for every KNOWN_COMMAND', () => {
    expect(HELP_TITLES.map((row) => row.command).sort()).toEqual([...KNOWN_COMMANDS].sort());
  });

  it.each(HELP_TITLES)(
    '$command -h exits 0 and starts with its exact title',
    ({ command, title, also }) => {
      const r = runCli(command, ['-h'], { cwd: project });
      assertSuccess(r);
      expect(r.stdout.split('\n')[0]).toBe(title);
      for (const text of also ?? []) {
        expect(r.stdout, `${command} -h is missing "${text}"`).toContain(text);
      }
    },
  );
});

describe("CLI '?' alias", () => {
  it("'?' -h exits 0 and prints the next help", () => {
    const result = runCliScript(['?', '-h']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vibecarbon next');
  });
});

describe('CLI -v', () => {
  it('-v exits with code 0', () => {
    const result = runCliScript(['-v']);
    expect(result.status).toBe(0);
  });

  it('answers --version the same as -v, the one double-dash exception', () => {
    const result = runCliScript(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(runCliScript(['-v']).stdout);
  });

  it('keeps a command rejecting --version as its own flag', () => {
    const result = runCliScript(['status', '--version']);
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
