import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source pins for carbon/src/server/middleware/requirePlan.ts. The
 * middleware's behaviour (no billing, no user, the free gate, the tier order,
 * the statuses that count) is tested against the real module in
 * carbon/tests/integration/server/middleware/require-plan-gates.test.ts and
 * require-plan.test.ts. These read the source to pin that price IDs come from
 * getProviderPriceIds(), which returns { starter?, pro? } only: there are no
 * yearly variants (yearly pricing was deferred from the product).
 */

describe('drift guards (carbon/ source)', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

  it('requirePlan resolves the current plan via planIdFromPriceId with provider price IDs', () => {
    const src = read('carbon/src/server/middleware/requirePlan.ts');
    expect(src).toMatch(/planIdFromPriceId\(sub\.stripePriceId, priceIds\)/);
    expect(src).toMatch(/getProviderPriceIds\(\)/);
    // No yearly price handling — yearly pricing was deferred.
    expect(src).not.toMatch(/yearly/i);
  });

  it('the active-plan query includes trialing subscriptions', () => {
    const src = read('carbon/src/server/middleware/requirePlan.ts');
    expect(src).toMatch(/inArray\(subscriptions\.status, \['active', 'trialing'\]\)/);
  });

  it('provider price IDs are starter/pro only (no yearly variants)', () => {
    const src = read('carbon/src/server/billing/index.ts');
    expect(src).toMatch(/\{ starter\?: string; pro\?: string \}/);
    expect(src).not.toMatch(/yearly/i);
  });
});
