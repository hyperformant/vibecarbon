import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Wordmark } from '../components/Logo';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
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

  const header = (
    <header className="h-20">
      <div className="mx-auto max-w-7xl h-full px-6 flex items-center">
        <Link to="/" className="group">
          <Wordmark />
        </Link>
      </div>
    </header>
  );

  if (!validToken) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        {header}
        <div className="flex-1 flex items-center justify-center p-4">
          <Card className="w-full max-w-md shadow-lg shadow-primary/5">
            <CardHeader className="text-center">
              <CardTitle className="text-2xl text-destructive">
                {t('auth.reset.invalidTitle')}
              </CardTitle>
              <CardDescription>{t('auth.reset.invalidDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                to="/forgot-password"
                className="inline-flex items-center justify-center w-full h-9 px-3 rounded-4xl bg-primary text-primary-foreground hover:bg-primary/80 text-sm font-medium transition-all"
              >
                {t('auth.reset.requestNew')}
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {header}
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-lg shadow-primary/5">
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
                {error && (
                  <div
                    role="alert"
                    className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg"
                  >
                    {error}
                  </div>
                )}

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
        </Card>
      </div>
    </div>
  );
}
