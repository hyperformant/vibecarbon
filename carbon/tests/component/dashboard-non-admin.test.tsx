/**
 * The end-user dashboard renders for any authenticated user and no longer
 * carries the platform-wide admin KPI grid (that moved to /admin). This also
 * guards the old non-admin infinite-skeleton bug: there is no stats-gated grid
 * on this page at all anymore.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const useAuthMock = vi.fn();
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({
    organizations: [],
    memberships: [],
    selectedOrganization: null,
    selectedOrganizationRole: null,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/api/useSubscription', () => ({
  useSubscription: () => ({
    plan: { id: 'free', name: 'Free' },
    isActive: false,
    isCanceling: false,
    subscription: null,
  }),
}));

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({ notifications: [], isLoading: false }),
}));

// The Docs quick action is gated on runtime docs visibility. Mocked to the
// default (on) so these assertions stay about the KPI grid, not the settings
// fetch — docs-visibility gating has its own test.
vi.mock('@/hooks/api', () => ({
  useDocsVisibility: () => ({ userDocsEnabled: true, apiDocsEnabled: true, isLoading: false }),
}));

import Dashboard from '@/pages/Dashboard';

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );
}

describe('Dashboard (end-user home)', () => {
  it('renders for a non-super-admin without the platform KPI grid', () => {
    useAuthMock.mockReturnValue({
      user: { email: 'user@example.com', user_metadata: {} },
      isSuperAdmin: false,
    });
    renderDashboard();

    expect(screen.getByText('Quick actions')).toBeTruthy();
    expect(screen.getByText('Profile')).toBeTruthy();
    // Platform KPIs moved to /admin — never rendered on the end-user dashboard.
    expect(screen.queryByText(/total users/i)).toBeNull();
    expect(screen.queryByText('dashboard.totalUsers')).toBeNull();
  });

  it('shows the same end-user home for a super-admin (no KPI grid here)', () => {
    useAuthMock.mockReturnValue({
      user: { email: 'admin@example.com', user_metadata: {} },
      isSuperAdmin: true,
    });
    renderDashboard();

    expect(screen.getByText('Your organizations')).toBeTruthy();
    expect(screen.queryByText(/total users/i)).toBeNull();
  });
});
