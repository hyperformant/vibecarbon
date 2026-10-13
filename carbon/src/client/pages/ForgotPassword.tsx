import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Wordmark } from '../components/Logo';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { authClient } from '../lib/auth-client';
import { unwrap } from '../lib/auth-errors';

export default function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // The emailed link lands on /reset-password?token=... (or ?error=).
      unwrap(await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' }));
      // The same answer whether or not the account exists (no enumeration).
      setSuccess(true);
    } catch {
      setError(t('auth.reset.sendFailed'));
    } finally {
      setLoading(false);
    }
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
          <CardHeader className="text-center">
            <CardTitle className="text-2xl text-primary">{t('auth.reset.forgotTitle')}</CardTitle>
            <CardDescription>
              {success ? t('auth.reset.checkEmail') : t('auth.reset.forgotDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {success ? (
              <div className="space-y-4">
                <div className="p-3 text-sm text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 rounded-lg">
                  {t('auth.reset.sentDetail')}
                </div>
                <p className="text-center text-sm text-muted-foreground">
                  {t('auth.reset.didntReceive')}{' '}
                  <button
                    type="button"
                    onClick={() => setSuccess(false)}
                    className="text-primary hover:underline font-medium cursor-pointer"
                  >
                    {t('auth.reset.tryAgain')}
                  </button>
                </p>
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
                  type="email"
                  placeholder={t('auth.emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? t('auth.sending') : t('auth.reset.sendLink')}
                </Button>
              </form>
            )}

            <p className="text-center text-sm text-muted-foreground">
              {t('auth.reset.remember')}{' '}
              <Link to="/login" className="text-primary hover:underline font-medium">
                {t('auth.signIn')}
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
