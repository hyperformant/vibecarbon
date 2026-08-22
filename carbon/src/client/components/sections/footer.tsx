import type { ReactNode } from 'react';

import { PROJECT_DISPLAY_NAME, Wordmark } from '@/components/Logo';
import { useDocsVisibility } from '@/hooks/api';
import { isDocsHrefVisible } from '@/lib/docs-links';
import { cn } from '@/lib/utils';

import { Footer, FooterBottom, FooterColumn, FooterContent } from '../ui/footer';

/*
 * Site footer. Adapted from Launch UI (MIT) for Vite: Launch UI's own logo and
 * the mode-toggle removed (the app owns its theming), siteConfig replaced with
 * inline generic links, and the brand swapped for the template's <Wordmark>.
 */

interface FooterLink {
  text: string;
  href: string;
}

interface FooterColumnProps {
  title: string;
  links: FooterLink[];
}

interface FooterProps {
  logo?: ReactNode;
  columns?: FooterColumnProps[];
  copyright?: string;
  policies?: FooterLink[];
  className?: string;
}

const DEFAULT_COLUMNS: FooterColumnProps[] = [
  {
    title: 'Product',
    links: [
      { text: 'Features', href: '#features' },
      { text: 'Pricing', href: '#pricing' },
      { text: 'Changelog', href: '/changelog' },
    ],
  },
  {
    title: 'Docs',
    links: [
      { text: 'Getting started', href: '/docs' },
      { text: 'Guides', href: '/docs' },
      { text: 'API reference', href: '/docs' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { text: 'Privacy', href: '/privacy' },
      { text: 'Terms', href: '/terms' },
    ],
  },
];

export default function FooterSection({
  logo = <Wordmark size="sm" />,
  columns = DEFAULT_COLUMNS,
  copyright = `© ${new Date().getFullYear()} ${PROJECT_DISPLAY_NAME}. All rights reserved.`,
  policies = [
    { text: 'Privacy Policy', href: '/privacy' },
    { text: 'Terms of Service', href: '/terms' },
  ],
  className,
}: FooterProps) {
  const docsVisibility = useDocsVisibility();

  // Drop links to a documentation surface the operator turned off, then drop
  // any column left with nothing in it — the default "Docs" column is entirely
  // user-docs links, so hiding them would otherwise leave a bare heading.
  const visibleColumns = columns
    .map((column) => ({
      ...column,
      links: column.links.filter((link) => isDocsHrefVisible(link.href, docsVisibility)),
    }))
    .filter((column) => column.links.length > 0);

  return (
    <footer className={cn('bg-background w-full px-4', className)}>
      <div className="max-w-container mx-auto">
        <Footer>
          <FooterContent>
            <FooterColumn className="col-span-2 sm:col-span-3 md:col-span-1">
              <div className="flex items-center gap-2">{logo}</div>
            </FooterColumn>
            {visibleColumns.map((column) => (
              <FooterColumn key={column.title}>
                <h3 className="text-md pt-1 font-semibold">{column.title}</h3>
                {column.links.map((link) => (
                  <a
                    key={`${link.href}-${link.text}`}
                    href={link.href}
                    className="text-muted-foreground text-sm"
                  >
                    {link.text}
                  </a>
                ))}
              </FooterColumn>
            ))}
          </FooterContent>
          <FooterBottom>
            <div>{copyright}</div>
            <div className="flex items-center gap-4">
              {policies.map((policy) => (
                <a key={`${policy.href}-${policy.text}`} href={policy.href}>
                  {policy.text}
                </a>
              ))}
            </div>
          </FooterBottom>
        </Footer>
      </div>
    </footer>
  );
}
