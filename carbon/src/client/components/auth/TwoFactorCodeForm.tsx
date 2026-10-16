import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { authErrorKey } from '@/lib/auth-errors';

/**
 * A second-factor code: six digits from the authenticator app, or one of the
 * backup codes shown at enrollment. Shared by the sign-in second step
 * (MFAVerify) and the step-up prompt, so both read and behave the same.
 *
 * `onSubmit` throws on a wrong code; the form shows the translated reason and
 * clears the field for another try.
 */
export function TwoFactorCodeForm({
  onSubmit,
  submitLabel,
  allowBackupCode = true,
  children,
}: {
  onSubmit: (code: string, kind: 'totp' | 'backup') => Promise<void>;
  submitLabel?: string;
  allowBackupCode?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'totp' | 'backup'>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (value = code) => {
    const trimmed = value.trim();
    if (kind === 'totp' && trimmed.length !== 6) {
      setError(t('auth.mfa.codeLength'));
      return;
    }
    if (kind === 'backup' && !trimmed) return;
    setError('');
    setLoading(true);
    try {
      await onSubmit(trimmed, kind);
    } catch (err) {
      setError(t(authErrorKey(err, 'auth.errors.invalidCode')));
      setCode('');
    } finally {
      setLoading(false);
    }
  };

  const switchKind = () => {
    setKind(kind === 'totp' ? 'backup' : 'totp');
    setCode('');
    setError('');
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {error && (
        <div role="alert" className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
          {error}
        </div>
      )}

      {kind === 'totp' ? (
        <div className="flex justify-center">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={setCode}
            onComplete={(value: string) => submit(value)}
            disabled={loading}
            aria-label={t('auth.mfa.codeLabel')}
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
      ) : (
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t('auth.mfa.backupPlaceholder')}
          aria-label={t('auth.mfa.backupLabel')}
          autoComplete="one-time-code"
          disabled={loading}
          autoFocus
        />
      )}

      <div className="space-y-2">
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? t('auth.mfa.verifying') : (submitLabel ?? t('auth.mfa.verify'))}
        </Button>
        {children}
      </div>

      {allowBackupCode && (
        <button
          type="button"
          onClick={switchKind}
          className="w-full text-center text-sm text-primary hover:underline cursor-pointer"
        >
          {kind === 'totp' ? t('auth.mfa.useBackupCode') : t('auth.mfa.useAuthenticator')}
        </button>
      )}
    </form>
  );
}
