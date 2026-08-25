import { catalogTiers, designSlugFromName } from '@shared/pricing';
import {
  IconAtom as Atom,
  IconCheck as Check,
  IconHeartHandshake as Handshake,
  IconHexagon as Hexagon,
  type TablerIcon as IconComponent,
  IconX as X,
} from '@tabler/icons-react';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useDocsVisibility } from '@/hooks/api';
import { ApiError, apiJson } from '@/lib/api';
import { cn } from '@/lib/utils';
import logoIcon from '../assets/logo-icon.svg';
import { FresnelEdge } from './effects/FresnelEdge';
import { Button } from './ui/button';

interface Tier {
  id: string;
  name: string;
  tagline: string;
  /** Null for the contact-us tier, which has no self-serve price to display. */
  price: number | null;
  originalPrice: number | null;
  unit: string;
  cta: string;
  ctaHref: string;
  /**
   * When set, the CTA posts to /license-checkout for this tier and redirects
   * straight into the provider's hosted checkout instead of navigating.
   */
  checkoutTier?: string;
  ctaVariant: 'outline' | 'exciting' | 'default';
  popular: boolean;
  icon: IconComponent;
  accent: {
    icon: string;
    bg: string;
    shadow: string;
    glow: string;
    priceGradient: string | null;
    check: string;
  };
  features: { text: string; included: boolean }[];
  delay: number;
}

export function PricingSection() {
  const { t } = useTranslation();
  const { userDocsEnabled } = useDocsVisibility();

  // The free tier's CTA sends people to the getting-started guide. With user
  // docs turned off there is no guide to send them to, so the button falls
  // back to signup rather than pointing at a route that now 404s.
  const graphiteCtaHref = userDocsEnabled ? '/docs/getting-started' : '/signup';

  const tiers: Tier[] = [
    {
      id: 'graphite',
      name: 'Graphite',
      tagline: t('landing.pricing.graphite.tagline'),
      price: 0,
      originalPrice: null,
      unit: t('landing.pricing.units.forever'),
      cta: t('landing.pricing.graphite.cta'),
      ctaHref: graphiteCtaHref,
      ctaVariant: 'default',
      popular: false,
      icon: Hexagon,
      accent: {
        icon: 'text-muted-foreground',
        bg: 'bg-muted/30 dark:bg-background/50',
        shadow: '',
        glow: 'oklch(0.7 0.02 250 / 0.06)',
        priceGradient: null,
        check: 'text-muted-foreground',
      },
      features: [
        { text: t('landing.pricing.graphite.features.unlimitedProjects'), included: true },
        { text: t('landing.pricing.graphite.features.localDev'), included: true },
        { text: t('landing.pricing.graphite.features.production'), included: true },
        { text: t('landing.pricing.graphite.features.backups'), included: true },
        { text: t('landing.pricing.graphite.features.cicd'), included: true },
        { text: t('landing.pricing.graphite.features.addOns'), included: true },
        { text: t('landing.pricing.graphite.features.supabase'), included: true },
        { text: t('landing.pricing.graphite.features.fairSource'), included: true },
        { text: t('landing.pricing.graphite.features.community'), included: true },
      ],
      delay: 0.1,
    },
    {
      id: 'fullerene',
      name: 'Fullerene',
      tagline: t('landing.pricing.fullerene.tagline'),
      price: 149,
      originalPrice: 299,
      unit: t('landing.pricing.units.oneTime'),
      cta: t('landing.pricing.fullerene.cta'),
      ctaHref: '/#pricing',
      checkoutTier: 'fullerene',
      ctaVariant: 'exciting',
      popular: true,
      icon: Atom,
      accent: {
        icon: 'text-primary',
        bg: 'bg-primary/[0.03] dark:bg-primary/[0.05]',
        shadow: 'shadow-lg shadow-primary/10',
        glow: 'oklch(0.82 0.14 192 / 0.08)',
        priceGradient: 'from-primary to-primary/70',
        check: 'text-primary',
      },
      features: [
        { text: t('landing.pricing.fullerene.features.graphite'), included: true },
        { text: t('landing.pricing.fullerene.features.deployModes'), included: true },
        { text: t('landing.pricing.fullerene.features.replication'), included: true },
        { text: t('landing.pricing.fullerene.features.healthChecks'), included: true },
        { text: t('landing.pricing.fullerene.features.cicd'), included: true },
        { text: t('landing.pricing.fullerene.features.monitoring'), included: true },
        { text: t('landing.pricing.fullerene.features.unlimited'), included: true },
        { text: t('landing.pricing.fullerene.features.support'), included: true },
      ],
      delay: 0.2,
    },
    {
      id: 'agency',
      name: 'Agency',
      tagline: t('landing.pricing.agency.tagline'),
      price: null,
      originalPrice: null,
      unit: t('landing.pricing.units.contact'),
      cta: t('landing.pricing.agency.cta'),
      ctaHref: '/contact',
      ctaVariant: 'default',
      popular: false,
      icon: Handshake,
      accent: {
        icon: 'text-secondary-accent',
        bg: 'bg-secondary-accent/[0.03] dark:bg-secondary-accent/[0.05]',
        shadow: 'shadow-lg shadow-secondary-accent/10',
        glow: 'oklch(0.65 0.26 350 / 0.06)',
        priceGradient: null,
        check: 'text-secondary-accent',
      },
      features: [
        { text: t('landing.pricing.agency.features.fullerene'), included: true },
        { text: t('landing.pricing.agency.features.exception'), included: true },
        { text: t('landing.pricing.agency.features.clients'), included: true },
        { text: t('landing.pricing.agency.features.whiteLabel'), included: true },
        { text: t('landing.pricing.agency.features.customTerms'), included: true },
        { text: t('landing.pricing.agency.features.priority'), included: true },
      ],
      delay: 0.3,
    },
  ];

  // When the operator has activated products via `vibecarbon configure`, those
  // drive WHICH cards show, their order (price-sorted), and their price —
  // matched to each tier's bespoke design above. The hardcoded `tiers` are the
  // fallback when no catalog is configured. Curated visuals, taglines, discounts
  // and feature copy stay local (they aren't in the provider catalog).
  const tiersById = new Map(tiers.map((tier) => [tier.id, tier]));
  const agencyTier = tiersById.get('agency');
  const displayTiers: Tier[] = catalogTiers.length
    ? (() => {
        const mapped = catalogTiers.map((ct, i) => {
          const slug = designSlugFromName(ct.name);
          const design = tiersById.get(slug);
          const price = Math.round(ct.amount / 100);
          const delay = 0.1 * (i + 1);
          if (design) {
            // Agency is a contact-only tier — never let a catalog product's
            // price override its `price: null` contact semantics (e.g. a $0
            // "Agency" placeholder product must still read "Contact us").
            return slug === 'agency' ? { ...design, delay } : { ...design, price, delay };
          }
          // Unrecognized product — default (graphite) styling, content from the catalog.
          return {
            ...tiers[0],
            id: ct.priceId,
            name: ct.name,
            tagline: ct.description ?? tiers[0].tagline,
            price,
            originalPrice: null,
            popular: false,
            features: ct.features.length
              ? ct.features.map((text) => ({ text, included: true }))
              : tiers[0].features,
            delay,
          };
        });
        // Agency has no purchasable Stripe product, so it never shows up in the
        // catalog on its own — always append the static contact-us card unless
        // the operator activated a product literally named "Agency".
        if (agencyTier && !mapped.some((tier) => tier.id === 'agency')) {
          return [...mapped, { ...agencyTier, delay: 0.1 * (mapped.length + 1) }];
        }
        return mapped;
      })()
    : tiers;

  return (
    <section id="pricing" className="py-24 md:py-36 overflow-hidden">
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
            {t('landing.pricing.headline1')}{' '}
            <span className="text-foreground">{t('landing.pricing.headlineSketch')}</span>{' '}
            {t('landing.pricing.headline2')}{' '}
            <span className="text-primary">{t('landing.pricing.headlineScale')}</span>
          </h2>
          <p className="text-lg text-muted-foreground">{t('landing.pricing.subheading')}</p>
        </motion.div>

        {/* Background glow */}
        <div className="relative">
          {/* Pricing Cards */}
          <div className="relative grid gap-8 lg:grid-cols-3">
            {displayTiers.map((tier) => (
              <TierCard key={tier.id} tier={tier} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function TierCard({ tier }: { tier: Tier }) {
  const { t } = useTranslation();
  const Icon = tier.icon;
  const [redirecting, setRedirecting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // One click from pricing to payment: create the checkout session and hand
  // off to the provider's hosted page (which collects the buyer's email).
  async function startCheckout() {
    setCheckoutError(null);
    setRedirecting(true);
    try {
      const data = await apiJson<{ url: string }>(
        '/api/v1/billing/license-checkout',
        { method: 'POST', body: { tier: tier.checkoutTier } },
        t('landing.pricing.checkoutError')
      );
      window.location.href = data.url;
    } catch (err) {
      setCheckoutError(err instanceof ApiError ? err.message : t('landing.pricing.checkoutError'));
      setRedirecting(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      whileHover={{ scale: 1.02 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ type: 'spring', stiffness: 300, damping: 30, delay: tier.delay }}
      className="relative"
    >
      {/* Badge — rendered outside FresnelEdge so it paints above the edge highlight line */}
      {tier.popular && (
        <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 z-10">
          <span className="relative inline-flex items-center whitespace-nowrap rounded-full px-5 py-1.5 text-xs font-semibold text-white">
            {/* Animated gradient border */}
            <span className="absolute inset-0 rounded-full bg-gradient-to-r from-violet-500 via-fuchsia-400 via-amber-300 to-violet-500 badge-shimmer" />
            {/* Inner dark fill */}
            <span className="absolute inset-[1.5px] rounded-full bg-gradient-to-r from-violet-950 via-fuchsia-950 to-violet-950" />
            {/* Shimmer highlight */}
            <span className="absolute inset-[1.5px] rounded-full bg-gradient-to-r from-transparent via-white/10 to-transparent badge-shimmer opacity-60" />
            <span className="relative">{t('landing.pricing.popular')}</span>
          </span>
        </div>
      )}
      <FresnelEdge
        className="h-full rounded-2xl"
        edgeColor={
          tier.id === 'fullerene'
            ? 'oklch(0.82 0.14 192 / 0.2)'
            : tier.id === 'agency'
              ? 'oklch(0.65 0.26 350 / 0.15)'
              : 'rgba(255, 255, 255, 0.08)'
        }
        glowStrength={tier.popular ? 0.8 : 0.3}
      >
        <div
          className={cn(
            'relative flex h-full flex-col rounded-2xl p-8 backdrop-blur-sm',
            'transition-shadow duration-300',
            tier.accent.bg,
            tier.accent.shadow
          )}
        >
          {/* Mouse-tracking glow */}
          <div className="absolute inset-0 z-0 pointer-events-none">
            <GlowTrackerCustom color={tier.accent.glow} />
          </div>

          {/* Icon + Tier name */}
          <div className="relative z-[1] mb-1 flex items-center gap-3">
            <div
              className={cn(
                'flex size-10 items-center justify-center rounded-xl border',
                tier.id === 'fullerene'
                  ? 'border-primary/20 bg-primary/10'
                  : tier.id === 'agency'
                    ? 'border-secondary-accent/20 bg-secondary-accent/10'
                    : 'border-border/50 bg-muted/50'
              )}
            >
              <Icon className={cn('size-5', tier.accent.icon)} />
            </div>
            <h3 className="text-xl font-bold">{tier.name}</h3>
          </div>

          {/* Tagline */}
          <p className="relative z-[1] mb-6 text-sm text-muted-foreground">{tier.tagline}</p>

          {/* Price. Fixed row height (= the text-4xl/lg:text-5xl line height) with
              bottom alignment: the Contact-us card's smaller text would otherwise
              produce a shorter line box and pull its pill/CTA/divider up a few px
              relative to the sibling cards. */}
          <div className="relative z-[1] mb-2 flex h-10 items-end lg:h-12">
            {tier.originalPrice && (
              <span className="mr-2 text-base text-muted-foreground/40 line-through">
                ${tier.originalPrice}
              </span>
            )}
            {tier.accent.priceGradient ? (
              <span
                className={cn(
                  'text-4xl lg:text-5xl font-black bg-gradient-to-r bg-clip-text text-transparent',
                  tier.accent.priceGradient
                )}
              >
                ${tier.price}
              </span>
            ) : tier.price === null ? (
              <span className="text-3xl lg:text-4xl font-black whitespace-nowrap">
                {t('landing.pricing.contactUs')}
              </span>
            ) : (
              <span className="text-4xl lg:text-5xl font-black">{t('common.free')}</span>
            )}
          </div>

          {/* Price unit pill */}
          <div className="relative z-[1] mb-6">
            <span className="inline-flex rounded-full bg-muted/60 px-2.5 py-0.5 text-xs text-muted-foreground">
              {tier.unit}
            </span>
          </div>

          {/* CTA */}
          <div className="relative z-[1] mb-8">
            {tier.checkoutTier ? (
              <>
                <Button
                  variant={tier.ctaVariant}
                  size="lg"
                  className="w-full"
                  disabled={redirecting}
                  onClick={startCheckout}
                >
                  {redirecting ? t('landing.pricing.redirecting') : tier.cta}
                </Button>
                {checkoutError && (
                  <p className="mt-2 text-center text-sm text-destructive">{checkoutError}</p>
                )}
              </>
            ) : (
              <Button variant={tier.ctaVariant} size="lg" className="w-full" asChild>
                <Link to={tier.ctaHref}>{tier.cta}</Link>
              </Button>
            )}
          </div>

          {/* Divider */}
          <div
            className={cn(
              'relative z-[1] mb-6 h-px',
              tier.id === 'fullerene'
                ? 'bg-gradient-to-r from-transparent via-primary/30 to-transparent'
                : tier.id === 'agency'
                  ? 'bg-gradient-to-r from-transparent via-secondary-accent/20 to-transparent'
                  : 'bg-border/50'
            )}
          />

          {/* Features */}
          <ul className="relative z-[1] flex-1 space-y-3">
            {tier.features.map((feature) => (
              <li key={feature.text} className="flex items-start gap-2.5">
                {feature.included ? (
                  <Check className={cn('mt-0.5 size-4 flex-shrink-0', tier.accent.check)} />
                ) : (
                  <X className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground/30" />
                )}
                <span
                  className={cn(
                    'text-sm',
                    feature.included ? 'text-muted-foreground' : 'text-muted-foreground/30'
                  )}
                >
                  {feature.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </FresnelEdge>
    </motion.div>
  );
}

/**
 * GlowTracker with customizable glow color per tier.
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
