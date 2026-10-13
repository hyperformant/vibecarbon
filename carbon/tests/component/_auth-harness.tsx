/**
 * Shared harness for component tests that drive the real AuthProvider over a
 * mocked `@/lib/auth-client`. Each test file must declare
 *
 *   vi.mock('@/lib/auth-client', async () => (await import('./_auth-harness')).authClientModule);
 *
 * (vi.mock is hoisted per file), then use `authClient`, `signedIn`, and
 * `renderApp` from here.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { vi } from 'vitest';

// input-otp (the 6-digit code field) probes the layout with
// elementFromPoint, which jsdom does not implement.
if (typeof document !== 'undefined' && !document.elementFromPoint) {
  document.elementFromPoint = () => null;
}

type Result ={ data: unknown; error: null } | { data: null; error: Record<string, unknown> };
const ok = (data: unknown): Result => ({ data, error: null });

export const authClient = {
  getSession: vi.fn(async (): Promise<Result> => ok(null)),
  signIn: {
    email: vi.fn(async (): Promise<Result> => ok({ redirect: false })),
    social: vi.fn(async (): Promise<Result> => ok({ url: 'https://idp.example', redirect: true })),
    magicLink: vi.fn(async (): Promise<Result> => ok({ status: true })),
  },
  signUp: { email: vi.fn(async (): Promise<Result> => ok({})) },
  signOut: vi.fn(async (): Promise<Result> => ok({ success: true })),
  updateUser: vi.fn(async (): Promise<Result> => ok({ status: true })),
  listAccounts: vi.fn(async (): Promise<Result> => ok([{ providerId: 'credential' }])),
  requestPasswordReset: vi.fn(async (): Promise<Result> => ok({ status: true })),
  resetPassword: vi.fn(async (): Promise<Result> => ok({ status: true })),
  twoFactor: {
    verifyTotp: vi.fn(async (): Promise<Result> => ok({})),
    verifyBackupCode: vi.fn(async (): Promise<Result> => ok({})),
    enable: vi.fn(async (): Promise<Result> => ok({})),
    disable: vi.fn(async (): Promise<Result> => ok({ status: true })),
  },
  admin: {
    impersonateUser: vi.fn(async (): Promise<Result> => ok({})),
    stopImpersonating: vi.fn(async (): Promise<Result> => ok({})),
  },
};

export const authClientModule = { authClient };

export function resetAuthClient() {
  const reset = (o: Record<string, unknown>) => {
    for (const v of Object.values(o)) {
      if (typeof v === 'function' && 'mockClear' in v) (v as ReturnType<typeof vi.fn>).mockClear();
      else if (v && typeof v === 'object') reset(v as Record<string, unknown>);
    }
  };
  reset(authClient);
  authClient.getSession.mockImplementation(async () => ok(null));
}

/** Makes getSession answer as this user from now on. */
export function signedIn(
  user: Partial<{
    id: string;
    email: string;
    name: string;
    role: string;
    twoFactorEnabled: boolean;
    onboardingCompleted: boolean;
  }> = {},
  session: Partial<{ twoFactorVerified: boolean; impersonatedBy: string | null }> = {}
) {
  const u = {
    id: 'user-1',
    email: 'jane@example.com',
    name: 'Jane Doe',
    role: 'user',
    twoFactorEnabled: false,
    onboardingCompleted: true,
    ...user,
  };
  authClient.getSession.mockImplementation(async () =>
    ok({ user: u, session: { id: 's1', userId: u.id, twoFactorVerified: false, ...session } })
  );
  return u;
}

export function signedOut() {
  authClient.getSession.mockImplementation(async () => ok(null));
}

/** Prints the current location, so tests can assert where the app went. */
export function LocationProbe({ label = 'at' }: { label?: string }) {
  const location = useLocation();
  return <p data-testid="location">{`${label}:${location.pathname}${location.search}`}</p>;
}

export function renderApp(path: string, routes: ReactNode, wrap?: (c: ReactNode) => ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Imported lazily so the test file's vi.mock of @/lib/auth-client is in place.
  return import('@/components/auth/AuthProvider').then(({ AuthProvider }) =>
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            {wrap ? wrap(<Routes>{routes}</Routes>) : <Routes>{routes}</Routes>}
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  );
}

/**
 * fetch stub: answers the public auth settings, records everything, and lets a
 * test queue answers for other paths.
 */
export function stubFetch(queue: Record<string, Response[]> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/v1/auth/settings') {
      return new Response(
        JSON.stringify({
          settings: {
            mfaEnabled: false,
            userDocsEnabled: true,
            apiDocsEnabled: true,
            providers: { google: true, microsoft: false },
            magicLinkEnabled: true,
          },
        }),
        { status: 200 }
      );
    }
    const next = queue[url]?.shift();
    return next ?? new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
