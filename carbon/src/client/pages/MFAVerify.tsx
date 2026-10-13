import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { syncAdminCookie, useAuth } from '../components/auth/AuthProvider';
import { TwoFactorCodeForm } from '../components/auth/TwoFactorCodeForm';
import { Wordmark } from '../components/Logo';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

/** The intended destination, if it is a same-site path (never an open redirect). */
function safeRedirect(param: string | null): string {
  if (param?.startsWith('/') && !param.startsWith('//') && !param.includes(':')) return param;
  return '/dashboard';
}

/**
 * Second step of a password sign-in for an account with two-factor on: the
 * password was right, and the server holds a short-lived challenge until a
 * code from the authenticator (or a backup code) arrives.
 */
export default function MFAVerify() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { pendingMfaChallenge, mfa, clearMfaChallenge, signOut } = useAuth();

  const handleVerify = async (code: string, kind: 'totp' | 'backup') => {
    const user = await mfa.verify(code, kind);
    // A fresh super-admin session needs its ForwardAuth cookie before any
    // admin subdomain.
    await syncAdminCookie(user?.role === 'super_admin');
    navigate(safeRedirect(searchParams.get('redirect')), { replace: true });
  };

  const handleCancel = async () => {
    clearMfaChallenge();
    await signOut().catch(() => undefined);
    navigate('/login');
  };

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
        <Card className="w-full max-w-md shadow-lg shadow-primary/5">
          {pendingMfaChallenge ? (
            <>
              <CardHeader className="text-center">
                <CardTitle className="text-2xl text-primary">{t('auth.mfa.title')}</CardTitle>
                <CardDescription>{t('auth.mfa.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <TwoFactorCodeForm onSubmit={handleVerify}>
                  <Button type="button" variant="ghost" onClick={handleCancel} className="w-full">
                    {t('auth.mfa.cancel')}
                  </Button>
                </TwoFactorCodeForm>
                <p className="text-center text-sm text-muted-foreground">{t('auth.mfa.help')}</p>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="text-center">
                <CardTitle className="text-2xl text-primary">
                  {t('auth.mfa.expiredTitle')}
                </CardTitle>
                <CardDescription>{t('auth.mfa.expiredDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link
                  to="/login"
                  className="inline-flex items-center justify-center w-full h-9 px-3 rounded-4xl bg-primary text-primary-foreground hover:bg-primary/80 text-sm font-medium transition-all"
                >
                  {t('auth.signIn')}
                </Link>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
