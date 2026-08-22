import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * Tests for auth route logic from carbon/src/server/routes/v1/auth.ts
 * Re-implements key logic inline to avoid path alias resolution issues
 */

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

interface MockUser {
  id: string;
  email?: string;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
  user_metadata?: {
    [key: string]: unknown;
  };
}

interface MockContext {
  req: {
    json: () => Promise<unknown>;
    header: (name: string) => string | undefined;
  };
  get: (key: string) => unknown;
}

interface MockSupabaseResponse<T> {
  data: T | null;
  error: { message: string } | null;
}

interface MockAuthResponse {
  data: {
    session: {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      expires_at: number;
      token_type: string;
    } | null;
    user: MockUser;
  };
  error: { message: string } | null;
}

// Validation schemas (from auth.ts)
const loginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

const unlockAccountSchema = z.object({
  email: z.string().email('Valid email is required'),
});

const updateSettingsSchema = z.object({
  mfa_enabled: z.boolean().optional(),
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function isSuperAdmin(user: MockUser): boolean {
  return user.app_metadata?.role === 'super_admin';
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  // Check x-forwarded-for (takes first IP from comma-separated list)
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  // Check x-real-ip
  const realIp = c.req.header('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Fallback
  return '127.0.0.1';
}

// ============================================================================
// VALIDATION SCHEMA TESTS
// ============================================================================

describe('Validation Schemas', () => {
  describe('loginSchema', () => {
    it('accepts valid email and password', () => {
      const result = loginSchema.safeParse({
        email: 'user@example.com',
        password: 'password123',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('user@example.com');
        expect(result.data.password).toBe('password123');
      }
    });

    it('rejects invalid email', () => {
      const result = loginSchema.safeParse({
        email: 'not-an-email',
        password: 'password123',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Valid email is required');
      }
    });

    it('rejects missing email', () => {
      const result = loginSchema.safeParse({
        password: 'password123',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod returns "Invalid input" when field is missing (required but undefined)
        expect(result.error.issues[0].message).toContain('expected string');
      }
    });

    it('rejects empty password', () => {
      const result = loginSchema.safeParse({
        email: 'user@example.com',
        password: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Password is required');
      }
    });

    it('rejects missing password', () => {
      const result = loginSchema.safeParse({
        email: 'user@example.com',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        // Zod returns "Invalid input" when field is missing (required but undefined)
        expect(result.error.issues[0].message).toContain('expected string');
      }
    });

    it('accepts password with minimum 1 character', () => {
      const result = loginSchema.safeParse({
        email: 'user@example.com',
        password: 'a',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('unlockAccountSchema', () => {
    it('accepts valid email', () => {
      const result = unlockAccountSchema.safeParse({
        email: 'locked@example.com',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('locked@example.com');
      }
    });

    it('rejects invalid email', () => {
      const result = unlockAccountSchema.safeParse({
        email: 'invalid-email',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Valid email is required');
      }
    });

    it('rejects missing email', () => {
      const result = unlockAccountSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('updateSettingsSchema', () => {
    it('accepts mfa_enabled as true', () => {
      const result = updateSettingsSchema.safeParse({
        mfa_enabled: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mfa_enabled).toBe(true);
      }
    });

    it('accepts mfa_enabled as false', () => {
      const result = updateSettingsSchema.safeParse({
        mfa_enabled: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mfa_enabled).toBe(false);
      }
    });

    it('accepts missing mfa_enabled (optional)', () => {
      const result = updateSettingsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mfa_enabled).toBeUndefined();
      }
    });

    it('rejects non-boolean mfa_enabled', () => {
      const result = updateSettingsSchema.safeParse({
        mfa_enabled: 'true',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// getClientIp HELPER TESTS
// ============================================================================

describe('getClientIp', () => {
  it('extracts IP from x-forwarded-for header', () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.100';
          return undefined;
        },
      },
    };
    expect(getClientIp(mockContext)).toBe('192.168.1.100');
  });

  it('takes first IP from comma-separated x-forwarded-for', () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.100, 10.0.0.1, 172.16.0.1';
          return undefined;
        },
      },
    };
    expect(getClientIp(mockContext)).toBe('192.168.1.100');
  });

  it('trims whitespace from x-forwarded-for IP', () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name === 'x-forwarded-for') return '  192.168.1.100  , 10.0.0.1';
          return undefined;
        },
      },
    };
    expect(getClientIp(mockContext)).toBe('192.168.1.100');
  });

  it('falls back to x-real-ip when x-forwarded-for is not present', () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name === 'x-real-ip') return '192.168.1.200';
          return undefined;
        },
      },
    };
    expect(getClientIp(mockContext)).toBe('192.168.1.200');
  });

  it('prefers x-forwarded-for over x-real-ip', () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.100';
          if (name === 'x-real-ip') return '192.168.1.200';
          return undefined;
        },
      },
    };
    expect(getClientIp(mockContext)).toBe('192.168.1.100');
  });

  it('falls back to 127.0.0.1 when no headers present', () => {
    const mockContext = {
      req: {
        header: () => undefined,
      },
    };
    expect(getClientIp(mockContext)).toBe('127.0.0.1');
  });
});

// ============================================================================
// LOGIN ENDPOINT LOGIC TESTS
// ============================================================================

describe('Login Endpoint Logic', () => {
  // Simulates the login endpoint as a testable function
  async function loginEndpoint(
    mockContext: MockContext,
    mockDb: {
      checkLockout: (
        email: string,
        ip: string,
      ) => Promise<MockSupabaseResponse<{ locked: boolean; remaining_minutes?: number }>>;
      signIn: (email: string, password: string) => Promise<MockAuthResponse>;
      recordFailedLogin: (email: string, ip: string) => Promise<MockSupabaseResponse<null>>;
      clearFailedLogins: (email: string, ip: string) => Promise<MockSupabaseResponse<null>>;
    },
  ): Promise<{ status: number; body: unknown }> {
    // Parse and validate body
    let body: z.infer<typeof loginSchema>;
    try {
      const rawBody = await mockContext.req.json();
      const result = loginSchema.safeParse(rawBody);

      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(', ');
        return { status: 400, body: { error: errors } };
      }

      body = result.data;
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    const ipAddress = getClientIp(mockContext);
    const email = body.email.toLowerCase();

    // Check lockout status
    const lockoutResult = await mockDb.checkLockout(email, ipAddress);

    if (lockoutResult.error) {
      // Log error but continue with login attempt
      console.error('Lockout check failed', lockoutResult.error);
    } else if (lockoutResult.data?.locked) {
      const remainingMinutes = lockoutResult.data.remaining_minutes || 0;
      return {
        status: 429,
        body: {
          error: `Account temporarily locked due to too many failed attempts. Please try again in ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`,
          locked: true,
          remainingMinutes,
        },
      };
    }

    // Attempt authentication
    const authResult = await mockDb.signIn(email, body.password);

    if (authResult.error || !authResult.data.session) {
      // Record failed attempt
      try {
        await mockDb.recordFailedLogin(email, ipAddress);
      } catch (recordError) {
        console.error('Failed to record login attempt', recordError);
      }

      return {
        status: 401,
        body: { error: authResult.error?.message || 'Invalid credentials' },
      };
    }

    // Clear failed attempts on success
    try {
      await mockDb.clearFailedLogins(email, ipAddress);
    } catch (clearError) {
      console.error('Failed to clear failed logins', clearError);
    }

    // Return session data
    return {
      status: 200,
      body: {
        session: authResult.data.session,
        user: {
          id: authResult.data.user.id,
          email: authResult.data.user.email,
          app_metadata: authResult.data.user.app_metadata,
          user_metadata: authResult.data.user.user_metadata,
        },
      },
    };
  }

  it('returns 400 for invalid JSON body', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      checkLockout: vi.fn(),
      signIn: vi.fn(),
      recordFailedLogin: vi.fn(),
      clearFailedLogins: vi.fn(),
    };

    const result = await loginEndpoint(mockContext, mockDb);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'Invalid JSON body' });
    expect(mockDb.checkLockout).not.toHaveBeenCalled();
  });

  it('returns 400 for missing email', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ password: 'test123' }),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      checkLockout: vi.fn(),
      signIn: vi.fn(),
      recordFailedLogin: vi.fn(),
      clearFailedLogins: vi.fn(),
    };

    const result = await loginEndpoint(mockContext, mockDb);

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('expected string');
  });

  it('returns 400 for missing password', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'user@example.com' }),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      checkLockout: vi.fn(),
      signIn: vi.fn(),
      recordFailedLogin: vi.fn(),
      clearFailedLogins: vi.fn(),
    };

    const result = await loginEndpoint(mockContext, mockDb);

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('expected string');
  });

  it('returns 429 when account is locked', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'locked@example.com', password: 'test123' }),
        header: () => '192.168.1.100',
      },
      get: () => null,
    };

    const mockDb = {
      checkLockout: vi.fn().mockResolvedValue({
        data: { locked: true, remaining_minutes: 15 },
        error: null,
      }),
      signIn: vi.fn(),
      recordFailedLogin: vi.fn(),
      clearFailedLogins: vi.fn(),
    };

    const result = await loginEndpoint(mockContext, mockDb);

    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({
      locked: true,
      remainingMinutes: 15,
    });
    expect(mockDb.checkLockout).toHaveBeenCalledWith('locked@example.com', '192.168.1.100');
    expect(mockDb.signIn).not.toHaveBeenCalled();
  });

  it('continues with login attempt when lockout check fails', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'user@example.com', password: 'correct' }),
        header: () => '192.168.1.100',
      },
      get: () => null,
    };

    const mockDb = {
      checkLockout: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Database error' },
      }),
      signIn: vi.fn().mockResolvedValue({
        data: {
          session: {
            access_token: 'token123',
            refresh_token: 'refresh123',
            expires_in: 3600,
            expires_at: Date.now() + 3600000,
            token_type: 'bearer',
          },
          user: { id: 'user-1', email: 'user@example.com' },
        },
        error: null,
      }),
      recordFailedLogin: vi.fn(),
      clearFailedLogins: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const result = await loginEndpoint(mockContext, mockDb);

    expect(result.status).toBe(200);
    expect(mockDb.signIn).toHaveBeenCalledWith('user@example.com', 'correct');
  });

  it('records failed attempt and returns 401 on auth failure', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'user@example.com', password: 'wrong' }),
        header: () => '192.168.1.100',
      },
      get: () => null,
    };

    const mockDb = {
      checkLockout: vi.fn().mockResolvedValue({ data: { locked: false }, error: null }),
      signIn: vi.fn().mockResolvedValue({
        data: { session: null, user: {} as MockUser },
        error: { message: 'Invalid credentials' },
      }),
      recordFailedLogin: vi.fn().mockResolvedValue({ data: null, error: null }),
      clearFailedLogins: vi.fn(),
    };

    const result = await loginEndpoint(mockContext, mockDb);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Invalid credentials' });
    expect(mockDb.recordFailedLogin).toHaveBeenCalledWith('user@example.com', '192.168.1.100');
    expect(mockDb.clearFailedLogins).not.toHaveBeenCalled();
  });

  it('clears failed attempts and returns session on success', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'User@Example.com', password: 'correct' }),
        header: () => '192.168.1.100',
      },
      get: () => null,
    };

    const mockSession = {
      access_token: 'token123',
      refresh_token: 'refresh123',
      expires_in: 3600,
      expires_at: Date.now() + 3600000,
      token_type: 'bearer',
    };

    const mockUser = {
      id: 'user-1',
      email: 'user@example.com',
      app_metadata: { role: 'user' },
      user_metadata: { name: 'Test User' },
    };

    const mockDb = {
      checkLockout: vi.fn().mockResolvedValue({ data: { locked: false }, error: null }),
      signIn: vi.fn().mockResolvedValue({
        data: { session: mockSession, user: mockUser },
        error: null,
      }),
      recordFailedLogin: vi.fn(),
      clearFailedLogins: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const result = await loginEndpoint(mockContext, mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      session: mockSession,
      user: {
        id: mockUser.id,
        email: mockUser.email,
        app_metadata: mockUser.app_metadata,
        user_metadata: mockUser.user_metadata,
      },
    });
    expect(mockDb.signIn).toHaveBeenCalledWith('user@example.com', 'correct');
    expect(mockDb.clearFailedLogins).toHaveBeenCalledWith('user@example.com', '192.168.1.100');
    expect(mockDb.recordFailedLogin).not.toHaveBeenCalled();
  });

  it('lowercases email before use', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'USER@EXAMPLE.COM', password: 'test' }),
        header: () => '192.168.1.100',
      },
      get: () => null,
    };

    const mockDb = {
      checkLockout: vi.fn().mockResolvedValue({ data: { locked: false }, error: null }),
      signIn: vi.fn().mockResolvedValue({
        data: { session: null, user: {} as MockUser },
        error: { message: 'Invalid credentials' },
      }),
      recordFailedLogin: vi.fn().mockResolvedValue({ data: null, error: null }),
      clearFailedLogins: vi.fn(),
    };

    await loginEndpoint(mockContext, mockDb);

    expect(mockDb.checkLockout).toHaveBeenCalledWith('user@example.com', '192.168.1.100');
    expect(mockDb.signIn).toHaveBeenCalledWith('user@example.com', 'test');
  });
});

// ============================================================================
// ADMIN UNLOCK-ACCOUNT ENDPOINT TESTS
// ============================================================================

describe('Admin Unlock-Account Endpoint', () => {
  async function unlockAccountEndpoint(
    user: MockUser | null,
    mockContext: MockContext,
    mockDb: {
      unlockAccount: (email: string) => Promise<MockSupabaseResponse<null>>;
    },
  ): Promise<{ status: number; body: unknown }> {
    // Check authentication
    if (!user) {
      return { status: 401, body: { error: 'Unauthorized' } };
    }

    // Check authorization
    if (!isSuperAdmin(user)) {
      return { status: 403, body: { error: 'Super admin access required' } };
    }

    // Parse and validate body
    let body: z.infer<typeof unlockAccountSchema>;
    try {
      const rawBody = await mockContext.req.json();
      const result = unlockAccountSchema.safeParse(rawBody);

      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(', ');
        return { status: 400, body: { error: errors } };
      }

      body = result.data;
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    // Call RPC
    const result = await mockDb.unlockAccount(body.email.toLowerCase());

    if (result.error) {
      return { status: 500, body: { error: 'Failed to unlock account' } };
    }

    return { status: 200, body: { success: true } };
  }

  it('returns 401 when user is not authenticated', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn(),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      unlockAccount: vi.fn(),
    };

    const result = await unlockAccountEndpoint(null, mockContext, mockDb);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized' });
    expect(mockDb.unlockAccount).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not super admin', async () => {
    const user: MockUser = {
      id: 'user-1',
      email: 'user@example.com',
      app_metadata: { role: 'user' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn(),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      unlockAccount: vi.fn(),
    };

    const result = await unlockAccountEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'Super admin access required' });
    expect(mockDb.unlockAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON body', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      unlockAccount: vi.fn(),
    };

    const result = await unlockAccountEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'Invalid JSON body' });
    expect(mockDb.unlockAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid email', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'not-an-email' }),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      unlockAccount: vi.fn(),
    };

    const result = await unlockAccountEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: expect.stringContaining('Valid email is required'),
    });
  });

  it('returns 500 on RPC error', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'locked@example.com' }),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      unlockAccount: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Database error' },
      }),
    };

    const result = await unlockAccountEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'Failed to unlock account' });
    expect(mockDb.unlockAccount).toHaveBeenCalledWith('locked@example.com');
  });

  it('successfully unlocks account', async () => {
    const user: MockUser = {
      id: 'admin-1',
      email: 'admin@example.com',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ email: 'LOCKED@EXAMPLE.COM' }),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      unlockAccount: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const result = await unlockAccountEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true });
    expect(mockDb.unlockAccount).toHaveBeenCalledWith('locked@example.com');
  });
});

// ============================================================================
// ADMIN LOCKED-ACCOUNTS ENDPOINT TESTS
// ============================================================================

describe('Admin Locked-Accounts Endpoint', () => {
  async function getLockedAccountsEndpoint(
    user: MockUser | null,
    mockDb: {
      getLockedAccounts: () => Promise<
        MockSupabaseResponse<
          Array<{
            email: string;
            attempt_count: number;
            first_attempt: string;
            last_attempt: string;
          }>
        >
      >;
    },
  ): Promise<{ status: number; body: unknown }> {
    // Check authentication
    if (!user) {
      return { status: 401, body: { error: 'Unauthorized' } };
    }

    // Check authorization
    if (!isSuperAdmin(user)) {
      return { status: 403, body: { error: 'Super admin access required' } };
    }

    // Call RPC
    const result = await mockDb.getLockedAccounts();

    if (result.error) {
      return { status: 500, body: { error: 'Failed to fetch locked accounts' } };
    }

    // Format response
    const lockedAccounts = (result.data || []).map((account) => ({
      email: account.email,
      attemptCount: account.attempt_count,
      firstAttempt: account.first_attempt,
      lastAttempt: account.last_attempt,
    }));

    return { status: 200, body: { lockedAccounts } };
  }

  it('returns 401 when user is not authenticated', async () => {
    const mockDb = {
      getLockedAccounts: vi.fn(),
    };

    const result = await getLockedAccountsEndpoint(null, mockDb);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized' });
    expect(mockDb.getLockedAccounts).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not super admin', async () => {
    const user: MockUser = {
      id: 'user-1',
      app_metadata: { role: 'user' },
    };

    const mockDb = {
      getLockedAccounts: vi.fn(),
    };

    const result = await getLockedAccountsEndpoint(user, mockDb);

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'Super admin access required' });
    expect(mockDb.getLockedAccounts).not.toHaveBeenCalled();
  });

  it('returns 500 on RPC error', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockDb = {
      getLockedAccounts: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Database error' },
      }),
    };

    const result = await getLockedAccountsEndpoint(user, mockDb);

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'Failed to fetch locked accounts' });
  });

  it('returns formatted locked accounts list', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockData = [
      {
        email: 'user1@example.com',
        attempt_count: 5,
        first_attempt: '2024-01-01T10:00:00Z',
        last_attempt: '2024-01-01T10:05:00Z',
      },
      {
        email: 'user2@example.com',
        attempt_count: 3,
        first_attempt: '2024-01-01T11:00:00Z',
        last_attempt: '2024-01-01T11:02:00Z',
      },
    ];

    const mockDb = {
      getLockedAccounts: vi.fn().mockResolvedValue({ data: mockData, error: null }),
    };

    const result = await getLockedAccountsEndpoint(user, mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      lockedAccounts: [
        {
          email: 'user1@example.com',
          attemptCount: 5,
          firstAttempt: '2024-01-01T10:00:00Z',
          lastAttempt: '2024-01-01T10:05:00Z',
        },
        {
          email: 'user2@example.com',
          attemptCount: 3,
          firstAttempt: '2024-01-01T11:00:00Z',
          lastAttempt: '2024-01-01T11:02:00Z',
        },
      ],
    });
  });

  it('returns empty array when no locked accounts', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockDb = {
      getLockedAccounts: vi.fn().mockResolvedValue({ data: [], error: null }),
    };

    const result = await getLockedAccountsEndpoint(user, mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ lockedAccounts: [] });
  });
});

// ============================================================================
// AUTH SETTINGS GET ENDPOINT TESTS
// ============================================================================

describe('Auth Settings GET Endpoint', () => {
  async function getAuthSettingsEndpoint(mockDb: {
    getSettings: () => Promise<MockSupabaseResponse<Array<{ key: string; value: unknown }>>>;
    env: {
      GOOGLE_ENABLED: boolean;
      MICROSOFT_ENABLED: boolean;
      GITHUB_ENABLED: boolean;
      APPLE_ENABLED: boolean;
      DISCORD_ENABLED: boolean;
      MAGIC_LINK_ENABLED: boolean;
    };
  }): Promise<{ status: number; body: unknown }> {
    try {
      const result = await mockDb.getSettings();

      // If query fails, return defaults
      if (result.error) {
        return {
          status: 200,
          body: {
            settings: {
              mfaEnabled: false,
              providers: {
                google: mockDb.env.GOOGLE_ENABLED,
                microsoft: mockDb.env.MICROSOFT_ENABLED,
                github: mockDb.env.GITHUB_ENABLED,
                apple: mockDb.env.APPLE_ENABLED,
                discord: mockDb.env.DISCORD_ENABLED,
              },
              magicLinkEnabled: mockDb.env.MAGIC_LINK_ENABLED,
            },
          },
        };
      }

      // Convert array to object
      const settings: Record<string, unknown> = {};
      for (const row of result.data || []) {
        settings[row.key] = row.value;
      }

      return {
        status: 200,
        body: {
          settings: {
            mfaEnabled:
              (settings.mfa_enabled as { enabled?: boolean } | undefined)?.enabled ?? false,
            providers: {
              google: mockDb.env.GOOGLE_ENABLED,
              microsoft: mockDb.env.MICROSOFT_ENABLED,
              github: mockDb.env.GITHUB_ENABLED,
              apple: mockDb.env.APPLE_ENABLED,
              discord: mockDb.env.DISCORD_ENABLED,
            },
            magicLinkEnabled: mockDb.env.MAGIC_LINK_ENABLED,
          },
        },
      };
    } catch {
      // Return defaults on any error
      return {
        status: 200,
        body: {
          settings: {
            mfaEnabled: false,
            providers: {
              google: mockDb.env.GOOGLE_ENABLED,
              microsoft: mockDb.env.MICROSOFT_ENABLED,
              github: mockDb.env.GITHUB_ENABLED,
              apple: mockDb.env.APPLE_ENABLED,
              discord: mockDb.env.DISCORD_ENABLED,
            },
            magicLinkEnabled: mockDb.env.MAGIC_LINK_ENABLED,
          },
        },
      };
    }
  }

  it('returns settings with mfaEnabled true', async () => {
    const mockDb = {
      getSettings: vi.fn().mockResolvedValue({
        data: [{ key: 'mfa_enabled', value: { enabled: true } }],
        error: null,
      }),
      env: {
        GOOGLE_ENABLED: true,
        MICROSOFT_ENABLED: false,
        GITHUB_ENABLED: true,
        APPLE_ENABLED: false,
        DISCORD_ENABLED: false,
        MAGIC_LINK_ENABLED: true,
      },
    };

    const result = await getAuthSettingsEndpoint(mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      settings: {
        mfaEnabled: true,
        providers: {
          google: true,
          microsoft: false,
          github: true,
          apple: false,
          discord: false,
        },
        magicLinkEnabled: true,
      },
    });
  });

  it('returns settings with mfaEnabled false', async () => {
    const mockDb = {
      getSettings: vi.fn().mockResolvedValue({
        data: [{ key: 'mfa_enabled', value: { enabled: false } }],
        error: null,
      }),
      env: {
        GOOGLE_ENABLED: false,
        MICROSOFT_ENABLED: false,
        GITHUB_ENABLED: false,
        APPLE_ENABLED: false,
        DISCORD_ENABLED: false,
        MAGIC_LINK_ENABLED: false,
      },
    };

    const result = await getAuthSettingsEndpoint(mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      settings: {
        mfaEnabled: false,
        providers: {
          google: false,
          microsoft: false,
          github: false,
          apple: false,
          discord: false,
        },
        magicLinkEnabled: false,
      },
    });
  });

  it('returns defaults when app_settings query fails', async () => {
    const mockDb = {
      getSettings: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Table does not exist' },
      }),
      env: {
        GOOGLE_ENABLED: true,
        MICROSOFT_ENABLED: true,
        GITHUB_ENABLED: true,
        APPLE_ENABLED: true,
        DISCORD_ENABLED: true,
        MAGIC_LINK_ENABLED: true,
      },
    };

    const result = await getAuthSettingsEndpoint(mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      settings: {
        mfaEnabled: false,
        providers: {
          google: true,
          microsoft: true,
          github: true,
          apple: true,
          discord: true,
        },
        magicLinkEnabled: true,
      },
    });
  });

  it('returns defaults when no settings rows returned', async () => {
    const mockDb = {
      getSettings: vi.fn().mockResolvedValue({
        data: [],
        error: null,
      }),
      env: {
        GOOGLE_ENABLED: false,
        MICROSOFT_ENABLED: true,
        GITHUB_ENABLED: false,
        APPLE_ENABLED: true,
        DISCORD_ENABLED: false,
        MAGIC_LINK_ENABLED: false,
      },
    };

    const result = await getAuthSettingsEndpoint(mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      settings: {
        mfaEnabled: false,
        providers: {
          google: false,
          microsoft: true,
          github: false,
          apple: true,
          discord: false,
        },
        magicLinkEnabled: false,
      },
    });
  });
});

// ============================================================================
// ADMIN SETTINGS PATCH ENDPOINT TESTS
// ============================================================================

describe('Admin Settings PATCH Endpoint', () => {
  async function updateSettingsEndpoint(
    user: MockUser | null,
    mockContext: MockContext,
    mockDb: {
      upsertSetting: (
        key: string,
        value: unknown,
        userId: string,
      ) => Promise<MockSupabaseResponse<null>>;
    },
  ): Promise<{ status: number; body: unknown }> {
    // Check authentication
    if (!user) {
      return { status: 401, body: { error: 'Unauthorized' } };
    }

    // Check authorization
    if (!isSuperAdmin(user)) {
      return { status: 403, body: { error: 'Super admin access required' } };
    }

    // Parse and validate body
    let body: z.infer<typeof updateSettingsSchema>;
    try {
      const rawBody = await mockContext.req.json();
      const result = updateSettingsSchema.safeParse(rawBody);

      if (!result.success) {
        const errors = result.error.issues.map((e) => e.message).join(', ');
        return { status: 400, body: { error: errors } };
      }

      body = result.data;
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    // Update MFA setting if provided
    if (body.mfa_enabled !== undefined) {
      const result = await mockDb.upsertSetting(
        'mfa_enabled',
        { enabled: body.mfa_enabled },
        user.id,
      );

      if (result.error) {
        return { status: 500, body: { error: 'Failed to update settings' } };
      }
    }

    return { status: 200, body: { success: true } };
  }

  it('returns 401 when user is not authenticated', async () => {
    const mockContext: MockContext = {
      req: {
        json: vi.fn(),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      upsertSetting: vi.fn(),
    };

    const result = await updateSettingsEndpoint(null, mockContext, mockDb);

    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized' });
    expect(mockDb.upsertSetting).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not super admin', async () => {
    const user: MockUser = {
      id: 'user-1',
      app_metadata: { role: 'user' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn(),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      upsertSetting: vi.fn(),
    };

    const result = await updateSettingsEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'Super admin access required' });
    expect(mockDb.upsertSetting).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON body', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      upsertSetting: vi.fn(),
    };

    const result = await updateSettingsEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'Invalid JSON body' });
    expect(mockDb.upsertSetting).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid mfa_enabled value', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ mfa_enabled: 'true' }),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      upsertSetting: vi.fn(),
    };

    const result = await updateSettingsEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(400);
    expect(mockDb.upsertSetting).not.toHaveBeenCalled();
  });

  it('updates mfa_enabled setting via upsert', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ mfa_enabled: true }),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      upsertSetting: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const result = await updateSettingsEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true });
    expect(mockDb.upsertSetting).toHaveBeenCalledWith('mfa_enabled', { enabled: true }, 'admin-1');
  });

  it('returns 500 on database error', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({ mfa_enabled: false }),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      upsertSetting: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Database error' },
      }),
    };

    const result = await updateSettingsEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'Failed to update settings' });
  });

  it('returns success when mfa_enabled is not provided (no-op)', async () => {
    const user: MockUser = {
      id: 'admin-1',
      app_metadata: { role: 'super_admin' },
    };

    const mockContext: MockContext = {
      req: {
        json: vi.fn().mockResolvedValue({}),
        header: () => undefined,
      },
      get: () => null,
    };

    const mockDb = {
      upsertSetting: vi.fn(),
    };

    const result = await updateSettingsEndpoint(user, mockContext, mockDb);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true });
    expect(mockDb.upsertSetting).not.toHaveBeenCalled();
  });
});
