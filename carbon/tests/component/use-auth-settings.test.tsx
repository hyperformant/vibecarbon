import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthSettings,
  authSettingsQueryKey,
  useAuthSettings,
  useMfaRequired,
} from '@/hooks/api/useAuthSettings';

// Wraps any rendered hook in a fresh QueryClient — retry: false so a
// fetch rejection surfaces in `error` immediately instead of after the
// useQuery defaults' multiple retries.
function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const okSettings: AuthSettings = {
  settings: {
    mfaEnabled: true,
    localizationEnabled: false,
    enabledLanguages: ['en'],
    userDocsEnabled: true,
    apiDocsEnabled: true,
  },
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(okSettings), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAuthSettings', () => {
  it('returns settings on success', async () => {
    const { result } = renderHook(() => useAuthSettings(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual(okSettings);
    expect(result.current.error).toBeNull();
  });

  it('hits /api/v1/auth/settings exactly once when called multiple times (TanStack dedupes)', async () => {
    const wrapper = makeWrapper();
    const a = renderHook(() => useAuthSettings(), { wrapper });
    const b = renderHook(() => useAuthSettings(), { wrapper });

    await waitFor(() => expect(a.result.current.isLoading).toBe(false));
    await waitFor(() => expect(b.result.current.isLoading).toBe(false));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/settings');
  });

  it('surfaces an error when fetch returns non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );

    const { result } = renderHook(() => useAuthSettings(), { wrapper: makeWrapper() });

    // The hook sets `retry: 1` (per-query options override the wrapper's
    // `retry: false` default), so we get one retry with TanStack's 1s
    // exponential-backoff delay before isError flips. Generous waitFor
    // timeout covers it.
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5_000 });
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('does not fetch when `enabled: false` is passed', async () => {
    const { result } = renderHook(() => useAuthSettings({ enabled: false }), {
      wrapper: makeWrapper(),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exports a stable query key (cache invalidation contract)', () => {
    // Renaming this key is a breaking change for any external invalidation
    // callers — pin it so regressions surface in review.
    expect(authSettingsQueryKey).toEqual(['auth', 'settings']);
  });
});

describe('useMfaRequired', () => {
  it('derives mfaRequired from the underlying settings', async () => {
    const { result } = renderHook(() => useMfaRequired(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.mfaRequired).toBe(true);
  });

  it('defaults to false when settings are missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ settings: null } satisfies AuthSettings), {
            status: 200,
          }),
      ),
    );

    const { result } = renderHook(() => useMfaRequired(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.mfaRequired).toBe(false);
  });
});
