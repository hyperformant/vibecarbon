import { type ReactNode, useEffect } from 'react';

import { cn } from '@/lib/utils';
import { SparkBurst, useSparkTrigger } from './effects/SparkBurst';

interface ShimmerBadgeProps {
  children: ReactNode;
  className?: string;
}

/**
 * Prominent gradient-shimmer eyebrow pill: an animated violet -> fuchsia ->
 * amber gradient rim over a dark interior, a shimmer sweep, a fuchsia spark
 * burst, and gradient-clipped text. Shared by the landing hero and the
 * marketing homepage. Sparks fire on mount, every 10s, and on hover.
 */
export function ShimmerBadge({ children, className }: ShimmerBadgeProps) {
  const [sparkTrigger, fireSpark] = useSparkTrigger();

  // Re-fire pill sparks every 10 seconds
  useEffect(() => {
    const interval = setInterval(fireSpark, 10000);
    return () => clearInterval(interval);
  }, [fireSpark]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: decorative hover spark effect
    <span
      className={cn(
        'group relative overflow-visible rounded-full px-4 py-1.5 text-sm font-medium',
        className
      )}
      onMouseEnter={fireSpark}
    >
      {/* Animated gradient border */}
      <span className="absolute inset-0 rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-400 via-amber-300 to-violet-500 badge-shimmer" />
      {/* Inner fill */}
      <span className="absolute inset-[1.5px] rounded-full bg-gradient-to-r from-violet-950/90 via-fuchsia-950/80 to-violet-950/90 dark:from-violet-950/90 dark:via-fuchsia-950/80 dark:to-violet-950/90" />
      {/* Shimmer highlight overlay */}
      <span className="absolute inset-[1.5px] rounded-full bg-gradient-to-r from-transparent via-white/10 to-transparent badge-shimmer opacity-60" />
      {/* Spark burst: fires on mount, every 10s, and on hover */}
      <SparkBurst delay={1.1} palette="fuchsia" trigger={sparkTrigger} />
      {/* Text content */}
      <span className="relative z-10 bg-gradient-to-r from-violet-400 via-fuchsia-300 to-amber-300 bg-clip-text text-transparent dark:from-violet-300 dark:via-fuchsia-200 dark:to-amber-200">
        {children}
      </span>
    </span>
  );
}
