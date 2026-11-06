import {
  IconAtom as Atom,
  IconHexagon as Hexagon,
  type TablerIcon as IconComponent,
  IconShieldCheck as Shield,
} from '@tabler/icons-react';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useDocsVisibility } from '@/hooks/api';
import { cn } from '@/lib/utils';
import logoIcon from '../assets/logo-icon.svg';
import { FresnelEdge } from './effects/FresnelEdge';
import { Button } from './ui/button';

/*
 * The three deploy modes as cards, in the visual language of the app's pricing
 * cards (icon, accent glow, Fresnel edge) with no price: the same app runs in
 * every mode, chosen per environment. A user's own plans live on /pricing.
 */

interface Mode {
  id: 'launch' | 'supercharge' | 'fortify';
  name: string;
  /** The deploy mode behind the benefit, shown as a secondary line. */
  mode: string;
  tagline: string;
  icon: IconComponent;
  accent: {
    icon: string;
    iconBox: string;
    bg: string;
    shadow: string;
    glow: string;
    edge: string;
    divider: string;
  };
  highlighted: boolean;
  delay: number;
}

export function GrowthSection() {
  const { t } = useTranslation();
  const { userDocsEnabled } = useDocsVisibility();

  // The CTA sends people to the getting-started guide. With user docs turned
  // off there is no guide to send them to, so the button falls back to signup
  // rather than pointing at a route that now 404s.
  const ctaHref = userDocsEnabled ? '/docs/getting-started' : '/signup';

  const modes: Mode[] = [
    {
      id: 'launch',
      name: t('landing.growth.launch.name'),
      mode: t('landing.growth.launch.mode'),
      tagline: t('landing.growth.launch.tagline'),
      icon: Hexagon,
      accent: {
        icon: 'text-muted-foreground',
        iconBox: 'border-border/50 bg-muted/50',
        bg: 'bg-muted/30 dark:bg-background/50',
        shadow: '',
        glow: 'oklch(0.7 0.02 250 / 0.06)',
        edge: 'rgba(255, 255, 255, 0.08)',
        divider: 'bg-border/50',
      },
      highlighted: false,
      delay: 0.1,
    },
    {
      id: 'supercharge',
      name: t('landing.growth.supercharge.name'),
      mode: t('landing.growth.supercharge.mode'),
      tagline: t('landing.growth.supercharge.tagline'),
      icon: Atom,
      accent: {
        icon: 'text-primary',
        iconBox: 'border-primary/20 bg-primary/10',
        bg: 'bg-primary/[0.03] dark:bg-primary/[0.05]',
        shadow: 'shadow-lg shadow-primary/10',
        glow: 'oklch(0.82 0.14 192 / 0.08)',
        edge: 'oklch(0.82 0.14 192 / 0.2)',
        divider: 'bg-gradient-to-r from-transparent via-primary/30 to-transparent',
      },
      highlighted: true,
      delay: 0.2,
    },
    {
      id: 'fortify',
      name: t('landing.growth.fortify.name'),
      mode: t('landing.growth.fortify.mode'),
      tagline: t('landing.growth.fortify.tagline'),
      icon: Shield,
      accent: {
        icon: 'text-secondary-accent',
        iconBox: 'border-secondary-accent/20 bg-secondary-accent/10',
        bg: 'bg-secondary-accent/[0.03] dark:bg-secondary-accent/[0.05]',
        shadow: 'shadow-lg shadow-secondary-accent/10',
        glow: 'oklch(0.65 0.26 350 / 0.06)',
        edge: 'oklch(0.65 0.26 350 / 0.15)',
        divider: 'bg-gradient-to-r from-transparent via-secondary-accent/20 to-transparent',
      },
      highlighted: false,
      delay: 0.3,
    },
  ];

  return (
    <section id="grow" className="py-24 md:py-36 overflow-hidden">
      <div className="mx-auto max-w-7xl px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.5 }}
          className="mx-auto mb-16 max-w-2xl text-center"
        >
          <motion.div
            className="flex justify-center mb-6"
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          >
            <img
              src={logoIcon}
              alt=""
              width={56}
              height={56}
              className="drop-shadow-[0_0_12px_oklch(0.82_0.14_192/0.6)]"
            />
          </motion.div>
          <h2 className="mb-4 text-3xl font-black tracking-tight md:text-5xl">
            {t('landing.growth.headline')}{' '}
            <span className="text-primary">{t('landing.growth.headlineHighlight')}</span>
          </h2>
          <p className="text-lg text-muted-foreground">{t('landing.growth.subheading')}</p>
        </motion.div>

        <div className="relative grid gap-8 lg:grid-cols-3">
          {modes.map((mode) => (
            <ModeCard key={mode.id} mode={mode} />
          ))}
        </div>

        <div className="mt-12 flex justify-center">
          <Button variant="exciting" size="lg" asChild>
            <Link to={ctaHref} className="inline-flex items-center gap-2">
              {t('landing.growth.launch.cta')}
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function ModeCard({ mode }: { mode: Mode }) {
  const Icon = mode.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      whileHover={{ scale: 1.02 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ type: 'spring', stiffness: 300, damping: 30, delay: mode.delay }}
      className="relative"
    >
      <FresnelEdge
        className="h-full rounded-2xl"
        edgeColor={mode.accent.edge}
        glowStrength={mode.highlighted ? 0.8 : 0.3}
      >
        <div
          className={cn(
            'relative flex h-full flex-col rounded-2xl p-8 backdrop-blur-sm',
            'transition-shadow duration-300',
            mode.accent.bg,
            mode.accent.shadow
          )}
        >
          {/* Mouse-tracking glow */}
          <div className="absolute inset-0 z-0 pointer-events-none">
            <GlowTrackerCustom color={mode.accent.glow} />
          </div>

          {/* Icon + name */}
          <div className="relative z-[1] mb-3 flex items-center gap-3">
            <div
              className={cn(
                'flex size-10 items-center justify-center rounded-xl border',
                mode.accent.iconBox
              )}
            >
              <Icon className={cn('size-5', mode.accent.icon)} />
            </div>
            <h3 className="text-xl font-bold">{mode.name}</h3>
          </div>

          {/* Deploy mode behind the benefit */}
          <div className="relative z-[1] mb-6">
            <span className="inline-flex rounded-full bg-muted/60 px-2.5 py-0.5 text-xs text-muted-foreground">
              {mode.mode}
            </span>
          </div>

          <div className={cn('relative z-[1] mb-6 h-px', mode.accent.divider)} />

          <p className="relative z-[1] text-sm text-muted-foreground">{mode.tagline}</p>
        </div>
      </FresnelEdge>
    </motion.div>
  );
}

/**
 * GlowTracker with customizable glow color per mode.
 */
function GlowTrackerCustom({ color }: { color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!parent) return;

    const handleMove = (e: MouseEvent) => {
      const rect = parent.getBoundingClientRect();
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    const handleEnter = () => setVisible(true);
    const handleLeave = () => setVisible(false);

    parent.addEventListener('mousemove', handleMove);
    parent.addEventListener('mouseenter', handleEnter);
    parent.addEventListener('mouseleave', handleLeave);
    return () => {
      parent.removeEventListener('mousemove', handleMove);
      parent.removeEventListener('mouseenter', handleEnter);
      parent.removeEventListener('mouseleave', handleLeave);
    };
  }, []);

  return (
    <div ref={ref} className="absolute inset-0 z-0 pointer-events-none">
      <div
        className="absolute -inset-px rounded-[inherit] transition-opacity duration-300"
        style={{
          opacity: visible ? 1 : 0,
          background: `radial-gradient(600px circle at ${pos.x}px ${pos.y}px, ${color} 0%, transparent 90%)`,
        }}
      />
    </div>
  );
}
