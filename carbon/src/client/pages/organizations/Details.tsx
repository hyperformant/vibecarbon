import {
  IconLoader2 as Loader2,
  IconPencil as Pencil,
  IconAlertTriangle as TriangleAlert,
} from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { OrganizationNotFound } from '@/components/OrganizationNotFound';
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
import { type Organization, useOrganizations } from '@/hooks/useOrganizations';
import { apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

async function deleteOrganization(orgId: string): Promise<void> {
  await apiJson<void>(
    `/api/v1/organizations/${orgId}`,
    { method: 'DELETE' },
    'Failed to delete organization'
  );
}

async function renameOrganization(
  orgId: string,
  name: string,
  fallback: string
): Promise<Organization> {
  const data = await apiJson<{ organization: Organization }>(
    `/api/v1/organizations/${orgId}`,
    { method: 'PATCH', body: { name } },
    fallback
  );
  return data.organization;
}

export default function OrgDetails() {
  const { orgId } = useParams<{ orgId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { organizations, memberships, refresh, isLoading: orgsLoading } = useOrganizations();
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const organization = organizations.find((org) => org.id === orgId);
  const isLastOrg = organizations.length <= 1;
  // The server lets an owner or an admin rename; a member gets no edit button.
  const role = memberships.find((m) => m.organization.id === orgId)?.role;
  const canEdit = role === 'OWNER' || role === 'ADMIN';
  const trimmedName = name.trim();

  const renameMutation = useMutation({
    mutationFn: () => renameOrganization(orgId ?? '', trimmedName, t('orgSettings.renameError')),
    onSuccess: async () => {
      // Every reader of the organizations (this page, the switcher) reads the
      // saved name from the server.
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setIsEditing(false);
      toast.success(t('orgSettings.renamed'));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const saveName = () => {
    if (trimmedName === organization?.name) {
      setIsEditing(false);
      return;
    }
    renameMutation.mutate();
  };

  const deleteMutation = useMutation({
    mutationFn: () => deleteOrganization(orgId ?? ''),
    onSuccess: async () => {
      await refresh();
      navigate('/dashboard');
      toast.success('Organization deleted');
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (orgsLoading) {
    return (
      <>
        <PageHeader title="Loading..." />
        <ContentPanel variant="default" className="flex items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </ContentPanel>
      </>
    );
  }

  if (!organization) {
    return <OrganizationNotFound />;
  }

  return (
    <>
      <PageHeader title="Organization Settings" />

      <ContentPanel variant="narrow">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{organization.name}</h2>
          <p className="text-muted-foreground">
            Manage your organization's settings and information
          </p>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle>Organization Information</CardTitle>
              <CardDescription>Basic details about this organization.</CardDescription>
            </div>
            {canEdit && !isEditing && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('orgSettings.editName')}
                onClick={() => {
                  setName(organization.name);
                  setIsEditing(true);
                }}
              >
                <Pencil className="size-4" />
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={isEditing ? name : organization.name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                disabled={!isEditing || renameMutation.isPending}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="slug">Slug</Label>
              <Input id="slug" defaultValue={organization.slug} disabled />
              <p className="text-xs text-muted-foreground">
                The slug is used in URLs and cannot be changed.
              </p>
            </div>
            <div className="grid gap-2">
              <Label>Plan</Label>
              <p className="text-sm font-medium">{organization.plan}</p>
            </div>
            {isEditing && (
              <div className="flex gap-2">
                <Button onClick={saveName} disabled={!trimmedName || renameMutation.isPending}>
                  {renameMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Save Changes
                </Button>
                <Button
                  variant="outline"
                  disabled={renameMutation.isPending}
                  onClick={() => setIsEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Organization ID</CardTitle>
            <CardDescription>Your unique organization identifier.</CardDescription>
          </CardHeader>
          <CardContent>
            <code className="text-sm text-muted-foreground">{organization.id}</code>
          </CardContent>
        </Card>

        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Danger Zone</CardTitle>
            <CardDescription>Irreversible and destructive actions.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Delete Organization</p>
                <p className="text-sm text-muted-foreground">
                  Permanently delete this organization and all its data. This action cannot be
                  undone.
                </p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setDeleteDialogOpen(true)}>
                Delete
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
            <AlertDialogTitle>Delete "{organization.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {isLastOrg
                ? 'You cannot delete your only organization. Create another organization first.'
                : 'This action cannot be undone. All members will be removed and all organization data will be permanently deleted.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {!isLastOrg && (
              <AlertDialogAction
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Delete organization
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
