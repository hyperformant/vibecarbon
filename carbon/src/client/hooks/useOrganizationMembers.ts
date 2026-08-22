import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAuthHeaders } from '@/lib/api';

export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export type Member = {
  id: string;
  role: MemberRole;
  createdAt: string;
  user: {
    id: string;
    email: string;
    name?: string;
    avatar?: string;
  } | null;
};

async function fetchMembers(orgId: string): Promise<Member[]> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/v1/organizations/${orgId}/members`, { headers });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch members');
  }

  const data = await response.json();
  return data.members;
}

async function addMember(orgId: string, email: string, role: 'ADMIN' | 'MEMBER'): Promise<Member> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/v1/organizations/${orgId}/members`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, role }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to add member');
  }

  const data = await response.json();
  return data.member;
}

async function updateMemberRole(orgId: string, userId: string, role: MemberRole): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/v1/organizations/${orgId}/members/${userId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ role }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to update role');
  }
}

async function removeMember(orgId: string, userId: string): Promise<void> {
  const headers = await getAuthHeaders();
  const response = await fetch(`/api/v1/organizations/${orgId}/members/${userId}`, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to remove member');
  }
}

export function useOrganizationMembers(orgId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['organization-members', orgId];

  const membersQuery = useQuery({
    queryKey,
    queryFn: () => {
      if (!orgId) throw new Error('Organization ID is required');
      return fetchMembers(orgId);
    },
    enabled: !!orgId,
  });

  const addMemberMutation = useMutation({
    mutationFn: ({ email, role }: { email: string; role: 'ADMIN' | 'MEMBER' }) => {
      if (!orgId) throw new Error('Organization ID is required');
      return addMember(orgId, email, role);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: MemberRole }) => {
      if (!orgId) throw new Error('Organization ID is required');
      return updateMemberRole(orgId, userId, role);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => {
      if (!orgId) throw new Error('Organization ID is required');
      return removeMember(orgId, userId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    members: membersQuery.data ?? [],
    isLoading: membersQuery.isLoading,
    error: membersQuery.error,
    refetch: membersQuery.refetch,
    addMember: addMemberMutation,
    updateRole: updateRoleMutation,
    removeMember: removeMemberMutation,
  };
}
