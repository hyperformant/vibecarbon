/**
 * Which languages a generated project ships.
 *
 * The locale files present on disk ARE the configuration. `src/client/lib/
 * locales.ts` globs them, so adding or removing a language is adding or
 * removing a file — there is no list to keep in sync, and nothing can drift
 * from what actually ships. This module is the CLI half of that: the file
 * operations, kept apart from the prompt so they can be tested without one.
 *
 * See the globalization-cli-design spec.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Codes the app has display names for, in the order the picker shows them. */
export const SUPPORTED_LOCALES = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
};

/** The reference locale. Mandatory: it is i18next's `fallbackLng`. */
export const BASE_LOCALE = 'en';

/** Locale directory, relative to a generated project's root. */
export const LOCALES_SUBDIR = join('src', 'client', 'locales');

export function localesDir(cwd = process.cwd()) {
  return join(cwd, LOCALES_SUBDIR);
}

function localePath(cwd, code) {
  return join(localesDir(cwd), `${code}.json`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Trailing newline, 2-space indent — matches how the template ships them. */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

/**
 * Language codes this project currently ships, sorted.
 * Unknown codes are included: a file on disk is a shipped language whether or
 * not this module has a label for it.
 */
export function installedLocales(cwd = process.cwd()) {
  const dir = localesDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Every leaf key path in a nested object, e.g. "auth.signIn". */
function leafPaths(obj, prefix = '') {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([key, val]) =>
    leafPaths(val, prefix ? `${prefix}.${key}` : key),
  );
}

function leafAt(obj, path) {
  return path.split('.').reduce((cur, part) => (cur == null ? cur : cur[part]), obj);
}

/**
 * Add a language, seeded from English.
 *
 * Every value starts as the English string. That is not a placeholder scheme
 * so much as the only honest option: the template ships `en.json` alone, so
 * there is no translated source to merge from. The upside is that the new
 * file satisfies i18n-parity on the first run — a half-populated locale file
 * fails CI immediately — while `status()` reports exactly how much of it is
 * still untranslated.
 *
 * @returns {{ seeded: number }} keys written, all of them awaiting translation
 */
export function addLocale(cwd, code) {
  if (!existsSync(localePath(cwd, BASE_LOCALE))) {
    throw new Error(`No ${BASE_LOCALE}.json in ${LOCALES_SUBDIR} — nothing to seed from.`);
  }
  const base = readJson(localePath(cwd, BASE_LOCALE));
  mkdirSync(localesDir(cwd), { recursive: true });
  writeJson(localePath(cwd, code), base);
  return { seeded: leafPaths(base).length };
}

/**
 * Remove a language.
 *
 * Refuses to remove the base locale: i18next falls back to it, so a project
 * without it renders key paths instead of text.
 */
export function removeLocale(cwd, code) {
  if (code === BASE_LOCALE) {
    throw new Error(`${BASE_LOCALE} is the fallback language and cannot be removed.`);
  }
  const path = localePath(cwd, code);
  if (!existsSync(path)) return { removed: false };
  unlinkSync(path);
  return { removed: true };
}

/**
 * Per-locale translation progress.
 *
 * "Untranslated" means byte-identical to the English value. Computed on
 * demand rather than tracked in a manifest, so there is no second file to
 * drift. The measure over-counts by design: strings that are legitimately the
 * same in both languages ("Email", "OK") read as untranslated, which is worth
 * saying out loud wherever this is displayed.
 */
export function status(cwd = process.cwd()) {
  const base = readJson(localePath(cwd, BASE_LOCALE));
  const paths = leafPaths(base);
  return installedLocales(cwd)
    .filter((code) => code !== BASE_LOCALE)
    .map((code) => {
      const target = readJson(localePath(cwd, code));
      const untranslated = paths.filter((p) => leafAt(target, p) === leafAt(base, p)).length;
      return { code, total: paths.length, untranslated };
    });
}
