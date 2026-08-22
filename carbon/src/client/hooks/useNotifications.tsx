import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import { useAuth } from '@/components/auth/AuthProvider';
import { getAuthHeaders } from '@/lib/api';

export type NotificationType = 'info' | 'warning' | 'error' | 'success';
export type NotificationVisibility = 'all' | 'authenticated' | 'public';

export type Notification = {
  id: string;
  title: string;
  message?: string;
  type: NotificationType;
  visibility?: NotificationVisibility;
  dismissible: boolean;
  action?: {
    label: string;
    url: string;
  };
  createdAt: string;
};

type NotificationContextValue = {
  notifications: Notification[];
  hasNotifications: boolean;
  isLoading: boolean;
  isDrawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  dismissNotification: (id: string) => Promise<void>;
  refetch: () => void;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

async function fetchNotifications(authenticated: boolean): Promise<Notification[]> {
  const headers: HeadersInit = authenticated ? await getAuthHeaders() : {};
  const response = await fetch('/api/v1/notifications', { headers });

  if (!response.ok) {
    if (response.status === 401) {
      return [];
    }
    throw new Error('Failed to fetch notifications');
  }

  const data = await response.json();
  return data.notifications;
}

async function dismissNotificationApi(notificationId: string): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/v1/notifications/${notificationId}/dismiss`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to dismiss notification');
  }
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const {
    data: notifications = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['notifications', !!user],
    queryFn: () => fetchNotifications(!!user),
    staleTime: Infinity, // Only fetch on page load
    refetchOnWindowFocus: false,
  });

  const dismissMutation = useMutation({
    mutationFn: dismissNotificationApi,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const openDrawer = useCallback(() => setIsDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setIsDrawerOpen(false), []);
  const toggleDrawer = useCallback(() => setIsDrawerOpen((prev) => !prev), []);

  const dismissNotification = useCallback(
    async (id: string) => {
      await dismissMutation.mutateAsync(id);
    },
    [dismissMutation]
  );

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        hasNotifications: notifications.length > 0,
        isLoading,
        isDrawerOpen,
        openDrawer,
        closeDrawer,
        toggleDrawer,
        dismissNotification,
        refetch,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
}
