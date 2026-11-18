/**
 * sourceFiles (tests/_shared/source-files.ts): the one recursive file walk the
 * source censuses share. A census is only as good as the set of files it
 * scans, so every option is pinned here: a walk that quietly lists fewer
 * files would turn each census that uses it into a test that cannot fail.
 * These pins are what the registry row in shared-helper-consumers.test.ts
 * points at as deep coverage.
 */
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';
import { createTempDir } from '../../_shared/temp-dir.js';

let root: string;

/** Create every file (and the directories above it) under `root`. */
function tree(files: string[]): void {
  for (const rel of files) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), '');
  }
}

beforeEach(() => {
  root = createTempDir('source-files-');
  tree([
    'a.js',
    'b.ts',
    'notes.md',
    '.hidden.js',
    'lib/c.js',
    'lib/deep/d.mjs',
    'lib/deep/e.test.ts',
    'node_modules/pkg/index.js',
    '.cache/f.js',
  ]);
});

const sorted = (list: string[]) => [...list].sort();

describe('sourceFiles', () => {
  it('lists every file at every depth, each joined onto the root', () => {
    expect(sorted(sourceFiles(root))).toEqual(
      sorted(
        [
          'a.js',
          'b.ts',
          'notes.md',
          '.hidden.js',
          'lib/c.js',
          'lib/deep/d.mjs',
          'lib/deep/e.test.ts',
          'node_modules/pkg/index.js',
          '.cache/f.js',
        ].map((rel) => join(root, rel)),
      ),
    );
  });

  it('lists a directory before it moves on to the next entry', () => {
    tree(['only/x/1.js', 'only/x/2.js', 'only/y.js']);
    const listed = sourceFiles(join(root, 'only'), { relativeTo: root });
    expect(sorted(listed)).toEqual(['only/x/1.js', 'only/x/2.js', 'only/y.js']);
    // The two files of x/ are neighbours wherever x/ falls in directory order.
    expect(Math.abs(listed.indexOf('only/x/1.js') - listed.indexOf('only/x/2.js'))).toBe(1);
  });

  it('keeps only names that end with one of exts', () => {
    expect(sorted(sourceFiles(root, { exts: ['.js'], relativeTo: root }))).toEqual(
      sorted(['a.js', '.hidden.js', 'lib/c.js', 'node_modules/pkg/index.js', '.cache/f.js']),
    );
    expect(sorted(sourceFiles(root, { exts: ['.mjs', '.test.ts'], relativeTo: root }))).toEqual([
      'lib/deep/d.mjs',
      'lib/deep/e.test.ts',
    ]);
  });

  it('passes over a skipped name, directory or file', () => {
    const listed = sourceFiles(root, { skip: ['node_modules', 'notes.md'], relativeTo: root });
    expect(listed).not.toContain('node_modules/pkg/index.js');
    expect(listed).not.toContain('notes.md');
    expect(listed).toContain('lib/c.js');
  });

  it('takes skip as a Set too', () => {
    const listed = sourceFiles(root, { skip: new Set(['lib']), relativeTo: root });
    expect(listed.filter((f) => f.startsWith('lib'))).toEqual([]);
  });

  it('skipDotDirs stays out of dot directories and still lists dot files', () => {
    const listed = sourceFiles(root, { skipDotDirs: true, relativeTo: root });
    expect(listed).not.toContain('.cache/f.js');
    expect(listed).toContain('.hidden.js');
  });

  it('enters dot directories unless told otherwise', () => {
    expect(sourceFiles(root, { relativeTo: root })).toContain('.cache/f.js');
  });

  it('walks several roots, in the order given', () => {
    const listed = sourceFiles([join(root, 'lib'), join(root, 'node_modules')], {
      relativeTo: root,
    });
    expect(sorted(listed)).toEqual([
      'lib/c.js',
      'lib/deep/d.mjs',
      'lib/deep/e.test.ts',
      'node_modules/pkg/index.js',
    ]);
    expect(listed.at(-1)).toBe('node_modules/pkg/index.js');
  });

  it('keeps a relative root relative', () => {
    tree(['rel/x.js']);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(sourceFiles('rel')).toEqual([join('rel', 'x.js')]);
    } finally {
      process.chdir(cwd);
    }
  });

  it('throws on a root that is missing, so a census cannot pass on nothing', () => {
    expect(() => sourceFiles(join(root, 'no-such-dir'))).toThrow(/ENOENT/);
    expect(() => sourceFiles([join(root, 'lib'), join(root, 'no-such-dir')])).toThrow(/ENOENT/);
  });

  it('throws on a root that is a file', () => {
    expect(() => sourceFiles(join(root, 'a.js'))).toThrow(/ENOTDIR/);
  });

  it('lists a symbolic link to a directory as a file and does not follow it', () => {
    symlinkSync(join(root, 'lib'), join(root, 'link'));
    const listed = sourceFiles(root, { relativeTo: root });
    expect(listed).toContain('link');
    expect(listed.filter((f) => f.startsWith('link/'))).toEqual([]);
  });

  it('lists names without reading a file: one it could not open is still listed', () => {
    tree(['.env.e2e']);
    chmodSync(join(root, '.env.e2e'), 0o000);
    try {
      expect(sourceFiles(root, { relativeTo: root })).toContain('.env.e2e');
    } finally {
      chmodSync(join(root, '.env.e2e'), 0o600);
    }
  });
});

describe('REPO_ROOT and readRepoFile', () => {
  it('REPO_ROOT is the directory holding this package, with no trailing separator', () => {
    expect(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')).name).toBe(
      'vibecarbon',
    );
    expect(REPO_ROOT).toBe(join(import.meta.dirname, '..', '..', '..'));
    expect(REPO_ROOT.endsWith('/')).toBe(false);
  });

  it('does not come from the working directory', async () => {
    const elsewhere = createTempDir('source-files-cwd-');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(elsewhere);
    try {
      vi.resetModules();
      const fresh = await import('../../_shared/source-files.js');
      expect(fresh.REPO_ROOT).toBe(REPO_ROOT);
      expect(fresh.readRepoFile('package.json')).toContain('"name": "vibecarbon"');
    } finally {
      cwd.mockRestore();
    }
  });

  it('readRepoFile reads the text at a path from the root, whole or in parts', () => {
    const text = readFileSync(join(REPO_ROOT, 'tests', '_shared', 'source-files.ts'), 'utf-8');
    expect(readRepoFile('tests/_shared/source-files.ts')).toBe(text);
    expect(readRepoFile('tests', '_shared', 'source-files.ts')).toBe(text);
  });

  it('readRepoFile throws on a file that is not there', () => {
    expect(() => readRepoFile('no-such-file.txt')).toThrow(/ENOENT/);
  });
});
