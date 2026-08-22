import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoVariables } from '@server/types';

// Mutable state driving the mocked billing config + DB rows.
const { state } = vi.hoisted(() => ({
  state: {
    configured: true,
    // resolveHighestPlan queries: personal customer (maybeSingle), memberships
    // (await), org customers (await), subscriptions (await).
    personalCustomer: null as { id: string } | null,
    memberships: [] as Array<{ organization_id: string | null }>,
    orgCustomers: [] as Array<{ id: string }>,
    subscriptions: [] as Array<{ stripe_price_id: string; status: string }>,
  },
}));

vi.mock('@server/billing', () => ({
  isBillingConfigured: () => state.configured,
  getProviderPriceIds: () => ({ starter: 'price_starter', pro: 'price_pro' }),
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// biome-ignore lint/suspicious/noExplicitAny: minimal thenable query-builder double
function builder(onAwait: any, onMaybeSingle: any): any {
  // biome-ignore lint/suspicious/noExplicitAny: builder is intentionally untyped
  const b: any = {};
  for (const m of ['select', 'eq', 'is', 'in', 'order']) b[m] = () => b;
  b.maybeSingle = () => Promise.resolve(onMaybeSingle);
  // Thenable so `await builder` resolves to onAwait.
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(onAwait).then(resolve, reject);
  return b;
}

vi.mock('@server/lib/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'customers') {
        // personal path uses maybeSingle; org path is awaited (.in())
        return builder({ data: state.orgCustomers }, { data: state.personalCustomer });
      }
      if (table === 'memberships') return builder({ data: state.memberships }, { data: null });
      if (table === 'subscriptions') return builder({ data: state.subscriptions }, { data: null });
      return builder({ data: null }, { data: null });
    },
  },
}));

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
    state.memberships = [{ organization_id: 'org1' }];
    state.orgCustomers = [{ id: 'cust_org1' }];
    state.subscriptions = [{ stripe_price_id: 'price_pro', status: 'active' }];
    const res = await app().request('/pro');
    expect(res.status).toBe(200);
  });

  it('does not grant pro access for an org subscription only at the starter tier', async () => {
    state.memberships = [{ organization_id: 'org1' }];
    state.orgCustomers = [{ id: 'cust_org1' }];
    state.subscriptions = [{ stripe_price_id: 'price_starter', status: 'active' }];
    const res = await app().request('/pro');
    expect(res.status).toBe(403);
  });
});
