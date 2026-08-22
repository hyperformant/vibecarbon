import type { PlanId } from '@shared/pricing';
import type { ReactNode } from 'react';
import { useSubscription } from '@/hooks/api';

const planHierarchy: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  pro: 2,
};

interface PlanGateProps {
  plan: PlanId;
  children: ReactNode;
  fallback?: ReactNode;
}

/**
 * Gate content behind a minimum plan requirement.
 *
 * Usage:
 *   <PlanGate plan="pro">
 *     <SecretFeature />
 *   </PlanGate>
 *
 *   <PlanGate plan="starter" fallback={<UpgradePrompt />}>
 *     <PaidFeature />
 *   </PlanGate>
 */
export function PlanGate({ plan, children, fallback = null }: PlanGateProps) {
  const { planId, isActive } = useSubscription();

  const hasAccess = isActive ? planHierarchy[planId] >= planHierarchy[plan] : plan === 'free';

  if (!hasAccess) return <>{fallback}</>;
  return <>{children}</>;
}
