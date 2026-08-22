/**
 * SmoothScroll lifecycle: the recursive requestAnimationFrame loop must be
 * cancelled on unmount (it previously re-scheduled forever, calling lenis.raf()
 * on a destroyed instance), and Lenis must not initialize under reduced-motion.
 */

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const destroy = vi.fn();
const lenisRaf = vi.fn();
const construct = vi.fn();

vi.mock('lenis', () => ({
  default: class {
    options = {};
    constructor(opts: unknown) {
      construct(opts);
    }
    raf(t: number) {
      lenisRaf(t);
    }
    destroy() {
      destroy();
    }
  },
}));

import { SmoothScroll } from '@/components/SmoothScroll';

function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
}

describe('SmoothScroll', () => {
  beforeEach(() => {
    construct.mockClear();
    destroy.mockClear();
    lenisRaf.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('cancels the rAF loop and destroys Lenis on unmount', () => {
    setReducedMotion(false);
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');

    const { unmount } = render(<SmoothScroll>hi</SmoothScroll>);
    expect(construct).toHaveBeenCalledTimes(1);

    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('does not initialize Lenis under reduced-motion', () => {
    setReducedMotion(true);
    const { unmount } = render(<SmoothScroll>hi</SmoothScroll>);
    expect(construct).not.toHaveBeenCalled();
    unmount();
    expect(destroy).not.toHaveBeenCalled();
  });
});
