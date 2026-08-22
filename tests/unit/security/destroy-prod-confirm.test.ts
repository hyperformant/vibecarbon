/**
 * Regression (C-6): `destroy prod -y` must still require type-to-confirm.
 *
 * The predicate matrix (which env names count as production) is covered once
 * in tests/unit/lib/prod-confirm.test.ts — destroy shares that predicate, so
 * it is not re-tested here. What IS destroy-specific, and what this file locks
 * in, is the wiring: destroy.js must derive its gate from the shared
 * lib/prod-confirm.js predicate and must run type-to-confirm even under -y
 * when the env is production.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const destroySrc = readFileSync(join(__dirname, '../../../src/destroy.js'), 'utf-8');

describe('C-6: prod destroy requires type-to-confirm even with -y', () => {
  it('derives the gate from the shared lib/prod-confirm.js predicate', () => {
    expect(destroySrc).toContain(
      "import { requiresProdTypeToConfirm } from './lib/prod-confirm.js'",
    );
    expect(destroySrc).toContain('const needsProdConfirm = requiresProdTypeToConfirm(envName)');
  });

  it('runs type-to-confirm when NOT -y OR the env is production (even with -y)', () => {
    expect(destroySrc).toContain('if (!args.yes || needsProdConfirm) {');
  });

  it('does not keep a local copy of the prod predicate', () => {
    // The predicate must stay single-sourced: no local prod/production
    // string matching outside the shared import.
    expect(destroySrc).not.toMatch(/envName\s*===\s*'prod(uction)?'/);
  });
});
