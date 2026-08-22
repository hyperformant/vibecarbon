import {
  IconCreditCard,
  IconLanguage,
  IconLayoutDashboard,
  IconShieldLock,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';

import {
  FeatureItem,
  FeatureItemDescription,
  FeatureItemIcon,
  FeatureItemTitle,
} from '../ui/feature-item';
import { Section } from '../ui/section';

/*
 * Feature grid. Adapted from Launch UI's "items" section (MIT) for Vite:
 * lucide -> Tabler icons, and the copy genericized as a starting point for the
 * generated app. Swap these for the capabilities that matter to your product.
 */

interface FeatureProps {
  title: string;
  description: string;
  icon: ReactNode;
}

interface FeaturesProps {
  title?: string;
  items?: FeatureProps[] | false;
  className?: string;
}

const DEFAULT_FEATURES: FeatureProps[] = [
  {
    title: 'Authentication',
    description: 'Email, OAuth, and magic links, with sessions and route guards handled for you.',
    icon: <IconShieldLock className="size-5 stroke-1" />,
  },
  {
    title: 'Billing',
    description: 'Plans, subscriptions, and invoices, with Stripe checkout and webhooks wired.',
    icon: <IconCreditCard className="size-5 stroke-1" />,
  },
  {
    title: 'Admin dashboard',
    description:
      'Users, roles, and organization settings, with the screens and permissions already built.',
    icon: <IconLayoutDashboard className="size-5 stroke-1" />,
  },
  {
    title: 'Docs & i18n',
    description:
      'Searchable docs, five bundled languages, and browser locale detection, with English fallbacks already in place.',
    icon: <IconLanguage className="size-5 stroke-1" />,
  },
];

export default function Features({
  title = "The parts you'd rather not build twice.",
  items = DEFAULT_FEATURES,
  className,
}: FeaturesProps) {
  return (
    <Section className={className}>
      <div className="max-w-container mx-auto flex flex-col items-center gap-6 sm:gap-20">
        <h2 className="max-w-[560px] text-center text-3xl leading-tight font-semibold sm:text-5xl sm:leading-tight">
          {title}
        </h2>
        {items !== false && items.length > 0 && (
          <div className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {items.map((item) => (
              <FeatureItem key={item.title}>
                <FeatureItemTitle className="flex items-center gap-2">
                  <FeatureItemIcon>{item.icon}</FeatureItemIcon>
                  {item.title}
                </FeatureItemTitle>
                <FeatureItemDescription>{item.description}</FeatureItemDescription>
              </FeatureItem>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}
