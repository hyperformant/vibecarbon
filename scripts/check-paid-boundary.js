#!/usr/bin/env node
/**
 * Paid-engine import-boundary guard.
 *
 * Vibecarbon ships everything in the public FSL npm package today, but a
 * future split would carve the paid-tier deploy engines (Compose HA,
 * Kubernetes, Kubernetes HA) into a separately-fetched, license-gated
 * distribution. For that split to be mechanical rather than an
 * archaeology project, free code must only ever reach into paid engines
 * through their declared entry points — never their internals.
 *
 * The paid surface and its entry points are declared as data in
 * src/lib/licensing/paid-surface.js (PAID_SURFACE / PAID_ENTRY_POINTS).
 * This script does not duplicate that list — it imports it.
 *
 * Algorithm:
 *   - Walk src/**\/*.js (tests are exempt).
 *   - Extract import specifiers with two regexes: static
 *     `import ... from '<spec>'` and dynamic `import('<spec>')`.
 *   - Resolve relative specifiers against the importing file's directory.
 *   - Classify both the importer and the importee against PAID_SURFACE.
 *   - Violation: importer is OUTSIDE the surface, importee is INSIDE the
 *     surface, and importee is not one of PAID_ENTRY_POINTS. Files inside
 *     the surface may import each other (and their own entry points)
 *     freely — this only constrains reaches from outside.
 *
 * Opt-out: place `// paid-boundary-ignore: <reason>` on the same line as
 * the import statement, or on the line immediately above it. Keep reasons
 * specific — this is an escape hatch for cases the entry-point pattern
 * genuinely can't express, not a way to silence the guard.
 *
 * Known blind spots (both acceptable today, flagged so a future change
 * doesn't trip over them silently):
 *   - `export ... from '<spec>'` re-exports are not matched — only the two
 *     `import` forms above are. There are no re-exports of paid-surface
 *     modules in the tree today; if one is ever added, this guard will not
 *     see it.
 *   - The ignore-comment anchor is the line containing the `import` keyword
 *     (or the line above it), not the line containing the specifier. For a
 *     multi-line static import like `import {\n  foo,\n} from '../paid/x.js';`,
 *     a `// paid-boundary-ignore:` comment placed next to the `from '...'`
 *     line (the natural spot) will NOT suppress the violation — it must be
 *     on/above the `import {` line instead.
 *
 * Exits 1 on any unignored violation, 0 when clean.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAID_ENTRY_POINTS, PAID_SURFACE } from '../src/lib/licensing/paid-surface.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoot = join(repoRoot, 'src');
const manifestPath = 'src/lib/licensing/paid-surface.js';

// Flattened [engineId, path] pairs, computed once.
const surfaceEntries = Object.entries(PAID_SURFACE).flatMap(([engine, paths]) =>
  paths.map((p) => [engine, p]),
);
const entryPointSet = new Set(PAID_ENTRY_POINTS);

/** Is `relPath` (repo-relative, forward-slash) inside the declared paid surface? */
function isInSurface(relPath) {
  for (const [, surfacePath] of surfaceEntries) {
    if (surfacePath.endsWith('/')) {
      if (relPath.startsWith(surfacePath)) return true;
    } else if (relPath === surfacePath) {
      return true;
    }
  }
  return false;
}

function shouldSkipDir(name) {
  return name === 'node_modules' || name === '.git' || name.startsWith('.');
}

// Matches `import ... from '<spec>'` / `import ... from "<spec>"` (static
// imports, including bare `export ... from` re-exports would NOT match
// this — intentionally scoped to the two forms the spec calls out).
const STATIC_IMPORT_RE = /\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
// Matches dynamic `import('<spec>')` / `import("<spec>")`.
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Resolve an import specifier to a `relBase`-relative, forward-slash path, or null if not relative/resolvable. */
function resolveSpecifier(importerAbsPath, specifier, relBase) {
  if (!specifier.startsWith('.')) return null; // bare/package specifier — not internal
  let abs = resolve(dirname(importerAbsPath), specifier);
  if (!/\.[a-zA-Z]+$/.test(abs)) abs += '.js'; // defensive: extensionless relative import
  return relative(relBase, abs).split('\\').join('/');
}

function lineIndexAt(text, matchIndex) {
  return text.slice(0, matchIndex).split('\n').length - 1;
}

function hasIgnoreComment(lines, lineIdx) {
  const line = lines[lineIdx] ?? '';
  const prevLine = lines[lineIdx - 1] ?? '';
  return line.includes('paid-boundary-ignore:') || prevLine.includes('paid-boundary-ignore:');
}

/** Scan a single file's text for violations, appending any found to `violations`. */
function scanFile(absPath, relBase, violations) {
  const rel = relative(relBase, absPath).split('\\').join('/');
  if (rel === manifestPath) return; // the manifest itself declares the surface; not a reach

  let text;
  try {
    text = readFileSync(absPath, 'utf-8');
  } catch {
    return;
  }
  const lines = text.split('\n');
  const importerInSurface = isInSurface(rel);

  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    for (const match of text.matchAll(re)) {
      const specifier = match[1];
      const importeeRel = resolveSpecifier(absPath, specifier, relBase);
      if (!importeeRel) continue;

      const importeeInSurface = isInSurface(importeeRel);
      if (!importeeInSurface) continue; // importee not paid — never a violation
      if (importerInSurface) continue; // surface files import each other freely
      if (entryPointSet.has(importeeRel)) continue; // reaching a declared entry point is fine

      const lineIdx = lineIndexAt(text, match.index ?? 0);
      if (hasIgnoreComment(lines, lineIdx)) continue;

      violations.push({
        rel,
        line: lineIdx + 1,
        importee: importeeRel,
        snippet: (lines[lineIdx] ?? '').trim().slice(0, 120),
      });
    }
  }
}

function walk(dir, relBase, violations) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (shouldSkipDir(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, relBase, violations);
    else if (st.isFile() && name.endsWith('.js')) scanFile(abs, relBase, violations);
  }
}

/**
 * Walk `walkRoot` and report violations, resolving both importer and
 * importee paths relative to `relBase` (defaults to the repo root) so
 * they can be matched against PAID_SURFACE / PAID_ENTRY_POINTS, which are
 * declared repo-relative. Tests pass a fixture tree's own root as both
 * `walkRoot` (well, its `src/` subdir) and `relBase` so a synthetic
 * `src/...` tree lines up with the real manifest's `src/...` paths.
 */
function run(walkRoot, relBase = repoRoot) {
  const violations = [];
  walk(walkRoot, relBase, violations);
  return violations;
}

// Allow the unit test to import `run`/`isInSurface` against an arbitrary
// root (e.g. a temp fixture tree) to prove the guard actually detects a
// synthetic violation, not just that it passes on the real tree.
export { run, isInSurface };

// Only execute the CLI behavior when run directly (`node
// scripts/check-paid-boundary.js`), not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = run(scanRoot);

  if (violations.length === 0) {
    console.log('paid-boundary: OK');
    process.exit(0);
  }

  console.error('paid-boundary: found reaches past a paid-engine entry point:\n');
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  -> ${v.importee}  ${v.snippet}`);
  }
  console.error(
    `\nFree code may only import a paid engine's declared entry points, not its internals.\n` +
      `See PAID_SURFACE / PAID_ENTRY_POINTS in ${manifestPath}.\n` +
      'Either re-export the needed symbol from the nearest entry point and import that instead,\n' +
      'or if this really is unavoidable, add `// paid-boundary-ignore: <reason>` with a real reason.',
  );
  process.exit(1);
}
