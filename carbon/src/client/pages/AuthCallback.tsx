import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { syncAdminCookie, useAuth } from '../components/auth/AuthProvider';

/**
 * Where a Google, Microsoft or magic-link sign-in lands. The auth API has
 * already set the session cookie; this page waits for the provider to read
 * it, mints the admin cookie for a super admin, and moves on.
 */
export default function AuthCallback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, isSuperAdmin, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      navigate('/login?error=auth_failed', { replace: true });
      return;
    }
    syncAdminCookie(isSuperAdmin).finally(() => navigate('/dashboard', { replace: true }));
  }, [user, isSuperAdmin, isLoading, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
        <p className="text-muted-foreground">{t('auth.completingSignIn')}</p>
      </div>
    </div>
  );
}
