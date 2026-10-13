import {
  IconShieldCheck as ShieldCheck,
  IconShieldOff as ShieldOff,
  IconDeviceMobile as Smartphone,
} from '@tabler/icons-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useAuth } from '@/components/auth/AuthProvider';
import { TwoFactorCodeForm } from '@/components/auth/TwoFactorCodeForm';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { authErrorKey } from '@/lib/auth-errors';
import { ContentPanel } from '../../components/ContentPanel';

/** The base32 secret inside an otpauth:// URI, for typing in by hand. */
function totpSecret(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

type Setup = { totpURI: string; backupCodes: string[] };

/**
 * Two-factor settings. Enrolling: (password, if the account has one) →
 * scan the QR code and keep the backup codes → confirm with a code from the
 * app. Turning it off needs a session that passed a code (the provider asks
 * for one when the server says so) and, for a password account, the password.
 */
export default function Security() {
  const { t } = useTranslation();
  const { mfa, hasMfaEnabled, mfaRequired } = useAuth();
  const [searchParams] = useSearchParams();

  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 'enable' | 'disable' while the confirm dialog (password and/or warning) is open
  const [confirming, setConfirming] = useState<'enable' | 'disable' | null>(null);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);

  const setupRequired = searchParams.get('setup') === 'required';

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once; mfa is rebuilt each render
  useEffect(() => {
    mfa
      .hasPassword()
      .then(setHasPassword)
      .catch(() => setHasPassword(true));
  }, []);

  const closeConfirm = () => {
    setConfirming(null);
    setPassword('');
  };

  const startEnrollment = async (pw?: string) => {
    setBusy(true);
    setError('');
    try {
      setSetup(await mfa.enroll(pw));
      closeConfirm();
    } catch (err) {
      setError(t(authErrorKey(err, 'security.enrollFailed')));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (pw?: string) => {
    setBusy(true);
    setError('');
    try {
      await mfa.disable(pw);
      closeConfirm();
    } catch (err) {
      setError(t(authErrorKey(err, 'security.disableFailed')));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = (checked: boolean) => {
    setError('');
    if (checked) {
      if (hasPassword) setConfirming('enable');
      else startEnrollment();
    } else {
      setConfirming('disable');
    }
  };

  const onConfirm = () => {
    const pw = hasPassword ? password : undefined;
    if (confirming === 'enable') startEnrollment(pw);
    else disable(pw);
  };

  const confirmEnrollment = async (code: string) => {
    await mfa.confirmEnrollment(code);
    setSetup(null);
  };

  return (
    <>
      <PageHeader title={t('security.title')} description={t('security.description')} />

      <ContentPanel variant="narrow">
        {setupRequired && !hasMfaEnabled && (
          <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg">
            <div className="flex items-start gap-3">
              <ShieldOff className="size-5 text-amber-600 dark:text-amber-500 mt-0.5" />
              <div>
                <p className="font-medium text-amber-800 dark:text-amber-200">
                  {t('security.mfaRequired')}
                </p>
                <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                  {t('security.mfaRequiredDescription')}
                </p>
              </div>
            </div>
          </div>
        )}

        {error && !confirming && !setup && (
          <div role="alert" className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
            {error}
          </div>
        )}

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2">
                  <Smartphone className="size-5" />
                  {t('security.twoFactor')}
                </CardTitle>
                <CardDescription>{t('security.twoFactorDescription')}</CardDescription>
              </div>
              {hasPassword !== null && (
                <Switch
                  aria-label={t('security.twoFactor')}
                  checked={hasMfaEnabled}
                  disabled={busy}
                  onCheckedChange={onToggle}
                />
              )}
            </div>
          </CardHeader>
          {(hasMfaEnabled || mfaRequired) && (
            <CardContent className="space-y-4">
              {hasMfaEnabled && (
                <div className="flex items-center gap-3 p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
                  <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-500 shrink-0" />
                  <p className="text-sm text-emerald-700 dark:text-emerald-300">
                    {t('security.mfaEnabledDescription')}
                  </p>
                </div>
              )}
              {mfaRequired && (
                <p className="text-sm text-muted-foreground">{t('security.mfaRequiredByOrg')}</p>
              )}
            </CardContent>
          )}
        </Card>
      </ContentPanel>

      {/* Password (and, for turning it off, the warning) before enable/disable */}
      <Dialog open={confirming !== null} onOpenChange={(open) => !open && closeConfirm()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirming === 'disable' ? t('security.disableMfa') : t('security.setupMfa')}
            </DialogTitle>
            <DialogDescription>
              {confirming === 'disable'
                ? t('security.disableMfaDescription')
                : t('security.passwordPrompt')}
            </DialogDescription>
          </DialogHeader>

          {confirming === 'disable' && mfaRequired && (
            <div className="p-3 text-sm text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded-lg">
              {t('security.disableMfaWarning')}
            </div>
          )}

          <form
            id="security-confirm"
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {hasPassword && (
              <>
                <Label htmlFor="security-password">{t('security.passwordLabel')}</Label>
                <Input
                  id="security-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                />
              </>
            )}
            {error && (
              <div
                role="alert"
                className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg"
              >
                {error}
              </div>
            )}
          </form>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={closeConfirm} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="security-confirm"
              variant={confirming === 'disable' ? 'destructive' : 'default'}
              disabled={busy || (hasPassword === true && !password)}
            >
              {confirming === 'disable'
                ? busy
                  ? t('security.disabling')
                  : t('security.disable2fa')
                : busy
                  ? t('security.settingUp')
                  : t('common.continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Setup: QR code, manual secret, backup codes, then the first code */}
      <Dialog open={setup !== null} onOpenChange={(open) => !open && setSetup(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('security.setupMfa')}</DialogTitle>
            <DialogDescription>{t('security.setupMfaDescription')}</DialogDescription>
          </DialogHeader>

          {setup && (
            <div className="space-y-6">
              <div className="flex justify-center">
                <div className="p-4 bg-white rounded-lg">
                  <QRCodeSVG value={setup.totpURI} size={176} title={t('security.qrTitle')} />
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm text-muted-foreground text-center">
                  {t('security.cantScan')}
                </p>
                <code className="block text-center text-sm bg-muted p-2 rounded font-mono break-all">
                  {totpSecret(setup.totpURI)}
                </code>
              </div>

              {setup.backupCodes.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t('security.backupCodes')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('security.backupCodesDescription')}
                  </p>
                  <ul
                    aria-label={t('security.backupCodes')}
                    className="grid grid-cols-2 gap-1 bg-muted p-3 rounded font-mono text-sm"
                  >
                    {setup.backupCodes.map((code) => (
                      <li key={code}>{code}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium text-center">{t('security.enterCode')}</p>
                <TwoFactorCodeForm
                  onSubmit={(code) => confirmEnrollment(code)}
                  submitLabel={t('security.verifyAndEnable')}
                  allowBackupCode={false}
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
