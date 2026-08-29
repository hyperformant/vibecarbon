import { motion, useScroll, useTransform } from 'framer-motion';
import { type ReactNode, useRef } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Wordmark } from './Logo';

interface CTAFooterProps {
  /** Gradient + glow classes for the footer background */
  gradient?: string;
  /** CTA content rendered above the footer links */
  children: ReactNode;
  /** Footer link elements */
  footerLinks: ReactNode;
  /**
   * 'row' (default): wordmark + links on one line — right for a handful of
   * links. 'columns': footerLinks renders as a full-width block (link
   * columns), with the wordmark and bottomRow on a separate baseline below.
   */
  layout?: 'row' | 'columns';
  /** Extra content on the baseline row (columns layout only). */
  bottomRow?: ReactNode;
}

export function CTAFooter({
  gradient = 'bg-gradient-to-br from-primary via-primary/80 to-primary/60',
  children,
  footerLinks,
  layout = 'row',
  bottomRow,
}: CTAFooterProps) {
  const ref = useRef<HTMLElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'end end'],
  });

  const opacity = useTransform(scrollYProgress, [0, 1], [0, 1]);
  const y = useTransform(scrollYProgress, [0, 1], [60, 0]);

  return (
    <footer ref={ref} className="relative">
      {/* Background layer — fades/slides in as the footer scrolls into view. */}
      <motion.div
        style={{ opacity, y: prefersReducedMotion ? 0 : y }}
        className={`absolute inset-0 ${gradient}`}
      />

      {/* CTA */}
      <div className="relative mx-auto max-w-2xl px-6 pt-20 pb-16 text-center md:pt-28 md:pb-20">
        {children}
      </div>

      {/* Footer */}
      {layout === 'columns' ? (
        <div className="relative mx-auto max-w-7xl px-6 pt-4 pb-10">
          {footerLinks}
          <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 sm:flex-row">
            <Wordmark size="sm" forceTheme="dark" />
            {bottomRow}
          </div>
        </div>
      ) : (
        <div className="relative mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
          <Wordmark size="sm" forceTheme="dark" />
          {footerLinks}
        </div>
      )}
    </footer>
  );
}
