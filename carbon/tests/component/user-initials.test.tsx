/**
 * The admin Users table and the organization Members list take avatar
 * initials from `getUserInitials` in lib/utils, which trims the name. Each
 * page used to carry its own copy without the trim, so a name of only spaces
 * rendered an empty avatar instead of the email's initial.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('@/components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'me' }, impersonateUser: vi.fn() }),
}));
vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({ organizations: [{ id: 'o1', name: 'Acme' }] }),
}));
vi.mock('@/hooks/useOrganizationMembers', () => ({
  useOrganizationMembers: () => ({
    members: [
      {
        id: 'm1',
        role: 'MEMBER',
        createdAt: '2026-01-01T00:00:00Z',
        user: { id: 'u2', email: 'blank@example.com', name: '   ' },
      },
    ],
    isLoading: false,
    error: null,
    addMember: { mutateAsync: vi.fn(), isPending: false },
    updateRole: { mutateAsync: vi.fn(), isPending: false },
    removeMember: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

import AdminUsers from '@/pages/admin/Users';
import Members from '@/pages/organizations/Members';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(path: string, routes: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>{routes}</Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('avatar initials for a whitespace-only name', () => {
  it('admin Users shows the email initial', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          users: [
            {
              id: 'u2',
              email: 'blank@example.com',
              name: '   ',
              avatar: null,
              role: null,
              emailVerified: true,
              organizationCount: 0,
              lastSignIn: null,
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          pagination: { total: 1, totalPages: 1 },
        }),
        { status: 200 }
      )
    );
    renderAt('/admin/users', <Route path="/admin/users" element={<AdminUsers />} />);

    expect(await screen.findByText('B')).toBeInTheDocument();
  });

  it('organization Members shows the email initial', () => {
    renderAt(
      '/organizations/o1/members',
      <Route path="/organizations/:orgId/members" element={<Members />} />
    );

    expect(screen.getByText('B')).toBeInTheDocument();
  });
});
