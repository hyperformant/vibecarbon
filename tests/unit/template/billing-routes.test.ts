import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * Tests for billing route logic from carbon/src/server/routes/v1/billing.ts
 *
 * These tests re-implement the validation schemas and business-logic patterns
 * inline (the template lives in a separate pnpm project whose node_modules may
 * be absent at unit-test time, so we don't import from carbon/src). The mirror
 * is kept aligned with today's source, and the `drift guards` describe block at
 * the bottom reads the real carbon/ files to pin the signatures this mirror
 * depends on.
 *
 * Current behavior modeled here:
 *  - getProviderPriceIds() returns { starter?, pro? } only — no yearly variants.
 *  - The /prices endpoint emits a monthly-only price map.
 *  - getOrCreateCustomer goes through the provider abstraction
 *    (provider.createCustomer / provider.deleteCustomer) and returns a
 *    providerCustomerId (stored in the legacy `stripe_customer_id` column).
 *  - Plans have no trial fields and checkout has no trial logic.
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface MockUser {
  id: string;
  email?: string;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
}

interface MockCustomer {
  id: string;
  stripe_customer_id: string;
  user_id?: string;
  organization_id?: string;
  email: string;
}

interface MockSubscription {
  id: string;
  customer_id: string;
  stripe_price_id: string;
  status: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
}

interface MockOrganization {
  id: string;
  name: string;
}

interface MockMembership {
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

// Mock provider price (Stripe-shaped, used by the subscription endpoint)
interface MockProviderPrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
  product: unknown;
}

// Mock checkout/portal session
interface MockSession {
  id: string;
  url: string | null;
}

// ============================================================================
// VALIDATION SCHEMAS (re-implemented from template)
// ============================================================================

const checkoutSchema = z.object({
  priceId: z.string().min(1, 'Price ID is required'),
  type: z.enum(['user', 'organization']),
  organizationId: z.string().uuid().optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const portalSchema = z.object({
  type: z.enum(['user', 'organization']),
  organizationId: z.string().uuid().optional(),
  returnUrl: z.string().url().optional(),
});

// ============================================================================
// PRICING CONFIG (simplified from shared/pricing.ts)
//
// Plans carry no trial fields — the product deliberately deferred trials.
// ============================================================================

interface Plan {
  id: string;
  name: string;
}

const plans: Plan[] = [
  { id: 'free', name: 'Free' },
  { id: 'starter', name: 'Startup' },
  { id: 'pro', name: 'Pro' },
];

// Mirror of pricing.ts planIdFromPriceId — provider-agnostic, maps only
// starter/pro/free (no yearly variants).
function planIdFromPriceId(priceId: string, priceIds: { starter?: string; pro?: string }): string {
  if (priceId === priceIds.starter) return 'starter';
  if (priceId === priceIds.pro) return 'pro';
  return 'free';
}

// ============================================================================
// HELPER FUNCTION: getOrCreateCustomer (re-implemented from billing.ts)
//
// Uses the active billing provider (provider.createCustomer /
// provider.deleteCustomer) rather than a direct Stripe SDK. Returns a
// providerCustomerId, persisted in the legacy `stripe_customer_id` column.
// ============================================================================

interface MockDbSingleResult {
  data: { id?: string; stripe_customer_id?: string; name?: string } | null;
  error: Error | null;
}

interface MockDbMaybeSingleResult {
  data: MockCustomer | null;
  error: Error | null;
}

interface MockDbQuery {
  eq: (field: string, value: string) => MockDbQuery;
  is: (field: string, value: null) => MockDbQuery;
  maybeSingle: () => Promise<MockDbMaybeSingleResult>;
  select: (fields: string) => MockDbQuery;
  single: () => Promise<MockDbSingleResult>;
  insert: (data: unknown) => MockDbQuery;
}

interface MockDb {
  from: (table: string) => MockDbQuery;
}

interface MockProvider {
  createCustomer: (data: {
    email: string;
    name: string;
    metadata: Record<string, string>;
  }) => Promise<string>;
  deleteCustomer: (customerId: string) => Promise<void>;
}

async function getOrCreateCustomer(
  type: 'user' | 'organization',
  userId: string,
  email: string,
  organizationId: string | undefined,
  mockDb: MockDb,
  provider: MockProvider,
): Promise<{ customerId?: string; providerCustomerId?: string }> {
  // Build query based on type
  const query = mockDb.from('customers').select('id, stripe_customer_id');

  if (type === 'user') {
    query.eq('user_id', userId).is('organization_id', null);
  } else {
    if (!organizationId) {
      throw new Error('Organization ID is required for organization billing');
    }
    query.eq('organization_id', organizationId).is('user_id', null);
  }

  const { data: existingCustomer, error: fetchError } = await query.maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to fetch customer: ${fetchError.message}`);
  }

  // Return existing customer if found. The legacy `stripe_customer_id` column
  // holds any provider's customer ID.
  if (existingCustomer) {
    return {
      customerId: existingCustomer.id,
      providerCustomerId: existingCustomer.stripe_customer_id,
    };
  }

  // Get organization name if applicable
  let customerName = email;
  if (type === 'organization' && organizationId) {
    const orgQuery = mockDb.from('organizations').select('name').eq('id', organizationId).single();
    const { data: org } = await orgQuery;
    if (org?.name) {
      customerName = org.name;
    }
  }

  // Create customer in the billing provider (returns the provider's customer ID)
  const providerCustomerId = await provider.createCustomer({
    email,
    name: customerName,
    metadata: {
      type,
      user_id: userId,
      organization_id: organizationId || '',
    },
  });

  // Create database record (stripe_customer_id stores the provider ID regardless
  // of active provider — the column name is kept for backward compatibility).
  const insertData =
    type === 'user'
      ? { user_id: userId, stripe_customer_id: providerCustomerId, email }
      : { organization_id: organizationId, stripe_customer_id: providerCustomerId, email };

  const insertQuery = mockDb
    .from('customers')
    .insert(insertData)
    .select('id, stripe_customer_id')
    .single();

  const { data: newCustomer, error: insertError } = await insertQuery;

  if (insertError) {
    // Best-effort cleanup of the provider customer if the DB insert fails.
    try {
      await provider.deleteCustomer(providerCustomerId);
    } catch {
      // Orphaned provider customer can be cleaned up manually.
    }
    throw new Error(`Failed to create customer record: ${insertError.message}`);
  }

  return {
    customerId: newCustomer?.id,
    providerCustomerId: newCustomer?.stripe_customer_id,
  };
}

// ============================================================================
// TESTS: VALIDATION SCHEMAS
// ============================================================================

describe('Billing Validation Schemas', () => {
  describe('checkoutSchema', () => {
    it('validates valid user checkout request', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'user',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.priceId).toBe('price_123');
        expect(result.data.type).toBe('user');
      }
    });

    it('validates valid organization checkout request', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'organization',
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.organizationId).toBe('550e8400-e29b-41d4-a716-446655440000');
      }
    });

    it('validates optional success and cancel URLs', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'user',
        successUrl: 'https://example.com/success',
        cancelUrl: 'https://example.com/cancel',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.successUrl).toBe('https://example.com/success');
        expect(result.data.cancelUrl).toBe('https://example.com/cancel');
      }
    });

    it('rejects missing priceId', () => {
      const result = checkoutSchema.safeParse({
        type: 'user',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod's error message for missing field
        expect(result.error.issues[0].message).toMatch(/required|expected/i);
      }
    });

    it('rejects empty priceId', () => {
      const result = checkoutSchema.safeParse({
        priceId: '',
        type: 'user',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Price ID is required');
      }
    });

    it('rejects invalid type', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'invalid',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid organizationId UUID', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'organization',
        organizationId: 'not-a-uuid',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid URL format for successUrl', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'user',
        successUrl: 'not-a-url',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid URL format for cancelUrl', () => {
      const result = checkoutSchema.safeParse({
        priceId: 'price_123',
        type: 'user',
        cancelUrl: 'not-a-url',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('portalSchema', () => {
    it('validates valid user portal request', () => {
      const result = portalSchema.safeParse({
        type: 'user',
      });

      expect(result.success).toBe(true);
    });

    it('validates valid organization portal request', () => {
      const result = portalSchema.safeParse({
        type: 'organization',
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.organizationId).toBe('550e8400-e29b-41d4-a716-446655440000');
      }
    });

    it('validates optional returnUrl', () => {
      const result = portalSchema.safeParse({
        type: 'user',
        returnUrl: 'https://example.com/billing',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.returnUrl).toBe('https://example.com/billing');
      }
    });

    it('rejects invalid type', () => {
      const result = portalSchema.safeParse({
        type: 'company',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid organizationId UUID', () => {
      const result = portalSchema.safeParse({
        type: 'organization',
        organizationId: 'invalid-uuid',
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid returnUrl format', () => {
      const result = portalSchema.safeParse({
        type: 'user',
        returnUrl: 'invalid-url',
      });

      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TESTS: getOrCreateCustomer LOGIC (provider abstraction)
// ============================================================================

describe('getOrCreateCustomer', () => {
  describe('user type billing', () => {
    it('returns existing customer for user', async () => {
      const existingCustomer: MockCustomer = {
        id: 'cust_db_123',
        stripe_customer_id: 'cus_provider_123',
        user_id: 'user_123',
        email: 'user@example.com',
      };

      const mockDb: MockDb = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: existingCustomer, error: null }),
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn(),
        deleteCustomer: vi.fn(),
      };

      const result = await getOrCreateCustomer(
        'user',
        'user_123',
        'user@example.com',
        undefined,
        mockDb,
        provider,
      );

      expect(result).toEqual({
        customerId: 'cust_db_123',
        providerCustomerId: 'cus_provider_123',
      });
      expect(provider.createCustomer).not.toHaveBeenCalled();
    });

    it('creates new customer for user when none exists', async () => {
      const newDbCustomer = {
        id: 'cust_db_new',
        stripe_customer_id: 'cus_new_123',
      };

      const mockDb: MockDb = {
        from: vi.fn((table: string) => {
          if (table === 'customers') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              insert: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: newDbCustomer, error: null }),
            };
          }
          return {};
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn().mockResolvedValue('cus_new_123'),
        deleteCustomer: vi.fn(),
      };

      const result = await getOrCreateCustomer(
        'user',
        'user_new',
        'newuser@example.com',
        undefined,
        mockDb,
        provider,
      );

      expect(result).toEqual({
        customerId: 'cust_db_new',
        providerCustomerId: 'cus_new_123',
      });
      expect(provider.createCustomer).toHaveBeenCalledWith({
        email: 'newuser@example.com',
        name: 'newuser@example.com',
        metadata: {
          type: 'user',
          user_id: 'user_new',
          organization_id: '',
        },
      });
    });

    it('queries database correctly for user type', async () => {
      const mockQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: { id: 'cust_1', stripe_customer_id: 'cus_123' },
          error: null,
        }),
      };

      const mockDb: MockDb = {
        from: vi.fn().mockReturnValue(mockQuery),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn().mockResolvedValue('cus_123'),
        deleteCustomer: vi.fn(),
      };

      await getOrCreateCustomer(
        'user',
        'user_123',
        'user@example.com',
        undefined,
        mockDb,
        provider,
      );

      expect(mockDb.from).toHaveBeenCalledWith('customers');
      expect(mockQuery.eq).toHaveBeenCalledWith('user_id', 'user_123');
      expect(mockQuery.is).toHaveBeenCalledWith('organization_id', null);
    });
  });

  describe('organization type billing', () => {
    it('returns existing customer for organization', async () => {
      const existingCustomer: MockCustomer = {
        id: 'cust_db_org_123',
        stripe_customer_id: 'cus_provider_org_123',
        organization_id: 'org_123',
        email: 'admin@example.com',
      };

      const mockDb: MockDb = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: existingCustomer, error: null }),
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn(),
        deleteCustomer: vi.fn(),
      };

      const result = await getOrCreateCustomer(
        'organization',
        'user_123',
        'admin@example.com',
        'org_123',
        mockDb,
        provider,
      );

      expect(result).toEqual({
        customerId: 'cust_db_org_123',
        providerCustomerId: 'cus_provider_org_123',
      });
      expect(provider.createCustomer).not.toHaveBeenCalled();
    });

    it('creates new customer with organization name', async () => {
      const orgData: MockOrganization = {
        id: 'org_123',
        name: 'Acme Corp',
      };

      const newDbCustomer = {
        id: 'cust_db_org_new',
        stripe_customer_id: 'cus_org_new',
      };

      const mockDb: MockDb = {
        from: vi.fn((table: string) => {
          if (table === 'customers') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              insert: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: newDbCustomer, error: null }),
            };
          }
          if (table === 'organizations') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: orgData, error: null }),
            };
          }
          return {};
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn().mockResolvedValue('cus_org_new'),
        deleteCustomer: vi.fn(),
      };

      const result = await getOrCreateCustomer(
        'organization',
        'user_123',
        'admin@example.com',
        'org_123',
        mockDb,
        provider,
      );

      expect(result).toEqual({
        customerId: 'cust_db_org_new',
        providerCustomerId: 'cus_org_new',
      });
      expect(provider.createCustomer).toHaveBeenCalledWith({
        email: 'admin@example.com',
        name: 'Acme Corp',
        metadata: {
          type: 'organization',
          user_id: 'user_123',
          organization_id: 'org_123',
        },
      });
    });

    it('throws error when organizationId is missing', async () => {
      // Mock the from().select() chain so the query builder doesn't error before
      // the guard is reached.
      const mockDb: MockDb = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(),
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn(),
        deleteCustomer: vi.fn(),
      };

      await expect(
        getOrCreateCustomer(
          'organization',
          'user_123',
          'admin@example.com',
          undefined,
          mockDb,
          provider,
        ),
      ).rejects.toThrow('Organization ID is required for organization billing');
    });

    it('queries database correctly for organization type', async () => {
      const mockQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };

      const mockDb: MockDb = {
        from: vi.fn((table: string) => {
          if (table === 'organizations') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: { name: 'Org Name' }, error: null }),
            };
          }
          if (table === 'customers') {
            return {
              ...mockQuery,
              insert: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({
                data: { id: 'cust_1', stripe_customer_id: 'cus_123' },
                error: null,
              }),
            };
          }
          return mockQuery;
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn().mockResolvedValue('cus_123'),
        deleteCustomer: vi.fn(),
      };

      await getOrCreateCustomer(
        'organization',
        'user_123',
        'admin@example.com',
        'org_123',
        mockDb,
        provider,
      );

      expect(mockQuery.eq).toHaveBeenCalledWith('organization_id', 'org_123');
      expect(mockQuery.is).toHaveBeenCalledWith('user_id', null);
    });
  });

  describe('error handling', () => {
    it('throws error when customer fetch fails', async () => {
      const mockDb: MockDb = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          maybeSingle: vi
            .fn()
            .mockResolvedValue({ data: null, error: new Error('Database connection failed') }),
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn(),
        deleteCustomer: vi.fn(),
      };

      await expect(
        getOrCreateCustomer('user', 'user_123', 'user@example.com', undefined, mockDb, provider),
      ).rejects.toThrow('Failed to fetch customer: Database connection failed');
    });

    it('deletes the provider customer when the DB insert fails', async () => {
      const mockDb: MockDb = {
        from: vi.fn((table: string) => {
          if (table === 'customers') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              insert: vi.fn().mockReturnThis(),
              single: vi
                .fn()
                .mockResolvedValue({ data: null, error: new Error('Insert constraint violation') }),
            };
          }
          return {};
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn().mockResolvedValue('cus_to_delete'),
        deleteCustomer: vi.fn().mockResolvedValue(undefined),
      };

      await expect(
        getOrCreateCustomer('user', 'user_123', 'user@example.com', undefined, mockDb, provider),
      ).rejects.toThrow('Failed to create customer record: Insert constraint violation');

      expect(provider.deleteCustomer).toHaveBeenCalledWith('cus_to_delete');
    });

    it('still throws when best-effort provider cleanup itself fails', async () => {
      const mockDb: MockDb = {
        from: vi.fn((table: string) => {
          if (table === 'customers') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              insert: vi.fn().mockReturnThis(),
              single: vi
                .fn()
                .mockResolvedValue({ data: null, error: new Error('Insert constraint violation') }),
            };
          }
          return {};
        }),
      };

      const provider: MockProvider = {
        createCustomer: vi.fn().mockResolvedValue('cus_to_delete'),
        deleteCustomer: vi.fn().mockRejectedValue(new Error('provider unreachable')),
      };

      await expect(
        getOrCreateCustomer('user', 'user_123', 'user@example.com', undefined, mockDb, provider),
      ).rejects.toThrow('Failed to create customer record: Insert constraint violation');

      expect(provider.deleteCustomer).toHaveBeenCalledWith('cus_to_delete');
    });
  });
});

// ============================================================================
// TESTS: ROUTE LOGIC PATTERNS
// ============================================================================

describe('Billing Route Logic', () => {
  describe('GET /billing/status', () => {
    it('returns configured status when the provider is configured', () => {
      const isBillingConfigured = () => true;

      const response = {
        configured: isBillingConfigured(),
      };

      expect(response).toEqual({
        configured: true,
      });
    });

    it('returns unconfigured status when the provider is not configured', () => {
      const isBillingConfigured = () => false;

      const response = {
        configured: isBillingConfigured(),
      };

      expect(response).toEqual({
        configured: false,
      });
    });
  });

  describe('GET /billing/prices', () => {
    it('returns plans with monthly-only price maps when configured', () => {
      const configured = true;
      // getProviderPriceIds() returns starter/pro only.
      const priceIds: { starter?: string; pro?: string } = {
        starter: 'price_starter_monthly',
        pro: 'price_pro_monthly',
      };

      const priceMap: Record<string, { monthly?: string }> = {};

      if (configured) {
        if (priceIds.starter) {
          priceMap.starter = { monthly: priceIds.starter };
        }
        if (priceIds.pro) {
          priceMap.pro = { monthly: priceIds.pro };
        }
      }

      const response = {
        configured,
        plans: plans.map((plan) => ({
          ...plan,
          // Both keys are emitted (stripePriceIds kept for backward compatibility).
          stripePriceIds: priceMap[plan.id] ?? null,
          priceIds: priceMap[plan.id] ?? null,
        })),
      };

      expect(response.configured).toBe(true);
      expect(response.plans[1].stripePriceIds).toEqual({ monthly: 'price_starter_monthly' });
      expect(response.plans[1].priceIds).toEqual({ monthly: 'price_starter_monthly' });
      expect(response.plans[2].stripePriceIds).toEqual({ monthly: 'price_pro_monthly' });
      // No yearly entry is emitted — yearly pricing was deferred from the product.
      expect(response.plans[1].stripePriceIds).not.toHaveProperty('yearly');
      expect(response.plans[2].stripePriceIds).not.toHaveProperty('yearly');
    });

    it('returns null price maps when not configured', () => {
      const configured = false;

      const response = {
        configured,
        plans: plans.map((plan) => ({
          ...plan,
          stripePriceIds: null,
          priceIds: null,
        })),
      };

      expect(response.configured).toBe(false);
      expect(response.plans[0].stripePriceIds).toBeNull();
      expect(response.plans[1].stripePriceIds).toBeNull();
      expect(response.plans[1].priceIds).toBeNull();
    });
  });

  describe('GET /billing/subscription', () => {
    it('returns 401 when user is not authenticated', () => {
      const user = null;

      const statusCode = user ? 200 : 401;
      const response = user ? {} : { error: 'Unauthorized' };

      expect(statusCode).toBe(401);
      expect(response).toEqual({ error: 'Unauthorized' });
    });

    it('returns 503 when billing is not configured', () => {
      const _user: MockUser = { id: 'user_123', email: 'user@example.com' };
      const isBillingConfigured = false;

      const statusCode = isBillingConfigured ? 200 : 503;
      const response = isBillingConfigured ? {} : { error: 'Billing is not configured' };

      expect(statusCode).toBe(503);
      expect(response).toEqual({ error: 'Billing is not configured' });
    });

    it('returns subscription: null when no customer found', () => {
      const customer = null;

      const response = customer
        ? {}
        : {
            subscription: null,
            status: 'none',
          };

      expect(response).toEqual({
        subscription: null,
        status: 'none',
      });
    });

    it('returns subscription: null when no active subscription found', () => {
      const _customer: MockCustomer = {
        id: 'cust_123',
        stripe_customer_id: 'cus_123',
        user_id: 'user_123',
        email: 'user@example.com',
      };
      const subscription = null;

      const response = subscription
        ? {}
        : {
            subscription: null,
            status: 'none',
          };

      expect(response).toEqual({
        subscription: null,
        status: 'none',
      });
    });

    it('returns full subscription details with resolved planId', () => {
      const subscription: MockSubscription = {
        id: 'sub_123',
        customer_id: 'cust_123',
        stripe_price_id: 'price_starter_monthly',
        status: 'active',
        current_period_end: '2024-12-31T23:59:59Z',
        cancel_at_period_end: false,
      };

      const price: MockProviderPrice = {
        id: 'price_starter_monthly',
        unit_amount: 1900,
        currency: 'usd',
        recurring: { interval: 'month' },
        product: { id: 'prod_123', name: 'Startup Plan' },
      };

      const resolvedPlanId = planIdFromPriceId(subscription.stripe_price_id, {
        starter: 'price_starter_monthly',
        pro: 'price_pro_monthly',
      });

      const response = {
        subscription: {
          id: subscription.id,
          status: subscription.status,
          priceId: subscription.stripe_price_id,
          planId: resolvedPlanId,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          product: price.product,
          price: {
            id: price.id,
            unitAmount: price.unit_amount,
            currency: price.currency,
            interval: price.recurring?.interval,
          },
        },
        status: subscription.status,
      };

      expect(response.subscription.planId).toBe('starter');
      expect(response.subscription.price.unitAmount).toBe(1900);
    });
  });

  describe('POST /billing/checkout', () => {
    it('returns 401 when user is not authenticated', () => {
      const user = null;

      const statusCode = user ? 200 : 401;
      const response = user ? {} : { error: 'Unauthorized' };

      expect(statusCode).toBe(401);
      expect(response).toEqual({ error: 'Unauthorized' });
    });

    it('returns 503 when billing is not configured', () => {
      const _user: MockUser = { id: 'user_123', email: 'user@example.com' };
      const isBillingConfigured = false;

      const statusCode = isBillingConfigured ? 200 : 503;
      const response = isBillingConfigured ? {} : { error: 'Billing is not configured' };

      expect(statusCode).toBe(503);
      expect(response).toEqual({ error: 'Billing is not configured' });
    });

    it('returns 400 for invalid request body', () => {
      const rawBody = { type: 'user' }; // Missing priceId
      const result = checkoutSchema.safeParse(rawBody);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(', ');
        expect(errors).toMatch(/required|expected/i);
      }
    });

    it('returns 400 when organization billing missing organizationId', () => {
      const body = {
        priceId: 'price_123',
        type: 'organization' as const,
        // Missing organizationId
      };

      const statusCode = body.type === 'organization' && !body.organizationId ? 400 : 200;
      const response =
        body.type === 'organization' && !body.organizationId
          ? { error: 'Organization ID is required for organization billing' }
          : {};

      expect(statusCode).toBe(400);
      expect(response).toEqual({ error: 'Organization ID is required for organization billing' });
    });

    it('returns 403 when user is not OWNER or ADMIN of organization', () => {
      const _body = {
        priceId: 'price_123',
        type: 'organization' as const,
        organizationId: 'org_123',
      };
      const membership: MockMembership | null = { role: 'MEMBER' };

      const isAuthorized =
        membership && (membership.role === 'OWNER' || membership.role === 'ADMIN');

      const statusCode = isAuthorized ? 200 : 403;
      const response = isAuthorized
        ? {}
        : { error: 'You must be an admin to manage organization billing' };

      expect(statusCode).toBe(403);
      expect(response).toEqual({ error: 'You must be an admin to manage organization billing' });
    });

    it('returns sessionId and url on success', () => {
      const mockSession: MockSession = {
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/pay/cs_test_123',
      };

      const response = {
        sessionId: mockSession.id,
        url: mockSession.url,
      };

      expect(response).toEqual({
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/pay/cs_test_123',
      });
    });

    it('resolves a paid plan from the configured price IDs (no trial logic)', () => {
      const priceId = 'price_starter_monthly';
      const resolvedPlanId = planIdFromPriceId(priceId, { starter: 'price_starter_monthly' });
      const planConfig = plans.find((p) => p.id === resolvedPlanId);

      expect(resolvedPlanId).toBe('starter');
      expect(planConfig).toBeDefined();
      // Plans carry no trial concept — trials were deferred from the product.
      // Only id/name are present; no trial field exists on the plan shape.
      expect(Object.keys(planConfig as Plan)).toEqual(['id', 'name']);
    });

    it('resolves unknown price IDs to the free plan', () => {
      const priceId = 'price_unknown';
      const resolvedPlanId = planIdFromPriceId(priceId, {});
      const planConfig = plans.find((p) => p.id === resolvedPlanId);

      expect(resolvedPlanId).toBe('free');
      expect(planConfig).toBeDefined();
    });
  });

  describe('POST /billing/portal', () => {
    it('returns 401 when user is not authenticated', () => {
      const user = null;

      const statusCode = user ? 200 : 401;
      const response = user ? {} : { error: 'Unauthorized' };

      expect(statusCode).toBe(401);
      expect(response).toEqual({ error: 'Unauthorized' });
    });

    it('returns 503 when billing is not configured', () => {
      const _user: MockUser = { id: 'user_123', email: 'user@example.com' };
      const isBillingConfigured = false;

      const statusCode = isBillingConfigured ? 200 : 503;
      const response = isBillingConfigured ? {} : { error: 'Billing is not configured' };

      expect(statusCode).toBe(503);
      expect(response).toEqual({ error: 'Billing is not configured' });
    });

    it('returns 400 for invalid request body', () => {
      const rawBody = { type: 'invalid' };
      const result = portalSchema.safeParse(rawBody);

      expect(result.success).toBe(false);
    });

    it('returns 404 when customer not found', () => {
      const customer = null;

      const statusCode = customer ? 200 : 404;
      const response = customer
        ? {}
        : { error: 'No billing account found. Please subscribe first.' };

      expect(statusCode).toBe(404);
      expect(response).toEqual({ error: 'No billing account found. Please subscribe first.' });
    });

    it('returns 403 when user is not OWNER or ADMIN for org billing', () => {
      const _body = {
        type: 'organization' as const,
        organizationId: 'org_123',
      };
      const membership: MockMembership | null = { role: 'MEMBER' };

      const isAuthorized =
        membership && (membership.role === 'OWNER' || membership.role === 'ADMIN');

      const statusCode = isAuthorized ? 200 : 403;
      const response = isAuthorized
        ? {}
        : { error: 'You must be an admin to manage organization billing' };

      expect(statusCode).toBe(403);
      expect(response).toEqual({ error: 'You must be an admin to manage organization billing' });
    });

    it('returns portal url on success', () => {
      const mockPortalSession: MockSession = {
        id: 'bps_123',
        url: 'https://billing.stripe.com/session/bps_123',
      };

      const response = {
        url: mockPortalSession.url,
      };

      expect(response).toEqual({
        url: 'https://billing.stripe.com/session/bps_123',
      });
    });
  });
});

// ============================================================================
// DRIFT GUARDS — pin the real carbon/ source these mirrors model.
//
// These read the current template files directly so the mirror can't silently
// drift away from the source again. No TypeScript is imported from carbon/src.
// ============================================================================

describe('drift guards (carbon/ source)', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

  it('getProviderPriceIds returns only starter/pro (no yearly variants)', () => {
    const src = read('carbon/src/server/billing/index.ts');
    expect(src).toMatch(
      /export function getProviderPriceIds\(\): \{ starter\?: string; pro\?: string \}/,
    );
    expect(src).not.toMatch(/yearly/i);
  });

  it('the /prices endpoint emits monthly-only price maps', () => {
    const src = read('carbon/src/server/routes/v1/billing.ts');
    expect(src).toMatch(/Record<string, \{ monthly\?: string \}>/);
    expect(src).not.toMatch(/yearly/i);
  });

  it('getOrCreateCustomer uses the provider abstraction and returns providerCustomerId', () => {
    const src = read('carbon/src/server/routes/v1/billing.ts');
    expect(src).toMatch(/provider\.createCustomer\(/);
    expect(src).toMatch(/provider\.deleteCustomer\(/);
    expect(src).toMatch(/providerCustomerId/);
    // The old direct-Stripe customer helpers must be gone.
    expect(src).not.toMatch(/stripe\.customers\.create\(/);
    expect(src).not.toMatch(/stripe\.customers\.del\(/);
  });

  it('pricing config has no trial fields and planIdFromPriceId maps only starter/pro/free', () => {
    const src = read('carbon/src/shared/pricing.ts');
    expect(src).not.toMatch(/trial/i);
    expect(src).toMatch(/export function planIdFromPriceId\(/);
    expect(src).toMatch(/if \(priceId === priceIds\.starter\) return 'starter';/);
    expect(src).toMatch(/if \(priceId === priceIds\.pro\) return 'pro';/);
  });
});
