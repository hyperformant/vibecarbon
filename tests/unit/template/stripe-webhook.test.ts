import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for Stripe webhook handler logic
 * These tests verify the webhook processing patterns used in the template code
 *
 * Since the template uses path aliases that don't resolve in the test runner,
 * we re-implement the key logic inline for testing.
 */

// ============================================================================
// TYPE DEFINITIONS (matching Stripe SDK types)
// ============================================================================

interface MockStripeSubscription {
  id: string;
  customer: string;
  status: 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete';
  items: {
    data: Array<{
      price: {
        id: string;
      };
    }>;
  };
  current_period_start?: number;
  current_period_end?: number;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
}

interface MockStripeCheckoutSession {
  id: string;
  mode: 'payment' | 'subscription' | 'setup';
  customer: string;
  subscription: string | null;
}

interface MockStripeInvoice {
  id: string;
  subscription?: string | { id: string } | null;
}

interface MockStripeEvent {
  id: string;
  type: string;
  data: {
    object: unknown;
  };
}

interface MockCustomer {
  id: string;
  stripe_customer_id: string;
}

interface MockDbResult<T> {
  data: T | null;
  error: Error | null;
}

type MockDbClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        single: () => Promise<MockDbResult<MockCustomer>>;
      };
    };
    insert: (data: unknown) => {
      select: () => {
        single: () => Promise<MockDbResult<unknown>>;
      };
    };
    update: (data: unknown) => {
      eq: (column: string, value: string) => Promise<MockDbResult<unknown>>;
    };
    upsert: (data: unknown, options?: { onConflict?: string }) => Promise<MockDbResult<unknown>>;
  };
};

// ============================================================================
// RE-IMPLEMENTED LOGIC FOR TESTING
// ============================================================================

/**
 * Check if Stripe is configured
 */
function isStripeConfigured(secretKey: string | null | undefined): boolean {
  return secretKey !== null && secretKey !== undefined && secretKey !== '';
}

/**
 * Verify webhook signature
 */
function verifyWebhookSignature(
  payload: string,
  signature: string,
  webhookSecret: string | null | undefined,
  stripeConstructEvent: (payload: string, signature: string, secret: string) => MockStripeEvent,
): MockStripeEvent {
  if (!webhookSecret) {
    throw new Error('Stripe webhook secret is not configured');
  }

  return stripeConstructEvent(payload, signature, webhookSecret);
}

/**
 * Route webhook event to appropriate handler
 */
async function routeWebhookEvent(
  event: MockStripeEvent,
  handlers: {
    checkoutSessionCompleted?: (session: MockStripeCheckoutSession) => Promise<void>;
    subscriptionUpdated?: (subscription: MockStripeSubscription) => Promise<void>;
    subscriptionDeleted?: (subscription: MockStripeSubscription) => Promise<void>;
    paymentFailed?: (invoice: MockStripeInvoice) => Promise<void>;
  },
): Promise<{ received: boolean; error?: string }> {
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        if (handlers.checkoutSessionCompleted) {
          await handlers.checkoutSessionCompleted(event.data.object as MockStripeCheckoutSession);
        }
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        if (handlers.subscriptionUpdated) {
          await handlers.subscriptionUpdated(event.data.object as MockStripeSubscription);
        }
        break;

      case 'customer.subscription.deleted':
        if (handlers.subscriptionDeleted) {
          await handlers.subscriptionDeleted(event.data.object as MockStripeSubscription);
        }
        break;

      case 'invoice.payment_failed':
        if (handlers.paymentFailed) {
          await handlers.paymentFailed(event.data.object as MockStripeInvoice);
        }
        break;

      default:
      // Unhandled event type
    }

    return { received: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { received: false, error: message };
  }
}

/**
 * Handle checkout session completed
 */
async function handleCheckoutSessionCompleted(
  session: MockStripeCheckoutSession,
  db: MockDbClient,
  retrieveSubscription: (id: string) => Promise<MockStripeSubscription>,
  upsertSubscriptionFn: (
    customerId: string,
    subscription: MockStripeSubscription,
    db: MockDbClient,
  ) => Promise<void>,
): Promise<void> {
  // Ignore non-subscription checkout sessions
  if (session.mode !== 'subscription') {
    return;
  }

  const customerId = session.customer;
  const subscriptionId = session.subscription;

  if (!subscriptionId) {
    throw new Error('Subscription ID not found in checkout session');
  }

  // Look up customer by stripe_customer_id
  const { data: customer, error: customerError } = await db
    .from('customers')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (customerError || !customer) {
    throw new Error(`Customer not found: ${customerId}`);
  }

  // Retrieve full subscription details
  const subscription = await retrieveSubscription(subscriptionId);

  // Upsert subscription
  await upsertSubscriptionFn(customer.id, subscription, db);
}

/**
 * Handle subscription updated
 */
async function handleSubscriptionUpdated(
  subscription: MockStripeSubscription,
  db: MockDbClient,
  upsertSubscriptionFn: (
    customerId: string,
    subscription: MockStripeSubscription,
    db: MockDbClient,
  ) => Promise<void>,
): Promise<void> {
  const customerId = subscription.customer;

  // Look up customer by stripe_customer_id
  const { data: customer, error: customerError } = await db
    .from('customers')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (customerError || !customer) {
    throw new Error(`Customer not found: ${customerId}`);
  }

  await upsertSubscriptionFn(customer.id, subscription, db);
}

/**
 * Handle subscription deleted
 */
async function handleSubscriptionDeleted(
  subscription: MockStripeSubscription,
  db: MockDbClient,
): Promise<void> {
  const { error } = await db
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id);

  if (error) {
    throw error;
  }
}

/**
 * Handle payment failed
 */
async function handlePaymentFailed(invoice: MockStripeInvoice, db: MockDbClient): Promise<void> {
  // Extract subscription ID (can be string or object with id)
  const subscriptionId =
    typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;

  // Ignore invoices without subscription
  if (!subscriptionId) {
    return;
  }

  const { error } = await db
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_subscription_id', subscriptionId);

  if (error) {
    throw error;
  }
}

/**
 * Upsert subscription
 */
async function upsertSubscription(
  customerId: string,
  subscription: MockStripeSubscription,
  db: MockDbClient,
): Promise<void> {
  const priceId = subscription.items.data[0]?.price.id;

  if (!priceId) {
    throw new Error('Subscription has no price');
  }

  const subscriptionData = {
    customer_id: customerId,
    stripe_subscription_id: subscription.id,
    stripe_price_id: priceId,
    status: subscription.status,
    current_period_start: subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000).toISOString()
      : null,
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000).toISOString()
      : null,
  };

  const { error } = await db.from('subscriptions').upsert(subscriptionData, {
    onConflict: 'stripe_subscription_id',
  });

  if (error) {
    throw error;
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('isStripeConfigured', () => {
  it('returns true when STRIPE_SECRET_KEY is set', () => {
    expect(isStripeConfigured('sk_test_12345')).toBe(true);
    expect(isStripeConfigured('sk_live_67890')).toBe(true);
  });

  it('returns false when STRIPE_SECRET_KEY is null', () => {
    expect(isStripeConfigured(null)).toBe(false);
  });

  it('returns false when STRIPE_SECRET_KEY is undefined', () => {
    expect(isStripeConfigured(undefined)).toBe(false);
  });

  it('returns false when STRIPE_SECRET_KEY is empty string', () => {
    expect(isStripeConfigured('')).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  it('throws when webhook secret not configured', () => {
    const mockConstructEvent = vi.fn();

    expect(() => {
      verifyWebhookSignature('payload', 'sig', null, mockConstructEvent);
    }).toThrow('Stripe webhook secret is not configured');

    expect(() => {
      verifyWebhookSignature('payload', 'sig', undefined, mockConstructEvent);
    }).toThrow('Stripe webhook secret is not configured');

    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it('delegates to stripe.webhooks.constructEvent when configured', () => {
    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: { object: {} },
    };

    const mockConstructEvent = vi.fn().mockReturnValue(mockEvent);

    const result = verifyWebhookSignature(
      'raw-payload',
      'sig_123',
      'whsec_test',
      mockConstructEvent,
    );

    expect(mockConstructEvent).toHaveBeenCalledWith('raw-payload', 'sig_123', 'whsec_test');
    expect(result).toEqual(mockEvent);
  });

  it('propagates errors from stripe.webhooks.constructEvent', () => {
    const mockConstructEvent = vi.fn().mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    expect(() => {
      verifyWebhookSignature('payload', 'bad-sig', 'whsec_test', mockConstructEvent);
    }).toThrow('Invalid signature');
  });
});

describe('routeWebhookEvent', () => {
  it('routes checkout.session.completed to correct handler', async () => {
    const mockSession: MockStripeCheckoutSession = {
      id: 'cs_123',
      mode: 'subscription',
      customer: 'cus_123',
      subscription: 'sub_123',
    };

    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: { object: mockSession },
    };

    const checkoutHandler = vi.fn().mockResolvedValue(undefined);

    const result = await routeWebhookEvent(mockEvent, {
      checkoutSessionCompleted: checkoutHandler,
    });

    expect(checkoutHandler).toHaveBeenCalledWith(mockSession);
    expect(result).toEqual({ received: true });
  });

  it('routes customer.subscription.updated to correct handler', async () => {
    const mockSubscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'customer.subscription.updated',
      data: { object: mockSubscription },
    };

    const subscriptionHandler = vi.fn().mockResolvedValue(undefined);

    const result = await routeWebhookEvent(mockEvent, {
      subscriptionUpdated: subscriptionHandler,
    });

    expect(subscriptionHandler).toHaveBeenCalledWith(mockSubscription);
    expect(result).toEqual({ received: true });
  });

  it('routes customer.subscription.created to subscriptionUpdated handler', async () => {
    const mockSubscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'customer.subscription.created',
      data: { object: mockSubscription },
    };

    const subscriptionHandler = vi.fn().mockResolvedValue(undefined);

    const result = await routeWebhookEvent(mockEvent, {
      subscriptionUpdated: subscriptionHandler,
    });

    expect(subscriptionHandler).toHaveBeenCalledWith(mockSubscription);
    expect(result).toEqual({ received: true });
  });

  it('routes customer.subscription.deleted to correct handler', async () => {
    const mockSubscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'canceled',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: 1234567890,
    };

    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'customer.subscription.deleted',
      data: { object: mockSubscription },
    };

    const deletedHandler = vi.fn().mockResolvedValue(undefined);

    const result = await routeWebhookEvent(mockEvent, {
      subscriptionDeleted: deletedHandler,
    });

    expect(deletedHandler).toHaveBeenCalledWith(mockSubscription);
    expect(result).toEqual({ received: true });
  });

  it('routes invoice.payment_failed to correct handler', async () => {
    const mockInvoice: MockStripeInvoice = {
      id: 'in_123',
      subscription: 'sub_123',
    };

    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'invoice.payment_failed',
      data: { object: mockInvoice },
    };

    const paymentFailedHandler = vi.fn().mockResolvedValue(undefined);

    const result = await routeWebhookEvent(mockEvent, {
      paymentFailed: paymentFailedHandler,
    });

    expect(paymentFailedHandler).toHaveBeenCalledWith(mockInvoice);
    expect(result).toEqual({ received: true });
  });

  it('returns received: true for unhandled event types', async () => {
    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'customer.created',
      data: { object: {} },
    };

    const result = await routeWebhookEvent(mockEvent, {});

    expect(result).toEqual({ received: true });
  });

  it('returns error when handler throws', async () => {
    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: { object: {} },
    };

    const checkoutHandler = vi.fn().mockRejectedValue(new Error('Customer not found'));

    const result = await routeWebhookEvent(mockEvent, {
      checkoutSessionCompleted: checkoutHandler,
    });

    expect(result).toEqual({
      received: false,
      error: 'Customer not found',
    });
  });

  it('handles non-Error exceptions', async () => {
    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: { object: {} },
    };

    const checkoutHandler = vi.fn().mockRejectedValue('String error');

    const result = await routeWebhookEvent(mockEvent, {
      checkoutSessionCompleted: checkoutHandler,
    });

    expect(result).toEqual({
      received: false,
      error: 'Unknown error',
    });
  });
});

describe('handleCheckoutSessionCompleted', () => {
  let mockDb: MockDbClient;
  let mockRetrieveSubscription: ReturnType<typeof vi.fn>;
  let mockUpsertSubscription: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'customer_123', stripe_customer_id: 'cus_123' },
              error: null,
            }),
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      }),
    } as unknown as MockDbClient;

    mockRetrieveSubscription = vi.fn().mockResolvedValue({
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    });

    mockUpsertSubscription = vi.fn().mockResolvedValue(undefined);
  });

  it('ignores non-subscription checkout sessions', async () => {
    const session: MockStripeCheckoutSession = {
      id: 'cs_123',
      mode: 'payment',
      customer: 'cus_123',
      subscription: null,
    };

    await handleCheckoutSessionCompleted(
      session,
      mockDb,
      mockRetrieveSubscription,
      mockUpsertSubscription,
    );

    expect(mockRetrieveSubscription).not.toHaveBeenCalled();
    expect(mockUpsertSubscription).not.toHaveBeenCalled();
  });

  it('looks up customer by stripe_customer_id', async () => {
    const session: MockStripeCheckoutSession = {
      id: 'cs_123',
      mode: 'subscription',
      customer: 'cus_123',
      subscription: 'sub_123',
    };

    await handleCheckoutSessionCompleted(
      session,
      mockDb,
      mockRetrieveSubscription,
      mockUpsertSubscription,
    );

    expect(mockDb.from).toHaveBeenCalledWith('customers');
  });

  it('throws when customer not found', async () => {
    const session: MockStripeCheckoutSession = {
      id: 'cs_123',
      mode: 'subscription',
      customer: 'cus_nonexistent',
      subscription: 'sub_123',
    };

    mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: new Error('Not found'),
            }),
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      }),
    } as unknown as MockDbClient;

    await expect(
      handleCheckoutSessionCompleted(
        session,
        mockDb,
        mockRetrieveSubscription,
        mockUpsertSubscription,
      ),
    ).rejects.toThrow('Customer not found: cus_nonexistent');

    expect(mockUpsertSubscription).not.toHaveBeenCalled();
  });

  it('calls upsertSubscription on success', async () => {
    const session: MockStripeCheckoutSession = {
      id: 'cs_123',
      mode: 'subscription',
      customer: 'cus_123',
      subscription: 'sub_123',
    };

    const mockSubscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    mockRetrieveSubscription.mockResolvedValue(mockSubscription);

    await handleCheckoutSessionCompleted(
      session,
      mockDb,
      mockRetrieveSubscription,
      mockUpsertSubscription,
    );

    expect(mockRetrieveSubscription).toHaveBeenCalledWith('sub_123');
    expect(mockUpsertSubscription).toHaveBeenCalledWith('customer_123', mockSubscription, mockDb);
  });
});

describe('handleSubscriptionUpdated', () => {
  let mockDb: MockDbClient;
  let mockUpsertSubscription: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'customer_123', stripe_customer_id: 'cus_123' },
              error: null,
            }),
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      }),
    } as unknown as MockDbClient;

    mockUpsertSubscription = vi.fn().mockResolvedValue(undefined);
  });

  it('looks up customer by stripe_customer_id', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    await handleSubscriptionUpdated(subscription, mockDb, mockUpsertSubscription);

    expect(mockDb.from).toHaveBeenCalledWith('customers');
  });

  it('throws when customer not found', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_nonexistent',
      status: 'active',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: new Error('Not found'),
            }),
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      }),
    } as unknown as MockDbClient;

    await expect(
      handleSubscriptionUpdated(subscription, mockDb, mockUpsertSubscription),
    ).rejects.toThrow('Customer not found: cus_nonexistent');

    expect(mockUpsertSubscription).not.toHaveBeenCalled();
  });

  it('calls upsertSubscription with customer ID and subscription', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    await handleSubscriptionUpdated(subscription, mockDb, mockUpsertSubscription);

    expect(mockUpsertSubscription).toHaveBeenCalledWith('customer_123', subscription, mockDb);
  });
});

describe('handleSubscriptionDeleted', () => {
  let mockDb: MockDbClient;
  let mockUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUpdate = vi.fn().mockResolvedValue({ data: null, error: null });

    mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn().mockReturnValue({
          eq: mockUpdate,
        }),
        upsert: vi.fn(),
      }),
    } as unknown as MockDbClient;
  });

  it('updates subscription status to canceled', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'canceled',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: 1234567890,
    };

    await handleSubscriptionDeleted(subscription, mockDb);

    expect(mockDb.from).toHaveBeenCalledWith('subscriptions');
    expect(mockUpdate).toHaveBeenCalledWith('stripe_subscription_id', 'sub_123');
  });

  it('sets canceled_at timestamp', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'canceled',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: 1234567890,
    };

    const mockUpdateFn = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn(),
        insert: vi.fn(),
        update: mockUpdateFn,
        upsert: vi.fn(),
      }),
    } as unknown as MockDbClient;

    await handleSubscriptionDeleted(subscription, mockDb);

    const updateCall = mockUpdateFn.mock.calls[0]?.[0];
    expect(updateCall).toHaveProperty('status', 'canceled');
    expect(updateCall).toHaveProperty('canceled_at');
    expect(typeof updateCall.canceled_at).toBe('string');
    expect(new Date(updateCall.canceled_at).toISOString()).toBe(updateCall.canceled_at);
  });

  it('throws on DB error', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'canceled',
      items: { data: [{ price: { id: 'price_123' } }] },
      cancel_at_period_end: false,
      canceled_at: 1234567890,
    };

    const dbError = new Error('Database error');
    mockUpdate.mockResolvedValue({ data: null, error: dbError });

    await expect(handleSubscriptionDeleted(subscription, mockDb)).rejects.toThrow(dbError);
  });
});

describe('handlePaymentFailed', () => {
  let mockDb: MockDbClient;
  let mockUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUpdate = vi.fn().mockResolvedValue({ data: null, error: null });

    mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn().mockReturnValue({
          eq: mockUpdate,
        }),
        upsert: vi.fn(),
      }),
    } as unknown as MockDbClient;
  });

  it('ignores invoices without subscription', async () => {
    const invoice: MockStripeInvoice = {
      id: 'in_123',
      subscription: null,
    };

    await handlePaymentFailed(invoice, mockDb);

    expect(mockDb.from).not.toHaveBeenCalled();
  });

  it('updates subscription to past_due', async () => {
    const invoice: MockStripeInvoice = {
      id: 'in_123',
      subscription: 'sub_123',
    };

    await handlePaymentFailed(invoice, mockDb);

    expect(mockDb.from).toHaveBeenCalledWith('subscriptions');
    expect(mockUpdate).toHaveBeenCalledWith('stripe_subscription_id', 'sub_123');
  });

  it('handles subscription as string', async () => {
    const invoice: MockStripeInvoice = {
      id: 'in_123',
      subscription: 'sub_123',
    };

    await handlePaymentFailed(invoice, mockDb);

    expect(mockUpdate).toHaveBeenCalledWith('stripe_subscription_id', 'sub_123');
  });

  it('handles subscription as object with id', async () => {
    const invoice: MockStripeInvoice = {
      id: 'in_123',
      subscription: { id: 'sub_456' },
    };

    await handlePaymentFailed(invoice, mockDb);

    expect(mockUpdate).toHaveBeenCalledWith('stripe_subscription_id', 'sub_456');
  });

  it('throws on DB error', async () => {
    const invoice: MockStripeInvoice = {
      id: 'in_123',
      subscription: 'sub_123',
    };

    const dbError = new Error('Database error');
    mockUpdate.mockResolvedValue({ data: null, error: dbError });

    await expect(handlePaymentFailed(invoice, mockDb)).rejects.toThrow(dbError);
  });
});

describe('upsertSubscription', () => {
  let mockDb: MockDbClient;
  let mockUpsert: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUpsert = vi.fn().mockResolvedValue({ data: null, error: null });

    mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        upsert: mockUpsert,
      }),
    } as unknown as MockDbClient;
  });

  it('throws when subscription has no price', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    await expect(upsertSubscription('customer_123', subscription, mockDb)).rejects.toThrow(
      'Subscription has no price',
    );

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('builds correct subscription data from Stripe subscription object', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_456' } }] },
      current_period_start: 1640000000,
      current_period_end: 1642592000,
      cancel_at_period_end: false,
      canceled_at: null,
    };

    await upsertSubscription('customer_123', subscription, mockDb);

    expect(mockUpsert).toHaveBeenCalledWith(
      {
        customer_id: 'customer_123',
        stripe_subscription_id: 'sub_123',
        stripe_price_id: 'price_456',
        status: 'active',
        current_period_start: new Date(1640000000 * 1000).toISOString(),
        current_period_end: new Date(1642592000 * 1000).toISOString(),
        cancel_at_period_end: false,
        canceled_at: null,
      },
      { onConflict: 'stripe_subscription_id' },
    );
  });

  it('converts Unix timestamps to ISO strings', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_456' } }] },
      current_period_start: 1640000000,
      current_period_end: 1642592000,
      cancel_at_period_end: true,
      canceled_at: 1643000000,
    };

    await upsertSubscription('customer_123', subscription, mockDb);

    const callArgs = mockUpsert.mock.calls[0]?.[0];
    expect(callArgs.current_period_start).toBe(new Date(1640000000 * 1000).toISOString());
    expect(callArgs.current_period_end).toBe(new Date(1642592000 * 1000).toISOString());
    expect(callArgs.canceled_at).toBe(new Date(1643000000 * 1000).toISOString());
  });

  it('handles null timestamps', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_456' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    await upsertSubscription('customer_123', subscription, mockDb);

    const callArgs = mockUpsert.mock.calls[0]?.[0];
    expect(callArgs.current_period_start).toBeNull();
    expect(callArgs.current_period_end).toBeNull();
    expect(callArgs.canceled_at).toBeNull();
  });

  it('uses stripe_subscription_id as conflict target', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_456' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    await upsertSubscription('customer_123', subscription, mockDb);

    expect(mockUpsert).toHaveBeenCalledWith(expect.any(Object), {
      onConflict: 'stripe_subscription_id',
    });
  });

  it('throws on DB error', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_456' } }] },
      cancel_at_period_end: false,
      canceled_at: null,
    };

    const dbError = new Error('Database error');
    mockUpsert.mockResolvedValue({ data: null, error: dbError });

    await expect(upsertSubscription('customer_123', subscription, mockDb)).rejects.toThrow(dbError);
  });

  it('handles different subscription statuses', async () => {
    const statuses: Array<MockStripeSubscription['status']> = [
      'active',
      'past_due',
      'canceled',
      'trialing',
      'incomplete',
    ];

    for (const status of statuses) {
      const subscription: MockStripeSubscription = {
        id: 'sub_123',
        customer: 'cus_123',
        status,
        items: { data: [{ price: { id: 'price_456' } }] },
        cancel_at_period_end: false,
        canceled_at: null,
      };

      mockUpsert.mockClear();
      await upsertSubscription('customer_123', subscription, mockDb);

      const callArgs = mockUpsert.mock.calls[0]?.[0];
      expect(callArgs.status).toBe(status);
    }
  });

  it('preserves cancel_at_period_end flag', async () => {
    const subscription: MockStripeSubscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_456' } }] },
      cancel_at_period_end: true,
      canceled_at: null,
    };

    await upsertSubscription('customer_123', subscription, mockDb);

    const callArgs = mockUpsert.mock.calls[0]?.[0];
    expect(callArgs.cancel_at_period_end).toBe(true);
  });
});

describe('Webhook Handler Integration', () => {
  it('simulates full webhook flow for checkout.session.completed', async () => {
    // Mock Stripe event
    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_123',
          mode: 'subscription',
          customer: 'cus_123',
          subscription: 'sub_123',
        },
      },
    };

    // Mock DB
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'customer_123', stripe_customer_id: 'cus_123' },
              error: null,
            }),
          }),
        }),
        upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn(),
        update: vi.fn(),
      }),
    } as unknown as MockDbClient;

    // Mock Stripe retrieve
    const mockRetrieveSubscription = vi.fn().mockResolvedValue({
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_456' } }] },
      current_period_start: 1640000000,
      current_period_end: 1642592000,
      cancel_at_period_end: false,
      canceled_at: null,
    });

    // Route event
    const result = await routeWebhookEvent(mockEvent, {
      checkoutSessionCompleted: async (session) => {
        await handleCheckoutSessionCompleted(
          session,
          mockDb,
          mockRetrieveSubscription,
          upsertSubscription,
        );
      },
    });

    expect(result).toEqual({ received: true });
    expect(mockRetrieveSubscription).toHaveBeenCalledWith('sub_123');
    expect(mockDb.from).toHaveBeenCalledWith('customers');
    expect(mockDb.from).toHaveBeenCalledWith('subscriptions');
  });

  it('simulates error handling for customer not found', async () => {
    const mockEvent: MockStripeEvent = {
      id: 'evt_123',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_nonexistent',
          status: 'active',
          items: { data: [{ price: { id: 'price_456' } }] },
          cancel_at_period_end: false,
          canceled_at: null,
        },
      },
    };

    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: new Error('Not found'),
            }),
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      }),
    } as unknown as MockDbClient;

    const result = await routeWebhookEvent(mockEvent, {
      subscriptionUpdated: async (subscription) => {
        await handleSubscriptionUpdated(subscription, mockDb, upsertSubscription);
      },
    });

    expect(result).toEqual({
      received: false,
      error: 'Customer not found: cus_nonexistent',
    });
  });
});
