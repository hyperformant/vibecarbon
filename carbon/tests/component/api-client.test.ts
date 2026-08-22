/**
 * Unit tests for the client API layer (src/client/lib/api.ts) — the single
 * source of auth headers, JSON handling, and error extraction that every
 * page's queryFn/mutationFn goes through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'tok-123' } },
      })),
    },
  },
}));

import { ApiError, apiFetch, apiJson, getAuthHeaders } from '@/lib/api';
import { supabase } from '@/lib/supabase';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAuthHeaders', () => {
  it('carries the bearer token when a session exists', async () => {
    const headers = (await getAuthHeaders()) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits Authorization entirely (never empty) without a session', async () => {
    (supabase.auth.getSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { session: null },
    });
    const headers = (await getAuthHeaders()) as Record<string, string>;
    expect('Authorization' in headers).toBe(false);
  });
});

describe('apiFetch', () => {
  it('merges auth headers with caller headers (caller wins on conflict)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await apiFetch('/api/v1/thing', { headers: { 'X-Custom': 'yes' } });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/v1/thing');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok-123',
      'Content-Type': 'application/json',
      'X-Custom': 'yes',
    });
  });
});

describe('apiJson', () => {
  it('returns the parsed body on 2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(apiJson<{ ok: boolean }>('/api/v1/ok')).resolves.toEqual({ ok: true });
  });

  it('JSON.stringifies object bodies and passes strings through', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    await apiJson('/api/v1/w', { method: 'POST', body: { a: 1 } });
    expect(fetchMock.mock.calls[0][1].body).toBe('{"a":1}');

    await apiJson('/api/v1/w', { method: 'POST', body: 'raw' });
    expect(fetchMock.mock.calls[1][1].body).toBe('raw');
  });

  it("throws ApiError carrying the server's error field and HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Plan required' }), { status: 403 })
    );
    const err = await apiJson('/api/v1/gated').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Plan required');
    expect(err.status).toBe(403);
  });

  it('falls back to the provided message on non-JSON error bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await apiJson('/api/v1/x', {}, 'Could not load x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Could not load x');
    expect(err.status).toBe(502);
  });

  it('resolves undefined for 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiJson<void>('/api/v1/none', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
