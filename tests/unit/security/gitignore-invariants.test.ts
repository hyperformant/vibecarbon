import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildGitAddArgv,
  buildGitAddNamedArgv,
  validateGitignore,
} from '../../../src/lib/project.js';
import { templatePathFor } from '../../../src/lib/template-paths.js';
import { gitScrubbedEnv } from '../../_shared/git-env.js';

const REQUIRED_IGNORES = [
  '.vibecarbon/',
  '.env',
  '.env.local',
  '.env.*.local',
  '*.pem',
  '*.key',
  '*.tfstate',
  '*.tfstate.*',
  '*.upgrade-backup',
  '*.upgrade-new',
];

describe('C-2: template .gitignore invariants', () => {
  const templateGitignore = readFileSync(
    join(process.cwd(), 'carbon', templatePathFor('.gitignore')),
    'utf-8',
  );

  it.each(REQUIRED_IGNORES)('carbon/_gitignore (shipped as .gitignore) ignores %s', (pattern) => {
    const lines = templateGitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines).toContain(pattern);
  });
});

describe('C-2: validateGitignore helper', () => {
  it('returns empty list when all required patterns are present', () => {
    const path = join(process.cwd(), 'carbon', templatePathFor('.gitignore'));
    expect(validateGitignore(path)).toEqual([]);
  });

  it('reports missing patterns', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'vb-gitignore-test-'));
    try {
      const p = join(tmp, '.gitignore');
      writeFileSync(p, 'node_modules\n.env\n'); // missing several
      const missing = validateGitignore(p);
      expect(missing).toContain('.vibecarbon/');
      expect(missing).toContain('*.key');
      expect(missing).toContain('*.tfstate');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports missing file', () => {
    expect(validateGitignore('/nonexistent/path/.gitignore')).toEqual(['.gitignore is missing']);
  });
});

describe('C-2: buildGitAddArgv never includes .vibecarbon or .env', () => {
  it('allowlist does not contain dangerous entries', () => {
    const argv = buildGitAddArgv();
    expect(argv).not.toContain('.');
    expect(argv).not.toContain('.vibecarbon/');
    expect(argv).not.toContain('.env');
    expect(argv).not.toContain('.env.local');
  });

  it('stages no .env file and nothing under .vibecarbon/, even when they exist', async () => {
    // The checks above run in this checkout, where none of these exist, and
    // the allowlist only ever returns paths that do. Here they all exist.
    const { writeFileSync, mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'vb-allowlist-test-'));
    try {
      const present = ['.env', '.env.local', '.env.example', '.env.local.example', 'package.json'];
      for (const name of present) writeFileSync(join(tmp, name), '');
      mkdirSync(join(tmp, '.vibecarbon'));
      writeFileSync(join(tmp, '.vibecarbon', 'deploy_key'), '');
      const paths = buildGitAddArgv(tmp)
        .slice(3)
        .filter((p) => !p.startsWith(':('));
      expect(paths).toEqual(['package.json']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The allowlist names whole directories (src/, tests/, volumes/). Without
  // this, a .env file inside one is staged whenever the project's .gitignore
  // does not cover its name (.env.e2e, .env.production) or is missing
  // (deleted, or a project created without git by an older CLI).
  it('stages no .env file inside an allowlisted directory, with no .gitignore to help', async () => {
    const { writeFileSync, mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const tmp = mkdtempSync(join(tmpdir(), 'vb-allowlist-env-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          env: gitScrubbedEnv(),
          cwd: tmp,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      git('init', '-q');
      for (const dir of ['src', 'tests', 'tests/e2e', 'volumes']) mkdirSync(join(tmp, dir));
      const files = [
        'src/app.ts',
        'src/.env.production',
        'tests/a.test.ts',
        'tests/.env.e2e',
        'tests/e2e/.env',
        'volumes/.env.local',
        'package.json',
      ];
      for (const name of files) writeFileSync(join(tmp, name), 'x');
      const [cmd, ...args] = buildGitAddArgv(tmp);
      execFileSync(cmd, args, { cwd: tmp, stdio: 'ignore', env: gitScrubbedEnv() });
      const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
      expect(staged).toEqual(['package.json', 'src/app.ts', 'tests/a.test.ts']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('adds no exclusion when nothing is staged (a lone exclusion would stage everything)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'vb-allowlist-empty-'));
    try {
      expect(buildGitAddArgv(tmp)).toEqual(['git', 'add', '--']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("names the template's Cursor rules, not the whole .cursor directory", () => {
    const argv = buildGitAddArgv(join(import.meta.dirname, '..', '..', '..', 'carbon'));
    expect(argv).toContain('.cursor/rules/');
    expect(argv).not.toContain('.cursor/');
  });

  it('starts with git add --', () => {
    const argv = buildGitAddArgv();
    expect(argv.slice(0, 3)).toEqual(['git', 'add', '--']);
  });

  it('includes drizzle.config.ts, the config the schema workflow reads', () => {
    expect(buildGitAddArgv(join(process.cwd(), 'carbon'))).toContain('drizzle.config.ts');
  });

  it('includes an allowlisted file that exists', () => {
    expect(buildGitAddArgv(process.cwd())).toContain('package.json');
  });
});

// deploy generates a missing lockfile and stages it. It used to do that with
// buildGitAddArgv, which staged the lockfile and every other allowlisted file
// the operator had changed.
describe('buildGitAddNamedArgv stages the named files and nothing else', () => {
  async function repo(prefix: string) {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const tmp = mkdtempSync(join(tmpdir(), prefix));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        env: gitScrubbedEnv(),
        cwd: tmp,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const run = (argv: string[]) => git(...argv.slice(1));
    const staged = () => git('diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
    git('init', '-q');
    return { tmp, git, run, staged, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }

  it('a new lockfile is staged; a modified allowlisted file and a new one are left alone', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { tmp, git, run, staged, cleanup } = await repo('vb-named-add-');
    try {
      mkdirSync(join(tmp, 'src'));
      writeFileSync(join(tmp, 'package.json'), '{}');
      writeFileSync(join(tmp, 'src', 'app.ts'), 'one');
      git('add', '--', 'package.json', 'src/app.ts');
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'base',
      );
      // The operator's work in progress, all of it on the allowlist.
      writeFileSync(join(tmp, 'package.json'), '{"name":"edited"}');
      writeFileSync(join(tmp, 'src', 'app.ts'), 'two');
      writeFileSync(join(tmp, 'src', 'new.ts'), 'new');
      // What deploy generated.
      writeFileSync(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9');

      // The mistake, shown on the same tree: the allowlist stages all four.
      expect(buildGitAddArgv(tmp)).toEqual(
        expect.arrayContaining(['package.json', 'src/', 'pnpm-lock.yaml']),
      );

      run(buildGitAddNamedArgv(tmp, ['pnpm-lock.yaml']));
      expect(staged()).toEqual(['pnpm-lock.yaml']);
      // Still modified and untracked in the working tree, untouched.
      expect(git('status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual(
        ['A  pnpm-lock.yaml', ' M package.json', ' M src/app.ts', '?? src/new.ts'].sort(),
      );
    } finally {
      cleanup();
    }
  });

  it('names only what exists, after git add --', async () => {
    const { writeFileSync } = await import('node:fs');
    const { tmp, cleanup } = await repo('vb-named-argv-');
    try {
      writeFileSync(join(tmp, 'bun.lock'), '');
      const argv = buildGitAddNamedArgv(tmp, ['bun.lock', 'bun.lockb']);
      expect(argv.slice(0, 3)).toEqual(['git', 'add', '--']);
      expect(argv.slice(3).filter((p) => !p.startsWith(':('))).toEqual(['bun.lock']);
    } finally {
      cleanup();
    }
  });

  it('adds no exclusion when no named file exists (a lone exclusion would stage everything)', async () => {
    const { writeFileSync } = await import('node:fs');
    const { tmp, run, staged, cleanup } = await repo('vb-named-empty-');
    try {
      writeFileSync(join(tmp, 'package.json'), '{}');
      writeFileSync(join(tmp, 'secret.txt'), 'x');
      const argv = buildGitAddNamedArgv(tmp, ['package-lock.json']);
      expect(argv).toEqual(['git', 'add', '--']);
      run(argv);
      expect(staged()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('never stages an env file, even one named outright', async () => {
    const { writeFileSync } = await import('node:fs');
    const { tmp, run, staged, cleanup } = await repo('vb-named-env-');
    try {
      writeFileSync(join(tmp, '.env.local'), 'SECRET=x');
      writeFileSync(join(tmp, 'package-lock.json'), '{}');
      run(buildGitAddNamedArgv(tmp, ['package-lock.json', '.env.local']));
      expect(staged()).toEqual(['package-lock.json']);
    } finally {
      cleanup();
    }
  });
});
