import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appWithUser, jsonPost } from '../../../_helpers/app';
import { queryChain } from '../../../_helpers/drizzle-mock';

// The billing routes of routes/v1/billing.ts, requested through the real
// handlers and the real requireOrgRole gate. The billing provider, the
// database and the Stripe price lookup are doubles. The second-factor gate
// (billing-aal2.test.ts), the cross-organization cases
// (billing-subscription-idor.test.ts) and getOrCreateCustomer
// (billing-customer.test.ts) have their own files.

const billing = vi.hoisted(() => ({
  configured: true,
  priceIds: {} as { starter?: string; pro?: string },
  provider: {
    type: 'stripe',
    createCustomer: vi.fn(async () => 'cus_new'),
    deleteCustomer: vi.fn(async () => undefined),
    createCheckout: vi.fn(async (_params: Record<string, unknown>) => ({
      sessionId: 'cs_test_123',
      url: 'https://checkout.stripe.com/pay/cs_test_123',
    })),
    createPortalSession: vi.fn(async (_params: Record<string, unknown>) => ({
      url: 'https://billing.stripe.com/session/bps_123',
    })),
  },
}));
const db = vi.hoisted(() => ({
  /** adminDb.select() results, in the order the handler reads them. */
  selects: [] as unknown[][],
  /** How many adminDb queries ran. */
  queries: 0,
  /** The caller's role in the target organization, as RLS shows it to them. */
  role: null as string | null,
}));
const priceRetrieve = vi.hoisted(() => vi.fn());
const setupSessionCreate = vi.hoisted(() =>
  vi.fn(async (_params: Record<string, unknown>) => ({
    id: 'cs_setup_123',
    url: 'https://checkout.stripe.com/setup/cs_setup_123',
  }))
);
// A dev stack started with a port offset of 10 (`vibecarbon up` picks one when
// the default ports are taken): env.ts moves SITE_URL to Vite's port, 5183,
// and the return URLs must follow it there.
const devOffset = vi.hoisted(() => {
  const before = process.env.DEV_PORT_OFFSET;
  process.env.DEV_PORT_OFFSET = '10';
  return before;
});

vi.mock('@server/billing', () => ({
  isBillingConfigured: () => billing.configured,
  getBillingProvider: () => billing.provider,
  getProviderPriceIds: () => billing.priceIds,
}));
vi.mock('@server/db/client', () => ({
  adminDb: {
    select: () =>
      queryChain(() => {
        db.queries++;
        return db.selects.shift() ?? [];
      }),
    insert: () => ({
      values: (v: { stripeCustomerId: string }) =>
        queryChain(() => {
          db.queries++;
          return [{ id: 'customer_new', stripeCustomerId: v.stripeCustomerId }];
        }),
    }),
  },
  withUserDb: (_userId: string | null, fn: (tx: unknown) => unknown) =>
    fn({ select: () => queryChain(() => (db.role ? [{ role: db.role }] : [])) }),
}));
vi.mock('@server/lib/stripe', () => ({
  getStripe: () => ({
    prices: { retrieve: priceRetrieve },
    checkout: { sessions: { create: setupSessionCreate } },
  }),
}));
vi.mock('@server/lib/mfa-settings', () => ({ isMfaGloballyEnabled: async () => false }));
// The provider-cost routes allow 20 requests per 15 minutes; this file sends more.
vi.mock('@server/lib/rate-limiter', () => ({
  createRateLimiter: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { billingRoutes } = await import('@server/routes/v1/billing');
afterAll(() => {
  if (devOffset === undefined) delete process.env.DEV_PORT_OFFSET;
  else process.env.DEV_PORT_OFFSET = devOffset;
});

const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'user@example.test' };
const ORG = '550e8400-e29b-41d4-a716-446655440000';
// The routes build their URLs on SITE_URL, which the offset moved.
const SITE = 'http://localhost:5183';

const signedIn = appWithUser(USER, '/api/v1/billing', billingRoutes);
const anonymous = appWithUser(null, '/api/v1/billing', billingRoutes);

const post = (path: string, body: unknown, app = signedIn) =>
  app.request(`/api/v1/billing${path}`, jsonPost(body));
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeEach(() => {
  billing.configured = true;
  billing.priceIds = {};
  for (const fn of Object.values(billing.provider)) {
    if (typeof fn === 'function') fn.mockClear();
  }
  db.selects = [];
  db.queries = 0;
  db.role = null;
  priceRetrieve.mockReset();
  setupSessionCreate.mockClear();
});

describe('GET /billing/status', () => {
  it.each([true, false])('reports configured: %s', async (configured) => {
    billing.configured = configured;
    const res = await anonymous.request('/api/v1/billing/status');
    expect(res.status).toBe(200);
    expect((await res.json()).configured).toBe(configured);
  });
});

describe('GET /billing/prices', () => {
  const prices = async () => (await anonymous.request('/api/v1/billing/prices')).json();

  it('gives each paid plan its monthly price id, under both keys, and nothing else', async () => {
    billing.priceIds = { starter: 'price_starter_monthly', pro: 'price_pro_monthly' };
    const body = await prices();
    expect(body.configured).toBe(true);
    const byId = Object.fromEntries(
      body.plans.map((p: { id: string; priceIds: unknown; stripePriceIds: unknown }) => [
        p.id,
        [p.priceIds, p.stripePriceIds],
      ])
    );
    // Exactly { monthly }: there is no yearly price.
    expect(byId).toEqual({
      free: [null, null],
      starter: [{ monthly: 'price_starter_monthly' }, { monthly: 'price_starter_monthly' }],
      pro: [{ monthly: 'price_pro_monthly' }, { monthly: 'price_pro_monthly' }],
    });
  });

  it('gives every plan null price ids while billing is not configured', async () => {
    billing.configured = false;
    billing.priceIds = { starter: 'price_starter_monthly', pro: 'price_pro_monthly' };
    const body = await prices();
    expect(body.configured).toBe(false);
    expect(body.plans).toHaveLength(3);
    for (const plan of body.plans) {
      expect(plan.priceIds).toBeNull();
      expect(plan.stripePriceIds).toBeNull();
    }
  });
});

describe('GET /billing/subscription', () => {
  const CUSTOMER = [{ id: 'cust_123', stripeCustomerId: 'cus_123' }];

  it('answers 401 with no user', async () => {
    const res = await anonymous.request('/api/v1/billing/subscription');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 503 while billing is not configured, before any query', async () => {
    billing.configured = false;
    const res = await signedIn.request('/api/v1/billing/subscription');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Billing is not configured' });
    expect(db.queries).toBe(0);
  });

  // requireOrgRole answers this before the handler runs, so the handler keeps
  // no check of its own for it.
  it.each([
    ['no organization id', '?type=organization'],
    ['an empty organization id', '?type=organization&organizationId='],
  ])('answers 400 to organization billing with %s, before any query', async (_name, query) => {
    const res = await signedIn.request(`/api/v1/billing/subscription${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Organization ID is required for organization billing' });
    expect(db.queries).toBe(0);
  });

  it.each([
    ['no customer', []],
    ['a customer with no active subscription', [CUSTOMER]],
  ])('reports no subscription for %s', async (_name, selects) => {
    db.selects = [...selects];
    const res = await signedIn.request('/api/v1/billing/subscription');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscription: null, status: 'none' });
    expect(db.queries).toBe(selects.length + 1);
  });

  it('returns the subscription with its plan, price and product', async () => {
    billing.priceIds = { starter: 'price_starter_monthly', pro: 'price_pro_monthly' };
    db.selects = [
      CUSTOMER,
      [
        {
          id: 'sub_row_1',
          stripeSubscriptionId: 'sub_123',
          stripePriceId: 'price_starter_monthly',
          status: 'active',
          currentPeriodEnd: '2024-12-31 23:59:59+00',
          cancelAtPeriodEnd: false,
        },
      ],
    ];
    priceRetrieve.mockResolvedValue({
      id: 'price_starter_monthly',
      unit_amount: 1900,
      currency: 'usd',
      recurring: { interval: 'month' },
      product: { id: 'prod_123', name: 'Startup Plan', description: 'not sent on' },
    });

    const res = await signedIn.request('/api/v1/billing/subscription');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subscription: {
        id: 'sub_row_1',
        status: 'active',
        priceId: 'price_starter_monthly',
        planId: 'starter',
        currentPeriodEnd: '2024-12-31T23:59:59+00:00',
        cancelAtPeriodEnd: false,
        product: { id: 'prod_123', name: 'Startup Plan' },
        price: { id: 'price_starter_monthly', unitAmount: 1900, currency: 'usd', interval: 'month' },
      },
      status: 'active',
    });
    expect(priceRetrieve).toHaveBeenCalledWith('price_starter_monthly', { expand: ['product'] });
  });
});

describe('POST /billing/checkout', () => {
  const EXISTING = [{ id: 'cust_123', stripeCustomerId: 'cus_123' }];
  const checkoutParams = () => billing.provider.createCheckout.mock.calls[0][0];

  it('answers 401 with no user', async () => {
    const res = await post('/checkout', { priceId: 'price_123', type: 'user' }, anonymous);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 503 while billing is not configured', async () => {
    billing.configured = false;
    const res = await post('/checkout', { priceId: 'price_123', type: 'user' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Billing is not configured' });
    expect(db.queries).toBe(0);
  });

  it('starts a personal checkout for the customer, and returns the session', async () => {
    db.selects = [EXISTING];
    const res = await post('/checkout', { priceId: 'price_123', type: 'user' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: 'cs_test_123',
      url: 'https://checkout.stripe.com/pay/cs_test_123',
    });
    expect(checkoutParams()).toEqual({
      customerId: 'cus_123',
      priceId: 'price_123',
      successUrl: `${SITE}/settings/billing?success=true`,
      cancelUrl: `${SITE}/settings/billing?canceled=true`,
      metadata: { type: 'user', user_id: USER.id, organization_id: '' },
    });
  });

  it.each(['OWNER', 'ADMIN'])('starts an organization checkout for its %s', async (role) => {
    db.role = role;
    db.selects = [EXISTING];
    const res = await post('/checkout', { priceId: 'price_123', type: 'organization', organizationId: ORG });
    expect(res.status).toBe(200);
    expect(checkoutParams().metadata).toEqual({ type: 'organization', user_id: USER.id, organization_id: ORG });
  });

  it('sends the caller back to the URLs it names when they are on this site', async () => {
    db.selects = [EXISTING];
    const res = await post('/checkout', {
      priceId: 'price_123',
      type: 'user',
      successUrl: `${SITE}/welcome`,
      cancelUrl: `${SITE}/pricing`,
    });
    expect(res.status).toBe(200);
    expect(checkoutParams()).toMatchObject({ successUrl: `${SITE}/welcome`, cancelUrl: `${SITE}/pricing` });
  });

  it('SECURITY: replaces a return URL on another site with the default', async () => {
    db.selects = [EXISTING];
    const res = await post('/checkout', {
      priceId: 'price_123',
      type: 'user',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });
    expect(res.status).toBe(200);
    expect(checkoutParams()).toMatchObject({
      successUrl: `${SITE}/settings/billing?success=true`,
      cancelUrl: `${SITE}/settings/billing?canceled=true`,
    });
  });

  it.each([
    ['no price id', { type: 'user' }, /required|expected/i],
    ['an empty price id', { priceId: '', type: 'user' }, /^Price ID is required$/],
    ['a success URL that is not a URL', { priceId: 'price_123', type: 'user', successUrl: 'not-a-url' }, /./],
    ['a cancel URL that is not a URL', { priceId: 'price_123', type: 'user', cancelUrl: 'not-a-url' }, /./],
    ['an unknown type', { priceId: 'price_123', type: 'invalid' }, /^Invalid type$/],
    [
      'organization billing with no organization id',
      { priceId: 'price_123', type: 'organization' },
      /^Organization ID is required for organization billing$/,
    ],
  ])('answers 400 for %s, and creates nothing', async (_name, body, message) => {
    const res = await post('/checkout', body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(message);
    expect(db.queries).toBe(0);
    expect(billing.provider.createCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['a member who is not an admin', 'MEMBER', ORG],
    ['an organization id that is not a UUID', 'OWNER', 'not-a-uuid'],
  ])('answers 403 for %s, and creates nothing', async (_name, role, organizationId) => {
    db.role = role;
    const res = await post('/checkout', { priceId: 'price_123', type: 'organization', organizationId });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('You must be an admin to manage organization billing');
    expect(db.queries).toBe(0);
    expect(billing.provider.createCheckout).not.toHaveBeenCalled();
  });
});

describe('POST /billing/setup', () => {
  it('starts a Stripe setup session that returns to the billing page', async () => {
    db.selects = [[{ id: 'cust_123', stripeCustomerId: 'cus_123' }]];
    const res = await post('/setup', { type: 'user' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: 'cs_setup_123',
      url: 'https://checkout.stripe.com/setup/cs_setup_123',
    });
    expect(setupSessionCreate.mock.calls[0][0]).toMatchObject({
      customer: 'cus_123',
      mode: 'setup',
      success_url: `${SITE}/settings/billing?setup=success`,
      cancel_url: `${SITE}/settings/billing?setup=canceled`,
    });
  });
});

describe('POST /billing/portal', () => {
  const CUSTOMER = [{ stripeCustomerId: 'cus_123' }];
  const portalParams = () => billing.provider.createPortalSession.mock.calls[0][0];

  it('answers 401 with no user', async () => {
    const res = await post('/portal', { type: 'user' }, anonymous);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('answers 503 while billing is not configured', async () => {
    billing.configured = false;
    const res = await post('/portal', { type: 'user' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Billing is not configured' });
  });

  it('opens the portal for the personal customer, returning to the billing page', async () => {
    db.selects = [CUSTOMER];
    const res = await post('/portal', { type: 'user' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.com/session/bps_123' });
    expect(portalParams()).toEqual({ customerId: 'cus_123', returnUrl: `${SITE}/settings/billing` });
  });

  it('opens the portal for an organization its admin manages', async () => {
    db.role = 'ADMIN';
    db.selects = [CUSTOMER];
    const res = await post('/portal', { type: 'organization', organizationId: ORG });
    expect(res.status).toBe(200);
    expect(portalParams().customerId).toBe('cus_123');
  });

  it.each([
    ['on this site is kept', `${SITE}/account`, `${SITE}/account`],
    ['on another site is replaced with the default', 'https://example.com/billing', `${SITE}/settings/billing`],
  ])('a return URL %s', async (_name, returnUrl, expected) => {
    db.selects = [CUSTOMER];
    const res = await post('/portal', { type: 'user', returnUrl });
    expect(res.status).toBe(200);
    expect(portalParams().returnUrl).toBe(expected);
  });

  it.each([
    ['an unknown type', { type: 'company' }],
    ['a return URL that is not a URL', { type: 'user', returnUrl: 'invalid-url' }],
  ])('answers 400 for %s', async (_name, body) => {
    const res = await post('/portal', body);
    expect(res.status).toBe(400);
    expect(db.queries).toBe(0);
    expect(billing.provider.createPortalSession).not.toHaveBeenCalled();
  });

  it.each([
    ['a member who is not an admin', 'MEMBER', ORG],
    ['an organization id that is not a UUID', 'OWNER', 'invalid-uuid'],
  ])('answers 403 for %s', async (_name, role, organizationId) => {
    db.role = role;
    const res = await post('/portal', { type: 'organization', organizationId });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe('You must be an admin to manage organization billing');
    expect(db.queries).toBe(0);
  });

  it('answers 404 when there is no customer yet', async () => {
    const res = await post('/portal', { type: 'user' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No billing account found. Please subscribe first.' });
    expect(billing.provider.createPortalSession).not.toHaveBeenCalled();
  });
});
