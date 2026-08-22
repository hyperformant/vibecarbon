import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../components/auth/AuthProvider';
import { Wordmark } from '../components/Logo';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '../components/ui/input-otp';

export default function MFAVerify() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { pendingMfaChallenge, mfa, clearMfaChallenge, signOut } = useAuth();

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleVerify = async () => {
    if (code.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }

    if (!pendingMfaChallenge) {
      setError('No pending MFA challenge. Please sign in again.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      await mfa.verify(pendingMfaChallenge.factorId, pendingMfaChallenge.challengeId, code);

      // Get redirect URL
      const redirectParam = searchParams.get('redirect') || '/dashboard';
      const safeRedirect =
        redirectParam.startsWith('/') &&
        !redirectParam.startsWith('//') &&
        !redirectParam.includes(':')
          ? redirectParam
          : '/dashboard';

      navigate(safeRedirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code. Please try again.');
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    clearMfaChallenge();
    await signOut();
    navigate('/login');
  };

  // If no pending challenge, show message
  if (!pendingMfaChallenge) {
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
              <CardTitle className="text-2xl text-primary">Session expired</CardTitle>
              <CardDescription>
                Your authentication session has expired. Please sign in again.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                to="/login"
                className="inline-flex items-center justify-center w-full h-9 px-3 rounded-4xl bg-primary text-primary-foreground hover:bg-primary/80 text-sm font-medium transition-all"
              >
                Sign in
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
            <CardTitle className="text-2xl text-primary">Two-factor authentication</CardTitle>
            <CardDescription>Enter the 6-digit code from your authenticator app</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {error && (
              <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
                {error}
              </div>
            )}

            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={setCode}
                onComplete={handleVerify}
                disabled={loading}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            <div className="space-y-2">
              <Button onClick={handleVerify} disabled={loading} className="w-full">
                {loading ? 'Verifying...' : 'Verify'}
              </Button>

              <Button variant="ghost" onClick={handleCancel} disabled={loading} className="w-full">
                Cancel and sign out
              </Button>
            </div>

            <p className="text-center text-sm text-muted-foreground">
              Open your authenticator app (Google Authenticator, Authy, etc.) and enter the code
              shown for this account.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
