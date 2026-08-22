/**
 * Regression: `restore -y prod` must still require the production
 * type-to-confirm. Previously the prod double-confirm was buried inside
 * `if (!values.y)`, so `-y` overwrote the production database with no prompt.
 *
 * The behavioral proof that the shared guard prompts under -y lives in
 * tests/unit/lib/prod-confirm.test.ts. Here we lock in that restore.js invokes
 * that guard UNCONDITIONALLY — i.e. the `confirmProdOrExit` call is NOT nested
 * inside the `if (!values.y)` block, so a future edit can't silently re-bury it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiresProdTypeToConfirm } from '../../../src/lib/prod-confirm.js';

const restoreSrc = readFileSync(join(__dirname, '../../../src/restore.js'), 'utf-8');

describe('restore prod confirm', () => {
  it.each(['prod', 'Prod', 'PROD', 'production', 'Production'])(
    'treats %s as production',
    (env) => {
      expect(requiresProdTypeToConfirm(env)).toBe(true);
    },
  );

  it('calls confirmProdOrExit', () => {
    expect(restoreSrc).toContain('confirmProdOrExit(envName');
  });

  it('does NOT nest the prod confirm inside the `if (!values.y)` skip block', () => {
    // Find the `if (!values.y) {` gate that wraps the soft y/N confirm and the
    // matching closing brace; assert confirmProdOrExit appears AFTER it (i.e.
    // is not skippable with -y).
    const gateIdx = restoreSrc.indexOf('if (!values.y) {');
    expect(gateIdx).toBeGreaterThan(-1);
    const confirmIdx = restoreSrc.indexOf('await confirmProdOrExit(envName');
    expect(confirmIdx).toBeGreaterThan(-1);

    // The soft-confirm block must close before the unconditional prod gate.
    const closeIdx = restoreSrc.indexOf('\n  }', gateIdx); // dedented closing brace of the block
    expect(closeIdx).toBeGreaterThan(gateIdx);
    expect(confirmIdx).toBeGreaterThan(closeIdx);
  });
});
