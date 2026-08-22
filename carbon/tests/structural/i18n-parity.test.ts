import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Structural invariant: every locale file this project ships must have the
// same key set as en.json. A missing key falls back to the key path at
// runtime (ugly); an extra key means the source string was renamed or dropped
// but the translation wasn't updated. Either way it's a bug.
//
// The locale set is READ FROM DISK rather than imported by name, because the
// files present are what defines the languages the project ships (see
// src/client/lib/i18n.ts, which globs the same directory). A hardcoded list
// would fail the moment a language is added or removed, which is exactly the
// operation this is supposed to survive.
//
// The project currently ships English only, so the comparison loop is empty
// and this file holds the line rather than asserting anything. That is the
// correct behavior, not a skipped test: `en.json is present` still runs, and
// the loop re-arms itself the moment a locale file is added back.
//
// This is the pattern for "cross-cutting invariant" tests — they don't
// exercise behavior, they assert that the shape of related artifacts agrees.
// Lives in tests/structural/ and runs under the `unit` project.

const LOCALES_DIR = join(import.meta.dirname, '../../src/client/locales');

/** Recursively collect every leaf key path, e.g. "auth.signIn", "landing.hero.badge". */
function collectKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, val]) =>
    collectKeys(val, prefix ? `${prefix}.${key}` : key)
  );
}

const readLocale = (file: string) =>
  JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf-8')) as unknown;

const localeFiles = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
const translations = localeFiles.filter((f) => f !== 'en.json');

const enKeys = new Set(collectKeys(readLocale('en.json')));

describe('i18n locale parity', () => {
  it('en.json is present and non-trivial', () => {
    // English is the fallback language and the reference key set. If it ever
    // goes missing, every assertion below becomes vacuous rather than failing.
    expect(localeFiles).toContain('en.json');
    expect(enKeys.size).toBeGreaterThan(100);
  });

  for (const file of translations) {
    const keys = new Set(collectKeys(readLocale(file)));

    it(`${file} contains every key from en.json`, () => {
      const missing = [...enKeys].filter((k) => !keys.has(k));
      expect(missing, `${file} missing: ${missing.slice(0, 10).join(', ')}`).toHaveLength(0);
    });

    it(`${file} has no extra keys absent from en.json`, () => {
      const extra = [...keys].filter((k) => !enKeys.has(k));
      expect(extra, `${file} extra: ${extra.slice(0, 10).join(', ')}`).toHaveLength(0);
    });
  }
});
