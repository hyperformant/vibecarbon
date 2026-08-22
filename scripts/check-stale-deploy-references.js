#!/usr/bin/env node
/**
 * Pre-commit regression guard for the PR 5 flag-soup retirement.
 *
 * Scans src/ + carbon/ for references to the five build-strategy flags
 * that PR 5 retired:
 *
 *   --direct, --push, --build-local, --gitops, --no-gitops
 *
 * Plus the legacy "applyKubernetesManifests" function name that came out
 * of the same architectural shift.
 *
 * Why this exists: the spec at
 *   the k3s-pivot-design spec:319
 * calls for a regression guard on these patterns so a future contributor
 * can't reintroduce the flag soup by reflex (e.g., re-adding --gitops
 * to the parser to "fix" a deploy script that broke after PR 5).
 *
 * Patterns are matched as quoted CLI strings (`'--direct'` / `"--direct"`)
 * to avoid false positives on legitimate code like `args.push(...)`,
 * `git push`, or `direct: true` (which is a legitimate prompt-set field).
 *
 * Opt-out: place `// stale-deploy-ignore: <reason>` on the same line as
 * the match, or on the line immediately above it. Keep reasons specific.
 *
 * Exits 1 on any unignored violation, 0 when clean.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = [join(repoRoot, 'src'), join(repoRoot, 'carbon')];

// Each pattern is a [regex, label] pair. The regex uses quoted forms so
// runtime shell-argv constructions don't false-match. e.g. Array#push
// (the JavaScript method) is fine; `'--push'` is not.
const PATTERNS = [
  [/['"]--direct['"]/g, '--direct'],
  [/['"]--push['"]/g, '--push'],
  [/['"]--build-local['"]/g, '--build-local'],
  [/['"]--gitops['"]/g, '--gitops'],
  [/['"]--no-gitops['"]/g, '--no-gitops'],
  [/\bapplyKubernetesManifests\b/g, 'applyKubernetesManifests'],
];

// Files allowed to mention these strings — typically the guard script itself.
const ALLOWLIST = new Set([
  relative(repoRoot, join(repoRoot, 'scripts/check-stale-deploy-references.js')),
]);

const violations = [];

function shouldSkipDir(name) {
  return name === 'node_modules' || name === '.git' || name.startsWith('.');
}

function scanFile(absPath) {
  const rel = relative(repoRoot, absPath);
  if (ALLOWLIST.has(rel)) return;
  if (!/\.(js|ts|tsx|mjs|cjs|mdx|md|yaml|yml|json)$/.test(absPath)) return;

  let text;
  try {
    text = readFileSync(absPath, 'utf-8');
  } catch {
    return;
  }
  const lines = text.split('\n');

  for (const [pattern, label] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const upToMatch = text.slice(0, match.index ?? 0);
      const lineIdx = upToMatch.split('\n').length - 1;
      const line = lines[lineIdx] ?? '';
      const prevLine = lines[lineIdx - 1] ?? '';

      // Opt-out: same-line or previous-line `stale-deploy-ignore:` marker.
      if (line.includes('stale-deploy-ignore:') || prevLine.includes('stale-deploy-ignore:')) {
        continue;
      }
      violations.push({ rel, line: lineIdx + 1, label, snippet: line.trim().slice(0, 120) });
    }
  }
}

function walk(dir) {
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
    if (st.isDirectory()) walk(abs);
    else if (st.isFile()) scanFile(abs);
  }
}

for (const root of scanRoots) walk(root);

if (violations.length === 0) {
  console.log('stale-deploy: OK');
  process.exit(0);
}

console.error('stale-deploy: found references to retired deploy flags / functions:\n');
for (const v of violations) {
  console.error(`  ${v.rel}:${v.line}  [${v.label}]  ${v.snippet}`);
}
console.error(
  '\nThese flags were retired in the k3s pivot.\n' +
    'Compose modes auto-detect; k8s is local-first; GitOps moved to `vibecarbon configure cicd`.\n' +
    'If you have a legitimate reason to mention these strings (e.g., a migration note or release-notes line),\n' +
    'add `// stale-deploy-ignore: <reason>` on the same or previous line.',
);
process.exit(1);
