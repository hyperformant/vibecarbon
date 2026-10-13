/**
 * Settings > Security over the real AuthProvider and a mocked auth client:
 * enrolling an authenticator (password → QR code, secret and backup codes →
 * first code) and turning it off, which needs a session that passed a code
 * (the server's MFA_REQUIRED triggers the step-up prompt, then a retry).
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient, renderApp, resetAuthClient, signedIn, stubFetch } from './_auth-harness';

vi.mock('@/lib/auth-client', async () => (await import('./_auth-harness')).authClientModule);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import Security from '@/pages/settings/Security';

const routes = <Route path="/settings/security" element={<Security />} />;
const TOTP_URI = 'otpauth://totp/Carbon:jane%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Carbon';

beforeEach(() => {
  resetAuthClient();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enrolling an authenticator', () => {
  it('password account: password → QR, secret and backup codes → first code turns it on', async () => {
    signedIn();
    authClient.twoFactor.enable.mockResolvedValueOnce({
      data: { method: 'totp', totpURI: TOTP_URI, backupCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'] },
      error: null,
    });
    await renderApp('/settings/security', routes);

    await userEvent.click(await screen.findByRole('switch', { name: 'security.twoFactor' }));
    await userEvent.type(await screen.findByLabelText('security.passwordLabel'), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'common.continue' }));

    expect(authClient.twoFactor.enable).toHaveBeenCalledWith({ password: 'hunter2hunter2' });
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByText('aaaaa-bbbbb')).toBeInTheDocument();
    expect(screen.getByText('ccccc-ddddd')).toBeInTheDocument();
    expect(screen.getByTitle('security.qrTitle')).toBeInTheDocument();

    authClient.twoFactor.verifyTotp.mockImplementationOnce(async () => {
      signedIn({ twoFactorEnabled: true }, { twoFactorVerified: true });
      return { data: {}, error: null };
    });
    await userEvent.type(screen.getByLabelText('auth.mfa.codeLabel'), '123456');

    await waitFor(() =>
      expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({ code: '123456' })
    );
    await waitFor(() => expect(screen.queryByText('JBSWY3DPEHPK3PXP')).not.toBeInTheDocument());
    expect(screen.getByRole('switch', { name: 'security.twoFactor' })).toBeChecked();
  });

  it('an account without a password enrolls without being asked for one', async () => {
    signedIn();
    authClient.listAccounts.mockResolvedValueOnce({ data: [{ providerId: 'google' }], error: null });
    authClient.twoFactor.enable.mockResolvedValueOnce({
      data: { method: 'totp', totpURI: TOTP_URI, backupCodes: [] },
      error: null,
    });
    await renderApp('/settings/security', routes);

    await userEvent.click(await screen.findByRole('switch', { name: 'security.twoFactor' }));

    expect(authClient.twoFactor.enable).toHaveBeenCalledWith({});
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
  });

  it('an old passwordless session is sent to sign in again (reauth_required)', async () => {
    signedIn();
    authClient.listAccounts.mockResolvedValueOnce({ data: [{ providerId: 'google' }], error: null });
    authClient.twoFactor.enable.mockResolvedValueOnce({
      data: null,
      error: { status: 403, code: 'REAUTH_REQUIRED', error: 'reauth_required' },
    });
    await renderApp('/settings/security', routes);
    await userEvent.click(await screen.findByRole('switch', { name: 'security.twoFactor' }));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        'at:/login?reason=reauth&redirect=%2Fsettings%2Fsecurity'
      )
    );
  });

  it('a wrong password is explained, and nothing is enrolled', async () => {
    signedIn();
    authClient.twoFactor.enable.mockResolvedValueOnce({
      data: null,
      error: { status: 400, code: 'INVALID_PASSWORD' },
    });
    await renderApp('/settings/security', routes);
    await userEvent.click(await screen.findByRole('switch', { name: 'security.twoFactor' }));
    await userEvent.type(await screen.findByLabelText('security.passwordLabel'), 'wrong-pass');
    await userEvent.click(screen.getByRole('button', { name: 'common.continue' }));
    expect(await screen.findByText('auth.errors.invalidPassword')).toBeInTheDocument();
    expect(screen.queryByText('JBSWY3DPEHPK3PXP')).not.toBeInTheDocument();
  });
});

describe('turning two-factor off', () => {
  it('needs aal2: MFA_REQUIRED prompts for a code, then the disable is retried', async () => {
    signedIn({ twoFactorEnabled: true });
    authClient.twoFactor.disable
      .mockResolvedValueOnce({ data: null, error: { status: 403, code: 'MFA_REQUIRED' } })
      .mockImplementationOnce(async () => {
        signedIn({ twoFactorEnabled: false });
        return { data: { status: true }, error: null };
      });
    await renderApp('/settings/security', routes);

    const toggle = await screen.findByRole('switch', { name: 'security.twoFactor' });
    await waitFor(() => expect(toggle).toBeChecked());
    await userEvent.click(toggle);
    await userEvent.type(await screen.findByLabelText('security.passwordLabel'), 'hunter2hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'security.disable2fa' }));

    expect(await screen.findByText('auth.stepUp.title')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('auth.mfa.codeLabel'), '654321');

    await waitFor(() => expect(authClient.twoFactor.disable).toHaveBeenCalledTimes(2));
    expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({ code: '654321' });
    expect(authClient.twoFactor.disable).toHaveBeenLastCalledWith({ password: 'hunter2hunter2' });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'security.twoFactor' })).not.toBeChecked()
    );
  });
});
