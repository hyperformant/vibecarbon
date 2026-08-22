import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import type { CatalogTier } from '@shared/billing-catalog.types';

// jsdom has no IntersectionObserver; framer-motion's `whileInView` needs one
// to mount without throwing. A no-op stub is enough for rendering assertions.
beforeAll(() => {
  class IntersectionObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // @ts-expect-error — minimal test stub, not a spec-complete implementation
  globalThis.IntersectionObserver = IntersectionObserverStub;
});

// PricingSection renders bespoke Graphite/Fullerene/Agency cards, or overlays
// that same design onto the operator's activated Stripe catalog when one is
// configured (`vibecarbon configure` -> Payments). Agency is a contact-only
// tier with no purchasable Stripe product, so it must survive both paths.

function tier(overrides: Partial<CatalogTier>): CatalogTier {
  return {
    priceId: 'price_test',
    name: 'Fullerene',
    description: null,
    features: [],
    amount: 14900,
    currency: 'usd',
    interval: 'one_time',
    type: 'one_time',
    ...overrides,
  };
}

async function renderWithCatalog(catalogTiers: CatalogTier[]) {
  vi.resetModules();
  vi.doMock('@shared/pricing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@shared/pricing')>()),
    catalogTiers,
  }));
  // PricingSection imports @/lib/api (checkout CTA), whose real module pulls
  // in @/lib/supabase — which throws at load without VITE_SUPABASE_* env
  // (hermetic CI has none). Mock the api seam so the chain never loads.
  vi.doMock('@/lib/api', () => ({
    ApiError: class ApiError extends Error {},
    apiJson: vi.fn(async () => ({ url: 'https://checkout.test/session' })),
  }));
  // PricingSection reads docs visibility to pick the free tier's CTA target.
  // Mocked rather than provided via a real QueryClient so the test stays
  // hermetic — the default (docs on) is what these catalog assertions expect.
  vi.doMock('@/hooks/api', () => ({
    useDocsVisibility: () => ({ userDocsEnabled: true, apiDocsEnabled: true, isLoading: false }),
  }));
  const { PricingSection } = await import('@/components/PricingSection');
  return render(
    <MemoryRouter>
      <PricingSection />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.doUnmock('@shared/pricing');
  vi.doUnmock('@/lib/api');
  vi.doUnmock('@/hooks/api');
  vi.resetModules();
});

describe('<PricingSection /> catalog mode', () => {
  it('appends the Agency contact card when the catalog has no Agency product', async () => {
    await renderWithCatalog([tier({ priceId: 'price_fullerene', name: 'Fullerene' })]);

    expect(screen.getByText('Agency')).toBeInTheDocument();
    expect(screen.getByText('Contact us')).toBeInTheDocument();
  });

  it('renders "Contact us" (not "Free") when a $0 Agency placeholder product is activated', async () => {
    await renderWithCatalog([
      tier({ priceId: 'price_fullerene', name: 'Fullerene', amount: 14900 }),
      tier({ priceId: 'price_agency', name: 'Agency', amount: 0 }),
    ]);

    // Exactly one Agency card — the catalog product must not cause a duplicate
    // alongside the always-appended static one.
    expect(screen.getAllByText('Agency')).toHaveLength(1);
    expect(screen.getByText('Contact us')).toBeInTheDocument();
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
  });
});
