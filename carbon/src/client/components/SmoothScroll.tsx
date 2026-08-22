import Lenis from 'lenis';
import { useEffect, useRef } from 'react';

export function SmoothScroll({ children }: { children: React.ReactNode }) {
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    // Respect reduced-motion: skip smooth-scroll hijacking entirely for users
    // who ask for less motion (WCAG 2.2.2). Nothing to clean up in that case.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const lenis = new Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - 2 ** (-10 * t)),
      smoothWheel: true,
      touchMultiplier: 2,
    });
    lenisRef.current = lenis;

    // Guard + cancel the rAF loop on unmount. Without this the recursive raf
    // re-schedules forever and keeps calling lenis.raf() on a destroyed
    // instance after cleanup (a real leak, worse under StrictMode double-mount).
    let rafId = 0;
    let cancelled = false;
    function raf(time: number) {
      if (cancelled) return;
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    }
    rafId = requestAnimationFrame(raf);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisRef.current = null;
    };
  }, []);

  // Listen for theme scroll settings changes and mutate Lenis options at runtime
  useEffect(() => {
    const handler = (e: Event) => {
      const { enabled, intensity } = (e as CustomEvent).detail;
      const lenis = lenisRef.current;
      if (!lenis) return;

      lenis.options.smoothWheel = enabled;
      lenis.options.duration = (intensity / 100) * 2.0;
    };

    document.addEventListener('theme:scroll-settings', handler);
    return () => document.removeEventListener('theme:scroll-settings', handler);
  }, []);

  return <>{children}</>;
}
