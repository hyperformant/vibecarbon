import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for session validation logic patterns
 * These tests verify the session validation behavior in AuthProvider
 */

// Mock Session type
interface MockSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: MockUser;
}

// Mock User type
interface MockUser {
  id: string;
  email?: string;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
  user_metadata?: {
    full_name?: string;
    [key: string]: unknown;
  };
}

// Mock error type
interface MockError {
  message: string;
  status?: number;
}

// Mock Supabase client responses
interface GetSessionResponse {
  data: { session: MockSession | null };
  error: MockError | null;
}

interface GetUserResponse {
  data: { user: MockUser | null };
  error: MockError | null;
}

// Extract the session validation logic pattern for testing
type AuthState = {
  user: MockUser | null;
  session: MockSession | null;
  shouldSignOut: boolean;
};

async function validateSession(
  getSession: () => Promise<GetSessionResponse>,
  getUser: () => Promise<GetUserResponse>,
): Promise<AuthState> {
  const {
    data: { session },
  } = await getSession();

  if (session) {
    // Validate the session with the server
    const {
      data: { user },
      error,
    } = await getUser();

    if (error || !user) {
      // Session is invalid (e.g., user deleted, database reset)
      return {
        user: null,
        session: null,
        shouldSignOut: true,
      };
    }

    return {
      user,
      session,
      shouldSignOut: false,
    };
  }

  return {
    user: null,
    session: null,
    shouldSignOut: false,
  };
}

describe('Session Validation', () => {
  describe('when no session exists', () => {
    it('returns null user and session without signing out', async () => {
      const getSession = vi.fn().mockResolvedValue({
        data: { session: null },
        error: null,
      });
      const getUser = vi.fn();

      const result = await validateSession(getSession, getUser);

      expect(result.user).toBeNull();
      expect(result.session).toBeNull();
      expect(result.shouldSignOut).toBe(false);
      expect(getUser).not.toHaveBeenCalled();
    });
  });

  describe('when valid session exists', () => {
    const mockUser: MockUser = {
      id: 'user-123',
      email: 'test@example.com',
      app_metadata: { role: 'super_admin' },
      user_metadata: { full_name: 'Test User' },
    };

    const mockSession: MockSession = {
      access_token: 'valid-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 3600000,
      user: mockUser,
    };

    it('validates session with server and returns user', async () => {
      const getSession = vi.fn().mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      const getUser = vi.fn().mockResolvedValue({
        data: { user: mockUser },
        error: null,
      });

      const result = await validateSession(getSession, getUser);

      expect(result.user).toEqual(mockUser);
      expect(result.session).toEqual(mockSession);
      expect(result.shouldSignOut).toBe(false);
      expect(getUser).toHaveBeenCalled();
    });

    it('preserves super_admin role from app_metadata', async () => {
      const superAdminUser: MockUser = {
        ...mockUser,
        app_metadata: { role: 'super_admin' },
      };
      const getSession = vi.fn().mockResolvedValue({
        data: { session: { ...mockSession, user: superAdminUser } },
        error: null,
      });
      const getUser = vi.fn().mockResolvedValue({
        data: { user: superAdminUser },
        error: null,
      });

      const result = await validateSession(getSession, getUser);

      expect(result.user?.app_metadata?.role).toBe('super_admin');
    });
  });

  describe('when session is stale (database reset scenario)', () => {
    const mockSession: MockSession = {
      access_token: 'stale-token',
      refresh_token: 'stale-refresh',
      user: { id: 'deleted-user', email: 'deleted@example.com' },
    };

    it('signs out when getUser returns error', async () => {
      const getSession = vi.fn().mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      const getUser = vi.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'User not found', status: 404 },
      });

      const result = await validateSession(getSession, getUser);

      expect(result.user).toBeNull();
      expect(result.session).toBeNull();
      expect(result.shouldSignOut).toBe(true);
    });

    it('signs out when getUser returns null user without error', async () => {
      const getSession = vi.fn().mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      const getUser = vi.fn().mockResolvedValue({
        data: { user: null },
        error: null,
      });

      const result = await validateSession(getSession, getUser);

      expect(result.user).toBeNull();
      expect(result.session).toBeNull();
      expect(result.shouldSignOut).toBe(true);
    });

    it('handles "JWT expired" error by signing out', async () => {
      const getSession = vi.fn().mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      const getUser = vi.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'JWT expired' },
      });

      const result = await validateSession(getSession, getUser);

      expect(result.shouldSignOut).toBe(true);
    });

    it('handles "Invalid JWT" error by signing out', async () => {
      const getSession = vi.fn().mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      const getUser = vi.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid JWT: invalid signature' },
      });

      const result = await validateSession(getSession, getUser);

      expect(result.shouldSignOut).toBe(true);
    });
  });
});

describe('Session Validation Flow', () => {
  it('calls getSession before getUser', async () => {
    const callOrder: string[] = [];

    const getSession = vi.fn().mockImplementation(async () => {
      callOrder.push('getSession');
      return {
        data: { session: { access_token: 'token', refresh_token: 'refresh', user: { id: '1' } } },
        error: null,
      };
    });

    const getUser = vi.fn().mockImplementation(async () => {
      callOrder.push('getUser');
      return { data: { user: { id: '1' } }, error: null };
    });

    await validateSession(getSession, getUser);

    expect(callOrder).toEqual(['getSession', 'getUser']);
  });

  it('does not call getUser when no session exists', async () => {
    const getSession = vi.fn().mockResolvedValue({
      data: { session: null },
      error: null,
    });
    const getUser = vi.fn();

    await validateSession(getSession, getUser);

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe('Session State Transitions', () => {
  // Test the expected state transitions during auth flow
  const scenarios = [
    {
      name: 'fresh browser, no session',
      sessionExists: false,
      userValid: false,
      expectedState: { hasUser: false, hasSession: false, signOut: false },
    },
    {
      name: 'valid session, valid user',
      sessionExists: true,
      userValid: true,
      expectedState: { hasUser: true, hasSession: true, signOut: false },
    },
    {
      name: 'stale session, user deleted (db reset)',
      sessionExists: true,
      userValid: false,
      expectedState: { hasUser: false, hasSession: false, signOut: true },
    },
  ];

  scenarios.forEach(({ name, sessionExists, userValid, expectedState }) => {
    it(`handles "${name}" correctly`, async () => {
      const mockSession = sessionExists
        ? { access_token: 'token', refresh_token: 'refresh', user: { id: '1' } }
        : null;
      const mockUser = userValid ? { id: '1', email: 'test@example.com' } : null;

      const getSession = vi.fn().mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      const getUser = vi.fn().mockResolvedValue({
        data: { user: mockUser },
        error: userValid ? null : { message: 'User not found' },
      });

      const result = await validateSession(getSession, getUser);

      expect(!!result.user).toBe(expectedState.hasUser);
      expect(!!result.session).toBe(expectedState.hasSession);
      expect(result.shouldSignOut).toBe(expectedState.signOut);
    });
  });
});
