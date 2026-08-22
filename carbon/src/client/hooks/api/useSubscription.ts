import type { Plan, PlanId } from '@shared/pricing';
import { plans } from '@shared/pricing';
import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/lib/api';

interface Subscription {
  id: string;
  status: string;
  priceId: string;
  planId: PlanId;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  product: {
    id: string;
    name: string;
    description?: string;
  };
  price: {
    id: string;
    unitAmount: number;
    currency: string;
    interval: string;
  };
}

interface SubscriptionResponse {
  subscription: Subscription | null;
  status: string;
}

async function fetchSubscription(
  type: 'user' | 'organization',
  organizationId?: string
): Promise<SubscriptionResponse> {
  const params = new URLSearchParams({ type });
  if (organizationId) params.set('organizationId', organizationId);
  return apiJson<SubscriptionResponse>(
    `/api/v1/billing/subscription?${params}`,
    {},
    'Failed to fetch subscription'
  );
}

export const subscriptionQueryKey = (type: 'user' | 'organization', organizationId?: string) =>
  ['subscription', type, organizationId ?? 'self'] as const;

export function useSubscription(options?: {
  type?: 'user' | 'organization';
  organizationId?: string;
  enabled?: boolean;
}) {
  const type = options?.type ?? 'user';
  const organizationId = options?.organizationId;

  const query = useQuery({
    queryKey: subscriptionQueryKey(type, organizationId),
    queryFn: () => fetchSubscription(type, organizationId),
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    enabled: options?.enabled ?? true,
  });

  const subscription = query.data?.subscription ?? null;
  const planId: PlanId = subscription?.planId ?? 'free';
  const plan: Plan = plans.find((p) => p.id === planId) ?? plans[0];
  const isActive = subscription?.status === 'active' || subscription?.status === 'trialing';

  return {
    ...query,
    subscription,
    planId,
    plan,
    isActive,
    isTrialing: subscription?.status === 'trialing',
    isCanceling: subscription?.cancelAtPeriodEnd ?? false,
  };
}
