/**
 * Census: nothing infers "promoted" from a bare pg_is_in_recovery() = 'f'.
 *
 * C1: failover used to read "the standby is not in recovery" as "a previous
 * run already promoted it" (`isStandbyPromoted`), which promoted stale or empty
 * data on a failback, an unseeded standby or a late-promote retry. The proof
 * now lives in failover-guard.js: `readReplicaState` is the one place that
 * turns the 't'/'f' text into a value, and every promote decision goes through
 * `assertFailoverPreconditions` and the journal.
 *
 * Rule: a source line that compares a result to the literal 'f', in a file
 * that queries pg_is_in_recovery(), must sit in a file that imports from
 * failover-guard.js, or inside `readReplicaState` itself. Files are listed with
 * git, so node_modules and build output are never walked.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const GUARD = 'src/lib/deploy/failover-guard.js';

/**
 * Known offenders, each with the reason it is not a promote inference. Every
 * entry must still match (the stale-entry check below), so fixing one forces
 * its removal here.
 */
const ALLOWED: Record<string, string> = {
  // HA-correctness Task 2 moves compose failover onto the guard and deletes
  // these accepts (probeRecovery() === 'f' after a failed pg_promote).
  'src/lib/deploy/compose/ha.js': 'compose failover, replaced by the guard in Task 2',
  // Single-server restore: postgres was started in recovery by the restore
  // itself, so 'f' means "recovery target reached", not "someone promoted it".
  'src/lib/deploy/compose/index.js': 'restore boots its own recovery and waits for it to end',
  // Chooses the wording of a backup-audit error; it gates nothing.
  'src/lib/deploy/walg-audit.js': 'error wording only',
};

/** A comparison against the literal 'f' (either side, any quote, == or ===). */
const F_COMPARE = /(?:[!=]==?\s*(['"`])f\1)|(?:(['"`])f\2\s*[!=]==?)/;

function isFCompare(line: string): boolean {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false;
  return F_COMPARE.test(line);
}

/** Line ranges [start, end] (1-based) of `function readReplicaState` bodies. */
function readReplicaStateRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  lines.forEach((line, i) => {
    if (!/function\s+readReplicaState\b/.test(line)) return;
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') depth--;
      }
      if (opened && depth === 0) {
        ranges.push([i + 1, j + 1]);
        return;
      }
    }
  });
  return ranges;
}

const importsGuard = (text: string) =>
  /from\s+['"][^'"]*failover-guard\.js['"]/.test(text) ||
  /import\(\s*['"][^'"]*failover-guard\.js['"]\s*\)/.test(text);

/** Every offending line in `src/**\/*.js`, as `path:line`. */
function findOffenders(files: Array<{ path: string; text: string }>): string[] {
  const out: string[] = [];
  for (const { path, text } of files) {
    if (!text.includes('pg_is_in_recovery')) continue;
    if (importsGuard(text)) continue;
    const lines = text.split('\n');
    const exempt = path === GUARD ? readReplicaStateRanges(lines) : [];
    lines.forEach((line, i) => {
      if (!isFCompare(line)) return;
      const n = i + 1;
      if (exempt.some(([a, b]) => n >= a && n <= b)) return;
      out.push(`${path}:${n}`);
    });
  }
  return out;
}

function srcFiles() {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', 'src'],
    {
      cwd: REPO,
      encoding: 'utf-8',
    },
  )
    .split('\n')
    .filter((f) => f.endsWith('.js'));
  return listed.map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf-8') }));
}

describe('census: promotion is never inferred from pg_is_in_recovery() alone', () => {
  it('the matcher sees each comparison shape and skips comments', () => {
    expect(isFCompare("    return out.trim() === 'f';")).toBe(true);
    expect(isFCompare('    if (r == "f") {')).toBe(true);
    expect(isFCompare("    if ('f' === probe) {")).toBe(true);
    expect(isFCompare("    if (x !== 'f') return;")).toBe(true);
    expect(isFCompare(" * pg_is_in_recovery() = 'f' alone")).toBe(false);
    expect(isFCompare("  const flag = 'f';")).toBe(false);
  });

  it('flags an isStandbyPromoted-shaped helper in a file that does not import the guard', () => {
    const planted = [
      "const SQL = 'SELECT pg_is_in_recovery()';",
      'export async function isStandbyPromoted(ip) {',
      "  return (await run(ip, SQL)).trim() === 'f';",
      '}',
    ].join('\n');
    expect(findOffenders([{ path: 'src/lib/deploy/replication.js', text: planted }])).toEqual([
      'src/lib/deploy/replication.js:3',
    ]);
  });

  it('exempts readReplicaState in the guard, and only it', () => {
    const guard = [
      "const SQL = 'SELECT pg_is_in_recovery()';",
      'export async function readReplicaState({ exec }) {',
      '  const out = await exec(SQL);',
      "  const inRecovery = out === 't' ? true : out === 'f' ? false : null;",
      '  return { inRecovery };',
      '}',
      "export const bad = (s) => s === 'f';",
    ].join('\n');
    expect(findOffenders([{ path: GUARD, text: guard }])).toEqual([`${GUARD}:7`]);
  });

  it('src/ has no promote inference outside the guard', () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(100);
    const offenders = findOffenders(files).filter(
      (loc) => !Object.hasOwn(ALLOWED, loc.slice(0, loc.lastIndexOf(':'))),
    );
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still has an offending line (no stale entries)', () => {
    const hits = new Set(findOffenders(srcFiles()).map((l) => l.slice(0, l.lastIndexOf(':'))));
    for (const path of Object.keys(ALLOWED)) expect(hits, path).toContain(path);
  });

  it('the guard owns readReplicaState', () => {
    const guard = readFileSync(join(REPO, GUARD), 'utf-8');
    expect(guard).toMatch(/export async function readReplicaState\b/);
  });
});
