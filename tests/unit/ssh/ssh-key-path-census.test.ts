/**
 * One definition of the SSH key path.
 *
 * Single-cluster k8s once wrote `.vibecarbon/ssh-<env>` while every other mode
 * wrote `.vibecarbon/deploy_key_<env>`, and a dozen readers each built one of
 * the two names by hand. `vibecarbon destroy` on a k8s env then stopped before
 * deleting anything (DigitalOcean, 2026-11-04). The path now has one owner,
 * sshKeyPathFor in src/lib/ssh.js; this census fails any other file in src/ or
 * tests/e2e that joins a key name under `.vibecarbon`.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readRepoFile, sourceFiles } from '../../_shared/source-files.js';

const OWNER = 'src/lib/ssh.js';

/** A key filename built from a template: deploy_key_${...} or ssh-${...}. */
const HAND_BUILT = /deploy_key_\$\{|`ssh-\$\{|['"`/]ssh-\$\{/;

function handBuiltKeyPaths(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file]) => file !== OWNER)
    .flatMap(([file, text]) =>
      text
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => HAND_BUILT.test(line))
        .map(({ n }) => `${file}:${n}`),
    );
}

describe('ssh key path census', () => {
  it('no file in src/ or tests/e2e builds a .vibecarbon key path by hand', () => {
    const files: Record<string, string> = {};
    for (const dir of ['src', 'tests/e2e']) {
      for (const f of sourceFiles(join(REPO_ROOT, dir), {
        exts: ['.js', '.ts'],
        skip: ['node_modules'],
      })) {
        files[relative(REPO_ROOT, f)] = readFileSync(f, 'utf8');
      }
    }
    expect(handBuiltKeyPaths(files)).toEqual([]);
  });

  it('fails on a planted hand-built path', () => {
    const d = '$'; // keeps the template text below out of the lint's way
    const planted = {
      'src/new-thing.js': `const k = join(cwd, '.vibecarbon', \`deploy_key_${d}{env}\`);`,
      'tests/e2e/x.ts': `const k = join(dir, '.vibecarbon', \`ssh-${d}{env}\`);`,
      [OWNER]: `return join(cwd, '.vibecarbon', \`deploy_key_${d}{baseEnv}\`);`,
    };
    expect(handBuiltKeyPaths(planted)).toEqual(['src/new-thing.js:1', 'tests/e2e/x.ts:1']);
  });

  it('shell and diagnose resolve deploy_key_<env> through the helper', () => {
    for (const f of ['src/shell.js', 'src/diagnose.js']) {
      expect(readRepoFile(f)).toMatch(/sshKeyPathFor\(envName, cwd\)/);
    }
    expect(readRepoFile('src/shell.js')).toContain('<cwd>/.vibecarbon/deploy_key_<env>');
  });
});
