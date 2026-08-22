import { IconUser, IconUsers } from '@tabler/icons-react';

import { cn } from '@/lib/utils';

import { PricingColumn, type PricingColumnProps } from '../ui/pricing-column';
import { Section } from '../ui/section';

/*
 * Pricing section. Adapted from Launch UI (MIT) for Vite: siteConfig removed,
 * lucide -> Tabler icons, and reframed from Launch UI's one-time purchase into
 * monthly subscription tiers (Starter / Pro / Team). Retint is automatic.
 */

interface PricingProps {
  title?: string | false;
  description?: string | false;
  plans?: PricingColumnProps[] | false;
  className?: string;
}

const DEFAULT_PRICING_PLANS: PricingColumnProps[] = [
  {
    name: 'Starter',
    description: 'For side projects and early prototypes.',
    price: 0,
    priceNote: 'No card required, and no time limit.',
    cta: {
      variant: 'glow',
      label: 'Get started',
      href: '/signup',
    },
    features: ['1 project', 'Up to 1,000 users', 'Community support'],
    variant: 'default',
  },
  {
    name: 'Pro',
    icon: <IconUser className="size-4" />,
    description: 'For products with paying customers.',
    price: 29,
    priceNote: 'Everything in Starter, with higher limits.',
    cta: {
      variant: 'default',
      label: 'Choose Pro',
      href: '/signup',
    },
    features: [
      'Unlimited projects',
      'Up to 50,000 users',
      'Advanced analytics',
      'Priority support',
    ],
    variant: 'glow-brand',
  },
  {
    name: 'Team',
    icon: <IconUsers className="size-4" />,
    description: 'For teams shipping together.',
    price: 99,
    priceNote: 'Everything in Pro, with SSO and audit logs.',
    cta: {
      variant: 'default',
      label: 'Choose Team',
      href: '/signup',
    },
    features: ['Everything in Pro', 'Roles & permissions', 'SSO & audit logs', 'Dedicated support'],
    variant: 'glow',
  },
];

export default function Pricing({
  title = 'Every price is on this page.',
  description = 'Start free. Upgrade when you outgrow it. Change or cancel your plan yourself, without talking to anyone.',
  plans = DEFAULT_PRICING_PLANS,
  className = '',
}: PricingProps) {
  return (
    <Section className={cn(className)}>
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-12">
        {(title || description) && (
          <div className="flex flex-col items-center gap-4 px-4 text-center sm:gap-8">
            {title && (
              <h2 className="text-3xl leading-tight font-semibold sm:text-5xl sm:leading-tight">
                {title}
              </h2>
            )}
            {description && (
              <p className="text-md text-muted-foreground max-w-[600px] font-medium sm:text-xl">
                {description}
              </p>
            )}
          </div>
        )}
        {plans !== false && plans.length > 0 && (
          <div className="max-w-container mx-auto grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <PricingColumn
                key={plan.name}
                name={plan.name}
                icon={plan.icon}
                description={plan.description}
                price={plan.price}
                priceNote={plan.priceNote}
                cta={plan.cta}
                features={plan.features}
                variant={plan.variant}
                className={plan.className}
              />
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}
