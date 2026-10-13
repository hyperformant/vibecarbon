/**
 * The client side of the in-process auth API: the real AuthProvider, Login
 * and MFAVerify pages over a mocked `@/lib/auth-client`.
 *
 * Covers sign-in (plain and with a second factor), sign-out clearing the
 * ForwardAuth cookie, and the step-up flow: a 403 `mfa_required` from the
 * API prompts for a code and retries once; not enrolled routes to the
 * Security page; `reauth_required` signs the user out and back to /login.
 *
 * CSRF: jsdom fetches have no browser Origin semantics, so the server's
 * origin check is proven in the db tier (tests/db/auth.test.ts, "CSRF").
 * What these tests pin is the client half: every call is same-origin with
 * credentials and no Authorization header.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authClient,
  renderApp,
  resetAuthClient,
  signedIn,
  signedOut,
  stubFetch,
} from './_auth-harness';

vi.mock('@/lib/auth-client', async () => (await import('./_auth-harness')).authClientModule);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useAuth } from '@/components/auth/AuthProvider';
import { apiFetch } from '@/lib/api';
import Login from '@/pages/Login';
import MFAVerify from '@/pages/MFAVerify';

const location = () => screen.getByTestId('location').textContent;

function Probe() {
  const { user, signOut, impersonateUser, stopImpersonating, isImpersonating } = useAuth();
  // The API answer's status lands in document.title (outlives re-renders).
  const setStatus = (s: string) => {
    document.title = s;
  };
  return (
    <div>
      <p>user:{user?.email ?? 'none'}</p>
      <p>impersonating:{String(isImpersonating)}</p>
      <button type="button" onClick={() => signOut()}>
        sign-out
      </button>
      <button
        type="button"
        onClick={async () => {
          const res = await apiFetch('/api/v1/organizations/o1', { method: 'DELETE' });
          setStatus(String(res.status));
        }}
      >
        delete-org
      </button>
      <button type="button" onClick={() => impersonateUser('user-2').catch(() => undefined)}>
        impersonate
      </button>
      <button type="button" onClick={() => stopImpersonating()}>
        stop-impersonating
      </button>
    </div>
  );
}

const routes = (
  <>
    <Route path="/login" element={<Login />} />
    <Route path="/mfa-verify" element={<MFAVerify />} />
    <Route path="/dashboard" element={<p>dashboard-page</p>} />
    <Route path="/probe" element={<Probe />} />
  </>
);

let fetchMock: ReturnType<typeof stubFetch>;

beforeEach(() => {
  resetAuthClient();
  fetchMock = stubFetch();
  document.title = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The ForwardAuth cookie was cleared (DELETE) before the session ended. */
function expectAdminCookieClearedBeforeSignOut() {
  const del = fetchMock.mock.calls.findIndex(
    ([u, init]) => String(u) === '/api/v1/admin/forwardauth-cookie' && init?.method === 'DELETE'
  );
  expect(del).toBeGreaterThanOrEqual(0);
  expect(fetchMock.mock.invocationCallOrder[del]).toBeLessThan(
    authClient.signOut.mock.invocationCallOrder[0]
  );
}

async function submitLogin(email: string, password: string) {
  await userEvent.type(await screen.findByPlaceholderText('auth.emailPlaceholder'), email);
  await userEvent.type(screen.getByPlaceholderText('auth.passwordPlaceholder'), password);
  await userEvent.click(screen.getByRole('button', { name: 'auth.signInAction' }));
}

describe('sign-in', () => {
  it('a password sign-in goes through the auth API and lands on the dashboard', async () => {
    authClient.signIn.email.mockImplementation(async () => {
      signedIn();
      return { data: { redirect: false }, error: null };
    });
    await renderApp('/login', routes);

    await submitLogin('jane@example.com', 'correct horse');

    expect(authClient.signIn.email).toHaveBeenCalledWith({
      email: 'jane@example.com',
      password: 'correct horse',
    });
    expect(await screen.findByText('dashboard-page')).toBeInTheDocument();
    // A regular user never mints the ForwardAuth cookie.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('forwardauth-cookie'))).toBe(
      false
    );
  });

  it('shows a translated reason for a wrong password, not the server text', async () => {
    authClient.signIn.email.mockResolvedValueOnce({
      data: null,
      error: { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
    });
    await renderApp('/login', routes);
    await submitLogin('jane@example.com', 'wrong');
    expect(await screen.findByText('auth.errors.invalidCredentials')).toBeInTheDocument();
  });

  it('a 2FA account goes to /mfa-verify, and a backup code finishes the sign-in', async () => {
    authClient.signIn.email.mockResolvedValueOnce({
      data: { twoFactorRedirect: true, twoFactorMethods: ['totp'] },
      error: null,
    });
    await renderApp('/login?redirect=%2Fdashboard', routes);
    await submitLogin('jane@example.com', 'correct horse');

    expect(await screen.findByText('auth.mfa.title')).toBeInTheDocument();
    expect(location()).toBe('at:/mfa-verify?redirect=%2Fdashboard');

    authClient.twoFactor.verifyBackupCode.mockImplementationOnce(async () => {
      signedIn({ twoFactorEnabled: true }, { twoFactorVerified: true });
      return { data: {}, error: null };
    });
    await userEvent.click(screen.getByRole('button', { name: 'auth.mfa.useBackupCode' }));
    await userEvent.type(screen.getByLabelText('auth.mfa.backupLabel'), 'abcde-fghij');
    await userEvent.click(screen.getByRole('button', { name: 'auth.mfa.verify' }));

    expect(authClient.twoFactor.verifyBackupCode).toHaveBeenCalledWith({ code: 'abcde-fghij' });
    expect(await screen.findByText('dashboard-page')).toBeInTheDocument();
  });

  it('the authenticator code path calls verify-totp', async () => {
    authClient.signIn.email.mockResolvedValueOnce({
      data: { twoFactorRedirect: true, twoFactorMethods: ['totp'] },
      error: null,
    });
    await renderApp('/login', routes);
    await submitLogin('jane@example.com', 'correct horse');
    await screen.findByText('auth.mfa.title');

    authClient.twoFactor.verifyTotp.mockImplementationOnce(async () => {
      signedIn({ twoFactorEnabled: true }, { twoFactorVerified: true });
      return { data: {}, error: null };
    });
    await userEvent.type(screen.getByLabelText('auth.mfa.codeLabel'), '123456');

    await waitFor(() =>
      expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({ code: '123456' })
    );
    expect(await screen.findByText('dashboard-page')).toBeInTheDocument();
  });

  it('a wrong second-factor code stays on the page with a translated reason', async () => {
    authClient.signIn.email.mockResolvedValueOnce({
      data: { twoFactorRedirect: true },
      error: null,
    });
    authClient.twoFactor.verifyBackupCode.mockResolvedValueOnce({
      data: null,
      error: { status: 401, code: 'INVALID_BACKUP_CODE' },
    });
    await renderApp('/login', routes);
    await submitLogin('jane@example.com', 'correct horse');
    await userEvent.click(await screen.findByRole('button', { name: 'auth.mfa.useBackupCode' }));
    await userEvent.type(screen.getByLabelText('auth.mfa.backupLabel'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'auth.mfa.verify' }));
    expect(await screen.findByText('auth.errors.invalidCode')).toBeInTheDocument();
    expect(location()).toBe('at:/mfa-verify?redirect=%2Fdashboard');
  });
});

describe('sign-out', () => {
  it('clears the ForwardAuth cookie (super admin) before ending the session', async () => {
    signedIn({ role: 'super_admin' });
    await renderApp('/probe', routes);
    await screen.findByText('user:jane@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'sign-out' }));

    await waitFor(() => expect(authClient.signOut).toHaveBeenCalled());
    const del = fetchMock.mock.calls.findIndex(
      ([u, init]) =>
        String(u) === '/api/v1/admin/forwardauth-cookie' && init?.method === 'DELETE'
    );
    expect(del).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.invocationCallOrder[del]).toBeLessThan(
      authClient.signOut.mock.invocationCallOrder[0]
    );
    expect(await screen.findByText('user:none')).toBeInTheDocument();
  });

  it('a regular user signs out without touching the admin cookie', async () => {
    signedIn();
    await renderApp('/probe', routes);
    await screen.findByText('user:jane@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'sign-out' }));
    await waitFor(() => expect(authClient.signOut).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('forwardauth-cookie'))).toBe(
      false
    );
  });

  it('signing out while impersonating returns to the admin first, so both sessions end', async () => {
    signedIn({ id: 'user-2', email: 'target@example.com' }, { impersonatedBy: 'admin-1' });
    await renderApp('/probe', routes);
    await screen.findByText('impersonating:true');
    await userEvent.click(screen.getByRole('button', { name: 'sign-out' }));
    await waitFor(() => expect(authClient.signOut).toHaveBeenCalled());
    expect(authClient.admin.stopImpersonating.mock.invocationCallOrder[0]).toBeLessThan(
      authClient.signOut.mock.invocationCallOrder[0]
    );
  });
});

describe('impersonation restore failure', () => {
  it('signs out cleanly, ForwardAuth cookie included, when the admin session cannot be restored', async () => {
    signedIn({ id: 'user-2', email: 'target@example.com' }, { impersonatedBy: 'admin-1' });
    authClient.admin.stopImpersonating.mockResolvedValueOnce({
      data: null,
      error: { status: 500, message: 'Failed to find admin session' },
    });
    await renderApp('/probe', routes);
    await screen.findByText('impersonating:true');
    signedOut();
    await userEvent.click(screen.getByRole('button', { name: 'stop-impersonating' }));
    await waitFor(() => expect(authClient.signOut).toHaveBeenCalled());
    expectAdminCookieClearedBeforeSignOut();
    expect(await screen.findByText('user:none')).toBeInTheDocument();
  });
});

describe('the ForwardAuth bounce (admin subdomain -> /login?redirect=)', () => {
  const grafana = 'http://grafana.localhost/d/home';
  const bounce = `/login?redirect=${encodeURIComponent(grafana)}`;
  let assigned: string | null;
  const realLocation = window.location;

  beforeEach(() => {
    assigned = null;
    // Capture full-page navigations (jsdom cannot perform them).
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        hostname: 'localhost',
        get href() {
          return 'http://localhost/login';
        },
        set href(url: string) {
          assigned = url;
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('a super admin gets the cookie, then goes back to the subdomain', async () => {
    signedIn({ role: 'super_admin' });
    await renderApp(bounce, routes);
    await waitFor(() => expect(assigned).toBe(grafana));
    expect(
      fetchMock.mock.calls.some(
        ([u, init]) => String(u) === '/api/v1/admin/forwardauth-cookie' && init?.method === 'POST'
      )
    ).toBe(true);
  });

  it('the provider and the sign-in page mint together: one POST, so no two tokens race for the cookie', async () => {
    signedIn({ role: 'super_admin' });
    await renderApp(bounce, routes);
    await waitFor(() => expect(assigned).toBe(grafana));
    // Let any straggling effect fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const posts = fetchMock.mock.calls.filter(
      ([u, init]) => String(u) === '/api/v1/admin/forwardauth-cookie' && init?.method === 'POST'
    );
    expect(posts).toHaveLength(1);
  });

  it('without the cookie (mint refused) it goes to the dashboard instead of looping', async () => {
    signedIn({ role: 'super_admin' });
    fetchMock = stubFetch({
      '/api/v1/admin/forwardauth-cookie': [
        new Response(JSON.stringify({ error: 'Super admin access required' }), { status: 403 }),
      ],
    });
    await renderApp(bounce, routes);
    expect(await screen.findByText('dashboard-page')).toBeInTheDocument();
    expect(assigned).toBeNull();
  });

  it('a regular user is never sent to an admin subdomain', async () => {
    signedIn();
    await renderApp(bounce, routes);
    expect(await screen.findByText('dashboard-page')).toBeInTheDocument();
    expect(assigned).toBeNull();
  });

  it('survives the two-factor step: MFAVerify sends the super admin back to the subdomain', async () => {
    authClient.signIn.email.mockResolvedValueOnce({
      data: { twoFactorRedirect: true, twoFactorMethods: ['totp'] },
      error: null,
    });
    await renderApp(bounce, routes);
    await submitLogin('admin@example.com', 'correct horse');
    expect(await screen.findByText('auth.mfa.title')).toBeInTheDocument();

    authClient.twoFactor.verifyTotp.mockImplementationOnce(async () => {
      signedIn({ role: 'super_admin', twoFactorEnabled: true }, { twoFactorVerified: true });
      return { data: {}, error: null };
    });
    await userEvent.type(screen.getByLabelText('auth.mfa.codeLabel'), '123456');
    await waitFor(() => expect(assigned).toBe(grafana));
  });
});

describe('step-up', () => {
  function queue403(body: object) {
    return new Response(JSON.stringify(body), { status: 403 });
  }

  it('403 mfa_required (enrolled): asks for a code on this session, then retries once', async () => {
    signedIn({ twoFactorEnabled: true });
    fetchMock = stubFetch({
      '/api/v1/organizations/o1': [
        queue403({ error: 'mfa_required', mfa_enrolled: true }),
        new Response(null, { status: 204 }),
      ],
    });
    await renderApp('/probe', routes);
    await screen.findByText('user:jane@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'delete-org' }));
    expect(await screen.findByText('auth.stepUp.title')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'auth.mfa.useBackupCode' }));
    await userEvent.type(screen.getByLabelText('auth.mfa.backupLabel'), 'abcde-fghij');
    await userEvent.click(screen.getByRole('button', { name: 'auth.stepUp.confirm' }));

    expect(authClient.twoFactor.verifyBackupCode).toHaveBeenCalledWith({ code: 'abcde-fghij' });
    await waitFor(() => expect(document.title).toBe('204'));
    const orgCalls = fetchMock.mock.calls.filter(([u]) => u === '/api/v1/organizations/o1');
    expect(orgCalls).toHaveLength(2);
    expect(orgCalls[1][1]?.method).toBe('DELETE');
    expect(orgCalls[1][1]?.credentials).toBe('same-origin');
  });

  it('cancelling the prompt leaves the refusal in place (no retry)', async () => {
    signedIn({ twoFactorEnabled: true });
    fetchMock = stubFetch({
      '/api/v1/organizations/o1': [queue403({ error: 'mfa_required', mfa_enrolled: true })],
    });
    await renderApp('/probe', routes);
    await screen.findByText('user:jane@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'delete-org' }));
    await screen.findByText('auth.stepUp.title');
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    await waitFor(() => expect(document.title).toBe('403'));
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/v1/organizations/o1')).toHaveLength(1);
  });

  it('403 mfa_required (not enrolled): routes to the Security page to enroll', async () => {
    signedIn();
    fetchMock = stubFetch({
      '/api/v1/organizations/o1': [queue403({ error: 'mfa_required', mfa_enrolled: false })],
    });
    await renderApp('/probe', routes);
    await screen.findByText('user:jane@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'delete-org' }));
    await waitFor(() => expect(location()).toBe('at:/settings/security?setup=required'));
  });

  it('403 reauth_required: signs out and asks for a fresh sign-in, keeping the page', async () => {
    signedIn();
    fetchMock = stubFetch({
      '/api/v1/organizations/o1': [queue403({ error: 'reauth_required' })],
    });
    await renderApp('/probe', routes);
    await screen.findByText('user:jane@example.com');
    signedOut();
    await userEvent.click(screen.getByRole('button', { name: 'delete-org' }));
    await waitFor(() => expect(location()).toBe('at:/login?reason=reauth&redirect=%2Fprobe'));
    expect(authClient.signOut).toHaveBeenCalled();
    expectAdminCookieClearedBeforeSignOut();
    expect(await screen.findByText('auth.errors.reauthRequired')).toBeInTheDocument();
  });

  it('impersonation through the admin plugin steps up on MFA_REQUIRED and retries', async () => {
    signedIn({ role: 'super_admin', twoFactorEnabled: true });
    authClient.admin.impersonateUser
      .mockResolvedValueOnce({ data: null, error: { status: 403, code: 'MFA_REQUIRED' } })
      .mockImplementationOnce(async () => {
        signedIn({ id: 'user-2', email: 'target@example.com' }, { impersonatedBy: 'user-1' });
        return { data: {}, error: null };
      });
    await renderApp('/probe', routes);
    await screen.findByText('user:jane@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'impersonate' }));
    await screen.findByText('auth.stepUp.title');
    await userEvent.click(screen.getByRole('button', { name: 'auth.mfa.useBackupCode' }));
    await userEvent.type(screen.getByLabelText('auth.mfa.backupLabel'), 'abcde-fghij');
    await userEvent.click(screen.getByRole('button', { name: 'auth.stepUp.confirm' }));

    expect(await screen.findByText('impersonating:true')).toBeInTheDocument();
    expect(authClient.admin.impersonateUser).toHaveBeenCalledTimes(2);
    expect(authClient.admin.impersonateUser).toHaveBeenLastCalledWith({ userId: 'user-2' });
  });
});
