/**
 * The marketing nav must not phone home to GitHub. It previously fetched
 * api.github.com/repos/hyperformant/vibecarbon on every visitor pageload to
 * show a star count — vendor-specific and a privacy leak from a customer's site.
 */

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@/components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/api', () => ({
  useAuthSettings: () => ({ data: undefined }),
  useDocsVisibility: () => ({ userDocsEnabled: true, apiDocsEnabled: true, isLoading: false }),
}));

import { Nav } from '@/components/Nav';

describe('Nav', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not fetch from GitHub (no phone-home)', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    render(
      <MemoryRouter>
        <Nav />
      </MemoryRouter>,
    );

    const calledGitHub = fetchSpy.mock.calls.some((args) =>
      String(args[0]).includes('api.github.com'),
    );
    expect(calledGitHub).toBe(false);
  });
});
