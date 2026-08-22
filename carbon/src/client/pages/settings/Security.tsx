import type { Factor } from '@supabase/supabase-js';
import {
  IconShieldCheck as ShieldCheck,
  IconShieldOff as ShieldOff,
  IconDeviceMobile as Smartphone,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useAuth } from '@/components/auth/AuthProvider';
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
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Switch } from '@/components/ui/switch';
import { ContentPanel } from '../../components/ContentPanel';

export default function Security() {
  const { t } = useTranslation();
  const { mfa, hasMfaEnabled, mfaRequired } = useAuth();
  const [searchParams] = useSearchParams();

  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Enrollment state
  const [enrolling, setEnrolling] = useState(false);
  const [enrollmentData, setEnrollmentData] = useState<{
    id: string;
    qrCode: string;
    secret: string;
  } | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [verifying, setVerifying] = useState(false);

  // Unenroll state
  const [unenrolling, setUnenrolling] = useState(false);
  const [factorToUnenroll, setFactorToUnenroll] = useState<string | null>(null);

  // Show setup prompt if redirected from login with MFA required
  const setupRequired = searchParams.get('setup') === 'required';

  const loadFactors = useCallback(async () => {
    try {
      const factorList = await mfa.listFactors();
      setFactors(factorList.filter((f) => f.status === 'verified'));
    } catch {
      setError('Failed to load MFA factors');
    } finally {
      setLoading(false);
    }
  }, [mfa]);

  // Load factors on mount
  useEffect(() => {
    loadFactors();
  }, [loadFactors]);

  const handleStartEnrollment = async () => {
    setEnrolling(true);
    setError('');

    try {
      const data = await mfa.enroll('Authenticator App');
      if (data && data.type === 'totp' && 'totp' in data) {
        setEnrollmentData({
          id: data.id,
          qrCode: data.totp.qr_code,
          secret: data.totp.secret,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start enrollment');
      setEnrolling(false);
    }
  };

  const handleVerifyEnrollment = async () => {
    if (!enrollmentData || verificationCode.length !== 6) return;

    setVerifying(true);
    setError('');

    try {
      // Create challenge and verify
      const challenge = await mfa.challenge(enrollmentData.id);
      if (challenge) {
        await mfa.verify(enrollmentData.id, challenge.id, verificationCode);
      }

      // Success - refresh factors and close dialog
      await loadFactors();
      setEnrollmentData(null);
      setEnrolling(false);
      setVerificationCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid verification code');
      setVerificationCode('');
    } finally {
      setVerifying(false);
    }
  };

  const handleCancelEnrollment = async () => {
    // If we have an unverified factor, unenroll it
    if (enrollmentData) {
      try {
        await mfa.unenroll(enrollmentData.id);
      } catch {
        // Ignore error - factor may not exist
      }
    }
    setEnrollmentData(null);
    setEnrolling(false);
    setVerificationCode('');
    setError('');
  };

  const handleUnenroll = async () => {
    if (!factorToUnenroll) return;

    setUnenrolling(true);
    setError('');

    try {
      await mfa.unenroll(factorToUnenroll);
      await loadFactors();
      setFactorToUnenroll(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable 2FA');
    } finally {
      setUnenrolling(false);
    }
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

        {error && (
          <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">{error}</div>
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
              {!loading && (
                <Switch
                  checked={hasMfaEnabled}
                  disabled={enrolling || unenrolling || mfaRequired}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      handleStartEnrollment();
                    } else if (factors.length > 0) {
                      setFactorToUnenroll(factors[0].id);
                    }
                  }}
                />
              )}
            </div>
          </CardHeader>
          {!loading && (hasMfaEnabled || mfaRequired) && (
            <CardContent className="space-y-4">
              {hasMfaEnabled && (
                <>
                  <div className="flex items-center gap-3 p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg">
                    <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-500 shrink-0" />
                    <p className="text-sm text-emerald-700 dark:text-emerald-300">
                      {t('security.mfaEnabledDescription')}
                    </p>
                  </div>

                  {factors.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">{t('security.enrolledAuthenticators')}</p>
                      {factors.map((factor) => (
                        <div
                          key={factor.id}
                          className="flex items-center justify-between p-3 border rounded-lg"
                        >
                          <div className="flex items-center gap-3">
                            <Smartphone className="size-4 text-muted-foreground" />
                            <span className="text-sm">
                              {factor.friendly_name || t('security.authenticatorApp')}
                            </span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setFactorToUnenroll(factor.id)}
                          >
                            {t('common.remove')}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {mfaRequired && (
                <p className="text-sm text-muted-foreground">{t('security.mfaRequiredByOrg')}</p>
              )}
            </CardContent>
          )}
        </Card>
      </ContentPanel>

      {/* Enrollment Dialog */}
      <Dialog open={!!enrollmentData} onOpenChange={() => handleCancelEnrollment()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('security.setupMfa')}</DialogTitle>
            <DialogDescription>{t('security.setupMfaDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* QR Code */}
            <div className="flex justify-center">
              {enrollmentData?.qrCode && (
                <div
                  className="p-4 bg-white rounded-lg"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: QR code is SVG from Supabase
                  dangerouslySetInnerHTML={{ __html: enrollmentData.qrCode }}
                />
              )}
            </div>

            {/* Manual entry */}
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground text-center">{t('security.cantScan')}</p>
              <code className="block text-center text-sm bg-muted p-2 rounded font-mono break-all">
                {enrollmentData?.secret}
              </code>
            </div>

            {/* Verification code input */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-center">{t('security.enterCode')}</p>
              <div className="flex justify-center">
                <InputOTP
                  maxLength={6}
                  value={verificationCode}
                  onChange={setVerificationCode}
                  onComplete={handleVerifyEnrollment}
                  disabled={verifying}
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
            </div>

            {error && (
              <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg text-center">
                {error}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={handleCancelEnrollment} disabled={verifying}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleVerifyEnrollment}
              disabled={verifying || verificationCode.length !== 6}
            >
              {verifying ? t('security.verifying') : t('security.verifyAndEnable')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unenroll Confirmation Dialog */}
      <Dialog open={!!factorToUnenroll} onOpenChange={() => setFactorToUnenroll(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('security.disableMfa')}</DialogTitle>
            <DialogDescription>{t('security.disableMfaDescription')}</DialogDescription>
          </DialogHeader>

          {mfaRequired && (
            <div className="p-3 text-sm text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300 rounded-lg">
              {t('security.disableMfaWarning')}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              onClick={() => setFactorToUnenroll(null)}
              disabled={unenrolling}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleUnenroll} disabled={unenrolling}>
              {unenrolling ? t('security.disabling') : t('security.disable2fa')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
