import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Sweep cleanliness gates the scenario verdict (2026-08-09, round-A v1):
 * the scenario passed its lifecycle while a Vultr API 500s window ate the
 * destroy's instance deletions AND blinded the in-run sweep — so the round
 * read "PASS" over two live leaked servers, discovered only by the next
 * quiescent sweep. "All steps passed" is not green unless the sweep both
 * completed and found nothing.
 *
 * Source-shape pins on the lifecycle (the shape itself is type-enforced:
 * the one dispatch, tests/e2e/utils/sweep-provider.ts, returns
 * { counts, enumFailed }): it must (a) fold sweepRegression into the
 * verdict, (b) take enumFailed from that dispatch, (c) set the flag from
 * orphan totals OR enumFailed. The dispatch's no-sweep arm counting as an
 * enumeration failure is tested on the dispatch itself
 * (sweep-provider.test.ts). Mutation-check: flip any of these in
 * _run-lifecycle.ts and the matching assertion fails.
 */
describe('teardown sweep gates the scenario verdict', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../e2e/scenarios/_run-lifecycle.ts', import.meta.url)),
    'utf-8',
  );

  it('the verdict folds sweepRegression in beside step failures', () => {
    expect(src).toMatch(/const hasFailure = hasStepFailure \|\| sweepRegression/);
  });

  it('orphans OR incomplete enumeration set the flag', () => {
    expect(src).toMatch(
      /if \(orphanTotal\(sweepCounts\) > 0 \|\| sweepEnumFailed\) \{\s*sweepRegression = true/,
    );
  });

  it('the sweep result, enumFailed included, comes from the one shared dispatch', () => {
    expect(src).toMatch(
      /const \{ counts: sweepCounts, enumFailed: sweepEnumFailed \} = await sweepProjectOrphans\(\{/,
    );
    // No second, local dispatch beside it.
    expect(src).not.toMatch(/sweepOrphaned[A-Za-z]+Resources\(/);
  });
});
