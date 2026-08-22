/**
 * Covers the user-facing pages migrated onto the shared client API layer
 * (src/client/lib/api.ts). Verifies one read path carries the Supabase auth
 * header end-to-end, and one write path surfaces the server error via
 * ApiError. Mirrors api-client.test.ts (supabase mock) and
 * use-auth-settings.test.tsx (vi.stubGlobal fetch).
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

import { ApiError } from '@/lib/api';
import { submitContactForm } from '@/pages/Contact';
import { fetchBillingStatus } from '@/pages/settings/Billing';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBillingStatus (migrated read path)', () => {
  it('hits the billing status endpoint with the bearer token and returns parsed JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ configured: true }), { status: 200 })
    );

    await expect(fetchBillingStatus()).resolves.toEqual({ configured: true });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/v1/billing/status');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });
});

describe('submitContactForm (migrated write path)', () => {
  it('POSTs the form body and rejects with the server error message on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Rate limited' }), { status: 429 })
    );

    const err = await submitContactForm({
      name: 'Ada',
      email: 'ada@example.com',
      subject: 'Hi',
      message: 'Hello there',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Rate limited');
    expect(err.status).toBe(429);

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/v1/contact/submit');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({ name: 'Ada', email: 'ada@example.com', subject: 'Hi', message: 'Hello there' })
    );
  });
});
