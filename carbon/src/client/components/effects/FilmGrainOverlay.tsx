import { useTheme } from 'next-themes';
import { useReducedMotion } from '../../hooks/useReducedMotion';

interface FilmGrainOverlayProps {
  opacity?: number;
  animated?: boolean;
}

/**
 * Film grain overlay for anodized metal/industrial feel
 * Uses SVG noise filter for subtle texture
 * Dark mode only — grain reads as dirt on light surfaces
 */
export function FilmGrainOverlay({ opacity = 0.03, animated = false }: FilmGrainOverlayProps) {
  const prefersReducedMotion = useReducedMotion();
  const { resolvedTheme } = useTheme();
  const shouldAnimate = animated && !prefersReducedMotion;

  if (resolvedTheme !== 'dark') return null;

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[9999]"
      style={{ mixBlendMode: 'overlay' }}
      aria-hidden="true"
    >
      <svg className="w-full h-full" style={{ opacity }} aria-hidden="true">
        <filter id="film-grain-filter">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" stitchTiles="stitch">
            {shouldAnimate && (
              <animate attributeName="seed" from="0" to="100" dur="1s" repeatCount="indefinite" />
            )}
          </feTurbulence>
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#film-grain-filter)" />
      </svg>
    </div>
  );
}
