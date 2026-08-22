/**
 * Component tests for PlanGate — the client half of the plan-gating feature
 * (the server half, requirePlan middleware, is covered from the root repo's
 * template suite). No template page uses it — it exists for template users —
 * so this test is also what keeps it from registering as dead code.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlanGate } from '@/components/PlanGate';

const useSubscriptionMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/api', () => ({ useSubscription: useSubscriptionMock }));

function stubPlan(planId: 'free' | 'starter' | 'pro', isActive: boolean) {
  useSubscriptionMock.mockReturnValue({ planId, isActive });
}

describe('PlanGate', () => {
  it('renders children when the active plan meets the requirement', () => {
    stubPlan('pro', true);
    render(
      <PlanGate plan="starter">
        <span>secret feature</span>
      </PlanGate>
    );
    expect(screen.getByText('secret feature')).toBeDefined();
  });

  it('renders the fallback when the active plan is below the requirement', () => {
    stubPlan('starter', true);
    render(
      <PlanGate plan="pro" fallback={<span>upgrade prompt</span>}>
        <span>secret feature</span>
      </PlanGate>
    );
    expect(screen.queryByText('secret feature')).toBeNull();
    expect(screen.getByText('upgrade prompt')).toBeDefined();
  });

  it('renders nothing (null fallback) when gated with no fallback provided', () => {
    stubPlan('free', true);
    const { container } = render(
      <PlanGate plan="pro">
        <span>secret feature</span>
      </PlanGate>
    );
    expect(container.textContent).toBe('');
  });

  it('treats an inactive subscription as free tier: gates paid, allows free', () => {
    stubPlan('pro', false); // stale plan id, subscription lapsed
    render(
      <PlanGate plan="pro" fallback={<span>gated</span>}>
        <span>paid</span>
      </PlanGate>
    );
    expect(screen.getByText('gated')).toBeDefined();

    stubPlan('pro', false);
    render(
      <PlanGate plan="free">
        <span>free content</span>
      </PlanGate>
    );
    expect(screen.getByText('free content')).toBeDefined();
  });
});
