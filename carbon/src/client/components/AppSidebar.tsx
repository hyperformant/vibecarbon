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
  type TablerIcon,
  IconCursorText as TextCursorInput,
  IconUser as User,
  IconUsers as Users,
} from '@tabler/icons-react';
import { useTheme } from 'next-themes';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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

interface NavItemProps {
  path: string;
  icon: TablerIcon;
  label: string;
  /** Shown while the sidebar is collapsed; defaults to the label. */
  tooltip?: string;
}

// A sidebar link: active on its own path, and prefetches its page on hover or
// focus (a no-op for a path that is not in prefetchMap).
function NavItem({ path, icon: Icon, label, tooltip = label }: NavItemProps) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={location.pathname === path}
        onClick={() => navigate(path)}
        onMouseEnter={() => prefetch(path)}
        onFocus={() => prefetch(path)}
        tooltip={tooltip}
        className="gap-0 p-0"
      >
        <IconSlot>
          <Icon className="size-4" />
        </IconSlot>
        <span className="group-data-[collapsible=icon]:hidden">{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// The "Back" entry at the top of the settings, organization and admin menus.
function BackToApp() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
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
            <span className="group-data-[collapsible=icon]:hidden">{t('common.back')}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
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

  const displayName = user?.name || 'User';

  const settingsItems: NavItemProps[] = [
    { path: '/settings/profile', icon: User, label: t('sidebar.profile') },
    { path: '/settings/billing', icon: CreditCard, label: t('sidebar.billing') },
    { path: '/settings/security', icon: Shield, label: t('sidebar.security') },
  ];

  const orgItems: NavItemProps[] = [
    {
      path: `/organizations/${currentOrgId}/details`,
      icon: Building2,
      label: t('sidebar.orgDetails'),
    },
    { path: `/organizations/${currentOrgId}/members`, icon: Users, label: t('sidebar.members') },
  ];

  // Jobs, AI Visibility, Contact and Newsletter are English literals, and two
  // of them have a longer tooltip than their label.
  const adminItems: NavItemProps[] = [
    { path: '/admin/dashboard', icon: LayoutDashboard, label: t('sidebar.overview') },
    { path: '/admin/organizations', icon: Building2, label: t('sidebar.organizations') },
    { path: '/admin/users', icon: Users, label: t('sidebar.users') },
    { path: '/admin/notifications', icon: Bell, label: t('sidebar.notifications') },
    { path: '/admin/logs', icon: FileText, label: t('sidebar.logs') },
    { path: '/admin/theme', icon: Palette, label: t('sidebar.theme') },
    { path: '/admin/jobs', icon: Clock, label: 'Jobs', tooltip: 'Background Jobs' },
    { path: '/admin/crawlers', icon: Robot, label: 'AI Visibility' },
    {
      path: '/admin/contact',
      icon: MessageSquare,
      label: 'Contact',
      tooltip: 'Contact Submissions',
    },
    { path: '/admin/newsletter', icon: Mail, label: 'Newsletter' },
    { path: '/admin/settings', icon: Settings, label: t('sidebar.settings') },
  ];

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
                      <NavItem
                        key={item.titleKey}
                        path={item.path}
                        icon={item.icon}
                        label={t(item.titleKey)}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {sidebarMode === 'settings' && (
            <>
              <BackToApp />

              {/* Settings Menu */}
              <SidebarGroup>
                <SidebarGroupLabel>{t('sidebar.userSettings')}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {settingsItems.map((item) => (
                      <NavItem key={item.path} {...item} />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {sidebarMode === 'org-settings' && currentOrg && (
            <>
              <BackToApp />

              {/* Org Settings Menu */}
              <SidebarGroup>
                <SidebarGroupLabel className="truncate">{currentOrg.name}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {orgItems.map((item) => (
                      <NavItem key={item.path} {...item} />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}

          {sidebarMode === 'admin' && (
            <>
              <BackToApp />

              {/* Admin Menu */}
              <SidebarGroup>
                <SidebarGroupLabel>{t('sidebar.superAdmin')}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {adminItems.map((item) => (
                      <NavItem key={item.path} {...item} />
                    ))}
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
                  {user?.image && <AvatarImage src={user.image} alt="" />}
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
