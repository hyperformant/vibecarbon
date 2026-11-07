import {
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandNpm,
  IconShieldCheck,
} from '@tabler/icons-react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { PROJECT_DISPLAY_NAME, Wordmark } from '@/components/Logo';
import { useDocsVisibility } from '@/hooks/api';
import { isDocsHrefVisible } from '@/lib/docs-links';

/*
 * Footer for the template's homepage. The generic scaffold footer
 * (components/sections/footer.tsx) stays for other pages; this one lays out the
 * brand lockup on the left, Product and Company link columns, and a Developers
 * column of icon buttons (GitHub, npm, Discord, security policy). Links to
 * docs routes that are switched off are filtered out.
 */

interface DevService {
  label: string;
  href: string;
  Icon: ComponentType<{ className?: string }>;
}

interface LinkColumn {
  title: string;
  links: { text: string; href: string }[];
}

function FooterLink({ text, href }: { text: string; href: string }) {
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

export function VibecarbonFooter() {
  const { t } = useTranslation();
  const docsVisibility = useDocsVisibility();

  const devServices: DevService[] = [
    { label: 'GitHub', href: 'https://github.com/hyperformant/vibecarbon/', Icon: IconBrandGithub },
    { label: 'npm', href: 'https://www.npmjs.com/package/vibecarbon', Icon: IconBrandNpm },
    { label: 'Discord', href: 'https://discord.gg/up8Z9sX6M6', Icon: IconBrandDiscord },
    {
      label: t('landing.footer.security'),
      href: 'https://github.com/hyperformant/vibecarbon/blob/main/SECURITY.md',
      Icon: IconShieldCheck,
    },
  ];

  const columns: LinkColumn[] = [
    {
      title: t('landing.footer.groups.product'),
      links: [
        { text: t('landing.footer.pricing'), href: '/pricing' },
        { text: t('landing.footer.blog'), href: '/blog' },
        { text: t('landing.footer.changelog'), href: '/changelog' },
        { text: t('landing.footer.userDocs'), href: '/docs' },
        { text: t('landing.footer.apiDocs'), href: '/api/docs' },
      ],
    },
    {
      title: t('landing.footer.groups.company'),
      links: [
        { text: t('landing.footer.contact'), href: '/contact' },
        { text: t('landing.footer.privacy'), href: '/privacy' },
        { text: t('landing.footer.terms'), href: '/terms' },
      ],
    },
  ];

  const visibleColumns = columns
    .map((column) => ({
      ...column,
      links: column.links.filter((link) => isDocsHrefVisible(link.href, docsVisibility)),
    }))
    .filter((column) => column.links.length > 0);

  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <div className="grid grid-cols-2 gap-x-8 gap-y-12 md:grid-cols-12">
          {/* Brand block: just the lockup. */}
          <div className="col-span-2 md:col-span-4">
            <Link to="/" aria-label={PROJECT_DISPLAY_NAME} className="inline-block">
              <Wordmark />
            </Link>
          </div>

          {visibleColumns.map((column) => (
            <div key={column.title} className="flex flex-col gap-4 md:col-span-3">
              <h3 className="text-xs font-semibold tracking-[0.14em] text-foreground/80 uppercase">
                {column.title}
              </h3>
              {column.links.map((link) => (
                <FooterLink key={`${link.href}-${link.text}`} text={link.text} href={link.href} />
              ))}
            </div>
          ))}

          {/* Developer services as icon buttons, two per row. */}
          <div className="flex flex-col gap-4 md:col-span-2">
            <h3 className="text-xs font-semibold tracking-[0.14em] text-foreground/80 uppercase">
              {t('landing.footer.groups.developers')}
            </h3>
            <nav
              aria-label={t('landing.footer.groups.developers')}
              className="grid w-fit grid-cols-2 gap-2.5"
            >
              {devServices.map(({ label, href, Icon }) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  title={label}
                  className="flex size-10 items-center justify-center rounded-xl bg-white text-zinc-900 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-primary hover:text-primary-foreground"
                >
                  <Icon className="size-5" />
                </a>
              ))}
            </nav>
          </div>
        </div>
      </div>
    </footer>
  );
}
