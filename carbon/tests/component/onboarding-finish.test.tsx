/**
 * Onboarding's last step marks the account onboarded. When that save fails,
 * the page says so (translated) and stays put, instead of an unhandled
 * rejection that leaves the button doing nothing.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const updateUser = vi.fn(async (_fields: Record<string, unknown>) => undefined);

vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'jane@example.com', name: 'Jane Doe' },
    updateUser,
  }),
}));

vi.mock('@/hooks/useOrganizations', () => ({
  useOrganizations: () => ({ createOrganization: vi.fn() }),
}));

vi.mock('@/components/SEO', () => ({ SEO: () => null }));

import Onboarding from '@/pages/Onboarding';

function renderOnboarding() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/dashboard" element={<p>dashboard-page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

async function reachPlanStep() {
  fireEvent.click(screen.getByRole('button', { name: 'common.continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'common.skipForNow' }));
  return screen.findByRole('button', { name: 'onboarding.plan.continueWithFree' });
}

beforeEach(() => {
  updateUser.mockReset();
  updateUser.mockResolvedValue(undefined);
});

describe('Onboarding: finishing', () => {
  it('marks the account onboarded and goes to the dashboard', async () => {
    renderOnboarding();
    fireEvent.click(await reachPlanStep());
    expect(await screen.findByText('dashboard-page')).toBeInTheDocument();
    expect(updateUser).toHaveBeenLastCalledWith({ onboardingCompleted: true });
  });

  it('a failed save shows a translated error and stays on the step', async () => {
    renderOnboarding();
    const finish = await reachPlanStep();
    updateUser.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(finish);
    expect(await screen.findByText('onboarding.plan.error')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('dashboard-page')).toBeNull());
  });
});
