import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { syncAdminCookie, useAuth } from '../components/auth/AuthProvider';
import { Wordmark } from '../components/Logo';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useAuthSettings } from '../hooks/api';
import { authErrorKey } from '../lib/auth-errors';
import { getSafeRedirect, leavesThisHost, performRedirect } from '../lib/safe-redirect';

type OAuthProvider = 'google' | 'microsoft';

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
};

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { user, isSuperAdmin, signIn, signUp } = useAuth();
  const { data: authSettings } = useAuthSettings();

  // Default to signup mode if on /signup route
  const [isSignUp, setIsSignUp] = useState(location.pathname === '/signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [showMagicLink, setShowMagicLink] = useState(false);

  // Derive enabled providers from settings
  const providers = authSettings?.settings?.providers;
  const enabledProviders = (['google', 'microsoft'] as const).filter(
    (provider) => providers?.[provider]
  );
  // Why the user landed here: a failed social or magic-link sign-in, or a
  // sensitive action that needs a fresh sign-in.
  const notice =
    searchParams.get('reason') === 'reauth'
      ? t('auth.errors.reauthRequired')
      : searchParams.get('error') === 'magic_link'
        ? t('auth.errors.magicLinkFailed')
        : searchParams.get('error')
          ? t('auth.oauthFailed')
          : '';
  const magicLinkEnabled = authSettings?.settings?.magicLinkEnabled ?? true;

  // Sync isSignUp state with route
  useEffect(() => {
    setIsSignUp(location.pathname === '/signup');
  }, [location.pathname]);

  // Redirect if already logged in. Await the ForwardAuth-cookie mint first:
  // this effect IS the bounce path when an admin's vc-admin-token expired on
  // a subdomain tool (ForwardAuth 302s here with ?redirect=), so the cookie
  // must be set before we send the browser back. Minting needs a session
  // that passed two-factor while MFA is on, so for a subdomain the mint may
  // ask for a code first. Without the cookie, the subdomain would only send
  // the browser back here: go to the dashboard instead.
  useEffect(() => {
    if (user) {
      const safeRedirect = getSafeRedirect(searchParams.get('redirect'));
      const away = leavesThisHost(safeRedirect);
      syncAdminCookie(isSuperAdmin, { stepUp: away }).then((minted) =>
        performRedirect(away && !minted ? '/dashboard' : safeRedirect, navigate)
      );
    }
  }, [user, isSuperAdmin, navigate, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const safeRedirect = getSafeRedirect(searchParams.get('redirect'));

      // On success the session lands in the AuthProvider, and the effect
      // above mints the admin cookie and redirects.
      if (isSignUp) {
        const { signedIn } = await signUp(email, password, name);
        if (!signedIn) setVerificationSent(true);
      } else {
        const { requiresMfa } = await signIn.email(email, password);
        if (requiresMfa) {
          // Second step, keeping the intended destination
          navigate(`/mfa-verify?redirect=${encodeURIComponent(safeRedirect)}`);
        }
      }
    } catch (err) {
      setError(t(authErrorKey(err)));
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
      setError(t(authErrorKey(err, 'auth.magicLinkFailed')));
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
      setError(t(authErrorKey(err, 'auth.oauthFailed')));
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
              {magicLinkSent || verificationSent
                ? t('auth.checkYourEmail')
                : isSignUp
                  ? t('auth.createAccount')
                  : t('auth.signIn')}
            </CardTitle>
            <CardDescription>
              {magicLinkSent
                ? t('auth.magicLinkSent', { email })
                : verificationSent
                  ? t('auth.verificationSent', { email })
                  : isSignUp
                    ? t('auth.signUpDescription')
                    : t('auth.signInDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {magicLinkSent || verificationSent ? (
              <div className="text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  {magicLinkSent ? t('auth.magicLinkExpiry') : t('auth.verificationHint')}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setMagicLinkSent(false);
                    setVerificationSent(false);
                    setShowMagicLink(false);
                    navigate('/login');
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
                  {notice && !error && (
                    <div role="status" className="p-3 text-sm bg-muted rounded-lg">
                      {notice}
                    </div>
                  )}
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
                        enabledProviders.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
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
