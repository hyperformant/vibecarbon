import {
  IconBook2 as Book,
  IconLock as Lock,
  IconMail as Mail,
  IconShield as Shield,
  IconLockOpen as Unlock,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { authSettingsQueryKey, useAuthSettings } from '@/hooks/api';
import { apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

type LockedAccount = {
  email: string;
  attemptCount: number;
  firstAttempt: string;
  lastAttempt: string;
};

const lockedAccountsQueryKey = ['admin', 'locked-accounts'];

export default function AdminSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: authSettings, isLoading: mfaLoading } = useAuthSettings();
  const mfaEnabled = authSettings?.settings?.mfaEnabled ?? false;
  const userDocsEnabled = authSettings?.settings?.userDocsEnabled ?? true;
  const apiDocsEnabled = authSettings?.settings?.apiDocsEnabled ?? true;

  const { data: lockedAccountsData, isLoading: lockedLoading } = useQuery<LockedAccount[]>({
    queryKey: lockedAccountsQueryKey,
    queryFn: async () => {
      const data = await apiJson<{ lockedAccounts?: LockedAccount[] }>(
        '/api/v1/auth/admin/locked-accounts',
        {},
        'Failed to fetch locked accounts'
      );
      return data.lockedAccounts || [];
    },
  });

  const lockedAccounts = lockedAccountsData ?? [];

  const mfaToggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiJson<void>(
        '/api/v1/auth/admin/settings',
        { method: 'PATCH', body: { mfa_enabled: enabled } },
        'Failed to update MFA setting'
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authSettingsQueryKey });
    },
    onError: () => {
      toast.error('Failed to update MFA setting');
    },
  });

  const userDocsToggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiJson<void>(
        '/api/v1/auth/admin/settings',
        { method: 'PATCH', body: { user_docs_enabled: enabled } },
        t('admin.settings.documentation.userDocsUpdateFailed')
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authSettingsQueryKey });
    },
    onError: () => {
      toast.error(t('admin.settings.documentation.userDocsUpdateFailed'));
    },
  });

  const apiDocsToggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiJson<void>(
        '/api/v1/auth/admin/settings',
        { method: 'PATCH', body: { api_docs_enabled: enabled } },
        t('admin.settings.documentation.apiDocsUpdateFailed')
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authSettingsQueryKey });
    },
    onError: () => {
      toast.error(t('admin.settings.documentation.apiDocsUpdateFailed'));
    },
  });

  const unlockMutation = useMutation({
    mutationFn: (email: string) =>
      apiJson<void>(
        '/api/v1/auth/admin/unlock-account',
        { method: 'POST', body: { email } },
        'Failed to unlock account'
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: lockedAccountsQueryKey });
    },
    onError: () => {
      toast.error('Failed to unlock account');
    },
  });

  return (
    <>
      <PageHeader title="Settings" description="Security and email configuration" />

      <ContentPanel variant="default">
        <div className="space-y-6">
          {/* Security Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="size-5" />
                Security
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="font-medium">Require MFA</div>
                  <div className="text-sm text-muted-foreground">
                    Users must set up two-factor authentication
                  </div>
                </div>
                {mfaLoading ? (
                  <div className="text-sm text-muted-foreground">Loading...</div>
                ) : (
                  <Switch
                    checked={mfaEnabled}
                    onCheckedChange={(enabled) => mfaToggleMutation.mutate(enabled)}
                    disabled={mfaToggleMutation.isPending}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* Documentation */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Book className="size-5" />
                {t('admin.settings.documentation.title')}
              </CardTitle>
              <CardDescription>{t('admin.settings.documentation.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="font-medium">
                    {t('admin.settings.documentation.userDocsLabel')}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {t('admin.settings.documentation.userDocsDescription')}
                  </div>
                </div>
                {mfaLoading ? (
                  <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
                ) : (
                  <Switch
                    checked={userDocsEnabled}
                    onCheckedChange={(enabled) => userDocsToggleMutation.mutate(enabled)}
                    disabled={userDocsToggleMutation.isPending}
                  />
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="font-medium">
                    {t('admin.settings.documentation.apiDocsLabel')}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {t('admin.settings.documentation.apiDocsDescription')}
                  </div>
                </div>
                {mfaLoading ? (
                  <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
                ) : (
                  <Switch
                    checked={apiDocsEnabled}
                    onCheckedChange={(enabled) => apiDocsToggleMutation.mutate(enabled)}
                    disabled={apiDocsToggleMutation.isPending}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* Email Setup */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="size-5" />
                Email (SMTP)
              </CardTitle>
              <CardDescription>
                Shared by Supabase Auth (auth emails) and the app (transactional emails).{' '}
                <a
                  href="https://resend.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Resend
                </a>{' '}
                recommended.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto">
                {`# .env.local
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_xxxx_your_key
SMTP_ADMIN_EMAIL=noreply@yourdomain.com
SMTP_SENDER_NAME=YourApp`}
              </pre>
            </CardContent>
          </Card>

          {/* Locked Accounts */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="size-5" />
                Locked Accounts
              </CardTitle>
              <CardDescription>
                Accounts temporarily locked due to failed login attempts
              </CardDescription>
            </CardHeader>
            <CardContent>
              {lockedLoading ? (
                <div className="text-sm text-muted-foreground">Loading...</div>
              ) : lockedAccounts.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No accounts are currently locked.
                </div>
              ) : (
                <div className="space-y-2">
                  {lockedAccounts.map((account) => (
                    <div
                      key={account.email}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div>
                        <div className="font-medium">{account.email}</div>
                        <div className="text-sm text-muted-foreground">
                          {account.attemptCount} failed attempts
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => unlockMutation.mutate(account.email)}
                        disabled={
                          unlockMutation.isPending && unlockMutation.variables === account.email
                        }
                      >
                        <Unlock className="size-4 mr-2" />
                        {unlockMutation.isPending && unlockMutation.variables === account.email
                          ? 'Unlocking...'
                          : 'Unlock'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </ContentPanel>
    </>
  );
}
