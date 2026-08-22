import {
  IconCloud as Cloud,
  IconContainer as Container,
  IconDatabase as Database,
  IconWorld as Globe,
  IconDeviceSdCard as HardDrive,
  IconKey as Key,
  IconStack2 as Layers,
  IconRadio as Radio,
  IconServer as Server,
  IconBolt as Zap,
} from '@tabler/icons-react';
import { motion } from 'framer-motion';
import { FresnelEdge } from '../effects/FresnelEdge';
import { GlowTracker } from '../effects/GlowTracker';

/* ------------------------------------------------------------------ */
/*  Layer data                                                         */
/* ------------------------------------------------------------------ */

interface TechItem {
  icon: React.ComponentType<{ className?: string; stroke?: number }>;
  label: string;
  accent: 'teal' | 'magenta';
}

interface LayerConfig {
  id: string;
  title: string;
  /** Tailwind max-width class — drives the pyramid shape */
  maxWidth: string;
  borderColor: string;
  glowShadow: string;
  /** Framer Motion entrance delay (bottom-up stagger) */
  delay: number;
  /** Framer Motion entrance y offset */
  yOffset: number;
  accent: 'teal' | 'magenta';
  items: TechItem[];
  /** Optional second row of items (Supabase uses a 2×2 + banner layout) */
  itemsRow2?: TechItem[];
  /** Full-width banner item (PostgreSQL) */
  banner?: TechItem;
  /** Show divider between items (Backend layer) */
  divider?: boolean;
  /** Show dot-grid background (Infrastructure layer) */
  dotGrid?: boolean;
}

const LAYERS: LayerConfig[] = [
  {
    id: 'frontend',
    title: 'FRONTEND',
    maxWidth: 'max-w-md',
    borderColor: 'border-primary/20',
    glowShadow: '0 8px 32px oklch(0.82 0.14 192 / 0.15)',
    delay: 0.55,
    yOffset: 10,
    accent: 'teal',
    items: [
      { icon: Zap, label: 'React 19', accent: 'teal' },
      { icon: Globe, label: 'Vite', accent: 'teal' },
      { icon: Layers, label: 'Shadcn UI', accent: 'teal' },
    ],
  },
  {
    id: 'backend',
    title: 'BACKEND',
    maxWidth: 'max-w-lg',
    borderColor: 'border-primary/20',
    glowShadow: '0 8px 24px oklch(0.82 0.14 192 / 0.10)',
    delay: 0.4,
    yOffset: 20,
    accent: 'teal',
    divider: true,
    items: [
      { icon: Globe, label: 'Traefik', accent: 'teal' },
      { icon: Server, label: 'Hono API', accent: 'teal' },
    ],
  },
  {
    id: 'supabase',
    title: 'SUPABASE',
    maxWidth: 'max-w-xl',
    borderColor: 'border-primary/20',
    glowShadow: '0 8px 28px oklch(0.75 0.20 270 / 0.12)',
    delay: 0.25,
    yOffset: 30,
    accent: 'teal',
    items: [
      { icon: Key, label: 'Auth', accent: 'teal' },
      { icon: Globe, label: 'REST API', accent: 'teal' },
    ],
    itemsRow2: [
      { icon: Radio, label: 'Realtime', accent: 'teal' },
      { icon: HardDrive, label: 'Storage', accent: 'teal' },
    ],
    banner: { icon: Database, label: 'PostgreSQL + RLS', accent: 'teal' },
  },
  {
    id: 'infrastructure',
    title: 'INFRASTRUCTURE',
    maxWidth: 'max-w-2xl',
    borderColor: 'border-secondary-accent/20',
    glowShadow: '0 8px 32px oklch(0.65 0.26 350 / 0.12)',
    delay: 0.1,
    yOffset: 40,
    accent: 'magenta',
    dotGrid: true,
    items: [
      { icon: Container, label: 'Docker', accent: 'teal' },
      { icon: Layers, label: 'Kubernetes', accent: 'teal' },
      { icon: HardDrive, label: 'S3 Storage', accent: 'magenta' },
      { icon: Cloud, label: 'Hetzner', accent: 'magenta' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  TechChip                                                           */
/* ------------------------------------------------------------------ */

function TechChip({ icon: Icon, label, accent }: TechItem) {
  const styles = {
    teal: {
      bg: 'bg-primary/10',
      icon: 'text-primary',
      border: 'border-primary/20',
      hoverGlow: '0 0 12px oklch(0.82 0.14 192 / 0.35)',
    },
    magenta: {
      bg: 'bg-secondary-accent/10',
      icon: 'text-secondary-accent',
      border: 'border-secondary-accent/20',
      hoverGlow: '0 0 12px oklch(0.65 0.26 350 / 0.35)',
    },
  }[accent];

  return (
    <motion.div
      whileHover={{ scale: 1.05 }}
      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
      className={`
        flex items-center gap-2 rounded-lg border px-3 py-2
        bg-gradient-to-br from-black/[0.03] dark:from-white/5 to-transparent
        transition-shadow duration-200
        ${styles.border}
      `}
      style={{ '--chip-glow': styles.hoverGlow } as React.CSSProperties}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = styles.hoverGlow;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = 'none';
      }}
    >
      <div className={`${styles.bg} rounded p-1.5`}>
        <Icon className={`size-4 ${styles.icon}`} stroke={1.5} />
      </div>
      <span className="font-medium text-foreground text-xs sm:text-sm">{label}</span>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  TechBanner — full-width item (PostgreSQL)                         */
/* ------------------------------------------------------------------ */

function TechBanner({ icon: Icon, label, accent }: TechItem) {
  const isTeal = accent === 'teal';
  return (
    <div
      className={`
        flex items-center justify-center gap-2 rounded-lg border px-4 py-2
        bg-gradient-to-r
        ${isTeal ? 'from-primary/10 via-primary/5 to-primary/10 border-primary/25' : 'from-secondary-accent/10 via-secondary-accent/5 to-secondary-accent/10 border-secondary-accent/25'}
      `}
    >
      <Icon
        className={`size-4 ${isTeal ? 'text-primary' : 'text-secondary-accent'}`}
        stroke={1.5}
      />
      <span className="font-semibold text-foreground text-xs sm:text-sm">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  FlowConnector — animated pulse between layers                     */
/* ------------------------------------------------------------------ */

function FlowConnector({ delay }: { delay: number }) {
  return (
    <motion.div
      className="flex flex-col items-center h-8 md:h-10"
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, amount: 0.5 }}
      transition={{ delay: delay + 0.15, duration: 0.4 }}
    >
      {/* Animated gradient line */}
      <div className="relative w-0.5 flex-1 overflow-hidden rounded-full">
        <div
          className="absolute inset-0 motion-safe:animate-[flowPulse_2s_ease-in-out_infinite]"
          style={{
            backgroundImage:
              'linear-gradient(to bottom, transparent 0%, oklch(0.82 0.14 192 / 0.6) 40%, oklch(0.82 0.14 192 / 0.8) 50%, oklch(0.82 0.14 192 / 0.6) 60%, transparent 100%)',
            backgroundSize: '100% 300%',
          }}
        />
        {/* Static fallback for reduced motion */}
        <div className="absolute inset-0 motion-reduce:block hidden bg-gradient-to-b from-border/40 via-border/60 to-border/40" />
      </div>
      {/* Glowing midpoint dot */}
      <div className="relative shrink-0 my-0.5">
        <div className="size-1.5 rounded-full bg-primary/70" />
        <div className="absolute inset-0 size-1.5 rounded-full bg-primary/40 motion-safe:animate-ping" />
      </div>
      <div className="relative w-0.5 flex-1 overflow-hidden rounded-full">
        <div
          className="absolute inset-0 motion-safe:animate-[flowPulse_2s_ease-in-out_infinite]"
          style={{
            backgroundImage:
              'linear-gradient(to bottom, transparent 0%, oklch(0.82 0.14 192 / 0.6) 40%, oklch(0.82 0.14 192 / 0.8) 50%, oklch(0.82 0.14 192 / 0.6) 60%, transparent 100%)',
            backgroundSize: '100% 300%',
            animationDelay: '0.3s',
          }}
        />
        <div className="absolute inset-0 motion-reduce:block hidden bg-gradient-to-b from-border/40 via-border/60 to-border/40" />
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  MobileFlowBar — simplified connector for mobile                   */
/* ------------------------------------------------------------------ */

function MobileFlowBar() {
  return (
    <div className="flex justify-center h-4">
      <div
        className="w-4 h-full rounded-full"
        style={{
          background:
            'linear-gradient(to bottom, oklch(0.82 0.14 192 / 0.3), oklch(0.65 0.26 350 / 0.3))',
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  LayerPlatform                                                      */
/* ------------------------------------------------------------------ */

function LayerPlatform({ layer }: { layer: LayerConfig }) {
  const labelBg =
    layer.accent === 'teal'
      ? 'bg-primary/10 text-primary'
      : 'bg-secondary-accent/10 text-secondary-accent';

  const mobileBorderColor =
    layer.accent === 'teal' ? 'oklch(0.82 0.14 192 / 0.6)' : 'oklch(0.65 0.26 350 / 0.6)';

  return (
    <motion.div
      className={`w-full ${layer.maxWidth} mx-auto`}
      initial={{ y: layer.yOffset, opacity: 0 }}
      whileInView={{ y: 0, opacity: 1 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{
        delay: layer.delay,
        duration: 0.5,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
    >
      <FresnelEdge
        className="rounded-2xl"
        edgeColor={
          layer.accent === 'teal' ? 'oklch(0.82 0.14 192 / 0.12)' : 'oklch(0.65 0.26 350 / 0.12)'
        }
        glowStrength={0.3}
      >
        <motion.div
          className={`
            relative rounded-2xl border backdrop-blur-xl
            bg-gradient-to-br from-white/[0.06] to-transparent
            ${layer.borderColor}
          `}
          style={{ boxShadow: layer.glowShadow }}
          whileHover={{ y: -2 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        >
          {/* Thick left accent border on mobile only */}
          <div
            className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl md:hidden"
            style={{ backgroundColor: mobileBorderColor }}
            aria-hidden="true"
          />
          <GlowTracker />

          {/* Dot grid background for infrastructure */}
          {layer.dotGrid && (
            <div
              className="absolute inset-0 overflow-hidden rounded-2xl pointer-events-none opacity-60"
              style={{
                backgroundImage:
                  'radial-gradient(circle, oklch(0.65 0.26 350 / 0.08) 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
              aria-hidden="true"
            />
          )}

          {/* Layer label badge */}
          <div
            className={`
              absolute -top-2.5 left-4 z-10 px-2 py-0.5 rounded text-[10px] font-mono font-semibold tracking-wider
              ${labelBg}
            `}
          >
            {layer.title}
          </div>

          {/* Content */}
          <div className="relative z-[1] px-4 py-5 sm:px-6">
            {/* Default layout: items in a row */}
            {!layer.divider && !layer.itemsRow2 && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                {layer.items.map((item) => (
                  <TechChip key={item.label} {...item} />
                ))}
              </div>
            )}

            {/* Backend layout: divider between items */}
            {layer.divider && (
              <div className="flex items-center justify-center gap-3">
                {layer.items.map((item, i) => (
                  <div key={item.label} className="flex items-center gap-3">
                    {i > 0 && (
                      <div className="hidden sm:block h-8 w-px bg-gradient-to-b from-transparent via-border/60 to-transparent" />
                    )}
                    <TechChip {...item} />
                  </div>
                ))}
              </div>
            )}

            {/* Supabase layout: 2×2 grid + banner */}
            {layer.itemsRow2 && (
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-2 gap-2">
                  {layer.items.map((item) => (
                    <TechChip key={item.label} {...item} />
                  ))}
                  {layer.itemsRow2.map((item) => (
                    <TechChip key={item.label} {...item} />
                  ))}
                </div>
                {layer.banner && <TechBanner {...layer.banner} />}
              </div>
            )}
          </div>
        </motion.div>
      </FresnelEdge>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  ArchitectureDiagram (exported)                                     */
/* ------------------------------------------------------------------ */

export function ArchitectureDiagram() {
  // Render order: bottom-up visually, but DOM order is top-down
  // (frontend first, infrastructure last)
  return (
    <>
      {/* Keyframe for flow pulse animation */}
      <style>{`
        @keyframes flowPulse {
          0% { background-position: 0 -100%; }
          100% { background-position: 0 200%; }
        }
      `}</style>

      <div className="relative w-full max-w-3xl mx-auto">
        <div className="flex flex-col gap-0">
          {LAYERS.map((layer, i) => (
            <div key={layer.id}>
              {/* Layer platform */}
              <LayerPlatform layer={layer} />

              {/* Flow connector (not after last layer) */}
              {i < LAYERS.length - 1 && (
                <>
                  <div className="hidden md:block">
                    <FlowConnector delay={layer.delay} />
                  </div>
                  <div className="md:hidden">
                    <MobileFlowBar />
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
