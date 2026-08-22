import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Wordmark } from '../components/Logo';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { supabase } from '../lib/supabase';

export default function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [validToken, setValidToken] = useState<boolean | null>(null);

  useEffect(() => {
    // Check if we have a valid recovery session
    // The Supabase client auto-detects the token from URL hash
    const checkSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      // Check URL hash for recovery type
      const hash = window.location.hash;
      const isRecovery = hash.includes('type=recovery') || hash.includes('type=invite');

      if (session || isRecovery) {
        setValidToken(true);
      } else {
        setValidToken(false);
      }
    };

    checkSession();

    // Listen for auth state changes (token validation)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setValidToken(true);
      } else if (event === 'SIGNED_IN' && session) {
        // Recovery token was validated
        setValidToken(true);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setLoading(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password,
      });

      if (error) throw error;

      setSuccess(true);

      // Sign out and redirect to login after 2 seconds
      setTimeout(async () => {
        await supabase.auth.signOut();
        navigate('/login?message=password_reset');
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setLoading(false);
    }
  };

  // Loading state while checking token
  if (validToken === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Validating reset link...</div>
      </div>
    );
  }

  // Invalid or expired token
  if (validToken === false) {
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
              <CardTitle className="text-2xl text-destructive">Invalid or expired link</CardTitle>
              <CardDescription>This password reset link is invalid or has expired.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-center text-sm text-muted-foreground">
                Please request a new password reset link.
              </p>
              <Link
                to="/forgot-password"
                className="inline-flex items-center justify-center w-full h-9 px-3 rounded-4xl bg-primary text-primary-foreground hover:bg-primary/80 text-sm font-medium transition-all"
              >
                Request new link
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

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
              {success ? 'Password updated' : 'Set new password'}
            </CardTitle>
            <CardDescription>
              {success ? 'Redirecting you to sign in...' : 'Enter your new password below'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {success ? (
              <div className="p-3 text-sm text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 rounded-lg">
                Your password has been successfully updated. You'll be redirected to sign in
                shortly.
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
                    {error}
                  </div>
                )}

                <Input
                  type="password"
                  placeholder="New password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                />

                <Input
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                />

                <Button type="submit" disabled={loading} className="w-full">
                  {loading ? 'Updating...' : 'Update password'}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
