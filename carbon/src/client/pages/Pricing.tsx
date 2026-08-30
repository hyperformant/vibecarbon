import {
  type CatalogTier,
  catalogTiers,
  formatPlanPrice,
  formatTierPrice,
  type Plan,
  plans,
} from '@shared/pricing';
import { IconArrowRight as ArrowRight, IconCheck as Check, IconX as X } from '@tabler/icons-react';
import { Link } from 'react-router';
import { Nav } from '@/components/Nav';
import { SEO } from '@/components/SEO';
import FooterSection from '@/components/sections/footer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PricingCardProps {
  name: string;
  description: string | null;
  price: string;
  /** Feature rows. Catalog tiers are all included; demo plans mark exclusions. */
  features: { text: string; included: boolean }[];
  ctaLabel: string;
  popular?: boolean;
}

function PricingCard({
  name,
  description,
  price,
  features,
  ctaLabel,
  popular = false,
}: PricingCardProps) {
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl border p-6 transition-shadow',
        popular ? 'border-primary shadow-lg shadow-primary/10' : 'border-border'
      )}
    >
      {popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <Badge>Most popular</Badge>
        </div>
      )}

      <div className="mb-4">
        <h2 className="text-lg font-semibold">{name}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>

      <div className="mb-6">
        <span className="text-4xl font-bold">{price}</span>
      </div>

      <ul className="mb-8 flex-1 space-y-3">
        {features.map((feature) => (
          <li key={feature.text} className="flex items-start gap-2.5 text-sm">
            {feature.included ? (
              <Check className="mt-0.5 size-4 shrink-0 text-primary" />
            ) : (
              <X className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
            )}
            <span className={feature.included ? '' : 'text-muted-foreground/50'}>
              {feature.text}
            </span>
          </li>
        ))}
      </ul>

      <Button variant={popular ? 'default' : 'outline'} size="lg" asChild className="w-full">
        <Link to="/signup" className="inline-flex items-center gap-2">
          {ctaLabel}
          <ArrowRight className="size-4 shrink-0" />
        </Link>
      </Button>
    </div>
  );
}

/** Cap the column count at the number of cards so 1–2 tiers don't stretch oddly. */
const gridColsByCount: Record<number, string> = {
  1: 'sm:max-w-md sm:mx-auto',
  2: 'sm:grid-cols-2 sm:max-w-3xl sm:mx-auto',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
};

export default function Pricing() {
  const useCatalog = catalogTiers.length > 0;
  const count = useCatalog ? catalogTiers.length : plans.length;
  const gridCols = gridColsByCount[Math.min(count, 4)] ?? 'sm:grid-cols-2 lg:grid-cols-4';

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO
        title="Pricing"
        description="Every price is on this page. Start free, upgrade when you outgrow it, and change or cancel your plan yourself."
      />

      <div className="mx-auto max-w-6xl px-6 pt-32 pb-24">
        {/* Header */}
        <div className="mx-auto mb-16 max-w-2xl text-center">
          <h1 className="mb-4 text-4xl font-black tracking-tight md:text-5xl">
            Every price is on this page.
          </h1>
          <p className="text-lg text-muted-foreground">
            Start free. Upgrade when you outgrow it. Change or cancel your plan yourself, without
            talking to anyone.
          </p>
        </div>

        {/* Plan cards */}
        <div className={cn('grid items-stretch gap-6', gridCols)}>
          {useCatalog
            ? catalogTiers.map((tier: CatalogTier) => (
                <PricingCard
                  key={tier.priceId}
                  name={tier.name}
                  description={tier.description}
                  price={formatTierPrice(tier)}
                  features={tier.features.map((text) => ({ text, included: true }))}
                  ctaLabel={tier.amount === 0 ? 'Get started' : `Choose ${tier.name}`}
                />
              ))
            : plans.map((plan: Plan) => (
                <PricingCard
                  key={plan.id}
                  name={plan.name}
                  description={plan.description}
                  price={formatPlanPrice(plan)}
                  features={plan.features}
                  ctaLabel={plan.id === 'free' ? 'Get started' : `Choose ${plan.name}`}
                  popular={plan.popular}
                />
              ))}
        </div>
      </div>

      <FooterSection />
    </div>
  );
}
