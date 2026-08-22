import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGitAddArgv, validateGitignore } from '../../../src/lib/project.js';

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
  const templateGitignore = readFileSync(join(process.cwd(), 'carbon', '.gitignore'), 'utf-8');

  it.each(REQUIRED_IGNORES)('carbon/.gitignore ignores %s', (pattern) => {
    const lines = templateGitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines).toContain(pattern);
  });
});

describe('C-2: validateGitignore helper', () => {
  it('returns empty list when all required patterns are present', () => {
    const path = join(process.cwd(), 'carbon', '.gitignore');
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
