import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import en from '@/locales/en.json';

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
  // @ts-expect-error: minimal test stub, not a spec-complete implementation
  globalThis.IntersectionObserver = IntersectionObserverStub;
});

// GrowthSection is static: three deploy modes, no price, no checkout. The
// only runtime input is docs visibility, which picks the CTA target. Mocked
// rather than provided via a real QueryClient so the test stays hermetic.
async function renderSection(userDocsEnabled: boolean) {
  vi.resetModules();
  vi.doMock('@/hooks/api', () => ({
    useDocsVisibility: () => ({ userDocsEnabled, apiDocsEnabled: true, isLoading: false }),
  }));
  const { GrowthSection } = await import('@/components/GrowthSection');
  return render(
    <MemoryRouter>
      <GrowthSection />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.doUnmock('@/hooks/api');
  vi.resetModules();
});

describe('<GrowthSection />', () => {
  it('renders the three modes with their deploy mode as the secondary line', async () => {
    await renderSection(true);

    const { launch, supercharge, fortify } = en.landing.growth;
    for (const mode of [launch, supercharge, fortify]) {
      expect(screen.getByRole('heading', { name: mode.name })).toBeInTheDocument();
      expect(screen.getByText(mode.mode)).toBeInTheDocument();
      expect(screen.getByText(mode.tagline)).toBeInTheDocument();
    }
  });

  it('anchors the section at #grow', async () => {
    const { container } = await renderSection(true);

    expect(container.querySelector('section#grow')).not.toBeNull();
    expect(container.querySelector('section#pricing')).toBeNull();
  });

  it('shows no price, unit, popular label or checkout control', async () => {
    const { container } = await renderSection(true);

    expect(container.textContent ?? '').not.toMatch(/\$\d|free|forever|popular|per month/i);
    // The only control is the CTA, a link (Button renders it with role=button).
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button')).toHaveAttribute('href');
  });

  it('sends the CTA to the getting-started guide when user docs are on', async () => {
    await renderSection(true);

    expect(screen.getByRole('button', { name: en.landing.growth.launch.cta })).toHaveAttribute(
      'href',
      '/docs/getting-started'
    );
  });

  it('falls back to signup when user docs are off', async () => {
    await renderSection(false);

    expect(screen.getByRole('button', { name: en.landing.growth.launch.cta })).toHaveAttribute(
      'href',
      '/signup'
    );
  });
});
