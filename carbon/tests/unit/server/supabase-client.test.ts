import { describe, expect, it, vi } from 'vitest';

const ENV = {
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_ANON_KEY: 'the-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'the-service-role-key',
};

vi.mock('@server/lib/env', () => ({ env: ENV }));

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn(() => ({})) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));

const supabaseModule = await import('@server/lib/supabase');
const { getSupabaseClient } = supabaseModule;

describe('getSupabaseClient (session middleware, auth.getUser only)', () => {
  it('SECURITY: uses the ANON key (not service role) as the apikey, with the user JWT', () => {
    createClientMock.mockClear();
    getSupabaseClient('Bearer user-jwt-token');

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const [url, key, options] = createClientMock.mock.calls[0] as unknown as [
      string,
      string,
      { global?: { headers?: Record<string, string> } },
    ];
    expect(url).toBe(ENV.SUPABASE_URL);
    // Fail-safe: if the Authorization header is ever dropped, this degrades to
    // anonymous, NOT to the service role.
    expect(key).toBe(ENV.SUPABASE_ANON_KEY);
    expect(key).not.toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(options?.global?.headers?.Authorization).toBe('Bearer user-jwt-token');
  });

  it('without a bearer token: anon key, no Authorization header', () => {
    createClientMock.mockClear();
    getSupabaseClient(undefined);
    const [, key, options] = createClientMock.mock.calls[0] as unknown as [
      string,
      string,
      { global?: unknown },
    ];
    expect(key).toBe(ENV.SUPABASE_ANON_KEY);
    expect(options?.global).toBeUndefined();
  });

  it('no longer exports a per-user data client', () => {
    // Data goes through db/client.ts (withUserDb / adminDb).
    expect(Object.keys(supabaseModule)).not.toContain('createSupabaseClient');
  });
});
