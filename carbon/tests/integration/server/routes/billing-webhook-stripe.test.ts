import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountRoute } from '../../../_helpers/app';

// POST /api/webhooks/billing with Stripe as the provider: the real route, the
// real StripeProvider and the Stripe SDK's own signature check, over payloads
// signed here with the SDK's test-header helper. Only the database, the mailer
// and the one Stripe API call the handler makes (subscriptions.retrieve) are
// doubles.

interface Write {
  op: 'insert' | 'update';
  table: string;
  values?: Record<string, unknown>;
  /** onConflictDoUpdate: the conflict column and the columns it rewrites. */
  conflict?: { target: string; set: Record<string, unknown> };
  params: unknown[];
}

const db = vi.hoisted(() => ({
  /** adminDb.select() results, in the order the handler reads them. */
  selects: [] as unknown[][],
  reads: [] as Array<{ table: string; params: unknown[] }>,
  writes: [] as Write[],
  /** Set to make every write fail with this value. */
  fail: undefined as unknown,
}));

vi.mock('@server/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const dialect = new PgDialect();

  // biome-ignore lint/suspicious/noExplicitAny: the chain stands in for every builder type
  function chain(op: 'select' | Write['op'], table?: any): any {
    const call: Write = { op: op as Write['op'], table: table ? getTableName(table) : '', params: [] };
    // biome-ignore lint/suspicious/noExplicitAny: Proxy over a callable target
    const proxy: any = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve()
              .then(() => {
                if (op === 'select') {
                  db.reads.push({ table: call.table, params: call.params });
                  return db.selects.shift() ?? [];
                }
                db.writes.push(call);
                if (db.fail !== undefined) throw db.fail;
                return [];
              })
              .then(resolve, reject);
        }
        // biome-ignore lint/suspicious/noExplicitAny: a Drizzle table
        if (prop === 'from') return (t: any) => ((call.table = getTableName(t)), proxy);
        if (prop === 'values' || prop === 'set') {
          return (v: Record<string, unknown>) => ((call.values = v), proxy);
        }
        if (prop === 'onConflictDoUpdate') {
          return (c: { target: { name: string }; set: Record<string, unknown> }) => (
            (call.conflict = { target: c.target.name, set: c.set }), proxy
          );
        }
        // biome-ignore lint/suspicious/noExplicitAny: a Drizzle condition
        if (prop === 'where') return (cond: any) => ((call.params = dialect.sqlToQuery(cond).params), proxy);
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    adminDb: {
      select: () => chain('select'),
      // biome-ignore lint/suspicious/noExplicitAny: a Drizzle table
      insert: (t: any) => chain('insert', t),
      // biome-ignore lint/suspicious/noExplicitAny: a Drizzle table
      update: (t: any) => chain('update', t),
    },
  };
});
vi.mock('@server/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock('@server/lib/email', () => ({ sendEmail }));

// `test_`-prefixed so the repo secret-scanner reads them as fixtures.
const SECRET_KEY = 'test_stripe_secret_key';
const WEBHOOK_SECRET = 'test_stripe_webhook_secret';

/**
 * The webhook route and the Stripe client, loaded fresh under the given
 * Stripe settings (the server reads its environment once, at import).
 */
async function load(settings: { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string }) {
  vi.resetModules();
  vi.stubEnv('BILLING_PROVIDER', 'stripe');
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const) {
    // An empty value is how the server sees an unset one.
    vi.stubEnv(key, settings[key] ?? '');
  }
  const { billingWebhookRoutes } = await import('@server/routes/webhooks/billing');
  const { stripe } = await import('@server/lib/stripe');
  return { app: mountRoute('/api/webhooks/billing', billingWebhookRoutes), stripe };
}

const { app, stripe } = await load({ STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
if (!stripe) throw new Error('the Stripe client did not load');

/** A Stripe event as Stripe posts it: JSON, signed with the webhook secret. */
function signed(type: string, object: unknown, secret = WEBHOOK_SECRET): RequestInit {
  const payload = JSON.stringify({ id: 'evt_123', object: 'event', type, data: { object } });
  return {
    method: 'POST',
    headers: { 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret }) },
    body: payload,
  };
}

const post = (type: string, object: unknown) => app.request('/api/webhooks/billing', signed(type, object));

const START = 1640000000;
const END = 1642592000;
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/**
 * A Stripe subscription with the fields the provider reads; `extra` overrides
 * or adds fields. The period is on the subscription itself here, as Stripe
 * sent it before API version 2025-03-31; see `subscriptionWithItemPeriod`.
 */
function subscription(extra: Record<string, unknown> = {}) {
  return {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    items: {
      data: [
        {
          price: {
            id: 'price_456',
            unit_amount: 1900,
            currency: 'usd',
            recurring: { interval: 'month' },
            product: { id: 'prod_1', name: 'Pro' },
          },
        },
      ],
    },
    cancel_at_period_end: false,
    canceled_at: null,
    ...extra,
  };
}

/**
 * The same subscription as Stripe sends it from API version 2025-03-31 on:
 * the billing period is on the subscription item, not on the subscription.
 */
function subscriptionWithItemPeriod() {
  const sub = subscription();
  const [item] = sub.items.data;
  return {
    ...sub,
    items: { data: [{ ...item, current_period_start: START, current_period_end: END }] },
  };
}

const CUSTOMER_ROW = [{ id: 'customer_123' }];
const retrieve = vi.spyOn(stripe.subscriptions, 'retrieve');

beforeEach(() => {
  db.selects = [];
  db.reads = [];
  db.writes = [];
  db.fail = undefined;
  sendEmail.mockClear();
  retrieve.mockReset();
  // biome-ignore lint/suspicious/noExplicitAny: a subscription with only the fields the provider reads
  retrieve.mockResolvedValue(subscription({ current_period_end: END }) as any);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A 500 that tells the sender nothing about why. */
async function expectHandlerFailed(res: Response) {
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: 'Webhook handler failed' });
}

describe('the signature', () => {
  it('answers 400 with no stripe-signature header, before verifying anything', async () => {
    const res = await app.request('/api/webhooks/billing', { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing webhook signature' });
  });

  it('accepts a payload signed with the webhook secret', async () => {
    const res = await post('customer.created', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it.each([
    ['signed with another secret', signed('customer.subscription.deleted', subscription(), 'test_other_secret')],
    [
      'whose body changed after signing',
      { ...signed('customer.subscription.deleted', subscription()), body: '{"type":"customer.subscription.deleted"}' },
    ],
  ])('answers 400 to a payload %s, and touches nothing', async (_name, init) => {
    const res = await app.request('/api/webhooks/billing', init);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('answers 400 to every payload while no webhook secret is set', async () => {
    const unset = await load({ STRIPE_SECRET_KEY: SECRET_KEY });
    const res = await unset.app.request(
      '/api/webhooks/billing',
      signed('customer.subscription.deleted', subscription())
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expect(db.writes).toEqual([]);
  });
});

describe('without a Stripe secret key', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('answers 503 when it is %s', async (_name, key) => {
    const unset = await load({ STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    expect(unset.stripe).toBeNull();
    const res = await unset.app.request('/api/webhooks/billing', signed('customer.created', {}));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Billing is not configured' });
  });
});

describe('an event type the app does not handle', () => {
  it('is acknowledged without reading or writing', async () => {
    const res = await post('customer.created', { id: 'cus_123' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual([]);
  });
});

describe('checkout.session.completed', () => {
  const session = (extra: Record<string, unknown> = {}) => ({
    id: 'cs_123',
    mode: 'subscription',
    customer: 'cus_123',
    subscription: 'sub_123',
    ...extra,
  });

  it('ignores a checkout that carries no subscription', async () => {
    const res = await post('checkout.session.completed', session({ mode: 'payment', subscription: null }));
    expect(res.status).toBe(200);
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('finds our customer, fetches the subscription from Stripe and stores it', async () => {
    db.selects = [CUSTOMER_ROW];
    const res = await post('checkout.session.completed', session());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(db.reads).toEqual([{ table: 'customers', params: ['cus_123'] }]);
    expect(retrieve).toHaveBeenCalledWith('sub_123', { expand: ['items.data.price.product'] });
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({
      op: 'insert',
      table: 'subscriptions',
      values: {
        customerId: 'customer_123',
        stripeSubscriptionId: 'sub_123',
        stripePriceId: 'price_456',
        status: 'active',
        currentPeriodEnd: iso(END),
        cancelAtPeriodEnd: false,
      },
    });
  });

  it('stores the period end Stripe now reports on the subscription item', async () => {
    db.selects = [CUSTOMER_ROW];
    // biome-ignore lint/suspicious/noExplicitAny: a subscription with only the fields the provider reads
    retrieve.mockResolvedValue(subscriptionWithItemPeriod() as any);
    const res = await post('checkout.session.completed', session());
    expect(res.status).toBe(200);
    expect(db.writes[0]).toMatchObject({ values: { currentPeriodEnd: iso(END) } });
  });

  it('answers 500 for a customer we do not know, and stores nothing', async () => {
    const res = await post('checkout.session.completed', session({ customer: 'cus_nonexistent' }));
    await expectHandlerFailed(res);
    expect(db.reads).toEqual([{ table: 'customers', params: ['cus_nonexistent'] }]);
    expect(db.writes).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('emails the confirmation to the address the checkout carries', async () => {
    db.selects = [CUSTOMER_ROW];
    const res = await post(
      'checkout.session.completed',
      session({ customer_details: { email: 'buyer@example.test' } })
    );
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: 'buyer@example.test' }));
  });
});

describe.each(['customer.subscription.created', 'customer.subscription.updated'])('%s', (type) => {
  it('finds our customer by the Stripe customer id and upserts the subscription', async () => {
    db.selects = [CUSTOMER_ROW];
    const res = await post(type, subscription({ current_period_start: START, current_period_end: END }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(db.reads).toEqual([{ table: 'customers', params: ['cus_123'] }]);
    const values = {
      customerId: 'customer_123',
      stripeSubscriptionId: 'sub_123',
      stripePriceId: 'price_456',
      status: 'active',
      currentPeriodStart: iso(START),
      currentPeriodEnd: iso(END),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    };
    // One row per Stripe subscription: a second event updates every column
    // but the subscription id it conflicts on.
    const { stripeSubscriptionId: _key, ...set } = values;
    expect(db.writes).toEqual([
      {
        op: 'insert',
        table: 'subscriptions',
        values,
        conflict: { target: 'stripe_subscription_id', set },
        params: [],
      },
    ]);
  });

  it('stores the period Stripe now reports on the subscription item', async () => {
    db.selects = [CUSTOMER_ROW];
    const res = await post(type, subscriptionWithItemPeriod());
    expect(res.status).toBe(200);
    expect(db.writes[0]).toMatchObject({
      values: { currentPeriodStart: iso(START), currentPeriodEnd: iso(END) },
    });
  });

  it('answers 500 for a customer we do not know, without naming the customer', async () => {
    const res = await post(type, subscription({ customer: 'cus_nonexistent' }));
    await expectHandlerFailed(res);
    expect(db.reads).toEqual([{ table: 'customers', params: ['cus_nonexistent'] }]);
    expect(db.writes).toEqual([]);
  });

  it('answers 500 for a subscription with no price, and stores nothing', async () => {
    db.selects = [CUSTOMER_ROW];
    await expectHandlerFailed(await post(type, subscription({ items: { data: [] } })));
    expect(db.writes).toEqual([]);
  });

  it('answers 500 when the upsert fails', async () => {
    db.selects = [CUSTOMER_ROW];
    db.fail = new Error('Database error');
    await expectHandlerFailed(await post(type, subscription()));
  });
});

describe('the subscription row a customer.subscription.updated event writes', () => {
  async function written(extra: Record<string, unknown>) {
    db.selects = [CUSTOMER_ROW];
    const res = await post('customer.subscription.updated', subscription(extra));
    expect(res.status).toBe(200);
    return db.writes[0].values as Record<string, unknown>;
  }

  it('turns Unix seconds into ISO timestamps', async () => {
    const values = await written({
      current_period_start: START,
      current_period_end: END,
      cancel_at_period_end: true,
      canceled_at: 1643000000,
    });
    expect(values.currentPeriodStart).toBe('2021-12-20T11:33:20.000Z');
    expect(values.currentPeriodEnd).toBe('2022-01-19T11:33:20.000Z');
    expect(values.canceledAt).toBe('2022-01-24T04:53:20.000Z');
  });

  it('stores null for the timestamps Stripe did not send', async () => {
    const values = await written({});
    expect(values.currentPeriodStart).toBeNull();
    expect(values.currentPeriodEnd).toBeNull();
    expect(values.canceledAt).toBeNull();
  });

  it.each(['active', 'past_due', 'canceled', 'trialing', 'incomplete'])('keeps the status %s', async (status) => {
    expect((await written({ status })).status).toBe(status);
  });

  it('keeps cancel_at_period_end', async () => {
    expect((await written({ cancel_at_period_end: true })).cancelAtPeriodEnd).toBe(true);
  });
});

describe('customer.subscription.deleted', () => {
  it('marks that subscription canceled, with the time', async () => {
    const res = await post('customer.subscription.deleted', subscription({ status: 'canceled' }));
    expect(res.status).toBe(200);
    expect(db.writes).toHaveLength(1);
    const [write] = db.writes;
    expect(write).toMatchObject({ op: 'update', table: 'subscriptions', params: ['sub_123'] });
    expect(write.values).toEqual({ status: 'canceled', canceledAt: expect.any(String) });
    const canceledAt = write.values?.canceledAt as string;
    expect(new Date(canceledAt).toISOString()).toBe(canceledAt);
  });

  it.each([
    ['an Error', new Error('Database error')],
    ['something that is not an Error', 'String error'],
  ])('answers 500 when the update throws %s', async (_name, thrown) => {
    db.fail = thrown;
    await expectHandlerFailed(await post('customer.subscription.deleted', subscription()));
  });
});

describe('invoice.payment_failed', () => {
  it('ignores an invoice with no subscription', async () => {
    const res = await post('invoice.payment_failed', { id: 'in_123', subscription: null });
    expect(res.status).toBe(200);
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['an id', 'sub_123', 'sub_123'],
    ['an object', { id: 'sub_456' }, 'sub_456'],
  ])('marks the subscription past due when the invoice names it as %s', async (_name, sub, id) => {
    const res = await post('invoice.payment_failed', { id: 'in_123', subscription: sub });
    expect(res.status).toBe(200);
    expect(db.writes).toEqual([
      { op: 'update', table: 'subscriptions', values: { status: 'past_due' }, params: [id] },
    ]);
  });

  it.each([
    ['an id', 'sub_123', 'sub_123'],
    ['an object', { id: 'sub_456' }, 'sub_456'],
  ])('marks the subscription past due when the invoice names it under its parent as %s', async (_name, sub, id) => {
    // Where Stripe puts it from API version 2025-03-31 on.
    const invoice = { id: 'in_123', parent: { type: 'subscription_details', subscription_details: { subscription: sub } } };
    const res = await post('invoice.payment_failed', invoice);
    expect(res.status).toBe(200);
    expect(db.writes).toEqual([
      { op: 'update', table: 'subscriptions', values: { status: 'past_due' }, params: [id] },
    ]);
  });

  it('emails the customer who owns the subscription', async () => {
    db.selects = [[{ customerId: 'customer_123' }], [{ email: 'payer@example.test' }]];
    const res = await post('invoice.payment_failed', { id: 'in_123', subscription: 'sub_123' });
    expect(res.status).toBe(200);
    expect(db.reads).toEqual([
      { table: 'subscriptions', params: ['sub_123'] },
      { table: 'customers', params: ['customer_123'] },
    ]);
    expect(sendEmail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: 'payer@example.test' }));
  });

  it('answers 500 when the update fails, and sends no email', async () => {
    db.fail = new Error('Database error');
    await expectHandlerFailed(await post('invoice.payment_failed', { id: 'in_123', subscription: 'sub_123' }));
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
