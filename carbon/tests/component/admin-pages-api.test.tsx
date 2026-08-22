/**
 * Regression coverage for the admin pages' migration onto the shared client
 * API layer (src/client/lib/api.ts). We exercise the extracted fetchers
 * directly through a stubbed global fetch:
 *  - a migrated READ (Infrastructure's fetchServicesStatus) resolves the parsed
 *    body and carries the Supabase bearer token, and
 *  - a migrated MUTATION (Notifications' createNotification) surfaces the
 *    server's error message (and the page fallback) as an ApiError on non-2xx.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same supabase stub shape as api-client.test.ts — getAuthHeaders reads the
// session's access_token off this mock.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'tok-abc' } },
      })),
    },
  },
}));

import { ApiError } from '@/lib/api';
import { fetchServicesStatus } from '@/pages/admin/Infrastructure';
import { createNotification } from '@/pages/admin/Notifications';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Infrastructure fetchServicesStatus (migrated read)', () => {
  it('resolves the parsed body and sends the bearer token', async () => {
    const payload = {
      summary: { healthy: 3, unhealthy: 0, total: 3 },
      services: [],
      timestamp: '2026-07-08T00:00:00Z',
    };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));

    await expect(fetchServicesStatus()).resolves.toEqual(payload);

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/_internal/services/status');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc');
  });
});

describe('Notifications createNotification (migrated mutation)', () => {
  const form = {
    title: 'Heads up',
    message: '',
    type: 'info' as const,
    visibility: 'all' as const,
    dismissible: true,
    isActive: true,
    actionLabel: '',
    actionUrl: '',
  };

  it("surfaces the server's error message as ApiError on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Title already exists' }), { status: 409 })
    );

    const err = await createNotification(form).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Title already exists');
    expect(err.status).toBe(409);
  });

  it('falls back to the page message when the error body carries no error field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));

    const err = await createNotification(form).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Failed to create notification');
  });
});
