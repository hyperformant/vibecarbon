import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../src/client/locales/en.json';

// Structural invariant: every translation key referenced in client source must
// exist in en.json.
//
// The parity test next door proves the five locale files agree with each
// other. It cannot catch the other half of the contract: a key the code asks
// for that no locale defines. i18next has no runtime error for that — it
// renders the key path itself, so the UI silently shows "dashboard.userId"
// where a label belongs, in every language at once. That is exactly the bug
// this test was written after finding.
//
// Together the two tests close the loop: parity keeps the locales in step with
// en.json, and this keeps en.json in step with the code.

/** Static `t('some.key')` calls. Dynamic keys are skipped — see below. */
const T_CALL = /\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g;

const CLIENT_ROOT = join(import.meta.dirname, '../../src/client');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Resolves a dotted path against en.json, requiring it to land on a string. */
function resolves(path: string): boolean {
  let cursor: unknown = en;
  for (const part of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || !(part in cursor)) return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === 'string';
}

const unresolved = walk(CLIENT_ROOT).flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(T_CALL)]
    .map((m) => m[1])
    .filter((key) => !resolves(key))
    .map((key) => `${relative(CLIENT_ROOT, file)}: ${key}`);
});

describe('i18n key resolution', () => {
  it('every t() key referenced in client source exists in en.json', () => {
    expect(
      unresolved,
      `These keys are requested by the code but missing from en.json, so i18next ` +
        `renders the raw key path to the user:\n  ${unresolved.join('\n  ')}`
    ).toEqual([]);
  });

  it('the scan actually finds keys (guards against a matcher that stopped matching)', () => {
    // Without this, a broken regex would make the assertion above vacuously
    // pass — zero keys scanned is zero keys unresolved.
    const scanned = walk(CLIENT_ROOT).flatMap((file) => [
      ...readFileSync(file, 'utf8').matchAll(T_CALL),
    ]);
    expect(scanned.length).toBeGreaterThan(300);
  });

  it('resolves() rejects paths that stop on an object rather than a string', () => {
    // 'admin.settings' is a real branch but not a usable label; asking for it
    // would render "[object Object]", so it must count as unresolved.
    expect(resolves('admin.settings.documentation.title')).toBe(true);
    expect(resolves('admin.settings')).toBe(false);
    expect(resolves('admin.settings.nope')).toBe(false);
  });
});
