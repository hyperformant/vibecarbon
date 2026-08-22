import { IconArrowRight as ArrowRightIcon } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import { useDocsVisibility } from '@/hooks/api';
import { isDocsHrefVisible } from '@/lib/docs-links';
import { cn } from '@/lib/utils';
import { ShimmerBadge } from '../ShimmerBadge';
import Glow from '../ui/glow';
import { LinkButton, type LinkButtonProps } from '../ui/link-button';
import { Mockup, MockupFrame } from '../ui/mockup';
import { Section } from '../ui/section';

/*
 * Marketing hero. Adapted from Launch UI (MIT) for Vite: lucide -> Tabler,
 * next/* removed, and the content genericized as a starting point for the
 * generated app. Replace the copy and the mockup with your own.
 */

interface HeroButtonProps extends Omit<LinkButtonProps, 'children'> {
  text: string;
}

interface HeroProps {
  title?: string;
  description?: string;
  mockup?: ReactNode | false;
  badge?: ReactNode | false;
  buttons?: HeroButtonProps[] | false;
  className?: string;
}

const DEFAULT_HERO_BUTTONS: HeroButtonProps[] = [
  { href: '/signup', text: 'Get started', variant: 'default' },
  { href: '/docs', text: 'View docs', variant: 'glow' },
];

// The marketing eyebrow reuses the landing hero's ShimmerBadge (same component).
const DEFAULT_HERO_BADGE = (
  <ShimmerBadge className="animate-appear">React · Supabase · Stripe</ShimmerBadge>
);

// Neutral placeholder — swap for a <Screenshot .../> of your own app.
const DEFAULT_HERO_MOCKUP = (
  <div className="bg-muted/40 text-muted-foreground grid aspect-[16/10] w-full place-items-center text-sm">
    Your app preview
  </div>
);

export default function Hero({
  title = 'Your first commit is a feature.',
  description = 'Authentication, billing, and an admin dashboard, wired together and working on the first run. Everything after that is your product.',
  mockup = DEFAULT_HERO_MOCKUP,
  badge = DEFAULT_HERO_BADGE,
  buttons = DEFAULT_HERO_BUTTONS,
  className,
}: HeroProps) {
  const docsVisibility = useDocsVisibility();

  // The default "View docs" CTA disappears with user docs turned off; the
  // primary "Get started" button carries the section on its own.
  const visibleButtons =
    buttons === false ? false : buttons.filter((b) => isDocsHrefVisible(b.href, docsVisibility));

  return (
    <Section className={cn('fade-bottom overflow-hidden pb-0 sm:pb-0 md:pb-0', className)}>
      <div className="max-w-container mx-auto flex flex-col gap-12 pt-16 sm:gap-24">
        <div className="flex flex-col items-center gap-6 text-center sm:gap-12">
          {badge !== false && badge}
          <h1 className="animate-appear from-foreground to-foreground dark:to-muted-foreground relative z-10 inline-block bg-linear-to-r bg-clip-text text-4xl leading-tight font-semibold text-balance text-transparent drop-shadow-2xl sm:text-6xl sm:leading-tight md:text-8xl md:leading-tight">
            {title}
          </h1>
          <p className="text-md animate-appear text-muted-foreground relative z-10 max-w-[740px] font-medium text-balance opacity-0 delay-100 sm:text-xl">
            {description}
          </p>
          {visibleButtons !== false && visibleButtons.length > 0 && (
            <div className="animate-appear relative z-10 flex justify-center gap-4 opacity-0 delay-300">
              {visibleButtons.map((button) => (
                <LinkButton
                  key={`${button.href}-${button.text}`}
                  variant={button.variant || 'default'}
                  size="lg"
                  href={button.href}
                  icon={button.icon}
                  iconRight={button.iconRight ?? <ArrowRightIcon className="ml-2 size-4" />}
                >
                  {button.text}
                </LinkButton>
              ))}
            </div>
          )}
          {mockup !== false && (
            <div className="relative w-full pt-12">
              <MockupFrame className="animate-appear opacity-0 delay-700" size="small">
                <Mockup type="responsive" className="bg-background/90 w-full rounded-xl border-0">
                  {mockup}
                </Mockup>
              </MockupFrame>
              <Glow variant="top" className="animate-appear-zoom opacity-0 delay-1000" />
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
