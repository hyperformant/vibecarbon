/**
 * The deploy-time secret scan must pass over the template's own source and
 * tests, or every `vibecarbon deploy` / `add` of a fresh project refuses.
 *
 * Regression (Task 6 of the in-app auth move): auth error keys and db-test
 * passwords in carbon/src and carbon/tests tripped the scanner, which
 * `refuseIfSecretsPresent` turns into a refused deploy. It was caught only by
 * the slower root integration tier; this pins the same contract in the fast
 * unit tier, in-process (scanContent over the files a generated project
 * commits from these two trees).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanContent } from '../../../src/lib/secret-scan.js';

const CARBON = join(__dirname, '..', '..', '..', 'carbon');
const TEXT_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.sql',
  '.md',
  '.mdx',
  '.yml',
  '.yaml',
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return TEXT_EXTS.has(extname(name)) ? [full] : [];
  });
}

describe('the template passes the deploy secret scan', () => {
  it('finds nothing in carbon/src or carbon/tests', () => {
    const files = [...walk(join(CARBON, 'src')), ...walk(join(CARBON, 'tests'))];
    expect(files.length).toBeGreaterThan(100);
    const findings = files.flatMap((file) =>
      scanContent(readFileSync(file, 'utf-8')).map(
        (f) => `${relative(CARBON, file)}:${f.line} ${f.ruleId} ${f.match}`,
      ),
    );
    expect(findings).toEqual([]);
  });
});
