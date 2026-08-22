import { cn } from '../../lib/utils';

interface FresnelEdgeProps {
  children: React.ReactNode;
  className?: string;
  edgeColor?: string;
  glowStrength?: number;
}

/**
 * Fresnel edge effect - glowing 1px edges on glass objects
 * Creates the "light catching" effect seen on premium glass surfaces
 */
export function FresnelEdge({
  children,
  className,
  edgeColor = 'rgba(255, 255, 255, 0.15)',
  glowStrength = 0.5,
}: FresnelEdgeProps) {
  return (
    <div className={cn('relative', className)}>
      {/* Main content */}
      {children}

      {/* Fresnel edge - top/left lighter (light source from top-left) */}
      <div
        className="absolute inset-0 pointer-events-none rounded-inherit"
        style={{
          boxShadow: `
            inset 1px 1px 0 ${edgeColor},
            inset -1px -1px 0 rgba(0,0,0,0.1),
            0 0 ${20 * glowStrength}px ${edgeColor}
          `,
          borderRadius: 'inherit',
        }}
        aria-hidden="true"
      />

      {/* Top edge highlight */}
      <div
        className="absolute top-0 left-[10%] right-[10%] h-[1px] pointer-events-none"
        style={{
          background: `linear-gradient(90deg, transparent, ${edgeColor}, transparent)`,
        }}
        aria-hidden="true"
      />
    </div>
  );
}
