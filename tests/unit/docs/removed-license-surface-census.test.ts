/**
 * Vibecarbon is MIT with no keys, no activation and no license service. The
 * strings below belonged to the retired license machinery; if one shows up in
 * the CLI or the template again, someone has revived a removed surface. The
 * bare word "activate" is NOT banned: it has unrelated uses.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const BANNED_STRINGS = [
  'vibecarbon activate',
  'vibecarbon deactivate',
  '/api/v1/license',
  '.vibecarbon.license',
  'license-checkout',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (stat.size < 2_000_000) out.push(full);
  }
  return out;
}

function findBanned(roots: string[], banned: string[]): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of walk(join(ROOT, root))) {
      const text = readFileSync(file, 'utf-8');
      for (const needle of banned) {
        if (text.includes(needle)) offenders.push(`${file.slice(ROOT.length + 1)}: ${needle}`);
      }
    }
  }
  return offenders;
}

describe('removed license surface census', () => {
  it('src/ and carbon/src/ never reference the retired license commands, API, file or checkout', () => {
    // Sanity: the walk reaches both trees.
    expect(walk(join(ROOT, 'src')).length).toBeGreaterThan(50);
    expect(walk(join(ROOT, 'carbon', 'src')).length).toBeGreaterThan(100);
    expect(findBanned(['src', 'carbon/src'], BANNED_STRINGS)).toEqual([]);
  });

  it('the scan catches a banned string (a scan that cannot fail guards nothing)', () => {
    // This file spells every banned string, so scanning it must find them all.
    const offenders = findBanned(['tests/unit/docs'], BANNED_STRINGS).filter((o) =>
      o.startsWith('tests/unit/docs/removed-license-surface-census.test.ts'),
    );
    expect(offenders.length).toBe(BANNED_STRINGS.length);
  });
});
