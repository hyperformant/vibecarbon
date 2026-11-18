import type { HonoVariables } from '@server/types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../../_helpers/drizzle-mock';

/**
 * requirePlan (src/server/middleware/requirePlan.ts) at each gate: no billing,
 * no user, the free gate, a missing customer or subscription, the tier order,
 * and the statuses the subscription query accepts. Org-level subscriptions are
 * in require-plan.test.ts.
 */

const { state } = vi.hoisted(() => ({
  state: {
    configured: true,
    user: { id: 'u1', email: 'u@test.com' } as { id: string; email: string } | null,
    // resolveHighestPlan: personal customer, memberships, (org customers),
    // subscriptions. No memberships here, so customers is asked once.
    personalCustomer: null as { id: string } | null,
    subscriptions: [] as Array<{ stripePriceId: string }>,
    queried: [] as string[],
    subscriptionWhere: null as SQL | null,
  },
}));

vi.mock('@server/billing', () => ({
  isBillingConfigured: () => state.configured,
  getProviderPriceIds: () => ({ starter: 'price_starter', pro: 'price_pro' }),
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    adminDb: {
      select: () => ({
        // biome-ignore lint/suspicious/noExplicitAny: any drizzle table
        from: (table: any) => {
          const name = getTableName(table);
          state.queried.push(name);
          const rows = () => {
            if (name === 'customers') return state.personalCustomer ? [state.personalCustomer] : [];
            if (name === 'subscriptions') return state.subscriptions;
            return [];
          };
          return {
            where: (cond: SQL) => {
              if (name === 'subscriptions') state.subscriptionWhere = cond;
              return queryChain(rows);
            },
          };
        },
      }),
    },
  };
});

const { requirePlan } = await import('@server/middleware/requirePlan');

function gate(minimum: 'free' | 'starter' | 'pro') {
  const app = new Hono<{ Variables: HonoVariables }>();
  app.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    if (state.user) c.set('user', state.user as any);
    await next();
  });
  app.get('/gated', requirePlan(minimum), (c) => c.text('ok'));
  return app.request('/gated');
}

function subscribed(priceId: string) {
  state.personalCustomer = { id: 'cust_me' };
  state.subscriptions = [{ stripePriceId: priceId }];
}

beforeEach(() => {
  state.configured = true;
  state.user = { id: 'u1', email: 'u@test.com' };
  state.personalCustomer = null;
  state.subscriptions = [];
  state.queried = [];
  state.subscriptionWhere = null;
});

describe('requirePlan without billing configured', () => {
  it('lets a request with no user through, and queries nothing', async () => {
    state.configured = false;
    state.user = null;
    const res = await gate('pro');
    expect(res.status).toBe(200);
    expect(state.queried).toEqual([]);
  });
});

describe('requirePlan with billing configured', () => {
  it('returns 401 with no user, and queries nothing', async () => {
    state.user = null;
    const res = await gate('starter');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(state.queried).toEqual([]);
  });

  it('lets any signed-in user through the free gate without a plan lookup', async () => {
    const res = await gate('free');
    expect(res.status).toBe(200);
    expect(state.queried).toEqual([]);
  });

  it('refuses with the required and current plan when there is no customer', async () => {
    const res = await gate('starter');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Upgrade required',
      requiredPlan: 'starter',
      currentPlan: 'free',
    });
    expect(state.queried).not.toContain('subscriptions');
  });

  it('refuses when the customer has no active subscription', async () => {
    state.personalCustomer = { id: 'cust_me' };
    const res = await gate('starter');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ requiredPlan: 'starter', currentPlan: 'free' });
  });

  it.each([
    ['starter meets a starter gate', 'price_starter', 'starter', 200],
    ['pro exceeds a starter gate', 'price_pro', 'starter', 200],
    ['starter is below a pro gate', 'price_starter', 'pro', 403],
    ['an unknown price counts as free, below a starter gate', 'price_other', 'starter', 403],
  ] as const)('%s', async (_what, priceId, minimum, status) => {
    subscribed(priceId);
    expect((await gate(minimum)).status).toBe(status);
  });

  it('names the current plan when the tier is too low', async () => {
    subscribed('price_starter');
    expect(await (await gate('pro')).json()).toEqual({
      error: 'Upgrade required',
      requiredPlan: 'pro',
      currentPlan: 'starter',
    });
  });

  it('counts active and trialing subscriptions, and no other status', async () => {
    subscribed('price_pro');
    await gate('pro');
    if (!state.subscriptionWhere) throw new Error('no subscriptions query');
    const { params } = new PgDialect().sqlToQuery(state.subscriptionWhere);
    expect(params).toEqual(['cust_me', 'active', 'trialing']);
  });
});
