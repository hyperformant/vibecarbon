import { eq } from 'drizzle-orm';
import { adminDb } from '../db/client';
import { customers, subscriptions } from '../db/schema';

/**
 * Billing rows the webhooks write. Webhooks act for the server, not a user,
 * so these go through `adminDb`.
 */

/** Our customer row for a provider customer id, or null. */
export async function findCustomerByProviderId(
  providerCustomerId: string
): Promise<{ id: string } | null> {
  const [customer] = await adminDb
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.stripeCustomerId, providerCustomerId))
    .limit(1);
  return customer ?? null;
}

export type SubscriptionWrite = Omit<
  typeof subscriptions.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;

/**
 * Insert a subscription, or update the row with the same provider
 * subscription id. On update only the columns present in `data` change.
 */
export async function upsertSubscriptionRow(data: SubscriptionWrite): Promise<void> {
  const { stripeSubscriptionId: _key, ...changes } = data;
  await adminDb
    .insert(subscriptions)
    .values(data)
    .onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: changes });
}
