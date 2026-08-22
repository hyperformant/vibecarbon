import { formatPlanPrice } from '@shared/pricing';
import {
  IconAlertCircle as AlertCircle,
  IconAlertTriangle as AlertTriangle,
  IconArrowRight as ArrowRight,
  IconBell as Bell,
  IconBook as Book,
  IconBuildingSkyscraper as Building,
  IconCircleCheck as CircleCheck,
  IconCreditCard as CreditCard,
  IconInfoCircle as InfoCircle,
  IconPlus as Plus,
  IconShieldCheck as ShieldCheck,
  IconShieldLock as ShieldLock,
  IconSparkles as Sparkles,
  IconUser as User,
  IconUsers as Users,
} from '@tabler/icons-react';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAuth } from '../components/auth/AuthProvider';
import { ContentPanel } from '../components/ContentPanel';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../components/ui/empty';
import { Skeleton } from '../components/ui/skeleton';
import { useDocsVisibility } from '../hooks/api';
import { useSubscription } from '../hooks/api/useSubscription';
import type { Notification, NotificationType } from '../hooks/useNotifications';
import { useNotifications } from '../hooks/useNotifications';
import { type Organization, useOrganizations } from '../hooks/useOrganizations';
import { cn, getUserInitials } from '../lib/utils';

function getGreetingKey() {
  const hour = new Date().getHours();
  if (hour < 12) return 'dashboard.greeting.morning';
  if (hour < 17) return 'dashboard.greeting.afternoon';
  return 'dashboard.greeting.evening';
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const NOTIFICATION_ICON: Record<NotificationType, ComponentType<{ className?: string }>> = {
  info: InfoCircle,
  success: CircleCheck,
  warning: AlertTriangle,
  error: AlertCircle,
};

const NOTIFICATION_TONE: Record<NotificationType, string> = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
};

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Card className="glass">
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between">
          <CardDescription className="text-xs font-medium tracking-wide uppercase">
            {label}
          </CardDescription>
          <div className="text-muted-foreground flex size-8 items-center justify-center rounded-md bg-muted">
            <Icon className="size-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-4">
        <p className="text-card-foreground truncate text-2xl font-semibold tracking-tight">
          {value}
        </p>
        {hint && <p className="text-muted-foreground mt-0.5 truncate text-xs">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function OrgRow({ org, role }: { org: Organization; role?: string }) {
  return (
    <Link
      to={`/organizations/${org.id}/details`}
      className="hover:bg-muted/40 group flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:border-border"
    >
      <div className="text-primary ring-primary/25 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold ring-1">
        {org.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm font-medium">{org.name}</p>
        <p className="text-muted-foreground truncate text-xs">/{org.slug}</p>
      </div>
      {role && (
        <Badge variant="secondary" className="shrink-0 capitalize">
          {role.toLowerCase()}
        </Badge>
      )}
      <ArrowRight className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

function NotificationRow({ notification }: { notification: Notification }) {
  const Icon = NOTIFICATION_ICON[notification.type] ?? InfoCircle;
  const tone = NOTIFICATION_TONE[notification.type] ?? 'text-primary';
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone)} />
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-medium">{notification.title}</p>
        {notification.message && (
          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
            {notification.message}
          </p>
        )}
      </div>
      <span className="text-muted-foreground shrink-0 text-xs whitespace-nowrap">
        {relativeTime(notification.createdAt)}
      </span>
    </div>
  );
}

function QuickAction({
  to,
  icon: Icon,
  label,
}: {
  to: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <Link
      to={to}
      className="hover:bg-muted/40 hover:border-primary/40 group flex flex-col items-start gap-3 rounded-xl border border-border bg-card/40 p-4 transition-colors"
    >
      <div className="text-primary flex size-9 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="size-4" />
      </div>
      <span className="text-foreground text-sm font-medium">{label}</span>
    </Link>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const {
    organizations,
    memberships,
    selectedOrganization,
    selectedOrganizationRole,
    isLoading: orgsLoading,
  } = useOrganizations();
  const { plan, isActive, isCanceling, subscription } = useSubscription();
  const { notifications, isLoading: notifsLoading } = useNotifications();
  const { userDocsEnabled } = useDocsVisibility();

  const greeting = t(getGreetingKey());
  const initials = getUserInitials(user);
  const firstName =
    user?.user_metadata?.full_name?.split(' ')[0] || user?.email?.split('@')[0] || 'there';
  const formattedDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const roleForOrg = (orgId: string) => memberships.find((m) => m.organization.id === orgId)?.role;

  const isFree = plan.id === 'free';
  const planStatus = isActive ? 'Active' : 'Inactive';
  const renewsOn =
    subscription?.currentPeriodEnd &&
    new Date(subscription.currentPeriodEnd).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  return (
    <>
      <PageHeader title={t('dashboard.title')} />

      <ContentPanel variant="full" className="space-y-8">
        {/* Welcome banner */}
        <Card className="glass relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 [background:radial-gradient(90%_140%_at_0%_0%,var(--glow-primary),transparent_55%)]" />
          <CardHeader className="relative">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="glow-teal-subtle text-primary ring-primary/30 flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xl font-semibold ring-1">
                  {initials}
                </div>
                <div>
                  <CardTitle className="font-display text-3xl tracking-tight">
                    {greeting}, {firstName}!
                  </CardTitle>
                  <CardDescription className="mt-1">{user?.email}</CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:flex-col sm:items-end">
                <Badge variant="outline" className="gap-1.5">
                  <Sparkles className="size-3" />
                  {plan.name}
                </Badge>
                <p className="text-muted-foreground rounded-full border border-border px-3 py-1.5 text-xs">
                  {formattedDate}
                </p>
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* User-scoped stats */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            icon={Sparkles}
            label="Current plan"
            value={plan.name}
            hint={isFree ? 'Upgrade available' : planStatus}
          />
          <StatCard
            icon={Building}
            label="Organizations"
            value={organizations.length}
            hint={selectedOrganization ? `Active: ${selectedOrganization.name}` : 'None yet'}
          />
          <StatCard
            icon={Bell}
            label="Notifications"
            value={notifications.length}
            hint={notifications.length === 1 ? 'unread message' : 'unread messages'}
          />
          <StatCard
            icon={ShieldCheck}
            label="Your role"
            value={
              selectedOrganizationRole ? (
                <span className="capitalize">{selectedOrganizationRole.toLowerCase()}</span>
              ) : (
                '—'
              )
            }
            hint={selectedOrganization?.name ?? 'No active org'}
          />
        </div>

        {/* Organizations + activity */}
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="flex flex-col">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle>Your organizations</CardTitle>
                  <CardDescription>Teams and workspaces you belong to</CardDescription>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link to="/settings/profile">
                    <Plus className="size-4" />
                    New
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex-1">
              {orgsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-14 w-full rounded-lg" />
                  <Skeleton className="h-14 w-full rounded-lg" />
                </div>
              ) : organizations.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Building />
                    </EmptyMedia>
                    <EmptyTitle>No organizations yet</EmptyTitle>
                    <EmptyDescription>
                      Create an organization to invite teammates and manage billing together.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="-mx-3 flex flex-col">
                  {organizations.map((org) => (
                    <OrgRow key={org.id} org={org} role={roleForOrg(org.id)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>Notifications and updates for your account</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              {notifsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-12 w-full rounded-lg" />
                </div>
              ) : notifications.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <CircleCheck />
                    </EmptyMedia>
                    <EmptyTitle>You're all caught up</EmptyTitle>
                    <EmptyDescription>New notifications will show up here.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="-mx-3 flex flex-col divide-y divide-border/60">
                  {notifications.slice(0, 6).map((n) => (
                    <NotificationRow key={n.id} notification={n} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Your plan */}
        <Card className="glass">
          <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="text-primary flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <CreditCard className="size-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-foreground text-base font-semibold">{plan.name} plan</p>
                  {!isFree && (
                    <Badge variant={isActive ? 'default' : 'secondary'}>{planStatus}</Badge>
                  )}
                </div>
                <p className="text-muted-foreground mt-0.5 text-sm">
                  {isFree
                    ? 'Upgrade for higher limits and team features.'
                    : isCanceling && renewsOn
                      ? `Cancels on ${renewsOn}`
                      : renewsOn
                        ? `Renews ${renewsOn} · ${formatPlanPrice(plan)}`
                        : formatPlanPrice(plan)}
                </p>
              </div>
            </div>
            <Button asChild variant={isFree ? 'default' : 'outline'}>
              <Link to="/settings/billing">
                {isFree ? 'Upgrade plan' : 'Manage billing'}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* Quick actions */}
        <div>
          <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
            Quick actions
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <QuickAction to="/settings/profile" icon={User} label="Profile" />
            <QuickAction to="/settings/security" icon={ShieldLock} label="Security" />
            <QuickAction to="/settings/billing" icon={CreditCard} label="Billing" />
            <QuickAction
              to={
                selectedOrganization
                  ? `/organizations/${selectedOrganization.id}/members`
                  : '/settings/profile'
              }
              icon={Users}
              label="Members"
            />
            {userDocsEnabled && <QuickAction to="/docs" icon={Book} label="Docs" />}
          </div>
        </div>
      </ContentPanel>
    </>
  );
}
