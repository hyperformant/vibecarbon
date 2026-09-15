import { render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import '@/lib/i18n';
import en from '@/locales/en.json';
import { FAQSection } from '@/components/FAQSection';

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

afterEach(() => {
  // FAQSection uses AccordionItem's `value={faq.question}`: a duplicate
  // question string across renders would collide, so nothing to clean up
  // beyond RTL's own auto-cleanup (setup-rtl.ts) between tests.
});

describe('<FAQSection />', () => {
  it('renders every question in locales/en.json landing.faq, q10 included (I6 regression)', () => {
    render(<FAQSection />);

    const faqKeys = Object.keys(en.landing.faq).filter((k) => k.startsWith('q'));
    // Guards the guard: if this ever drops back to 9, the assertion below
    // would vacuously pass on a component that dropped q10 right along with
    // the locale entry disappearing, so pin the count from the fixture too.
    expect(faqKeys.length).toBeGreaterThanOrEqual(10);

    for (const key of faqKeys) {
      const { question } = (en.landing.faq as Record<string, { question: string; answer: string }>)[
        key
      ];
      expect(screen.getByText(question)).toBeInTheDocument();
    }
  });

  it('renders exactly one accordion item per FAQ entry (no silent truncation)', () => {
    render(<FAQSection />);

    const faqKeys = Object.keys(en.landing.faq).filter((k) => k.startsWith('q'));
    expect(screen.getAllByRole('button')).toHaveLength(faqKeys.length);
  });
});
