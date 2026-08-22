import { Link } from 'react-router';
import { Logo } from '@/components/Logo';

interface FooterLink {
  to: string;
  label: string;
}

const defaultLinks: FooterLink[] = [
  { to: '/', label: 'Home' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/terms', label: 'Terms' },
];

/**
 * Minimal footer for secondary pages (contact, docs, blog, legal…). The
 * sticky header already carries the full wordmark, so this centers the
 * icon-only mark above the link row instead of repeating it.
 */
export function SiteFooter({ links = defaultLinks }: { links?: FooterLink[] }) {
  return (
    <footer className="border-t border-border py-8">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-4 px-6">
        <Link to="/" aria-label="Home">
          <Logo size="sm" />
        </Link>
        <div className="flex items-center gap-6">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </footer>
  );
}
