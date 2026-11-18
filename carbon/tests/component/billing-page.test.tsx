/**
 * The Billing settings page over a stubbed fetch.
 *
 * Subscription: Billing reads it through useSubscription, so it shares one
 * cache entry with every other reader (the Dashboard, PlanGate). It used to
 * keep its own query under a different key, so opening Billing fetched the
 * same subscription a second time.
 *
 * Not-configured notice: it names the environment variables of the active
 * billing provider, which /api/v1/billing/status reports as envVars, not
 * always Stripe's. The names come from the server: a client source spelling
 * POLAR's access token variable would trip the no-session-token invariant
 * in tests/structural/security-invariants.test.ts.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('@/components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'jane@example.com' } }),
}));

import { useSubscription } from '@/hooks/api';
import Billing from '@/pages/settings/Billing';

const fetchMock = vi.fn();

function answer(status: Record<string, unknown>, statusCode = 200) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/v1/billing/status') {
      return new Response(JSON.stringify(status), { status: statusCode });
    }
    if (url === '/api/v1/billing/prices') {
      return new Response(JSON.stringify({ configured: true, plans: [] }), { status: 200 });
    }
    if (url.startsWith('/api/v1/billing/subscription')) {
      return new Response(JSON.stringify({ subscription: null, status: 'none' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
}

const subscriptionCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/v1/billing/subscription'));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Another reader of the subscription, as the Dashboard and PlanGate are. */
function PlanProbe() {
  const { planId, isSuccess } = useSubscription();
  return <p>{isSuccess ? `plan:${planId}` : 'plan:loading'}</p>;
}

function renderBilling(withProbe = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      {withProbe && <PlanProbe />}
      <Billing />
    </QueryClientProvider>
  );
}

describe('Billing subscription', () => {
  it('shares one subscription request with the other useSubscription readers', async () => {
    answer({ configured: true, provider: 'stripe' });
    renderBilling(true);

    expect(await screen.findByText('plan:free')).toBeInTheDocument();
    expect(await screen.findByText('billing.choosePlan')).toBeInTheDocument();
    // Let any second, differently keyed request start before counting.
    await new Promise((r) => setTimeout(r, 50));

    expect(subscriptionCalls()).toHaveLength(1);
    expect(String(subscriptionCalls()[0][0])).toBe('/api/v1/billing/subscription?type=user');
  });
});

describe('Billing not-configured notice', () => {
  it.each([
    ['stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']],
    ['paddle', ['PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET']],
    ['polar', ['POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET']],
  ])('names the %s variables', async (provider, names) => {
    answer({ configured: false, provider, envVars: names });
    renderBilling();

    const notice = await screen.findByText(/Billing is not configured/);
    for (const name of names) expect(notice).toHaveTextContent(name);
    if (provider !== 'stripe') expect(notice).not.toHaveTextContent('STRIPE_');
  });

  it("falls back to Stripe's variables when the status read fails", async () => {
    answer({ error: 'down' }, 500);
    renderBilling();

    const notice = await screen.findByText(/Billing is not configured/);
    expect(notice).toHaveTextContent('STRIPE_SECRET_KEY');
  });
});
