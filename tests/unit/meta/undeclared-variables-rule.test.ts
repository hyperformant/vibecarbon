/**
 * `noUndeclaredVariables` must stay enabled.
 *
 * src/ is plain JavaScript, so nothing type-checks it. A bare identifier that
 * resolves in no scope parses fine and throws only when that line executes —
 * which, in the deploy effects, can be long after real infrastructure has been
 * created and billed.
 *
 * Live evidence (CI l2 leg, 2026-08-20): the compose-HA persist effect
 * referenced `standbyServerType`, a const belonging to a DIFFERENT effect
 * function. It threw `standbyServerType is not defined` at
 * persist-pending-config — AFTER both servers were provisioned. With this rule
 * on, biome reports it as
 *   compose-ha.js:294 × The standbyServerType variable is undeclared
 * before the commit even lands.
 *
 * It was OFF because biome's `recommended` preset does not include it, and it
 * cost nothing to turn on: zero violations across all of src/ and tests/ at
 * the time it was enabled.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const config = () => {
  const raw = readFileSync(fileURLToPath(new URL('../../../biome.json', import.meta.url)), 'utf8');
  return JSON.parse(raw) as {
    linter?: { rules?: { correctness?: Record<string, unknown> } };
  };
};

describe('biome noUndeclaredVariables', () => {
  it('is enabled at error severity', () => {
    const rule = config().linter?.rules?.correctness?.noUndeclaredVariables;
    expect(
      rule,
      'noUndeclaredVariables guards a class of runtime-only failures in plain-JS src/ — ' +
        'a live deploy died on one AFTER provisioning two servers',
    ).toBe('error');
  });

  it('the recommended preset is still on beneath it', () => {
    // The rule is an ADDITION to recommended, not a replacement for it.
    const rules = config().linter?.rules as Record<string, unknown> | undefined;
    expect(rules?.preset).toBe('recommended');
  });
});
