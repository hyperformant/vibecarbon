/**
 * Login's error banners are announced to screen readers (`role="alert"`),
 * like every other auth form's. The password form and the magic-link form
 * each have one; both used to be plain divs, so a failed sign-in was silent
 * for anyone not looking at the card.
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient, renderApp, resetAuthClient, stubFetch } from './_auth-harness';

vi.mock('@/lib/auth-client', async () => (await import('./_auth-harness')).authClientModule);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import Login from '@/pages/Login';

const routes = <Route path="/login" element={<Login />} />;

beforeEach(() => {
  resetAuthClient();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Login error banners', () => {
  it('announces a failed password sign-in', async () => {
    authClient.signIn.email.mockResolvedValueOnce({
      data: null,
      error: { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
    });
    await renderApp('/login', routes);

    await userEvent.type(await screen.findByPlaceholderText('auth.emailPlaceholder'), 'jane@example.com');
    await userEvent.type(screen.getByPlaceholderText('auth.passwordPlaceholder'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'auth.signInAction' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('auth.errors.invalidCredentials');
  });

  it('announces a failed magic-link request', async () => {
    authClient.signIn.magicLink.mockResolvedValueOnce({
      data: null,
      error: { status: 500, message: 'mailer down' },
    });
    await renderApp('/login', routes);

    await userEvent.click(await screen.findByRole('button', { name: 'auth.signInWithMagicLink' }));
    await userEvent.type(screen.getByPlaceholderText('auth.emailPlaceholder'), 'jane@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'auth.sendMagicLink' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('auth.magicLinkFailed');
  });
});
