import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../_harness/index.js';

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
// is also excluded — it doesn't need a project (it operates on global
// Hetzner state).
//
// This table is the only "outside a project" test: each command's own file
// used to carry a copy. Each row's argv is the union of the flags this table
// and that copy passed (`-y` in most), so every flag the copies got through
// the parser still goes through it here. The guard runs straight after the
// parser in every command, before any positional is read.
const IN_PROJECT_COMMANDS: Array<{ name: string; argv: string[] }> = [
  { name: 'add', argv: ['add', 'observability', '-y'] },
  { name: 'remove', argv: ['remove', 'observability', '-y'] },
  { name: 'up', argv: ['up'] },
  { name: 'down', argv: ['down'] },
  { name: 'reset', argv: ['reset', '-y'] },
  { name: 'deploy', argv: ['deploy', 'prod', '-y'] },
  { name: 'destroy', argv: ['destroy', 'prod', '-y'] },
  { name: 'backup', argv: ['backup', 'prod', '-l', '-y'] },
  { name: 'restore', argv: ['restore', 'prod', '-l', '-y'] },
  { name: 'failover', argv: ['failover', 'prod', '-y'] },
  { name: 'scale', argv: ['scale', 'prod', '-y'] },
  { name: 'update', argv: ['update', 'prod', '-y'] },
  { name: 'upgrade', argv: ['upgrade', '-y'] },
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
    it(`${name} → emits "Not in a Vibecarbon project directory." and exits 1`, () => {
      // runCli gives the child a throwaway HOME and a closed API port, so a
      // command that misses its guard cannot touch the developer's
      // ~/.vibecarbon or report to production. Hard ceiling: the guard runs
      // synchronously and returns at once; past 15 s is a regression.
      const result = runCli(argv[0], argv.slice(1), { cwd: tmp, timeoutMs: 15_000 });

      const combined = `${result.stdout}\n${result.stderr}`;

      expect(
        result.exitCode,
        `${name}: expected exit 1 (assertInProjectDir). exit=${result.exitCode} output:\n${combined}`,
      ).toBe(1);
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

// Below a project root the refusal is still correct — every command resolves
// docker-compose.yml, .env.local, k8s overlays and relative arguments against
// the cwd, so running from `src/client` would read a tree the user did not
// mean. What changes is the follow-up line: telling someone already inside a
// created project to "run this from within a project created with vibecarbon
// create" describes their situation wrongly and leaves them to find the root
// themselves.
describe('vibecarbon — inside a project but below its root: refusal names the root', () => {
  let root: string;
  let sub: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vc-subdir-'));
    writeFileSync(join(root, '.vibecarbon.json'), JSON.stringify({ projectName: 'acme' }));
    writeFileSync(join(root, 'docker-compose.yml'), 'services: {}\n');
    sub = join(root, 'src', 'client');
    mkdirSync(sub, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const { name, argv } of [
    { name: 'up', argv: ['up'] },
    { name: 'deploy', argv: ['deploy', 'prod'] },
  ]) {
    it(`${name} → refuses, names the project root, and exits 1`, () => {
      const result = runCli(argv[0], argv.slice(1), { cwd: sub, timeoutMs: 15_000 });

      const combined = `${result.stdout}\n${result.stderr}`;

      expect(
        result.exitCode,
        `${name}: expected exit 1. exit=${result.exitCode} output:\n${combined}`,
      ).toBe(1);
      expect(combined, `${name}: missing canonical error message`).toContain(
        'Not in a Vibecarbon project directory.',
      );
      expect(combined, `${name}: did not name the project root`).toContain(
        `The project root is ${root}`,
      );
      expect(combined, `${name}: did not hand over the cd`).toContain(`cd ${root}`);
      expect(combined, `${name}: kept the misleading generic follow-up line`).not.toContain(
        'Run this command from within a project created with',
      );
    });
  }
});
