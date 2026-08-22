import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addLocale,
  BASE_LOCALE,
  installedLocales,
  LOCALES_SUBDIR,
  removeLocale,
  status,
} from '../../../src/lib/globalization.js';

/**
 * The locale files on disk are the language set, so these are the operations
 * that change what a project ships. Exercised against real temp directories
 * rather than mocked fs: the thing under test IS the file layout.
 */

const EN = {
  common: { save: 'Save', cancel: 'Cancel' },
  nav: { docs: 'User Docs' },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-global-'));
  mkdirSync(join(dir, LOCALES_SUBDIR), { recursive: true });
  writeFileSync(join(dir, LOCALES_SUBDIR, 'en.json'), JSON.stringify(EN, null, 2));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (code: string) =>
  JSON.parse(readFileSync(join(dir, LOCALES_SUBDIR, `${code}.json`), 'utf-8'));

describe('installedLocales', () => {
  it('reports what is on disk, not a declared list', () => {
    expect(installedLocales(dir)).toEqual(['en']);
    addLocale(dir, 'es');
    expect(installedLocales(dir)).toEqual(['en', 'es']);
  });

  it('includes codes it has no label for — a file is a shipped language', () => {
    writeFileSync(join(dir, LOCALES_SUBDIR, 'ja.json'), JSON.stringify(EN));
    expect(installedLocales(dir)).toContain('ja');
  });

  it('returns empty rather than throwing when the directory is absent', () => {
    const bare = mkdtempSync(join(tmpdir(), 'vc-bare-'));
    expect(installedLocales(bare)).toEqual([]);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('addLocale', () => {
  it('writes the full English key set so parity passes on the first run', () => {
    const { seeded } = addLocale(dir, 'es');
    expect(seeded).toBe(3);
    expect(read('es')).toEqual(EN);
  });

  it('seeds values identical to English, which is what marks them untranslated', () => {
    addLocale(dir, 'fr');
    expect(read('fr').nav.docs).toBe('User Docs');
  });

  it('picks up keys the project added to en.json, not a stale template copy', () => {
    // The reason seeding reads the project's own en.json: a project that has
    // accumulated custom keys must not receive a locale file missing them.
    const extended = { ...EN, custom: { mine: 'Project specific' } };
    writeFileSync(join(dir, LOCALES_SUBDIR, 'en.json'), JSON.stringify(extended, null, 2));
    const { seeded } = addLocale(dir, 'de');
    expect(seeded).toBe(4);
    expect(read('de').custom.mine).toBe('Project specific');
  });

  it('refuses when there is no en.json to seed from', () => {
    const bare = mkdtempSync(join(tmpdir(), 'vc-bare-'));
    expect(() => addLocale(bare, 'es')).toThrow(/nothing to seed from/);
    rmSync(bare, { recursive: true, force: true });
  });

  it('writes a trailing newline, matching how the template ships locale files', () => {
    addLocale(dir, 'es');
    expect(readFileSync(join(dir, LOCALES_SUBDIR, 'es.json'), 'utf-8').endsWith('}\n')).toBe(true);
  });
});

describe('removeLocale', () => {
  it('deletes the file, which is what removes the language', () => {
    addLocale(dir, 'es');
    expect(removeLocale(dir, 'es')).toEqual({ removed: true });
    expect(installedLocales(dir)).toEqual(['en']);
  });

  it('never removes the fallback language', () => {
    // Without en.json every key renders as its own path, in every language.
    expect(() => removeLocale(dir, BASE_LOCALE)).toThrow(/fallback language/);
    expect(installedLocales(dir)).toContain('en');
  });

  it('is a no-op on a language that is not installed', () => {
    expect(removeLocale(dir, 'pt')).toEqual({ removed: false });
  });
});

describe('status', () => {
  it('counts a freshly seeded locale as entirely untranslated', () => {
    addLocale(dir, 'es');
    expect(status(dir)).toEqual([{ code: 'es', total: 3, untranslated: 3 }]);
  });

  it('counts a key as translated once its value differs from English', () => {
    addLocale(dir, 'es');
    const es = read('es');
    es.common.save = 'Guardar';
    writeFileSync(join(dir, LOCALES_SUBDIR, 'es.json'), JSON.stringify(es, null, 2));
    expect(status(dir)).toEqual([{ code: 'es', total: 3, untranslated: 2 }]);
  });

  it('does not report on the base locale itself', () => {
    expect(status(dir)).toEqual([]);
  });

  it('reports each installed locale independently', () => {
    addLocale(dir, 'es');
    addLocale(dir, 'fr');
    const fr = read('fr');
    fr.nav.docs = 'Documentation utilisateur';
    writeFileSync(join(dir, LOCALES_SUBDIR, 'fr.json'), JSON.stringify(fr, null, 2));
    expect(status(dir)).toEqual([
      { code: 'es', total: 3, untranslated: 3 },
      { code: 'fr', total: 3, untranslated: 2 },
    ]);
  });
});
