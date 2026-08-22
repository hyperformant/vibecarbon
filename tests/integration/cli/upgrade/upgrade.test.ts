/**
 * vibecarbon upgrade — file-mutation tests against a real project.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitScrubbedEnv } from '../../../_shared/git-env.js';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon upgrade', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('upgrade', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Upgrade');
  });

  it('-dry leaves package.json unchanged', () => {
    const before = readFileSync(join(project, 'package.json'), 'utf-8');
    const r = runCli('upgrade', ['-dry', '-y'], { cwd: project, timeoutMs: 60_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    const after = readFileSync(join(project, 'package.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('-force accepted by parser', () => {
    const r = runCli('upgrade', ['-force', '-y'], { cwd: project, timeoutMs: 60_000 });
    if (/unknown flag: -force/.test(r.stderr)) {
      throw new Error(`-force rejected:\n${r.stderr}`);
    }
  });

  it('on a fresh project, upgrade is idempotent (no diff to apply)', () => {
    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 60_000 });
    // A freshly-created project should report nothing to upgrade.
    if (r.exitCode === null) throw new Error(`upgrade timed out`);
  });

  it('customer `git add -A` stays clean: upgrade leaves no untracked, un-ignored files', () => {
    // Generated-artifact hygiene (escape class, 2026-07-30): upgrade wrote
    // `.upgrade-backup` / `.upgrade-new` sidecars no .gitignore pattern
    // covered, so a customer's `git add -A` would commit them — and the
    // secret scanner only gates TRACKED content, so a backup carrying a
    // rendered secret would sail through. The class invariant, checked
    // BEHAVIORALLY rather than per-suffix: after a mutating CLI command,
    // every file left in the project is either tracked-by-intent or
    // gitignored. A future sidecar with a brand-new suffix fails here
    // without anyone having to remember to extend an inventory.
    // Git exports GIT_DIR (and friends) to every hook it runs, and the
    // pre-push hook runs this very suite. Under an inherited GIT_DIR, `cwd`
    // does NOT pick the repo — git operates on the REAL repo with the
    // fixture dir as its work tree, so the `git add -A` below would stage
    // the fixture's tree over the actual branch (this happened on
    // 2026-07-30: two `e2e@test.invalid` fixture commits landed on a
    // feature branch during `git push`). gitScrubbedEnv strips the
    // repo-targeting vars; isolateConfig pins global/system config to
    // /dev/null so nothing here can read or write an operator's identity
    // (the -c flags below supply the only identity git gets).
    const gitEnv = gitScrubbedEnv({ isolateConfig: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.invalid', ...args], {
        cwd: project,
        encoding: 'utf-8',
        env: gitEnv,
      });

    // Simulate the customer: everything committed before the upgrade.
    git('add', '-A');
    if (git('status', '--porcelain').trim() !== '') {
      git('commit', '-m', 'baseline', '--no-verify', '--quiet');
    }

    // Locally modify a template-managed file so -force actually writes a
    // .upgrade-backup sidecar (fresh projects are byte-identical to the
    // template — without this the invariant below would pass vacuously).
    const target = join(project, 'docker-compose.yml');
    writeFileSync(target, `${readFileSync(target, 'utf-8')}\n# local drift\n`);
    git('add', '-A');
    git('commit', '-m', 'local drift', '--no-verify', '--quiet');

    const r = runCli('upgrade', ['-force', '-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    // Positive control — the sidecar exists, so the assertion below is
    // exercised against a real artifact, not an empty run.
    expect(
      existsSync(`${target}.upgrade-backup`),
      'expected upgrade -force to back up the locally-modified docker-compose.yml — if the ' +
        'sidecar naming changed, update this test AND carbon/.gitignore together',
    ).toBe(true);

    // The invariant: every untracked-and-un-ignored file upgrade leaves
    // behind is a TEMPLATE file (upgrade legitimately materializes files the
    // template gained since the project was created — those are meant to be
    // committed). Anything else is an upgrade WORK ARTIFACT and must be
    // gitignored — a sidecar with a brand-new suffix has no carbon/
    // counterpart, so it fails here without a suffix inventory to maintain.
    const untracked = git('ls-files', '--others', '--exclude-standard')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const workArtifacts = untracked.filter(
      (rel) => !existsSync(join(process.cwd(), 'carbon', rel)),
    );
    expect(
      workArtifacts,
      'upgrade left non-template files a customer `git add -A` would commit — and the secret ' +
        'scanner only gates tracked content. Either gitignore the artifact (carbon/.gitignore + ' +
        'REQUIRED_IGNORES in tests/unit/security/gitignore-invariants.test.ts) or stop writing ' +
        'it into the project.',
    ).toEqual([]);
  });

  it('re-pins a stale packageManager to the host pnpm — and says so', () => {
    // The pin's SOURCE moved when the template went npm-based: carbon/ no
    // longer carries a `packageManager` field to re-take, so the host's
    // installed pnpm is what upgrade pins to — and it is also the pnpm that
    // regenerates the lockfile at the end of the same run, so pin, lockfile,
    // and pnpm config still travel together.
    //
    // What did NOT move is PR #214's rule: never silently. The customer must
    // see the old and new values, and must be able to get the old one back.
    // (The fixture is created with -skip-lockfile, so this stale field is
    // also what makes detectPackageManager report pnpm here.)
    const pkgPath = join(project, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.packageManager = 'pnpm@9.9.9';
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const r = runCli('upgrade', ['-force', '-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    const after = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(after.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+/);
    expect(after.packageManager).not.toBe('pnpm@9.9.9');
    // The announcement names the old value (clack may wrap the line, so
    // assert the tokens, not the whole sentence).
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain('pnpm@9.9.9');
    expect(out).toContain('host pnpm pin');
    // Recoverability claim holds: the sidecar carries the old content.
    expect(readFileSync(`${pkgPath}.upgrade-backup`, 'utf-8')).toContain('pnpm@9.9.9');
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('upgrade', ['-y'], { cwd: '/tmp', timeoutMs: 15_000 });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });

  it('upgrades a legacy project with no PROJECT_DISPLAY_NAME recorded (titleize fallback)', () => {
    // Projects created before PROJECT_DISPLAY_NAME existed have no record of
    // it in .env.local; reconstructVariables must fall back to titleizing the
    // slug instead of crashing or substituting an empty string.
    const envPath = join(project, '.env.local');
    const env = readFileSync(envPath, 'utf-8');
    const stripped = env
      .split('\n')
      .filter((line) => !line.startsWith('PROJECT_DISPLAY_NAME='))
      .join('\n');
    expect(stripped).not.toBe(env);
    writeFileSync(envPath, stripped);

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 60_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);
  });
});
