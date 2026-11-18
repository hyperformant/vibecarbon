import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { AuthCardLayout, AuthLinkButton } from '../components/auth/AuthCardLayout';
import { FormError } from '../components/auth/FormError';
import { Button } from '../components/ui/button';
import { CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { authClient } from '../lib/auth-client';
import { authErrorKey, unwrap } from '../lib/auth-errors';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Landing page of the emailed reset link. The auth API checks the link and
 * sends the browser here with `?token=` (valid) or `?error=INVALID_TOKEN`.
 * Setting the password signs out every session of the account.
 */
export default function ResetPassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const validToken = !!token && !searchParams.get('error');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError(t('auth.reset.mismatch'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('auth.errors.passwordTooShort'));
      return;
    }

    setLoading(true);
    try {
      unwrap(await authClient.resetPassword({ newPassword: password, token: token ?? '' }));
      setSuccess(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      setError(t(authErrorKey(err, 'auth.reset.failed')));
    } finally {
      setLoading(false);
    }
  };

  if (!validToken) {
    return (
      <AuthCardLayout>
        <CardHeader className="text-center">
          <CardTitle className="text-2xl text-destructive">
            {t('auth.reset.invalidTitle')}
          </CardTitle>
          <CardDescription>{t('auth.reset.invalidDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AuthLinkButton to="/forgot-password">{t('auth.reset.requestNew')}</AuthLinkButton>
        </CardContent>
      </AuthCardLayout>
    );
  }

  return (
    <AuthCardLayout>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl text-primary">
          {success ? t('auth.reset.successTitle') : t('auth.reset.title')}
        </CardTitle>
        <CardDescription>
          {success ? t('auth.reset.redirecting') : t('auth.reset.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {success ? (
          <div className="p-3 text-sm text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 rounded-lg">
            {t('auth.reset.successDetail')}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <FormError>{error}</FormError>}

            <Input
              type="password"
              placeholder={t('auth.reset.newPassword')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              autoFocus
            />

            <Input
              type="password"
              placeholder={t('auth.reset.confirmPassword')}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
            />

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? t('auth.reset.updating') : t('auth.reset.update')}
            </Button>
          </form>
        )}
      </CardContent>
    </AuthCardLayout>
  );
}
