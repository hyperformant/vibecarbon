/**
 * FAMILY-SWEEP CENSUS — the e2e `skip` status.
 *
 * The e2e VerificationResult.status used to be only 'pass' | 'fail'. Skips
 * (missing SSH handle, feature not enabled, no Chrome, unresolved standby IP)
 * were recorded as `status: 'pass'` with a `details.skipped` flag, so ~11 check
 * sites reported GREEN when their preconditions were MISSING — a refactor that
 * broke standby-IP resolution would silently turn the replication checks into
 * green no-ops instead of failing.
 *
 * This census walks EVERY tests/e2e/checks/*.ts and asserts the skip-as-pass
 * (and skip-as-fail) anti-pattern is gone: any result that carries a `skipped`
 * marker must have `status: 'skip'`, never 'pass'/'fail'. It is the recursive
 * property-assertion that keeps the whole class fixed, not just today's members.
 *
 * It also unit-tests the aggregation: a `skip` is counted as skipped, never
 * folded into pass, and a `fail` still fails.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { summarizeVerifications } from '../../e2e/scenarios/verification-summary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = join(__dirname, '..', '..', 'e2e', 'checks');

function checkFiles(): { name: string; src: string }[] {
  return readdirSync(CHECKS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ name: f, src: readFileSync(join(CHECKS_DIR, f), 'utf-8') }));
}

/**
 * The object literal that directly encloses `index`: the nearest unmatched
 * '{' to the left, out to its matching '}'. Brace-balanced (not regex) so a
 * top-level `status:` literal captures its whole result object INCLUDING a
 * nested `details: { skipped: ... }`.
 */
function enclosingObject(src: string, index: number): string {
  let depth = 0;
  let open = -1;
  for (let i = index; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open === -1) return '';
  depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

// A `status:` verdict literal (ignores type annotations / ternaries, which
// don't put a quote immediately after the colon).
const VERDICT_RE = /status:\s*'(pass|fail|skip)'/g;
// The `details.skipped` marker key (only ever the skip flag; prose like
// "checks that are skipped" has no trailing colon).
const SKIPPED_KEY_RE = /\bskipped\s*:/;
// A non-skip result builder (`pass(`, `fail(`, `result(`) called WITH a
// skipped marker in its arguments — the helper-call form of the anti-pattern.
const HELPER_SKIP_CALL_RE = /\b(?:pass|fail|result)\s*\([^)]*\bskipped\s*:/g;

describe('skip-status census — no check returns pass/fail from a skip branch', () => {
  const files = checkFiles();

  it('finds check files to census (guards against an empty walk)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('every result carrying a `skipped` marker has status:"skip" (Rule A: inline literals)', () => {
    const offenders: string[] = [];
    let skipResultsSeen = 0;
    for (const { name, src } of files) {
      VERDICT_RE.lastIndex = 0;
      let m: RegExpExecArray | null = VERDICT_RE.exec(src);
      while (m !== null) {
        const value = m[1];
        const obj = enclosingObject(src, m.index);
        if (SKIPPED_KEY_RE.test(obj)) {
          if (value === 'skip') {
            skipResultsSeen++;
          } else {
            const line = src.slice(0, m.index).split('\n').length;
            offenders.push(`${name}:${line} status:'${value}' paired with a skipped marker`);
          }
        }
        m = VERDICT_RE.exec(src);
      }
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: the census must actually have examined skip results.
    expect(skipResultsSeen).toBeGreaterThan(0);
  });

  it('no non-skip result builder is called with a skipped marker (Rule B: helper calls)', () => {
    const offenders: string[] = [];
    for (const { name, src } of files) {
      HELPER_SKIP_CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null = HELPER_SKIP_CALL_RE.exec(src);
      while (m !== null) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${name}:${line} ${m[0].replace(/\s+/g, ' ')}…`);
        m = HELPER_SKIP_CALL_RE.exec(src);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the skip-marker key appears somewhere (the anti-pattern class still has members to protect)', () => {
    const total = files.filter(({ src }) => SKIPPED_KEY_RE.test(src)).length;
    expect(total).toBeGreaterThan(0);
  });
});

describe('summarizeVerifications — skip is counted separately, never folded into pass', () => {
  it('counts skip on its own axis, never as pass', () => {
    expect(
      summarizeVerifications([{ status: 'pass' }, { status: 'skip' }, { status: 'skip' }]),
    ).toEqual({ passed: 1, failed: 0, skipped: 2, total: 3 });
  });

  it('a fail still counts as failed, alongside skips', () => {
    const t = summarizeVerifications([{ status: 'skip' }, { status: 'fail' }, { status: 'pass' }]);
    expect(t).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
  });

  it('a lone skip is neither pass nor fail', () => {
    expect(summarizeVerifications([{ status: 'skip' }])).toEqual({
      passed: 0,
      failed: 0,
      skipped: 1,
      total: 1,
    });
  });

  it('an unexpected status reddens the run (counts as failed, not skipped)', () => {
    const t = summarizeVerifications([{ status: 'error' }]);
    expect(t.failed).toBe(1);
    expect(t.skipped).toBe(0);
  });
});
