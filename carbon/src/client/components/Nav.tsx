import { IconArrowRight as ArrowRight, IconMenu2 as Menu, IconX as X } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useDocsVisibility } from '@/hooks/api';
import { cn } from '@/lib/utils';
import { useAuth } from './auth/AuthProvider';
import { GitHubStarsButton } from './GitHubStarsButton';
import { LanguageSwitcher } from './LanguageSwitcher';
import { Wordmark } from './Logo';
import { Button } from './ui/button';

export function Nav() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [isScrolled, setIsScrolled] = useState(false);

  const { userDocsEnabled, apiDocsEnabled } = useDocsVisibility();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on resize to desktop
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) setMobileOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <nav className="fixed inset-x-0 z-50 h-20" style={{ top: 'var(--notification-bar-h, 0px)' }}>
      {/* Background layer that fades in/out smoothly */}
      <div
        className={cn(
          'absolute inset-0 bg-background/80 backdrop-blur-xl border-b border-border/50 shadow-sm transition-opacity duration-500 ease-out',
          isScrolled || mobileOpen ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div className="relative mx-auto max-w-7xl h-full px-6 flex items-center justify-between">
        {/* Logo & Brand */}
        <Link to="/" className="group">
          <Wordmark />
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-2">
          <GitHubStarsButton />
          <LanguageSwitcher />
          {userDocsEnabled && (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/docs">{t('nav.docs')}</Link>
            </Button>
          )}
          {apiDocsEnabled && (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/api/docs">{t('nav.apiDocs')}</Link>
            </Button>
          )}
          {user ? (
            <Button variant="exciting" size="sm" asChild className="font-semibold gap-2">
              <Link to="/dashboard">
                {t('nav.dashboard')}
                <ArrowRight className="size-4 shrink-0" />
              </Link>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/login">{t('nav.logIn')}</Link>
              </Button>
              <Button size="sm" asChild>
                <Link to="/signup">{t('nav.signUp')}</Link>
              </Button>
            </>
          )}
        </div>

        {/* Mobile hamburger */}
        <button
          type="button"
          className="relative md:hidden p-2 text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
        >
          {mobileOpen ? <X className="size-6" /> : <Menu className="size-6" />}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="relative md:hidden bg-background/95 backdrop-blur-xl border-b border-border">
          <div className="mx-auto max-w-7xl px-6 py-6 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <LanguageSwitcher />
              <GitHubStarsButton />
            </div>
            {userDocsEnabled && (
              <Link
                to="/docs"
                onClick={() => setMobileOpen(false)}
                className="text-foreground font-medium transition-colors text-base"
              >
                {t('nav.docs')}
              </Link>
            )}
            {apiDocsEnabled && (
              <Link
                to="/api/docs"
                onClick={() => setMobileOpen(false)}
                className="text-foreground font-medium transition-colors text-base"
              >
                {t('nav.apiDocs')}
              </Link>
            )}
            <div className="flex flex-col gap-3 pt-2">
              {user ? (
                <Button
                  variant="exciting"
                  size="lg"
                  asChild
                  className="w-full text-base font-semibold justify-center gap-2"
                >
                  <Link to="/dashboard" onClick={() => setMobileOpen(false)}>
                    {t('nav.dashboard')}
                    <ArrowRight className="size-4 shrink-0" />
                  </Link>
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="lg"
                    asChild
                    className="w-full text-base justify-center"
                  >
                    <Link to="/login" onClick={() => setMobileOpen(false)}>
                      {t('nav.logIn')}
                    </Link>
                  </Button>
                  <Button size="lg" asChild className="w-full text-base justify-center">
                    <Link to="/signup" onClick={() => setMobileOpen(false)}>
                      {t('nav.signUp')}
                    </Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
