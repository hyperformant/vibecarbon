import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { PROJECT_DISPLAY_NAME, Wordmark } from '@/components/Logo';
import { useDocsVisibility } from '@/hooks/api';
import { isDocsHrefVisible } from '@/lib/docs-links';
import { cn } from '@/lib/utils';

/*
 * Site footer. One footer for every public page: wordmark-only brand column,
 * link columns under uppercase micro-headings, and an optional trailing column
 * of icon buttons (socials, package registries…) laid out two per row. A single
 * top hairline is the only rule — no copyright bar (copyright notice has been
 * legally optional since the Berne Convention; drop it unless your counsel
 * disagrees). Dashboard pages render no footer at all.
 */

interface FooterLink {
  text: string;
  href: string;
}

interface FooterColumnProps {
  title: string;
  links: FooterLink[];
}

interface FooterIconLink {
  label: string;
  href: string;
  icon: ReactNode;
}

interface FooterIconColumnProps {
  title: string;
  links: FooterIconLink[];
}

interface FooterProps {
  logo?: ReactNode;
  columns?: FooterColumnProps[];
  /** Trailing column of icon-only buttons, e.g. GitHub / npm / Discord. */
  iconColumn?: FooterIconColumnProps;
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

function ColumnHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold tracking-[0.14em] text-foreground/80 uppercase">
      {children}
    </h3>
  );
}

function ColumnLink({ text, href }: FooterLink) {
  const className = 'w-fit text-sm text-muted-foreground transition-colors hover:text-primary';
  return href.startsWith('/') && !href.startsWith('//') ? (
    <Link to={href} className={className}>
      {text}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {text}
    </a>
  );
}

export default function FooterSection({
  logo = <Wordmark />,
  columns = DEFAULT_COLUMNS,
  iconColumn,
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
    <footer className={cn('w-full border-t border-border bg-background', className)}>
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 md:grid-cols-12">
          {/* Brand block: just the lockup. */}
          <div className="col-span-2 md:col-span-4">
            <Link to="/" aria-label={PROJECT_DISPLAY_NAME} className="inline-block">
              {logo}
            </Link>
          </div>

          {/* Link + icon columns share the remaining width evenly, whatever
              their count. */}
          <div className="col-span-2 grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3 md:col-span-8">
            {visibleColumns.map((column) => (
              <div key={column.title} className="flex flex-col gap-4">
                <ColumnHeading>{column.title}</ColumnHeading>
                {column.links.map((link) => (
                  <ColumnLink key={`${link.href}-${link.text}`} {...link} />
                ))}
              </div>
            ))}

            {iconColumn && iconColumn.links.length > 0 && (
              <div className="flex flex-col gap-4">
                <ColumnHeading>{iconColumn.title}</ColumnHeading>
                <nav aria-label={iconColumn.title} className="grid w-fit grid-cols-2 gap-2.5">
                  {iconColumn.links.map(({ label, href, icon }) => (
                    <a
                      key={href}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={label}
                      title={label}
                      className="flex size-10 items-center justify-center rounded-xl bg-white text-zinc-900 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-primary hover:text-primary-foreground"
                    >
                      {icon}
                    </a>
                  ))}
                </nav>
              </div>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}
