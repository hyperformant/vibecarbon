/**
 * Forgot / reset password on the auth API: the request names /reset-password
 * as the landing page, and that page sends the emailed token back with the
 * new password. An invalid link (?error=INVALID_TOKEN) never shows the form.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient, renderApp, resetAuthClient, stubFetch } from './_auth-harness';

vi.mock('@/lib/auth-client', async () => (await import('./_auth-harness')).authClientModule);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';

const routes = (
  <>
    <Route path="/forgot-password" element={<ForgotPassword />} />
    <Route path="/reset-password" element={<ResetPassword />} />
  </>
);

beforeEach(() => {
  resetAuthClient();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('password reset', () => {
  it('requests a reset link that lands on /reset-password', async () => {
    await renderApp('/forgot-password', routes);
    await userEvent.type(screen.getByPlaceholderText('auth.emailPlaceholder'), 'jane@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'auth.reset.sendLink' }));
    expect(authClient.requestPasswordReset).toHaveBeenCalledWith({
      email: 'jane@example.com',
      redirectTo: '/reset-password',
    });
    expect(await screen.findByText('auth.reset.sentDetail')).toBeInTheDocument();
  });

  it('sets the new password with the token from the link', async () => {
    await renderApp('/reset-password?token=tok-123', routes);
    await userEvent.type(screen.getByPlaceholderText('auth.reset.newPassword'), 'new-password-1');
    await userEvent.type(screen.getByPlaceholderText('auth.reset.confirmPassword'), 'new-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'auth.reset.update' }));
    await waitFor(() =>
      expect(authClient.resetPassword).toHaveBeenCalledWith({
        newPassword: 'new-password-1',
        token: 'tok-123',
      })
    );
    expect(await screen.findByText('auth.reset.successDetail')).toBeInTheDocument();
  });

  it('refuses mismatched passwords before calling the API', async () => {
    await renderApp('/reset-password?token=tok-123', routes);
    await userEvent.type(screen.getByPlaceholderText('auth.reset.newPassword'), 'new-password-1');
    await userEvent.type(screen.getByPlaceholderText('auth.reset.confirmPassword'), 'new-password-2');
    await userEvent.click(screen.getByRole('button', { name: 'auth.reset.update' }));
    expect(await screen.findByText('auth.reset.mismatch')).toBeInTheDocument();
    expect(authClient.resetPassword).not.toHaveBeenCalled();
  });

  it('an invalid or expired link offers a new one instead of the form', async () => {
    await renderApp('/reset-password?error=INVALID_TOKEN', routes);
    expect(screen.getByText('auth.reset.invalidTitle')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('auth.reset.newPassword')).not.toBeInTheDocument();
  });
});
