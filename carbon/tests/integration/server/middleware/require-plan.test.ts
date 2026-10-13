import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../../_helpers/drizzle-mock';
import type { HonoVariables } from '@server/types';

// Mutable state driving the mocked billing config + DB rows.
const { state } = vi.hoisted(() => ({
  state: {
    configured: true,
    // resolveHighestPlan queries, in order: personal customer, memberships,
    // org customers (only when there are memberships), subscriptions.
    personalCustomer: null as { id: string } | null,
    memberships: [] as Array<{ organizationId: string | null }>,
    orgCustomers: [] as Array<{ id: string }>,
    subscriptions: [] as Array<{ stripePriceId: string; status: string }>,
    customerQueries: 0,
  },
}));

vi.mock('@server/billing', () => ({
  isBillingConfigured: () => state.configured,
  getProviderPriceIds: () => ({ starter: 'price_starter', pro: 'price_pro' }),
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// adminDb.select(...).from(table) resolves to the rows for that table. The
// first customers query is the personal lookup, the second the org lookup.
vi.mock('@server/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    adminDb: {
      select: () => ({
        // biome-ignore lint/suspicious/noExplicitAny: any drizzle table
        from: (table: any) =>
          queryChain(() => {
            switch (getTableName(table)) {
              case 'customers':
                state.customerQueries += 1;
                if (state.customerQueries === 1) {
                  return state.personalCustomer ? [state.personalCustomer] : [];
                }
                return state.orgCustomers;
              case 'memberships':
                return state.memberships;
              case 'subscriptions':
                return state.subscriptions;
              default:
                return [];
            }
          }),
      }),
    },
  };
});

const { requirePlan } = await import('@server/middleware/requirePlan');

function app() {
  const a = new Hono<{ Variables: HonoVariables }>();
  a.use('*', async (c, next) => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal injected user
    c.set('user', { id: 'u1', email: 'u@test.com' } as any);
    await next();
  });
  a.get('/pro', requirePlan('pro'), (c) => c.text('ok'));
  return a;
}

beforeEach(() => {
  state.configured = true;
  state.personalCustomer = null;
  state.memberships = [];
  state.orgCustomers = [];
  state.subscriptions = [];
  state.customerQueries = 0;
});

describe('requirePlan (provider-agnostic + org-level subscriptions)', () => {
  it('allows all requests when billing is not configured', async () => {
    state.configured = false;
    const res = await app().request('/pro');
    expect(res.status).toBe(200);
  });

  it('returns 403 when the user has no active subscription anywhere', async () => {
    const res = await app().request('/pro');
    expect(res.status).toBe(403);
    expect((await res.json()).requiredPlan).toBe('pro');
  });

  it('grants access via an ORGANIZATION subscription the user belongs to', async () => {
    state.memberships = [{ organizationId: 'org1' }];
    state.orgCustomers = [{ id: 'cust_org1' }];
    state.subscriptions = [{ stripePriceId: 'price_pro', status: 'active' }];
    const res = await app().request('/pro');
    expect(res.status).toBe(200);
  });

  it('does not grant pro access for an org subscription only at the starter tier', async () => {
    state.memberships = [{ organizationId: 'org1' }];
    state.orgCustomers = [{ id: 'cust_org1' }];
    state.subscriptions = [{ stripePriceId: 'price_starter', status: 'active' }];
    const res = await app().request('/pro');
    expect(res.status).toBe(403);
  });

  it('grants access via the PERSONAL subscription', async () => {
    state.personalCustomer = { id: 'cust_me' };
    state.subscriptions = [{ stripePriceId: 'price_pro', status: 'active' }];
    const res = await app().request('/pro');
    expect(res.status).toBe(200);
  });
});
