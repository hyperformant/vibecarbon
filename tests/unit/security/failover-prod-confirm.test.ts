/**
 * Regression (finding #6): `failover -y prod` must still require the production
 * type-to-confirm. Previously failover had NO type-to-confirm at all — the only
 * gate was the soft y/N inside `if (!parsed.yes)`, which `-y` skipped entirely,
 * so a scripted `failover -y prod` could promote/flip production with no prompt.
 *
 * The behavioral proof that the shared guard prompts under -y lives in
 * tests/unit/lib/prod-confirm.test.ts. Here we lock in that failover.js invokes
 * confirmProdOrExit UNCONDITIONALLY — i.e. not nested inside a `!parsed.yes`
 * skip block.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiresProdTypeToConfirm } from '../../../src/lib/prod-confirm.js';

const failoverSrc = readFileSync(join(__dirname, '../../../src/failover.js'), 'utf-8');

describe('failover prod confirm', () => {
  it.each(['prod', 'Prod', 'PROD', 'production', 'Production'])(
    'treats %s as production',
    (env) => {
      expect(requiresProdTypeToConfirm(env)).toBe(true);
    },
  );

  it('calls confirmProdOrExit with actionLabel failover', () => {
    expect(failoverSrc).toContain('confirmProdOrExit(envName');
    expect(failoverSrc).toMatch(/actionLabel:\s*'failover'/);
  });

  it('invokes the prod gate OUTSIDE any `!parsed.yes` soft-confirm block', () => {
    const confirmIdx = failoverSrc.indexOf('await confirmProdOrExit(envName');
    expect(confirmIdx).toBeGreaterThan(-1);

    // The gate is guarded only by the `!parsed.dryRun && isDestructiveFailover`
    // condition — NOT by a `!parsed.yes` / `!values.y` skip block. Assert no
    // such yes-skip opens immediately before the call.
    const preamble = failoverSrc.slice(Math.max(0, confirmIdx - 400), confirmIdx);
    expect(preamble).not.toMatch(/if \(!parsed\.yes\) \{[^}]*$/);
    expect(preamble).not.toMatch(/if \(!values\.y\) \{[^}]*$/);
    // It IS reached on the destructive, non-dry path.
    expect(preamble).toContain('isDestructiveFailover');
  });
});
