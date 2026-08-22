import {
  IconAlertCircle as AlertCircle,
  IconAlertTriangle as AlertTriangle,
  IconCircleCheck as CheckCircle2,
  IconInfoCircle as Info,
  IconX as X,
} from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { type NotificationType, useNotifications } from '@/hooks/useNotifications';
import { cn } from '@/lib/utils';

function getNotificationIcon(type: NotificationType) {
  switch (type) {
    case 'error':
      return <AlertCircle className="size-4" />;
    case 'warning':
      return <AlertTriangle className="size-4" />;
    case 'success':
      return <CheckCircle2 className="size-4" />;
    default:
      return <Info className="size-4" />;
  }
}

function getNotificationStyles(type: NotificationType) {
  switch (type) {
    case 'error':
      return 'bg-destructive border-destructive text-white';
    case 'warning':
      return 'bg-warning border-warning text-black/90';
    case 'success':
      return 'bg-success border-success text-white dark:text-black/90';
    default:
      return 'bg-primary border-primary text-primary-foreground';
  }
}

export function NotificationBar() {
  const { notifications, hasNotifications, isDrawerOpen, toggleDrawer, dismissNotification } =
    useNotifications();
  const barRef = useRef<HTMLDivElement>(null);

  // Measure bar height and set CSS variable so fixed elements (Nav, Sidebar) can offset their top
  useEffect(() => {
    const el = barRef.current;
    if (!el || !hasNotifications) {
      document.documentElement.style.removeProperty('--notification-bar-h');
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      document.documentElement.style.setProperty('--notification-bar-h', `${height}px`);
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--notification-bar-h');
    };
  }, [hasNotifications]);

  if (!hasNotifications) {
    return null;
  }

  const latestNotification = notifications[0];

  const handleAction = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div ref={barRef} className="sticky top-0 z-50 border-b">
      {/* Always visible bar showing latest notification */}
      <div
        className={cn(
          'flex items-center gap-3 px-4 py-2 transition-colors',
          getNotificationStyles(latestNotification.type)
        )}
      >
        <span className="shrink-0">{getNotificationIcon(latestNotification.type)}</span>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-medium text-sm truncate">{latestNotification.title}</span>
          {latestNotification.message && (
            <span className="text-sm opacity-80 truncate hidden sm:inline">
              - {latestNotification.message}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {latestNotification.action &&
            (() => {
              const action = latestNotification.action;
              return (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  onClick={() => handleAction(action.url)}
                >
                  {action.label}
                </Button>
              );
            })()}
          {notifications.length > 1 && (
            <Button variant="ghost" size="sm" className="h-7" onClick={toggleDrawer}>
              {isDrawerOpen ? 'Hide' : `+${notifications.length - 1} more`}
            </Button>
          )}
          {latestNotification.dismissible && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => dismissNotification(latestNotification.id)}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Expanded section showing additional notifications */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-300 ease-in-out',
          isDrawerOpen && notifications.length > 1 ? 'max-h-60' : 'max-h-0'
        )}
      >
        <div className="max-h-60 overflow-y-auto border-t">
          {notifications.slice(1).map((notification) => (
            <div
              key={notification.id}
              className={cn(
                'flex items-center gap-3 px-4 py-2 border-b last:border-b-0',
                getNotificationStyles(notification.type)
              )}
            >
              <span className="shrink-0">{getNotificationIcon(notification.type)}</span>
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm truncate">{notification.title}</span>
                {notification.message && (
                  <span className="text-sm opacity-80 ml-1 truncate">- {notification.message}</span>
                )}
              </div>
              {notification.action &&
                (() => {
                  const action = notification.action;
                  return (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0"
                      onClick={() => handleAction(action.url)}
                    >
                      {action.label}
                    </Button>
                  );
                })()}
              {notification.dismissible && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={() => dismissNotification(notification.id)}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
