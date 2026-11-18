import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { AuthCardLayout, AuthLinkButton } from '../components/auth/AuthCardLayout';
import { syncAdminCookie, useAuth } from '../components/auth/AuthProvider';
import { TwoFactorCodeForm } from '../components/auth/TwoFactorCodeForm';
import { Button } from '../components/ui/button';
import { CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { getSafeRedirect, leavesThisHost, performRedirect } from '../lib/safe-redirect';

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
    // admin subdomain (the ForwardAuth bounce reaches here through /login).
    const minted = await syncAdminCookie(user?.role === 'super_admin');
    const target = getSafeRedirect(searchParams.get('redirect'));
    performRedirect(leavesThisHost(target) && !minted ? '/dashboard' : target, navigate);
  };

  const handleCancel = async () => {
    clearMfaChallenge();
    await signOut().catch(() => undefined);
    navigate('/login');
  };

  return (
    <AuthCardLayout>
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
            <CardTitle className="text-2xl text-primary">{t('auth.mfa.expiredTitle')}</CardTitle>
            <CardDescription>{t('auth.mfa.expiredDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <AuthLinkButton to="/login">{t('auth.signIn')}</AuthLinkButton>
          </CardContent>
        </>
      )}
    </AuthCardLayout>
  );
}
