import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const CLI = join(REPO_ROOT, 'src', 'cli.js');

// Every CLI subcommand that mutates or reads a project's tree must emit
// the same friendly "not in a project" message and exit non-zero when
// run from outside a Vibecarbon project. The shared `assertInProjectDir`
// helper enforces this — without it, commands behave inconsistently:
//
//   - `add` / `deploy` would walk the entire parent tree with the
//     secret-scanner and dump real tokens to scrollback.
//   - `up` / `down` / `reset` would print confusing package.json errors.
//   - `backup` / `restore` / `failover` / `destroy` / `access` /
//     `configure` would each emit slightly different wording.
//   - `shell` / `diagnose` would fall through to `kubectl` against a
//     kubeconfig path that doesn't exist.
//
// This parameterized test pins the consistent contract: same exit code,
// same message, no leakage from upstream secret scans.
//
// `status` is intentionally excluded — it has a documented dual mode
// that lists registered projects when run outside a project. `console`
// and `activate` / `deactivate` are also excluded — they don't need a
// project (they operate on global Hetzner / license state).
const IN_PROJECT_COMMANDS: Array<{ name: string; argv: string[] }> = [
  { name: 'add', argv: ['add', 'observability'] },
  { name: 'remove', argv: ['remove', 'observability'] },
  { name: 'up', argv: ['up'] },
  { name: 'down', argv: ['down'] },
  { name: 'reset', argv: ['reset', '-y'] },
  { name: 'deploy', argv: ['deploy', 'prod'] },
  { name: 'destroy', argv: ['destroy', 'prod', '-y'] },
  { name: 'backup', argv: ['backup', 'prod', '-l'] },
  { name: 'restore', argv: ['restore', 'prod', '-l'] },
  { name: 'failover', argv: ['failover', 'prod'] },
  { name: 'scale', argv: ['scale', 'prod'] },
  { name: 'upgrade', argv: ['upgrade'] },
  { name: 'configure', argv: ['configure'] },
  { name: 'configure cicd', argv: ['configure', 'cicd', 'prod'] },
  { name: 'access', argv: ['access', 'list'] },
  { name: 'shell', argv: ['shell', 'prod'] },
  { name: 'diagnose', argv: ['diagnose', 'prod'] },
];

describe('vibecarbon — outside a project directory: canonical refusal', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vc-noproj-'));
    // Plant a value the secret-scanner WOULD flag if it ran. If any of
    // the assertions below find "Refusing to" or "secrets detected" in
    // the output, that means the command let a secret-scan walk the
    // unrelated parent tree.
    writeFileSync(
      join(tmp, 'leaky.env'),
      'CLOUDFLARE_API_TOKEN="rMPctubolw3N83LIYdSUiISpQmMI_ZCgiwY8sD6U"\n',
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const { name, argv } of IN_PROJECT_COMMANDS) {
    it(`${name} → emits "Not in a Vibecarbon project directory." and exits non-zero`, () => {
      const result = spawnSync(process.execPath, [CLI, ...argv], {
        cwd: tmp,
        encoding: 'utf-8',
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        // Hard ceiling: the guard should run synchronously and return
        // immediately. Anything that hangs past 15s is a regression.
        timeout: 15000,
      });

      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

      expect(
        result.status,
        `${name}: expected non-zero exit. status=${result.status} signal=${result.signal} output:\n${combined}`,
      ).not.toBe(0);
      expect(combined, `${name}: missing canonical error message`).toContain(
        'Not in a Vibecarbon project directory.',
      );
      expect(combined, `${name}: missing follow-up info line`).toContain(
        'Run this command from within a project created with `vibecarbon create`.',
      );
      // No upstream check should have run before the project guard. In
      // particular, the secret-scan must not have walked the temp dir.
      expect(combined, `${name}: secret-scan ran before the project guard`).not.toContain(
        'Refusing to',
      );
      expect(combined, `${name}: secret-scan ran before the project guard`).not.toContain(
        'secrets detected',
      );
    });
  }
});
