import { motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type SparkPalette = 'primary' | 'fuchsia';

const palettes: Record<SparkPalette, string[]> = {
  primary: [
    'bg-primary',
    'bg-primary/80',
    'bg-secondary-accent',
    'bg-secondary-accent/80',
    'bg-primary/60',
    'bg-secondary-accent/60',
  ],
  fuchsia: [
    'bg-violet-400',
    'bg-fuchsia-400',
    'bg-violet-300',
    'bg-fuchsia-300',
    'bg-purple-400',
    'bg-pink-400',
  ],
};

interface SparkBurstProps {
  /** Delay before sparks fire (seconds) */
  delay?: number;
  /** Number of particles */
  count?: number;
  /** Color palette */
  palette?: SparkPalette;
  /** Change this value to re-trigger the burst */
  trigger?: number;
}

function generateParticles(rx: number, ry: number, count: number, colors: string[]) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * 360 + (Math.random() * 20 - 10);
    const rad = (angle * Math.PI) / 180;
    const startX = Math.cos(rad) * rx;
    const startY = Math.sin(rad) * ry;
    const outX = Math.cos(rad);
    const outY = Math.sin(rad);
    const swirlDir = Math.random() > 0.5 ? 1 : -1;
    const tangX = -outY * swirlDir;
    const tangY = outX * swirlDir;
    const dist = 20 + Math.random() * 25;
    const swirlAmount = 12 + Math.random() * 16;
    const midX = startX + outX * dist * 0.3 + tangX * swirlAmount;
    const midY = startY + outY * dist * 0.3 + tangY * swirlAmount;
    const endX = startX + outX * dist + tangX * swirlAmount * 0.5;
    const endY = startY + outY * dist + tangY * swirlAmount * 0.5;
    const size = 1.5 + Math.random() * 2;
    return {
      id: `${i}-${Math.random().toString(36).slice(2, 8)}`,
      startX,
      startY,
      midX,
      midY,
      endX,
      endY,
      size,
      color: colors[i % colors.length],
      delay: Math.random() * 0.2,
      duration: 0.5 + Math.random() * 0.4,
    };
  });
}

/**
 * Ember sparks that swirl outward from the parent element's border.
 * Parent must be `position: relative` and `overflow: visible`.
 *
 * Fires on mount, and re-fires whenever `trigger` changes.
 */
export function SparkBurst({
  delay = 0.3,
  count = 12,
  palette = 'primary',
  trigger = 0,
}: SparkBurstProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [dimensions, setDimensions] = useState<{ rx: number; ry: number } | null>(null);
  const [playing, setPlaying] = useState(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on trigger to handle late mounts
  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    setDimensions({ rx: el.offsetWidth / 2, ry: el.offsetHeight / 2 });
    setPlaying(true);
  }, [trigger]);

  const colors = palettes[palette];

  // Regenerate particles whenever trigger changes (or on first render with dimensions).
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger forces particle regeneration on hover
  const particles = useMemo(() => {
    if (!dimensions) return [];
    return generateParticles(dimensions.rx, dimensions.ry, count, colors);
  }, [dimensions, count, colors, trigger]);

  // Unmount the particles once the burst has finished. Finished motion.spans
  // otherwise stay composited (zero-opacity, transformed) over the parent's
  // label forever, and stale layers over text produce rendering artifacts on
  // some fullscreen / fractional-scale display setups.
  useEffect(() => {
    if (!playing || particles.length === 0) return;
    const lastEnd = delay + Math.max(...particles.map((p) => p.delay + p.duration));
    const timeout = setTimeout(() => setPlaying(false), lastEnd * 1000 + 100);
    return () => clearTimeout(timeout);
  }, [playing, particles, delay]);

  if (!dimensions || !playing) {
    return <span ref={containerRef} className="absolute inset-0 pointer-events-none" />;
  }

  return (
    <span ref={containerRef} className="absolute inset-0 pointer-events-none z-20">
      {particles.map((p) => (
        <motion.span
          key={p.id}
          className={`absolute rounded-full ${p.color}`}
          style={{
            width: p.size,
            height: p.size,
            left: '50%',
            top: '50%',
            marginLeft: -p.size / 2,
            marginTop: -p.size / 2,
          }}
          initial={{ opacity: 0, x: p.startX, y: p.startY, scale: 1 }}
          animate={{
            opacity: [0, 1, 0.8, 0],
            x: [p.startX, p.startX, p.midX, p.endX],
            y: [p.startY, p.startY, p.midY, p.endY],
            scale: [0, 1, 0.8, 0],
          }}
          transition={{
            duration: p.duration,
            delay: delay + p.delay,
            ease: 'easeOut',
            times: [0, 0.01, 0.4, 1],
          }}
        />
      ))}
    </span>
  );
}

/**
 * Hook that returns [trigger, fire] for imperatively re-triggering a SparkBurst.
 */
export function useSparkTrigger() {
  const [trigger, setTrigger] = useState(0);
  const fire = useCallback(() => setTrigger((t) => t + 1), []);
  return [trigger, fire] as const;
}
