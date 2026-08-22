import { describe, expect, it, vi } from 'vitest';

const ENV = {
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_ANON_KEY: 'the-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'the-service-role-key',
};

vi.mock('@server/lib/env', () => ({ env: ENV }));

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn(() => ({})) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));

const { createSupabaseClient } = await import('@server/lib/supabase');

describe('createSupabaseClient (per-user, RLS-enforced client)', () => {
  it('SECURITY: uses the ANON key (not service role) as the apikey, with the user JWT', () => {
    createClientMock.mockClear();
    createSupabaseClient('user-jwt-token');

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const [url, key, options] = createClientMock.mock.calls[0];
    expect(url).toBe(ENV.SUPABASE_URL);
    // Fail-safe: if the Authorization header is ever dropped, this degrades to
    // the anon role under RLS, NOT to service_role BYPASSRLS.
    expect(key).toBe(ENV.SUPABASE_ANON_KEY);
    expect(key).not.toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(options?.global?.headers?.Authorization).toBe('Bearer user-jwt-token');
  });
});
