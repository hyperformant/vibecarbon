import {
  IconArrowLeft as ArrowLeft,
  IconChartBar as BarChart2,
  IconBell as Bell,
  IconBuilding as Building2,
  IconSelector as ChevronsUpDown,
  IconClock as Clock,
  IconCreditCard as CreditCard,
  IconExternalLink as ExternalLink,
  IconFileText as FileText,
  IconLayoutDashboard as LayoutDashboard,
  IconLogout as LogOut,
  IconMail as Mail,
  IconMessage2 as MessageSquare,
  IconMoon as Moon,
  IconPalette as Palette,
  IconPlus as Plus,
  IconRobot as Robot,
  IconSettings as Settings,
  IconShield as Shield,
  IconSun as Sun,
  IconCursorText as TextCursorInput,
  IconUser as User,
  IconUsers as Users,
} from '@tabler/icons-react';
import { useTheme } from 'next-themes';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
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
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { useOrganizations } from '@/hooks/useOrganizations';
import { useEnabledServices } from '@/hooks/useRunningServices';
import { getServiceUrl } from '@/lib/admin-services';
import { cn, getUserInitials } from '@/lib/utils';
import { useAuth } from './auth/AuthProvider';
import { Logo, WordmarkText } from './Logo';

const prefetchMap: Record<string, () => Promise<unknown>> = {
  '/dashboard': () => import('@/pages/Dashboard'),
  '/ui-components': () => import('@/pages/UIComponents'),
  '/charts': () => import('@/pages/Charts'),
  '/settings/profile': () => import('@/pages/settings/Profile'),
  '/settings/billing': () => import('@/pages/settings/Billing'),
  '/settings/security': () => import('@/pages/settings/Security'),
  '/admin/dashboard': () => import('@/pages/admin/Dashboard'),
  '/admin/organizations': () => import('@/pages/admin/Organizations'),
  '/admin/users': () => import('@/pages/admin/Users'),
  '/admin/notifications': () => import('@/pages/admin/Notifications'),
  '/admin/logs': () => import('@/pages/admin/Logs'),
  '/admin/theme': () => import('@/pages/admin/Theme'),
  '/admin/settings': () => import('@/pages/admin/Settings'),
  '/admin/infrastructure': () => import('@/pages/admin/Infrastructure'),
  '/admin/jobs': () => import('@/pages/admin/Jobs'),
  '/admin/crawlers': () => import('@/pages/admin/Crawlers'),
  '/admin/contact': () => import('@/pages/admin/ContactSubmissions'),
  '/admin/newsletter': () => import('@/pages/admin/Newsletter'),
};

function prefetch(path: string) {
  prefetchMap[path]?.();
}

const menuItems = [
  {
    titleKey: 'sidebar.dashboard',
    icon: LayoutDashboard,
    path: '/dashboard',
  },
  {
    titleKey: 'sidebar.uiComponents',
    icon: TextCursorInput,
    path: '/ui-components',
  },
  {
    titleKey: 'sidebar.charts',
    icon: BarChart2,
    path: '/charts',
  },
];

// Fixed-width icon container matching collapsed SidebarMenuButton size (40px)
function IconSlot({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`flex size-10 shrink-0 items-center justify-center rounded-md ${className}`}>
      {children}
    </span>
  );
}

export function AppSidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isSuperAdmin, signOut } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const { state, toggleSidebar } = useSidebar();
  const { organizations, selectedOrganization, selectOrganization, createOrganization } =
    useOrganizations();
  const [isCreateOrgOpen, setIsCreateOrgOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Derive sidebar mode from current path
  const sidebarMode = location.pathname.startsWith('/admin')
    ? 'admin'
    : location.pathname.startsWith('/settings')
      ? 'settings'
      : location.pathname.startsWith('/organizations/')
        ? 'org-settings'
        : 'user';

  // Extract orgId from path for org-settings mode
  const orgIdMatch = location.pathname.match(/^\/organizations\/([^/]+)/);
  const currentOrgId = orgIdMatch?.[1];
  const currentOrg = organizations.find((org) => org.id === currentOrgId);

  const { services: enabledServices } = useEnabledServices();
  const isCollapsed = state === 'collapsed';

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  const handleExternalLink = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  const handleCreateOrganization = async () => {
    if (!newOrgName.trim()) return;

    setIsCreating(true);
    setCreateError(null);

    try {
      await createOrganization(newOrgName.trim());
      setNewOrgName('');
      setIsCreateOrgOpen(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create organization');
    } finally {
      setIsCreating(false);
    }
  };

  const displayName = user?.user_metadata?.full_name || 'User';

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <button
            type="button"
            onClick={toggleSidebar}
            className="flex h-full w-full cursor-pointer items-center"
          >
            <IconSlot>
              <Logo size="sm" />
            </IconSlot>
            <span className="grid shrink-0 grid-cols-[1fr] opacity-100 transition-[grid-template-columns,opacity] duration-300 ease-in-out group-data-[collapsible=icon]:grid-cols-[0fr] group-data-[collapsible=icon]:opacity-0">
              <span className="overflow-hidden">
                <WordmarkText size="sm" />
              </span>
            </span>
          </button>
        </SidebarHeader>

        <SidebarContent>
          {sidebarMode === 'user' && (
            <>
              {/* Organization Switcher */}
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <DropdownMenu>
                      <DropdownMenuTrigger className="flex w-full items-center rounded-md border border-border text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-10 transition-colors cursor-pointer group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
                        <IconSlot>
                          <Building2 className="size-4" />
                        </IconSlot>
                        <span className="flex-1 truncate font-medium group-data-[collapsible=icon]:hidden">
                          {selectedOrganization?.name || t('sidebar.selectOrganization')}
                        </span>
                        <ChevronsUpDown className="mr-2 size-4 opacity-50 group-data-[collapsible=icon]:hidden" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side={isCollapsed ? 'right' : 'bottom'}>
                        {organizations.map((org) => {
                          const isSelected = selectedOrganization?.id === org.id;
                          return (
                            <DropdownMenuItem
                              key={org.id}
                              onClick={() => selectOrganization(org)}
                              className={`flex items-center justify-between ${isSelected ? 'bg-accent' : ''}`}
                            >
                              <span className="flex items-center gap-2">
                                <Building2 className="size-4" />
                                {org.name}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(`/organizations/${org.id}/details`);
                                }}
                                className="p-1.5 -mr-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent-foreground/10 transition-colors"
                              >
                                <Settings className="size-3.5" />
                              </button>
                            </DropdownMenuItem>
                          );
                        })}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="flex items-center gap-2"
                          onClick={() => setIsCreateOrgOpen(true)}
                        >
                          <Plus className="size-4" />
                          {t('sidebar.createOrganization')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>

              {/* Menu */}
              <SidebarGroup>
                <SidebarGroupLabel>{t('sidebar.menu')}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {menuItems.map((item) => (
                      <SidebarMenuItem key={item.titleKey}>
                        <SidebarMenuButton
                          isActive={location.pathname === item.path}
                          onClick={() => navigate(item.path)}
                          onMouseEnter={() => prefetch(item.path)}
                          onFocus={() => prefetch(item.path)}
                          tooltip={t(item.titleKey)}
                          className="gap-0 p-0"
                        >
                          <IconSlot>
                            <item.icon className="size-4" />
                          </IconSlot>
                          <span className="group-data-[collapsible=icon]:hidden">
                            {t(item.titleKey)}
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {sidebarMode === 'settings' && (
            <>
              {/* Back to App */}
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => navigate('/dashboard')}
                      tooltip={t('common.back')}
                      className="gap-0 p-0"
                    >
                      <IconSlot>
                        <ArrowLeft className="size-4" />
                      </IconSlot>
                      <span className="group-data-[collapsible=icon]:hidden">
                        {t('common.back')}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>

              {/* Settings Menu */}
              <SidebarGroup>
                <SidebarGroupLabel>{t('sidebar.userSettings')}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/settings/profile'}
                        onClick={() => navigate('/settings/profile')}
                        onMouseEnter={() => prefetch('/settings/profile')}
                        onFocus={() => prefetch('/settings/profile')}
                        tooltip={t('sidebar.profile')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <User className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.profile')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/settings/billing'}
                        onClick={() => navigate('/settings/billing')}
                        onMouseEnter={() => prefetch('/settings/billing')}
                        onFocus={() => prefetch('/settings/billing')}
                        tooltip={t('sidebar.billing')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <CreditCard className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.billing')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/settings/security'}
                        onClick={() => navigate('/settings/security')}
                        onMouseEnter={() => prefetch('/settings/security')}
                        onFocus={() => prefetch('/settings/security')}
                        tooltip={t('sidebar.security')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Shield className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.security')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {sidebarMode === 'org-settings' && currentOrg && (
            <>
              {/* Back to App */}
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => navigate('/dashboard')}
                      tooltip={t('common.back')}
                      className="gap-0 p-0"
                    >
                      <IconSlot>
                        <ArrowLeft className="size-4" />
                      </IconSlot>
                      <span className="group-data-[collapsible=icon]:hidden">
                        {t('common.back')}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>

              {/* Org Settings Menu */}
              <SidebarGroup>
                <SidebarGroupLabel className="truncate">{currentOrg.name}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === `/organizations/${currentOrgId}/details`}
                        onClick={() => navigate(`/organizations/${currentOrgId}/details`)}
                        tooltip={t('sidebar.orgDetails')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Building2 className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.orgDetails')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === `/organizations/${currentOrgId}/members`}
                        onClick={() => navigate(`/organizations/${currentOrgId}/members`)}
                        tooltip={t('sidebar.members')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Users className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.members')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {sidebarMode === 'admin' && (
            <>
              {/* Back to App */}
              <SidebarGroup>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => navigate('/dashboard')}
                      tooltip={t('common.back')}
                      className="gap-0 p-0"
                    >
                      <IconSlot>
                        <ArrowLeft className="size-4" />
                      </IconSlot>
                      <span className="group-data-[collapsible=icon]:hidden">
                        {t('common.back')}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>

              {/* Admin Menu */}
              <SidebarGroup>
                <SidebarGroupLabel>{t('sidebar.superAdmin')}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/dashboard'}
                        onClick={() => navigate('/admin/dashboard')}
                        onMouseEnter={() => prefetch('/admin/dashboard')}
                        onFocus={() => prefetch('/admin/dashboard')}
                        tooltip={t('sidebar.overview')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <LayoutDashboard className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.overview')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/organizations'}
                        onClick={() => navigate('/admin/organizations')}
                        onMouseEnter={() => prefetch('/admin/organizations')}
                        onFocus={() => prefetch('/admin/organizations')}
                        tooltip={t('sidebar.organizations')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Building2 className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.organizations')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/users'}
                        onClick={() => navigate('/admin/users')}
                        onMouseEnter={() => prefetch('/admin/users')}
                        onFocus={() => prefetch('/admin/users')}
                        tooltip={t('sidebar.users')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Users className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.users')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/notifications'}
                        onClick={() => navigate('/admin/notifications')}
                        onMouseEnter={() => prefetch('/admin/notifications')}
                        onFocus={() => prefetch('/admin/notifications')}
                        tooltip={t('sidebar.notifications')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Bell className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.notifications')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/logs'}
                        onClick={() => navigate('/admin/logs')}
                        onMouseEnter={() => prefetch('/admin/logs')}
                        onFocus={() => prefetch('/admin/logs')}
                        tooltip={t('sidebar.logs')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <FileText className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.logs')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/theme'}
                        onClick={() => navigate('/admin/theme')}
                        onMouseEnter={() => prefetch('/admin/theme')}
                        onFocus={() => prefetch('/admin/theme')}
                        tooltip={t('sidebar.theme')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Palette className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.theme')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/jobs'}
                        onClick={() => navigate('/admin/jobs')}
                        onMouseEnter={() => prefetch('/admin/jobs')}
                        onFocus={() => prefetch('/admin/jobs')}
                        tooltip="Background Jobs"
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Clock className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">Jobs</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/crawlers'}
                        onClick={() => navigate('/admin/crawlers')}
                        onMouseEnter={() => prefetch('/admin/crawlers')}
                        onFocus={() => prefetch('/admin/crawlers')}
                        tooltip="AI Visibility"
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Robot className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">AI Visibility</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/contact'}
                        onClick={() => navigate('/admin/contact')}
                        onMouseEnter={() => prefetch('/admin/contact')}
                        onFocus={() => prefetch('/admin/contact')}
                        tooltip="Contact Submissions"
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <MessageSquare className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">Contact</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/newsletter'}
                        onClick={() => navigate('/admin/newsletter')}
                        onMouseEnter={() => prefetch('/admin/newsletter')}
                        onFocus={() => prefetch('/admin/newsletter')}
                        tooltip="Newsletter"
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Mail className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">Newsletter</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={location.pathname === '/admin/settings'}
                        onClick={() => navigate('/admin/settings')}
                        onMouseEnter={() => prefetch('/admin/settings')}
                        onFocus={() => prefetch('/admin/settings')}
                        tooltip={t('sidebar.settings')}
                        className="gap-0 p-0"
                      >
                        <IconSlot>
                          <Settings className="size-4" />
                        </IconSlot>
                        <span className="group-data-[collapsible=icon]:hidden">
                          {t('sidebar.settings')}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    {enabledServices.map((service) => {
                      const url = getServiceUrl(service);
                      return (
                        <SidebarMenuItem key={service.id}>
                          <SidebarMenuButton
                            onClick={url ? () => handleExternalLink(url) : undefined}
                            tooltip={
                              url
                                ? service.description
                                : 'Internal only: kubectl port-forward svc/traefik-dashboard 8080:8080 -n vibecarbon'
                            }
                            className={cn('gap-0 p-0', !url && 'cursor-default opacity-50')}
                          >
                            <IconSlot>
                              <service.icon className="size-4" />
                            </IconSlot>
                            <span className="flex-1 group-data-[collapsible=icon]:hidden">
                              {service.name}
                            </span>
                            {url && (
                              <ExternalLink className="mr-2 size-3 opacity-50 group-data-[collapsible=icon]:hidden" />
                            )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}
        </SidebarContent>

        <SidebarFooter>
          {/* User Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger className="group/user flex w-full items-center rounded-md text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground h-12 transition-colors group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
              <IconSlot>
                <Avatar size="sm">
                  <AvatarFallback>{getUserInitials(user)}</AvatarFallback>
                </Avatar>
              </IconSlot>
              <div className="flex flex-1 flex-col overflow-hidden group-data-[collapsible=icon]:hidden">
                <span className="truncate font-medium text-sidebar-foreground group-hover/user:text-sidebar-accent-foreground transition-colors">
                  {displayName}
                </span>
                <span className="truncate text-xs text-sidebar-foreground/70 group-hover/user:text-sidebar-accent-foreground transition-colors">
                  {user?.email}
                </span>
              </div>
              <ChevronsUpDown className="mr-2 size-4 shrink-0 opacity-50 group-data-[collapsible=icon]:hidden" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side={isCollapsed ? 'right' : 'top'}
              className="min-w-56"
            >
              <div className="flex items-start justify-between px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{displayName}</p>
                  <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
                </div>
                <button
                  type="button"
                  onClick={toggleTheme}
                  className="relative size-9 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
                >
                  <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0 absolute" />
                  <Moon className="size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100 absolute" />
                  <span className="sr-only">{t('common.toggleTheme')}</span>
                </button>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/settings/profile')}>
                <Settings className="size-4" />
                {t('common.settings')}
              </DropdownMenuItem>
              {isSuperAdmin && (
                <DropdownMenuItem onClick={() => navigate('/admin/dashboard')}>
                  <Shield className="size-4" />
                  {t('sidebar.superAdmin')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut}>
                <LogOut className="size-4" />
                {t('common.signOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      </Sidebar>

      <Dialog open={isCreateOrgOpen} onOpenChange={setIsCreateOrgOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('createOrg.title')}</DialogTitle>
            <DialogDescription>{t('createOrg.description')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="org-name">{t('createOrg.nameLabel')}</Label>
              <Input
                id="org-name"
                placeholder={t('createOrg.namePlaceholder')}
                value={newOrgName}
                onChange={(e) => {
                  setNewOrgName(e.target.value);
                  setCreateError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreateOrganization();
                  }
                }}
                disabled={isCreating}
              />
              {createError && <p className="text-sm text-destructive">{createError}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsCreateOrgOpen(false);
                setCreateError(null);
                setNewOrgName('');
              }}
              disabled={isCreating}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateOrganization} disabled={!newOrgName.trim() || isCreating}>
              {isCreating ? t('common.creating') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
