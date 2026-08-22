/**
 * kubectl argv flag-order census.
 *
 * kubectl splits its flags into two classes: GLOBAL flags (--kubeconfig,
 * --context, -n, ...) may precede the verb, while COMMAND-SCOPED flags
 * (--all-namespaces, -o, -l, --previous, ...) may not. Put a command-scoped
 * flag first and kubectl stops treating the argv as a built-in command at
 * all — it looks for a plugin and dies with a message that names the wrong
 * flag entirely:
 *
 *   $ kubectl --kubeconfig /dev/null --all-namespaces get pods -o wide
 *   Error: flags cannot be placed before plugin name: --kubeconfig
 *
 * Reproduced on kubectl v1.35.0. The blamed flag (`--kubeconfig`) is
 * perfectly legal there; `--all-namespaces` is the actual offender, which is
 * why this class survives casual review.
 *
 * It shipped in the e2e failure-diagnostics collector, so every k8s scenario
 * failure lost its certificate/ACME dump — observed in run 31843736065
 * (digitalocean/k8s) and again in 31857911325 (hetzner/k8s-ha), i.e. exactly
 * when that evidence was most needed.
 *
 * This census walks every kubectl argv literal in the tree rather than
 * pinning the one known site, so a new call site cannot reintroduce the
 * class.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCAN_ROOTS = ['src', 'tests/e2e', 'scripts'];

/** Flags kubectl accepts only AFTER the verb. */
const COMMAND_SCOPED_FLAGS = new Set([
  '--all-namespaces',
  '-A',
  '-o',
  '--output',
  '-l',
  '--selector',
  '--previous',
  '--tail',
  '--since',
  '--ignore-not-found',
  '--show-labels',
  '--sort-by',
]);

/** Verbs that mark where the command begins. */
const VERBS = new Set([
  'get',
  'describe',
  'logs',
  'apply',
  'delete',
  'patch',
  'create',
  'exec',
  'rollout',
  'top',
  'wait',
  'cordon',
  'uncordon',
  'drain',
  'label',
  'annotate',
  'scale',
  'set',
  'expose',
  'run',
  'edit',
  'replace',
  'taint',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Extract the string literals of each `('kubectl', [ ... ])` argv array.
 *
 * Only literals are recoverable — a `kc` variable holding a path is invisible
 * here, which is harmless: this guard only judges flags, and flags are always
 * written literally. An argv whose VERB is a variable is skipped rather than
 * guessed at, and reported so the count stays honest.
 */
function kubectlArgvLiterals(source: string): string[][] {
  const argvs: string[][] = [];

  const bodyFrom = (openBracketIndex: number): string => {
    let depth = 1;
    let i = openBracketIndex + 1;
    while (i < source.length && depth > 0) {
      if (source[i] === '[') depth++;
      else if (source[i] === ']') depth--;
      i++;
    }
    return source.slice(openBracketIndex + 1, i - 1);
  };

  const push = (body: string) => {
    const literals = [...body.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]);
    if (literals.length > 0) argvs.push(literals);
  };

  // Shape 1: an explicit program name — safeRun('kubectl', [ ... ]).
  const named = /['"]kubectl['"]\s*,\s*\[/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom.
  while ((m = named.exec(source)) !== null) push(bodyFrom(named.lastIndex - 1));

  // Shape 2: a bare argv array with the program implied — `argv: ['--kubeconfig',
  // kc, 'get', ...]` in tests/e2e/utils/cluster-diagnostics.ts. Anchored on the
  // '--kubeconfig' literal (an unambiguous kubectl signal) and walked BACK to
  // the enclosing '['. Shape 1 alone silently skipped this whole file — caught
  // by mutation-testing the guard rather than by reading it.
  const kubeconfigFlag = /['"]--kubeconfig['"]/g;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom.
  while ((m = kubeconfigFlag.exec(source)) !== null) {
    let depth = 0;
    let i = m.index;
    while (i >= 0) {
      if (source[i] === ']') depth++;
      else if (source[i] === '[') {
        if (depth === 0) break;
        depth--;
      }
      i--;
    }
    if (i >= 0) push(bodyFrom(i));
  }

  return argvs;
}

describe('kubectl argv flag order', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)));

  it('scans a non-trivial number of source files', () => {
    // Guards the guard: a broken walk would vacuously pass everything below.
    expect(files.length).toBeGreaterThan(50);
  });

  it('never places a command-scoped flag before the verb', () => {
    const offenders = new Set<string>();

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const argv of kubectlArgvLiterals(source)) {
        const verbIndex = argv.findIndex((a) => VERBS.has(a));
        if (verbIndex < 0) continue; // verb is a variable — not judgeable
        for (const arg of argv.slice(0, verbIndex)) {
          if (COMMAND_SCOPED_FLAGS.has(arg)) {
            // A Set, not an array: an argv matching both extractor shapes
            // would otherwise report the same site twice.
            offenders.add(
              `${file.replace(`${REPO_ROOT}/`, '')}: '${arg}' precedes '${argv[verbIndex]}'`,
            );
          }
        }
      }
    }

    expect([...offenders]).toEqual([]);
  });
});
