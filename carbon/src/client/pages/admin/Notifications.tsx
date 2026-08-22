import {
  IconAlertCircle as AlertCircle,
  IconAlertTriangle as AlertTriangle,
  IconCircleCheck as CheckCircle2,
  IconInfoCircle as Info,
  IconLoader2 as Loader2,
  IconDots as MoreHorizontal,
  IconPencil as Pencil,
  IconPlus as Plus,
  IconTrash as Trash2,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiJson } from '@/lib/api';
import { ContentPanel } from '../../components/ContentPanel';

type NotificationType = 'info' | 'warning' | 'error' | 'success';
type NotificationVisibility = 'all' | 'authenticated' | 'public';

type AdminNotification = {
  id: string;
  title: string;
  message?: string;
  type: NotificationType;
  visibility: NotificationVisibility;
  dismissible: boolean;
  organizationId?: string;
  startsAt?: string;
  endsAt?: string;
  actionLabel?: string;
  actionUrl?: string;
  isActive: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
};

type NotificationFormData = {
  title: string;
  message: string;
  type: NotificationType;
  visibility: NotificationVisibility;
  dismissible: boolean;
  isActive: boolean;
  actionLabel: string;
  actionUrl: string;
};

const defaultFormData: NotificationFormData = {
  title: '',
  message: '',
  type: 'info',
  visibility: 'all',
  dismissible: true,
  isActive: true,
  actionLabel: '',
  actionUrl: '',
};

async function fetchAdminNotifications(): Promise<AdminNotification[]> {
  const data = await apiJson<{ notifications: AdminNotification[] }>(
    '/api/v1/admin/notifications',
    {},
    'Failed to fetch notifications'
  );
  return data.notifications;
}

export async function createNotification(data: NotificationFormData): Promise<AdminNotification> {
  const result = await apiJson<{ notification: AdminNotification }>(
    '/api/v1/admin/notifications',
    {
      method: 'POST',
      body: {
        title: data.title,
        message: data.message || undefined,
        type: data.type,
        visibility: data.visibility,
        dismissible: data.dismissible,
        isActive: data.isActive,
        actionLabel: data.actionLabel || undefined,
        actionUrl: data.actionUrl || undefined,
      },
    },
    'Failed to create notification'
  );
  return result.notification;
}

async function updateNotification(
  id: string,
  data: Partial<NotificationFormData>
): Promise<AdminNotification> {
  const result = await apiJson<{ notification: AdminNotification }>(
    `/api/v1/admin/notifications/${id}`,
    { method: 'PATCH', body: data },
    'Failed to update notification'
  );
  return result.notification;
}

async function deleteNotification(id: string): Promise<void> {
  await apiJson<void>(
    `/api/v1/admin/notifications/${id}`,
    { method: 'DELETE' },
    'Failed to delete notification'
  );
}

function getTypeIcon(type: NotificationType) {
  switch (type) {
    case 'error':
      return <AlertCircle className="size-4 text-destructive" />;
    case 'warning':
      return <AlertTriangle className="size-4 text-warning" />;
    case 'success':
      return <CheckCircle2 className="size-4 text-success" />;
    default:
      return <Info className="size-4 text-info" />;
  }
}

function getTypeBadgeVariant(type: NotificationType) {
  switch (type) {
    case 'error':
      return 'destructive';
    case 'warning':
      return 'outline';
    case 'success':
      return 'default';
    default:
      return 'secondary';
  }
}

export default function AdminNotifications() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingNotification, setEditingNotification] = useState<AdminNotification | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AdminNotification | null>(null);
  const [formData, setFormData] = useState<NotificationFormData>(defaultFormData);

  const {
    data: notifications = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['admin-notifications'],
    queryFn: fetchAdminNotifications,
  });

  const createMutation = useMutation({
    mutationFn: createNotification,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      setIsCreateOpen(false);
      setFormData(defaultFormData);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<NotificationFormData> }) =>
      updateNotification(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      setEditingNotification(null);
      setFormData(defaultFormData);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteNotification,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      setDeleteConfirm(null);
    },
  });

  const handleCreate = () => {
    createMutation.mutate(formData);
  };

  const handleUpdate = () => {
    if (!editingNotification) return;
    updateMutation.mutate({ id: editingNotification.id, data: formData });
  };

  const handleEdit = (notification: AdminNotification) => {
    setFormData({
      title: notification.title,
      message: notification.message || '',
      type: notification.type,
      visibility: notification.visibility,
      dismissible: notification.dismissible,
      isActive: notification.isActive,
      actionLabel: notification.actionLabel || '',
      actionUrl: notification.actionUrl || '',
    });
    setEditingNotification(notification);
  };

  const handleToggleActive = (notification: AdminNotification) => {
    updateMutation.mutate({
      id: notification.id,
      data: { isActive: !notification.isActive },
    });
  };

  const isFormOpen = isCreateOpen || !!editingNotification;
  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <>
      <PageHeader title="Notifications" description="System-wide notifications" />

      <ContentPanel variant="full">
        <Card>
          <CardHeader>
            <CardTitle>All Notifications</CardTitle>
            <CardDescription>
              Active notifications are shown to users. Inactive notifications are hidden.
            </CardDescription>
            <CardAction>
              <Button onClick={() => setIsCreateOpen(true)}>
                <Plus className="mr-2 size-4" />
                Create Notification
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="py-8 text-center text-destructive">
                {error instanceof Error ? error.message : 'Failed to load notifications'}
              </div>
            ) : notifications.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                No notifications yet. Create one to get started.
              </div>
            ) : (
              <div className="space-y-3">
                {notifications.map((notification) => (
                  <div
                    key={notification.id}
                    className="flex items-center justify-between rounded-lg border p-4"
                  >
                    <div className="flex items-start gap-3">
                      {getTypeIcon(notification.type)}
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{notification.title}</p>
                          <Badge variant={getTypeBadgeVariant(notification.type)}>
                            {notification.type}
                          </Badge>
                          {notification.visibility !== 'all' && (
                            <Badge variant="outline">{notification.visibility}</Badge>
                          )}
                          {!notification.isActive && <Badge variant="outline">Inactive</Badge>}
                        </div>
                        {notification.message && (
                          <p className="text-sm text-muted-foreground mt-1">
                            {notification.message}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground mt-2">
                          Created {new Date(notification.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={notification.isActive}
                        onCheckedChange={() => handleToggleActive(notification)}
                        disabled={updateMutation.isPending}
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEdit(notification)}>
                            <Pencil className="mr-2 size-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteConfirm(notification)}
                          >
                            <Trash2 className="mr-2 size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </ContentPanel>

      {/* Create/Edit Dialog */}
      <Dialog
        open={isFormOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCreateOpen(false);
            setEditingNotification(null);
            setFormData(defaultFormData);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingNotification ? 'Edit Notification' : 'Create Notification'}
            </DialogTitle>
            <DialogDescription>
              {editingNotification
                ? 'Update the notification details below.'
                : 'Create a new notification to display to all users.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                placeholder="Notification title"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                disabled={isPending}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="message">Message (optional)</Label>
              <Textarea
                id="message"
                placeholder="Additional details..."
                value={formData.message}
                onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                disabled={isPending}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="type">Type</Label>
                <Select
                  defaultValue="info"
                  value={formData.type}
                  onValueChange={(value) =>
                    setFormData({ ...formData, type: value as NotificationType })
                  }
                  disabled={isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="info">
                      <span className="flex items-center gap-2">
                        <Info className="size-4 text-info" />
                        Info
                      </span>
                    </SelectItem>
                    <SelectItem value="success">
                      <span className="flex items-center gap-2">
                        <CheckCircle2 className="size-4 text-success" />
                        Success
                      </span>
                    </SelectItem>
                    <SelectItem value="warning">
                      <span className="flex items-center gap-2">
                        <AlertTriangle className="size-4 text-warning" />
                        Warning
                      </span>
                    </SelectItem>
                    <SelectItem value="error">
                      <span className="flex items-center gap-2">
                        <AlertCircle className="size-4 text-destructive" />
                        Error
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="visibility">Visibility</Label>
                <Select
                  defaultValue="all"
                  value={formData.visibility}
                  onValueChange={(value) =>
                    setFormData({ ...formData, visibility: value as NotificationVisibility })
                  }
                  disabled={isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All users</SelectItem>
                    <SelectItem value="authenticated">Authenticated only</SelectItem>
                    <SelectItem value="public">Public only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Options</Label>
              <div className="flex gap-6">
                <label
                  htmlFor="notification-dismissible"
                  className="flex items-center gap-2 text-sm"
                >
                  <Switch
                    id="notification-dismissible"
                    checked={formData.dismissible}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, dismissible: checked })
                    }
                    disabled={isPending}
                  />
                  Dismissible
                </label>
                <label htmlFor="notification-active" className="flex items-center gap-2 text-sm">
                  <Switch
                    id="notification-active"
                    checked={formData.isActive}
                    onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
                    disabled={isPending}
                  />
                  Active
                </label>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Action Button (optional)</Label>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Button label"
                  value={formData.actionLabel}
                  onChange={(e) => setFormData({ ...formData, actionLabel: e.target.value })}
                  disabled={isPending}
                />
                <Input
                  placeholder="URL"
                  value={formData.actionUrl}
                  onChange={(e) => setFormData({ ...formData, actionUrl: e.target.value })}
                  disabled={isPending}
                />
              </div>
            </div>
            {(createMutation.error || updateMutation.error) && (
              <p className="text-sm text-destructive">
                {createMutation.error instanceof Error
                  ? createMutation.error.message
                  : updateMutation.error instanceof Error
                    ? updateMutation.error.message
                    : 'An error occurred'}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsCreateOpen(false);
                setEditingNotification(null);
                setFormData(defaultFormData);
              }}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={editingNotification ? handleUpdate : handleCreate}
              disabled={!formData.title.trim() || isPending}
            >
              {isPending
                ? 'Saving...'
                : editingNotification
                  ? 'Save Changes'
                  : 'Create Notification'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Notification</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteConfirm?.title}"? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.error && (
            <p className="text-sm text-destructive">
              {deleteMutation.error instanceof Error
                ? deleteMutation.error.message
                : 'Failed to delete notification'}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirm(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
