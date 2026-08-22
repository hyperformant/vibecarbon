import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { syncAdminCookie, useAuth } from '../components/auth/AuthProvider';
import { Wordmark } from '../components/Logo';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useAuthSettings } from '../hooks/api';

type OAuthProvider = 'google' | 'microsoft' | 'github' | 'apple' | 'discord';

const providerConfig: Record<OAuthProvider, { label: string; icon: React.ReactNode }> = {
  google: {
    label: 'Google',
    icon: (
      <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        />
        <path
          fill="currentColor"
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        />
        <path
          fill="currentColor"
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        />
        <path
          fill="currentColor"
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        />
      </svg>
    ),
  },
  microsoft: {
    label: 'Microsoft',
    icon: (
      <svg className="size-4" viewBox="0 0 23 23" aria-hidden="true">
        <path fill="#f35325" d="M1 1h10v10H1z" />
        <path fill="#81bc06" d="M12 1h10v10H12z" />
        <path fill="#05a6f0" d="M1 12h10v10H1z" />
        <path fill="#ffba08" d="M12 12h10v10H12z" />
      </svg>
    ),
  },
  github: {
    label: 'GitHub',
    icon: (
      <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
      </svg>
    ),
  },
  apple: {
    label: 'Apple',
    icon: (
      <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
    ),
  },
  discord: {
    label: 'Discord',
    icon: (
      <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
      </svg>
    ),
  },
};

/**
 * Validate a redirect URL is safe (not an open redirect).
 * Allows relative paths and absolute URLs to sibling subdomains
 * (e.g., n8n.localhost when the app is on localhost).
 */
function getSafeRedirect(redirectParam: string | null): string {
  const fallback = '/dashboard';
  if (!redirectParam) return fallback;

  // Relative paths: must start with / and not // (protocol-relative)
  if (redirectParam.startsWith('/') && !redirectParam.startsWith('//')) {
    return redirectParam;
  }

  // Absolute URLs: allow ONLY the current host or a subdomain of it. The login
  // page is served on the app's own origin, so anchoring on
  // window.location.hostname is exact — this preserves the admin-tool
  // ForwardAuth flow (login on the apex, redirect back to studio./grafana.
  // subdomains) while rejecting look-alikes. The previous "last two DNS
  // labels" heuristic was an OPEN REDIRECT on multi-part public suffixes:
  // on app.example.co.uk it treated `co.uk` as the base domain, so
  // `https://evil.co.uk` matched and post-login users could be sent there.
  try {
    const url = new URL(redirectParam);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;

    const host = window.location.hostname;
    const target = url.hostname;
    if (target === host || target.endsWith(`.${host}`)) {
      return redirectParam; // same origin or a subdomain of it
    }
  } catch {
    // Invalid URL
  }

  return fallback;
}

/**
 * Navigate to redirect target — uses window.location for absolute URLs
 * (cross-subdomain) and react-router navigate for relative paths.
 */
function performRedirect(redirect: string, navigate: ReturnType<typeof useNavigate>) {
  if (redirect.startsWith('http://') || redirect.startsWith('https://')) {
    window.location.href = redirect;
  } else {
    navigate(redirect, { replace: true });
  }
}

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { user, signIn, signUp } = useAuth();
  const { data: authSettings } = useAuthSettings();

  // Default to signup mode if on /signup route
  const [isSignUp, setIsSignUp] = useState(location.pathname === '/signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [showMagicLink, setShowMagicLink] = useState(false);

  // Derive enabled providers from settings
  const providers = authSettings?.settings?.providers;
  const enabledProviders: OAuthProvider[] = providers
    ? (Object.entries(providers) as [OAuthProvider, boolean][])
        .filter(([, enabled]) => enabled)
        .map(([provider]) => provider)
    : [];
  const magicLinkEnabled = authSettings?.settings?.magicLinkEnabled ?? true;

  // Sync isSignUp state with route
  useEffect(() => {
    setIsSignUp(location.pathname === '/signup');
  }, [location.pathname]);

  // Redirect if already logged in. Await the ForwardAuth-cookie mint first:
  // this effect IS the bounce path when an admin's vc-admin-token expired on
  // a subdomain tool (ForwardAuth 302s here with ?redirect=), so the cookie
  // must be set before we send the browser back.
  useEffect(() => {
    if (user) {
      const safeRedirect = getSafeRedirect(searchParams.get('redirect'));
      syncAdminCookie().finally(() => performRedirect(safeRedirect, navigate));
    }
  }, [user, navigate, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const safeRedirect = getSafeRedirect(searchParams.get('redirect'));

      if (isSignUp) {
        await signUp(email, password, name);
        performRedirect(safeRedirect, navigate);
      } else {
        const { requiresMfa } = await signIn.email(email, password);
        if (requiresMfa) {
          // Redirect to MFA verification with the intended destination
          navigate(`/mfa-verify?redirect=${encodeURIComponent(safeRedirect)}`);
        } else {
          // Cross-subdomain targets need the ForwardAuth cookie before we leave
          await syncAdminCookie();
          performRedirect(safeRedirect, navigate);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.authFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setError('');
    setLoading(true);

    try {
      await signIn.magicLink(email);
      setMagicLinkSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.magicLinkFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = async (provider: OAuthProvider) => {
    setLoading(true);
    setError('');
    try {
      await signIn[provider]();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.oauthFailed'));
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="h-20">
        <div className="mx-auto max-w-7xl h-full px-6 flex items-center">
          <Link to="/" className="group">
            <Wordmark />
          </Link>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-lg shadow-primary/5">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl text-primary">
              {magicLinkSent
                ? t('auth.checkYourEmail')
                : isSignUp
                  ? t('auth.createAccount')
                  : t('auth.signIn')}
            </CardTitle>
            <CardDescription>
              {magicLinkSent ? t('auth.magicLinkSent', { email }) : t('auth.poweredBy')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {magicLinkSent ? (
              <div className="text-center space-y-4">
                <p className="text-sm text-muted-foreground">{t('auth.magicLinkExpiry')}</p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setMagicLinkSent(false);
                    setShowMagicLink(false);
                  }}
                >
                  {t('auth.backToSignIn')}
                </Button>
              </div>
            ) : showMagicLink ? (
              <>
                <form onSubmit={handleMagicLink} className="space-y-4">
                  {error && (
                    <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
                      {error}
                    </div>
                  )}
                  <Input
                    type="email"
                    placeholder={t('auth.emailPlaceholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                  <Button type="submit" disabled={loading} className="w-full">
                    {loading ? t('auth.sending') : t('auth.sendMagicLink')}
                  </Button>
                </form>
                <button
                  type="button"
                  onClick={() => setShowMagicLink(false)}
                  className="w-full text-center text-sm text-primary hover:underline"
                >
                  {t('auth.passwordInstead')}
                </button>
              </>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="space-y-4">
                  {error && (
                    <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
                      {error}
                    </div>
                  )}

                  {isSignUp && (
                    <Input
                      type="text"
                      placeholder={t('auth.namePlaceholder')}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  )}

                  <Input
                    type="email"
                    placeholder={t('auth.emailPlaceholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />

                  <Input
                    type="password"
                    placeholder={t('auth.passwordPlaceholder')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />

                  <div className="flex justify-between items-center">
                    {magicLinkEnabled && !isSignUp && (
                      <button
                        type="button"
                        onClick={() => setShowMagicLink(true)}
                        className="text-sm text-primary hover:underline cursor-pointer"
                      >
                        {t('auth.signInWithMagicLink')}
                      </button>
                    )}
                    {!isSignUp && (
                      <Link
                        to="/forgot-password"
                        className="text-sm text-primary hover:underline ml-auto"
                      >
                        {t('auth.forgotPassword')}
                      </Link>
                    )}
                  </div>

                  <Button type="submit" disabled={loading} className="w-full">
                    {loading
                      ? t('common.loading')
                      : isSignUp
                        ? t('auth.signUp')
                        : t('auth.signInAction')}
                  </Button>
                </form>

                {enabledProviders.length > 0 && (
                  <>
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-border/50" />
                      </div>
                      <div className="relative flex justify-center text-sm">
                        <span className="px-2 bg-transparent text-muted-foreground">
                          {t('auth.orContinueWith')}
                        </span>
                      </div>
                    </div>

                    <div
                      className={`grid gap-4 ${
                        enabledProviders.length === 1
                          ? 'grid-cols-1'
                          : enabledProviders.length === 2
                            ? 'grid-cols-2'
                            : enabledProviders.length === 3
                              ? 'grid-cols-3'
                              : 'grid-cols-2'
                      }`}
                    >
                      {enabledProviders.map((provider) => (
                        <Button
                          key={provider}
                          type="button"
                          variant="outline"
                          onClick={() => handleOAuth(provider)}
                          disabled={loading}
                        >
                          {providerConfig[provider].icon}
                          {providerConfig[provider].label}
                        </Button>
                      ))}
                    </div>
                  </>
                )}

                <p className="text-center text-sm text-muted-foreground">
                  {isSignUp ? t('auth.alreadyHaveAccount') : t('auth.dontHaveAccount')}{' '}
                  <button
                    type="button"
                    onClick={() => navigate(isSignUp ? '/login' : '/signup')}
                    className="text-primary hover:underline font-medium cursor-pointer"
                  >
                    {isSignUp ? t('auth.signIn') : t('nav.signUp')}
                  </button>
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
