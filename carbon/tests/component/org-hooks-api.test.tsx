/**
 * The organization, members and notification hooks over the shared client
 * API layer (src/client/lib/api.ts, apiJson), through a stubbed fetch:
 * reads return the parsed list, writes send JSON and surface the server's
 * `error` (or the hook's fallback when the body has none), and a signed-out
 * notifications read is an empty list rather than an error.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'jane@example.com' } }),
}));

import { NotificationProvider, useNotifications } from '@/hooks/useNotifications';
import { useOrganizationMembers } from '@/hooks/useOrganizationMembers';
import { OrganizationsProvider, useOrganizations } from '@/hooks/useOrganizations';
import { ApiError } from '@/lib/api';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper(extra?: (children: ReactNode) => ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {extra ? extra(children) : children}
    </QueryClientProvider>
  );
}

const member = {
  id: 'm1',
  role: 'MEMBER',
  createdAt: '2026-01-01T00:00:00Z',
  user: { id: 'u2', email: 'sam@example.com', name: 'Sam' },
};

describe('useOrganizationMembers', () => {
  it('reads the member list', async () => {
    fetchMock.mockResolvedValueOnce(json({ members: [member] }));
    const { result } = renderHook(() => useOrganizationMembers('o1'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.members).toEqual([member]));
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/organizations/o1/members');
  });

  it("adds a member with a JSON body and surfaces the server's error", async () => {
    fetchMock.mockResolvedValueOnce(json({ members: [] }));
    fetchMock.mockResolvedValueOnce(json({ error: 'User not found' }, 404));
    const { result } = renderHook(() => useOrganizationMembers('o1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let err: unknown;
    await act(async () => {
      err = await result.current.addMember
        .mutateAsync({ email: 'nobody@example.com', role: 'MEMBER' })
        .catch((e) => e);
    });

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('User not found');
    const [path, init] = fetchMock.mock.calls[1];
    expect(path).toBe('/api/v1/organizations/o1/members');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'nobody@example.com', role: 'MEMBER' });
  });

  it('falls back to the hook message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(json({ members: [member] }));
    fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    const { result } = renderHook(() => useOrganizationMembers('o1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    let err: unknown;
    await act(async () => {
      err = await result.current.removeMember.mutateAsync('u2').catch((e) => e);
    });

    expect((err as Error).message).toBe('Failed to remove member');
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });
});

describe('useOrganizations', () => {
  it("creates an organization and surfaces the server's error", async () => {
    fetchMock.mockResolvedValueOnce(json({ memberships: [] }));
    fetchMock.mockResolvedValueOnce(json({ error: 'Slug already taken' }, 409));
    const { result } = renderHook(() => useOrganizations(), {
      wrapper: wrapper((c) => <OrganizationsProvider>{c}</OrganizationsProvider>),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let err: unknown;
    await act(async () => {
      err = await result.current.createOrganization('Acme Inc').catch((e) => e);
    });

    expect((err as Error).message).toBe('Slug already taken');
    const [path, init] = fetchMock.mock.calls[1];
    expect(path).toBe('/api/v1/organizations');
    expect(JSON.parse(init.body)).toEqual({ name: 'Acme Inc', slug: 'acme-inc' });
  });
});

describe('useNotifications', () => {
  it('a signed-out read is an empty list, not an error', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401));
    const { result } = renderHook(() => useNotifications(), {
      wrapper: wrapper((c) => <NotificationProvider>{c}</NotificationProvider>),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notifications).toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/notifications');
  });
});
