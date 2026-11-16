import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGitAddArgv, validateGitignore } from '../../../src/lib/project.js';
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

  it('includes drizzle.config.ts, the config the schema workflow reads', () => {
    expect(buildGitAddArgv(join(process.cwd(), 'carbon'))).toContain('drizzle.config.ts');
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
  // does not cover its name (.env.e2e, .env.production) or is missing (a
  // project created without git has none).
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

  it('extras are appended to the allowlist', () => {
    const argv = buildGitAddArgv();
    expect(argv).not.toContain('.');
    // Test with a real path that exists in cwd
    const realArgv = buildGitAddArgv(process.cwd(), ['package.json']);
    expect(realArgv).toContain('package.json');
  });

  it('silently drops extras that do not exist', () => {
    const argv = buildGitAddArgv(process.cwd(), ['definitely-not-a-real-file.txt']);
    expect(argv).not.toContain('definitely-not-a-real-file.txt');
  });

  it('includes extras that do exist', () => {
    const argv = buildGitAddArgv(process.cwd(), ['package.json']);
    // package.json is already in the allowlist, so this should just not duplicate
    expect(argv.filter((p) => p === 'package.json').length).toBeGreaterThanOrEqual(1);
  });
});
