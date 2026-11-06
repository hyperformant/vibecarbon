/**
 * Billing provider abstraction layer.
 *
 * Defines a common interface that all payment providers (Stripe, Paddle, Polar)
 * must implement. This allows the billing routes and webhook handlers to remain
 * provider-agnostic, selecting the active provider at runtime via BILLING_PROVIDER.
 */

export type BillingProviderType = 'stripe' | 'paddle' | 'polar';

export interface CheckoutResult {
  url: string;
  sessionId?: string;
}

export interface PortalResult {
  url: string;
}

export interface SubscriptionInfo {
  id: string;
  status: string;
  planId: string;
  priceId: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  price: {
    unitAmount: number;
    currency: string;
    interval: string;
  };
  product: {
    id: string;
    name: string;
  };
}

export interface BillingProvider {
  readonly type: BillingProviderType;

  /** Returns true if the provider has its required API keys configured. */
  isConfigured(): boolean;

  /**
   * Create a checkout session and return the redirect URL.
   * `customerId` is optional: guest checkouts omit it and let the provider's
   * checkout page collect the buyer's email itself.
   */
  createCheckout(params: {
    customerId?: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    mode?: 'subscription' | 'payment';
  }): Promise<CheckoutResult>;

  /** Create a customer portal session and return the redirect URL. */
  createPortalSession(params: { customerId: string; returnUrl: string }): Promise<PortalResult>;

  /** Retrieve subscription details for a customer. */
  getSubscription(params: {
    customerId: string;
    subscriptionId: string;
  }): Promise<SubscriptionInfo | null>;

  /**
   * Verify and parse an incoming webhook payload.
   * Returns a normalized event type and data payload.
   */
  handleWebhook(params: {
    body: string;
    signature: string;
  }): Promise<{ type: string; data: Record<string, unknown> }>;

  /** Create a customer in the provider and return the provider's customer ID. */
  createCustomer(params: {
    email: string;
    name: string;
    metadata: Record<string, string>;
  }): Promise<string>;

  /** Delete a customer in the provider. */
  deleteCustomer(customerId: string): Promise<void>;
}
