import { DrizzleQueryError } from 'drizzle-orm/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryChain } from '../../../_helpers/drizzle-mock';

/**
 * getOrCreateCustomer (routes/v1/billing.ts): one customer row per user or
 * organization, holding the billing provider's customer id. Tested against
 * the real function; the database and the provider are doubles.
 */

const db = vi.hoisted(() => ({
  // Results for successive adminDb.select() chains, in call order; an Error
  // entry makes that query throw it.
  selects: [] as (unknown[] | Error)[],
  inserted: [] as unknown[],
  insertResult: (): unknown[] | Promise<unknown[]> => [],
}));
const provider = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  deleteCustomer: vi.fn(),
}));

vi.mock('@server/db/client', () => ({
  adminDb: {
    select: () =>
      queryChain(() => {
        const next = db.selects.shift() ?? [];
        if (next instanceof Error) throw next;
        return next;
      }),
    insert: () => ({
      values: (v: unknown) => {
        db.inserted.push(v);
        return queryChain(() => db.insertResult());
      },
    }),
  },
  withUserDb: vi.fn(),
}));
vi.mock('@server/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@server/billing', () => ({
  isBillingConfigured: () => true,
  getBillingProvider: () => ({ type: 'stripe', ...provider }),
  getProviderPriceIds: () => ({}),
}));

const { getOrCreateCustomer } = await import('@server/routes/v1/billing');

const USER = '00000000-0000-0000-0000-000000000001';
const ORG = '00000000-0000-0000-0000-0000000000aa';

beforeEach(() => {
  db.selects = [];
  db.inserted = [];
  db.insertResult = () => [];
  provider.createCustomer.mockReset();
  provider.deleteCustomer.mockReset();
});

describe('getOrCreateCustomer', () => {
  it('returns the existing customer without calling the provider', async () => {
    db.selects = [[{ id: 'c1', stripeCustomerId: 'cus_existing' }]];
    await expect(getOrCreateCustomer('user', USER, 'u@test.com')).resolves.toEqual({
      customerId: 'c1',
      providerCustomerId: 'cus_existing',
    });
    expect(provider.createCustomer).not.toHaveBeenCalled();
    expect(db.inserted).toEqual([]);
  });

  it('creates a personal customer at the provider, then the row', async () => {
    provider.createCustomer.mockResolvedValue('cus_new');
    db.insertResult = () => [{ id: 'c2', stripeCustomerId: 'cus_new' }];
    await expect(getOrCreateCustomer('user', USER, 'u@test.com')).resolves.toEqual({
      customerId: 'c2',
      providerCustomerId: 'cus_new',
    });
    expect(provider.createCustomer).toHaveBeenCalledWith({
      email: 'u@test.com',
      name: 'u@test.com',
      metadata: { type: 'user', user_id: USER, organization_id: '' },
    });
    expect(db.inserted).toEqual([
      { userId: USER, stripeCustomerId: 'cus_new', email: 'u@test.com' },
    ]);
  });

  it('names an organization customer after the org and keys the row by org', async () => {
    db.selects = [[], [{ name: 'Acme Inc' }]];
    provider.createCustomer.mockResolvedValue('cus_org');
    db.insertResult = () => [{ id: 'c3', stripeCustomerId: 'cus_org' }];
    await getOrCreateCustomer('organization', USER, 'u@test.com', ORG);
    expect(provider.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Acme Inc',
        metadata: { type: 'organization', user_id: USER, organization_id: ORG },
      })
    );
    expect(db.inserted).toEqual([
      { organizationId: ORG, stripeCustomerId: 'cus_org', email: 'u@test.com' },
    ]);
  });

  it('requires an organization id for organization billing', async () => {
    await expect(getOrCreateCustomer('organization', USER, 'u@test.com')).rejects.toThrow(
      /Organization ID is required/
    );
  });

  it('deletes the provider customer when the row insert fails, and keeps params out of the message', async () => {
    provider.createCustomer.mockResolvedValue('cus_orphan');
    const cause = Object.assign(new Error('duplicate key value violates unique constraint'), {
      severity: 'ERROR',
      code: '23505',
      detail: 'Key (email)=(u@test.com) already exists.',
    });
    db.insertResult = () => {
      throw new DrizzleQueryError('insert into customers ...', ['u@test.com', 'cus_orphan'], cause);
    };
    const err = await getOrCreateCustomer('user', USER, 'u@test.com').catch((e: Error) => e);
    expect(provider.deleteCustomer).toHaveBeenCalledWith('cus_orphan');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Failed to create customer record');
    expect((err as Error).message).not.toContain('u@test.com');
    // The database error is kept as the cause, for the (sanitizing) logger.
    expect((err as Error).cause).toBeInstanceOf(DrizzleQueryError);
  });

  it('still throws the insert failure when best-effort provider cleanup itself fails', async () => {
    provider.createCustomer.mockResolvedValue('cus_orphan');
    provider.deleteCustomer.mockRejectedValue(new Error('provider down'));
    db.insertResult = () => {
      throw new DrizzleQueryError('insert into customers ...', ['u@test.com'], new Error('boom'));
    };
    await expect(getOrCreateCustomer('user', USER, 'u@test.com')).rejects.toThrow(
      'Failed to create customer record'
    );
    expect(provider.deleteCustomer).toHaveBeenCalledWith('cus_orphan');
  });

  it('a failed lookup surfaces without the query params in its message', async () => {
    const lookup = new DrizzleQueryError('select ... where user_id = $1', [USER], new Error('boom'));
    db.selects = [lookup];
    const err = await getOrCreateCustomer('user', USER, 'u@test.com').catch((e: Error) => e);
    expect((err as Error).message).toBe('Failed to fetch customer');
    expect((err as Error).message).not.toContain(USER);
    expect((err as Error).cause).toBe(lookup);
    expect(provider.createCustomer).not.toHaveBeenCalled();
  });
});
