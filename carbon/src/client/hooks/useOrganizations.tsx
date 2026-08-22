import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useAuth } from '@/components/auth/AuthProvider';

export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export type Organization = {
  id: string;
  name: string;
  slug: string;
  plan: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
  created_at: string;
  updated_at: string;
};

export type Membership = {
  id: string;
  role: OrganizationRole;
  organization: Organization;
};

type OrganizationsContextType = {
  /** List of organizations the user belongs to */
  organizations: Organization[];
  /** List of memberships with role info */
  memberships: Membership[];
  /** Currently selected organization */
  selectedOrganization: Organization | null;
  /** User's role in the selected organization */
  selectedOrganizationRole: OrganizationRole | null;
  /** Whether the user is an admin (OWNER or ADMIN) of the selected organization */
  isOrgAdmin: boolean;
  /** Whether the user is the owner of the selected organization */
  isOrgOwner: boolean;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: string | null;
  /** Select an organization */
  selectOrganization: (org: Organization) => void;
  /** Create a new organization */
  createOrganization: (name: string) => Promise<Organization>;
  /** Refresh organizations list */
  refresh: () => Promise<void>;
};

const OrganizationsContext = createContext<OrganizationsContextType | undefined>(undefined);

const SELECTED_ORG_KEY = 'selectedOrganizationId';

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50);
}

function transformMemberships(data: Record<string, unknown>[]): Membership[] {
  return (data || [])
    .filter((m) => m.organization !== null)
    .map((m) => ({
      id: m.id as string,
      role: m.role as OrganizationRole,
      organization: m.organization as unknown as Organization,
    }));
}

export function OrganizationsProvider({ children }: { children: ReactNode }) {
  const { user, session } = useAuth();
  const queryClient = useQueryClient();
  const [selectedOrganization, setSelectedOrganization] = useState<Organization | null>(null);

  const {
    data: memberships = [],
    isLoading,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: ['organizations', user?.id],
    queryFn: async () => {
      const response = await fetch('/api/v1/me', {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch organizations');
      }

      const { memberships: data } = await response.json();
      return transformMemberships(data);
    },
    enabled: !!user && !!session,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const error = queryError
    ? queryError instanceof Error
      ? queryError.message
      : 'Failed to fetch organizations'
    : null;

  // Restore selected organization from localStorage when memberships change
  useEffect(() => {
    if (memberships.length === 0) {
      setSelectedOrganization(null);
      return;
    }

    const savedOrgId = localStorage.getItem(SELECTED_ORG_KEY);
    const savedOrg = memberships.find((m) => m.organization.id === savedOrgId);

    if (savedOrg) {
      setSelectedOrganization(savedOrg.organization);
    } else {
      setSelectedOrganization(memberships[0].organization);
    }
  }, [memberships]);

  // Select organization handler
  const selectOrganization = useCallback((org: Organization) => {
    setSelectedOrganization(org);
    localStorage.setItem(SELECTED_ORG_KEY, org.id);
  }, []);

  // Create organization mutation
  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!session) {
        throw new Error('Not authenticated');
      }

      const slug = generateSlug(name);

      const response = await fetch('/api/v1/organizations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ name, slug }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create organization');
      }

      return data.organization as Organization;
    },
    onSuccess: (org) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      selectOrganization(org);
    },
  });

  const createOrganization = useCallback(
    async (name: string): Promise<Organization> => {
      return createMutation.mutateAsync(name);
    },
    [createMutation]
  );

  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  // Derived values
  const organizations = useMemo(() => memberships.map((m) => m.organization), [memberships]);

  const selectedMembership = useMemo(
    () => memberships.find((m) => m.organization.id === selectedOrganization?.id),
    [memberships, selectedOrganization]
  );

  const selectedOrganizationRole = selectedMembership?.role ?? null;
  const isOrgAdmin = selectedOrganizationRole === 'OWNER' || selectedOrganizationRole === 'ADMIN';
  const isOrgOwner = selectedOrganizationRole === 'OWNER';

  const value = useMemo(
    () => ({
      organizations,
      memberships,
      selectedOrganization,
      selectedOrganizationRole,
      isOrgAdmin,
      isOrgOwner,
      isLoading: !!user && isLoading,
      error,
      selectOrganization,
      createOrganization,
      refresh,
    }),
    [
      organizations,
      memberships,
      selectedOrganization,
      selectedOrganizationRole,
      isOrgAdmin,
      isOrgOwner,
      user,
      isLoading,
      error,
      selectOrganization,
      createOrganization,
      refresh,
    ]
  );

  return <OrganizationsContext.Provider value={value}>{children}</OrganizationsContext.Provider>;
}

export function useOrganizations() {
  const context = useContext(OrganizationsContext);
  if (context === undefined) {
    throw new Error('useOrganizations must be used within an OrganizationsProvider');
  }
  return context;
}
