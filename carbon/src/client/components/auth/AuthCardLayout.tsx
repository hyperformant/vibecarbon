import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Wordmark } from '@/components/Logo';
import { Card } from '@/components/ui/card';

/**
 * The page around every signed-out auth form (sign in, sign up, forgot and
 * reset password, the two-factor step): the wordmark header and one centred
 * card. Children are the card's header and content.
 */
export function AuthCardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="h-20">
        <div className="mx-auto max-w-7xl h-full px-6 flex items-center">
          <Link to="/" className="group">
            <Wordmark />
          </Link>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-lg shadow-primary/5">{children}</Card>
      </div>
    </div>
  );
}

/**
 * A full-width link styled as the primary button, for a card whose only
 * action is to go somewhere else (an expired two-factor step, a dead reset
 * link). The Button component cannot render as a Link (no asChild), so the
 * link carries the button's classes itself.
 */
export function AuthLinkButton({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center justify-center w-full h-9 px-3 rounded-4xl bg-primary text-primary-foreground hover:bg-primary/80 text-sm font-medium transition-all"
    >
      {children}
    </Link>
  );
}
