import { type MotionValue, useScroll, useTransform } from 'framer-motion';
import { useRef } from 'react';

interface ScrollProgress {
  scrollY: MotionValue<number>;
  scrollYProgress: MotionValue<number>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Track overall page scroll progress
 */
export function useScrollProgress(): ScrollProgress {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollY, scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  return { scrollY, scrollYProgress, containerRef };
}

interface SectionProgress {
  scrollYProgress: MotionValue<number>;
  centeredProgress: MotionValue<number>;
  blur: MotionValue<number>;
  scale: MotionValue<number>;
  opacity: MotionValue<number>;
}

/**
 * Track scroll progress for individual sections with depth-of-field transforms
 * centeredProgress: -1 (above viewport) -> 0 (centered) -> 1 (below viewport)
 */
export function useSectionProgress(
  sectionRef: React.RefObject<HTMLElement | null>
): SectionProgress {
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start end', 'end start'],
  });

  // Transform to -1 (above viewport) -> 0 (centered) -> 1 (below viewport)
  const centeredProgress = useTransform(scrollYProgress, [0, 0.5, 1], [-1, 0, 1]);

  // Minimal blur effect - just a subtle hint of focus
  const blur = useTransform(scrollYProgress, [0, 0.3, 0.5, 0.7, 1], [0, 0, 0, 0, 0]);

  // No scale effect - keep sections stable
  const scale = useTransform(scrollYProgress, [0, 0.5, 1], [1, 1, 1]);

  // Subtle opacity for edge sections only
  const opacity = useTransform(scrollYProgress, [0, 0.15, 0.5, 0.85, 1], [0.7, 1, 1, 1, 0.7]);

  return { scrollYProgress, centeredProgress, blur, scale, opacity };
}
