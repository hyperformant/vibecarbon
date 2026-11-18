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

interface SettingToggleProps {
  /** The app_settings key this switch writes through PATCH /api/v1/auth/admin/settings. */
  settingKey: 'mfa_enabled' | 'user_docs_enabled' | 'api_docs_enabled';
  label: string;
  description: string;
  checked: boolean;
  loading: boolean;
  loadingText: string;
  /** Shown in a toast when the update fails, and the request's fallback error. */
  errorMessage: string;
}

// One labelled switch for a global setting. Each owns its mutation, so one
// pending update disables only its own switch.
function SettingToggle({
  settingKey,
  label,
  description,
  checked,
  loading,
  loadingText,
  errorMessage,
}: SettingToggleProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiJson<void>(
        '/api/v1/auth/admin/settings',
        { method: 'PATCH', body: { [settingKey]: enabled } },
        errorMessage
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authSettingsQueryKey });
    },
    onError: () => {
      toast.error(errorMessage);
    },
  });

  return (
    <div className="flex items-center justify-between">
      <div className="space-y-0.5">
        <div className="font-medium">{label}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      {loading ? (
        <div className="text-sm text-muted-foreground">{loadingText}</div>
      ) : (
        <Switch
          checked={checked}
          onCheckedChange={(enabled) => mutation.mutate(enabled)}
          disabled={mutation.isPending}
        />
      )}
    </div>
  );
}

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
              {/* The MFA row keeps its English literals, the docs rows are translated. */}
              <SettingToggle
                settingKey="mfa_enabled"
                label="Require MFA"
                description="Users must set up two-factor authentication"
                checked={mfaEnabled}
                loading={mfaLoading}
                loadingText="Loading..."
                errorMessage="Failed to update MFA setting"
              />
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
              <SettingToggle
                settingKey="user_docs_enabled"
                label={t('admin.settings.documentation.userDocsLabel')}
                description={t('admin.settings.documentation.userDocsDescription')}
                checked={userDocsEnabled}
                loading={mfaLoading}
                loadingText={t('common.loading')}
                errorMessage={t('admin.settings.documentation.userDocsUpdateFailed')}
              />
              <SettingToggle
                settingKey="api_docs_enabled"
                label={t('admin.settings.documentation.apiDocsLabel')}
                description={t('admin.settings.documentation.apiDocsDescription')}
                checked={apiDocsEnabled}
                loading={mfaLoading}
                loadingText={t('common.loading')}
                errorMessage={t('admin.settings.documentation.apiDocsUpdateFailed')}
              />
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
                Used for auth emails (verification, password reset, magic links) and transactional
                emails.{' '}
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
