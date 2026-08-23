/**
 * The marketing nav must not phone home to GitHub UNLESS the project
 * explicitly opts in. It previously fetched
 * api.github.com/repos/hyperformant/vibecarbon on every visitor pageload to
 * show a star count — vendor-specific and a privacy leak from a customer's
 * site — and the 2026-08 landing refresh reintroduced exactly that fetch,
 * hardcoded. The gate is VITE_GITHUB_REPO_URL: unset (every generated app's
 * default) → no button, no request; set → the button renders and fetches
 * THAT repo. Both directions are pinned here, against the REAL hook — a
 * mocked hook would prove nothing about the fetch.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@/components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/api', async () => ({
  // Keep the REAL useGitHubStars/getGitHubRepoUrl — the contract under test.
  // Imported from the specific module, NOT the barrel: the barrel drags in
  // supabase-backed hooks whose module-load env check throws under jsdom.
  ...(await import('@/hooks/api/useGitHubStars')),
  useAuthSettings: () => ({ data: undefined }),
  useDocsVisibility: () => ({ userDocsEnabled: true, apiDocsEnabled: true, isLoading: false }),
}));

import { Nav } from '@/components/Nav';

function renderNav() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Nav />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Nav', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not fetch from GitHub and renders no GitHub button when no repo is configured (no phone-home)', () => {
    vi.stubEnv('VITE_GITHUB_REPO_URL', '');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    renderNav();

    const calledGitHub = fetchSpy.mock.calls.some((args) =>
      String(args[0]).includes('api.github.com'),
    );
    expect(calledGitHub).toBe(false);
    expect(screen.queryByLabelText('GitHub repository')).toBeNull();
  });

  it('fetches stars for the CONFIGURED repo when one is opted in', async () => {
    vi.stubEnv('VITE_GITHUB_REPO_URL', 'https://github.com/acme/widgets');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ stargazers_count: 42 }), { status: 200 }));

    renderNav();

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          (args) => String(args[0]) === 'https://api.github.com/repos/acme/widgets',
        ),
      ).toBe(true);
    });
    expect(screen.getAllByLabelText('GitHub repository').length).toBeGreaterThan(0);
  });
});
