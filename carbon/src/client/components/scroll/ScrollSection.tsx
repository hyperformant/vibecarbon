import { motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useSectionProgress } from '../../hooks/useScrollProgress';
import { cn } from '../../lib/utils';
import { useScrollytelling } from './ScrollytellingProvider';

interface ScrollSectionProps {
  id: string;
  children: React.ReactNode;
  className?: string;
  disableEffects?: boolean;
}

/**
 * Scroll section with depth-of-field effects
 * Blurs when not in focus, sharpens when centered in viewport
 */
export function ScrollSection({
  id,
  children,
  className,
  disableEffects = false,
}: ScrollSectionProps) {
  const ref = useRef<HTMLElement>(null);
  const { activeSection, registerSection, unregisterSection } = useScrollytelling();
  const { blur, scale, opacity } = useSectionProgress(ref);
  const prefersReducedMotion = useReducedMotion();

  const isActive = activeSection === id;

  // Register section bounds on mount
  useEffect(() => {
    if (!ref.current) return;

    const updateBounds = () => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const scrollTop = window.scrollY;
      registerSection(id, rect.top + scrollTop, rect.bottom + scrollTop);
    };

    updateBounds();
    window.addEventListener('resize', updateBounds);

    return () => {
      window.removeEventListener('resize', updateBounds);
      unregisterSection(id);
    };
  }, [id, registerSection, unregisterSection]);

  // Skip effects for accessibility or when disabled
  if (prefersReducedMotion || disableEffects) {
    return (
      <section ref={ref} id={id} className={cn('relative', className)} data-active={isActive}>
        {children}
      </section>
    );
  }

  return (
    <motion.section
      ref={ref}
      id={id}
      style={{
        filter: `blur(${blur}px)`,
        scale,
        opacity,
      }}
      className={cn('relative will-change-transform', className)}
      data-active={isActive}
    >
      {children}
    </motion.section>
  );
}
