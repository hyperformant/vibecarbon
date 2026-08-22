import { IconLoader2 as Loader2, IconAlertTriangle as TriangleAlert } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/components/auth/AuthProvider';
import { ContentPanel } from '@/components/ContentPanel';
import { AvatarUpload } from '@/components/FileUpload';
import { PageHeader } from '@/components/PageHeader';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';
import { supabase } from '@/lib/supabase';

async function deleteAccount(): Promise<void> {
  await apiJson<void>('/api/v1/me', { method: 'DELETE' }, 'Failed to delete account');
}

export default function Profile() {
  const { t } = useTranslation();
  const { user, isSuperAdmin, signOut } = useAuth();
  const navigate = useNavigate();
  const displayName = user?.user_metadata?.full_name || '';
  const [name, setName] = useState(displayName);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ data: { full_name: name } });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(t('profile.saved'));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAccount,
    onSuccess: async () => {
      await signOut();
      navigate('/login');
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  async function handleAvatarUpload(url: string) {
    await supabase.auth.updateUser({ data: { avatar_url: url } });
  }

  return (
    <>
      <PageHeader title={t('profile.title')} description={t('profile.description')} />

      <ContentPanel variant="narrow">
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.profileInfo')}</CardTitle>
            <CardDescription>{t('profile.profileInfoDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {user && (
              <AvatarUpload
                userId={user.id}
                currentUrl={user.user_metadata?.avatar_url}
                onUpload={handleAvatarUpload}
              />
            )}

            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="name">{t('profile.fullName')}</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('profile.namePlaceholder')}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="email">{t('profile.email')}</Label>
                <Input id="email" type="email" defaultValue={user?.email || ''} disabled />
                <p className="text-xs text-muted-foreground">{t('profile.emailChangeHint')}</p>
              </div>
            </div>

            <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              {saveMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('profile.account')}</CardTitle>
            <CardDescription>{t('profile.accountDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{t('dashboard.userId')}</p>
                <code className="text-sm text-muted-foreground">{user?.id}</code>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{t('profile.deleteAccount')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('profile.deleteAccountDescription')}
                </p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setDeleteDialogOpen(true)}>
                {t('common.delete')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </ContentPanel>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <TriangleAlert className="text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('profile.deleteAccountConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {isSuperAdmin
                ? t('profile.superAdminCannotDelete')
                : t('profile.deleteAccountConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            {!isSuperAdmin && (
              <AlertDialogAction
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {t('profile.deleteAccountConfirmButton')}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
