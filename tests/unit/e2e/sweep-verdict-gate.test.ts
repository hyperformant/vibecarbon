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
 * Source-shape pins (the destructuring itself is type-enforced — every
 * sweep now returns { counts, enumFailed }): the lifecycle must (a) fold
 * sweepRegression into the verdict, (b) treat the no-sweep default arm as
 * an enumeration failure, (c) set the flag from orphan totals OR
 * enumFailed. Mutation-check: flip any of these in _run-lifecycle.ts and
 * the matching assertion fails.
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
      /if \(sweepOrphanTotal > 0 \|\| sweepEnumFailed\) \{\s*sweepRegression = true/,
    );
  });

  it('the no-sweep default arm counts as an enumeration failure', () => {
    const defaultArm = src.split('no orphan sweep implemented')[1]?.slice(0, 800) ?? '';
    expect(defaultArm).toContain('sweepEnumFailed = true');
  });

  it('every provider arm consumes enumFailed (type-enforced shape, pinned here too)', () => {
    const arms = src.match(/enumFailed: sweepEnumFailed \}/g) || [];
    expect(arms.length).toBeGreaterThanOrEqual(4); // hetzner, digitalocean, linode, vultr
  });
});
