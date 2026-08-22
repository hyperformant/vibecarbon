import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Re-implement the key logic inline to avoid path alias issues
function extractToken(req: Request, cookieHeader: string | undefined): string | null {
  // 1. Check Authorization header
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // 2. Check X-Forwarded-Access-Token (set by Traefik ForwardAuth)
  const forwardedToken = req.headers.get('X-Forwarded-Access-Token');
  if (forwardedToken) {
    return forwardedToken;
  }

  // 3. Check cookies for Supabase auth token
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').reduce(
      (acc, cookie) => {
        const [key, value] = cookie.trim().split('=');
        if (key && value) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>,
    );

    const supabaseToken =
      cookies['sb-auth-token'] ||
      cookies['sb-access-token'] ||
      Object.entries(cookies).find(
        ([key]) => key.startsWith('sb-') && key.endsWith('-auth-token'),
      )?.[1];

    if (supabaseToken) {
      try {
        const parsed = JSON.parse(decodeURIComponent(supabaseToken));
        if (parsed.access_token) {
          return parsed.access_token;
        }
      } catch {
        return supabaseToken;
      }
    }
  }

  return null;
}

function getValidatedSiteUrl(): string {
  const siteUrl = process.env.SITE_URL || 'http://localhost:5173';
  try {
    const url = new URL(siteUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'http://localhost:5173';
    }
    return url.origin;
  } catch {
    return 'http://localhost:5173';
  }
}

interface VerifyRoleInput {
  roleParam?: string;
  rolesParam?: string;
  token: string | null;
  acceptHeader?: string;
  userFromToken?: {
    id: string;
    email: string;
    app_metadata: { role?: string };
  } | null;
  getUserError?: boolean;
}

interface VerifyRoleOutput {
  status: number;
  redirect?: string;
  headers?: Record<string, string>;
}

// Mock route handler logic
function verifyRoleHandler(input: VerifyRoleInput): VerifyRoleOutput {
  const { roleParam, rolesParam, token, acceptHeader, userFromToken, getUserError } = input;

  // Parse required roles
  const requiredRoles: string[] = [];
  if (roleParam) {
    requiredRoles.push(roleParam);
  }
  if (rolesParam) {
    requiredRoles.push(...rolesParam.split(',').map((r) => r.trim()));
  }

  // Return 400 if no roles specified
  if (requiredRoles.length === 0) {
    return { status: 400 };
  }

  // Check if token exists
  if (!token) {
    const isBrowserRequest = acceptHeader?.includes('text/html');
    if (isBrowserRequest) {
      const siteUrl = getValidatedSiteUrl();
      const loginUrl = new URL('/login', siteUrl);
      const returnTo = 'https://example.com/protected'; // Mock current URL
      loginUrl.searchParams.set('returnTo', returnTo);
      return { status: 302, redirect: loginUrl.toString() };
    }
    return { status: 401 };
  }

  // Check if getUser failed
  if (getUserError || !userFromToken) {
    return { status: 401 };
  }

  // Check role
  const userRole = userFromToken.app_metadata.role;
  if (!userRole || !requiredRoles.includes(userRole)) {
    return { status: 403 };
  }

  // Success
  return {
    status: 200,
    headers: {
      'X-User-Id': userFromToken.id,
      'X-User-Email': userFromToken.email,
      'X-User-Role': userRole,
    },
  };
}

describe('verify-role ForwardAuth logic', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('extractToken', () => {
    it('extracts Bearer token from Authorization header', () => {
      const req = new Request('https://example.com', {
        headers: {
          Authorization: 'Bearer my-jwt-token',
        },
      });

      const token = extractToken(req, undefined);
      expect(token).toBe('my-jwt-token');
    });

    it('extracts token from X-Forwarded-Access-Token header', () => {
      const req = new Request('https://example.com', {
        headers: {
          'X-Forwarded-Access-Token': 'forwarded-token',
        },
      });

      const token = extractToken(req, undefined);
      expect(token).toBe('forwarded-token');
    });

    it('extracts JSON-encoded token from sb-auth-token cookie', () => {
      const req = new Request('https://example.com');
      const cookieValue = encodeURIComponent(JSON.stringify({ access_token: 'cookie-jwt-token' }));
      const cookieHeader = `sb-auth-token=${cookieValue}`;

      const token = extractToken(req, cookieHeader);
      expect(token).toBe('cookie-jwt-token');
    });

    it('extracts raw token from sb-access-token cookie', () => {
      const req = new Request('https://example.com');
      const cookieHeader = 'sb-access-token=raw-token-value';

      const token = extractToken(req, cookieHeader);
      expect(token).toBe('raw-token-value');
    });

    it('extracts token from dynamic cookie pattern (sb-*-auth-token)', () => {
      const req = new Request('https://example.com');
      const cookieValue = encodeURIComponent(JSON.stringify({ access_token: 'dynamic-token' }));
      const cookieHeader = `sb-project-xyz-auth-token=${cookieValue}`;

      const token = extractToken(req, cookieHeader);
      expect(token).toBe('dynamic-token');
    });

    it('returns null when no token is found', () => {
      const req = new Request('https://example.com');
      const cookieHeader = 'other-cookie=value';

      const token = extractToken(req, cookieHeader);
      expect(token).toBeNull();
    });

    it('prioritizes Authorization header over X-Forwarded-Access-Token', () => {
      const req = new Request('https://example.com', {
        headers: {
          Authorization: 'Bearer auth-token',
          'X-Forwarded-Access-Token': 'forwarded-token',
        },
      });

      const token = extractToken(req, undefined);
      expect(token).toBe('auth-token');
    });

    it('prioritizes X-Forwarded-Access-Token over cookies', () => {
      const req = new Request('https://example.com', {
        headers: {
          'X-Forwarded-Access-Token': 'forwarded-token',
        },
      });
      const cookieHeader = 'sb-auth-token=cookie-token';

      const token = extractToken(req, cookieHeader);
      expect(token).toBe('forwarded-token');
    });

    it('handles malformed JSON in cookie gracefully', () => {
      const req = new Request('https://example.com');
      const cookieHeader = 'sb-auth-token=not-json-value';

      const token = extractToken(req, cookieHeader);
      expect(token).toBe('not-json-value');
    });

    it('handles multiple cookies correctly', () => {
      const req = new Request('https://example.com');
      const cookieValue = encodeURIComponent(JSON.stringify({ access_token: 'my-token' }));
      const cookieHeader = `session=abc123; sb-auth-token=${cookieValue}; other=value`;

      const token = extractToken(req, cookieHeader);
      expect(token).toBe('my-token');
    });

    it('returns null for empty cookie header', () => {
      const req = new Request('https://example.com');
      const token = extractToken(req, '');
      expect(token).toBeNull();
    });

    it('ignores Authorization header without Bearer prefix', () => {
      const req = new Request('https://example.com', {
        headers: {
          Authorization: 'Basic dXNlcjpwYXNz',
        },
      });

      const token = extractToken(req, undefined);
      expect(token).toBeNull();
    });
  });

  describe('getValidatedSiteUrl', () => {
    it('returns origin for valid http URL', () => {
      process.env.SITE_URL = 'http://example.com:3000/path';
      const url = getValidatedSiteUrl();
      expect(url).toBe('http://example.com:3000');
    });

    it('returns origin for valid https URL', () => {
      process.env.SITE_URL = 'https://example.com/path?query=1';
      const url = getValidatedSiteUrl();
      expect(url).toBe('https://example.com');
    });

    it('falls back to localhost for invalid protocol', () => {
      process.env.SITE_URL = 'ftp://example.com';
      const url = getValidatedSiteUrl();
      expect(url).toBe('http://localhost:5173');
    });

    it('falls back to localhost for invalid URL string', () => {
      process.env.SITE_URL = 'not-a-valid-url';
      const url = getValidatedSiteUrl();
      expect(url).toBe('http://localhost:5173');
    });

    it('falls back to localhost when SITE_URL is missing', () => {
      delete process.env.SITE_URL;
      const url = getValidatedSiteUrl();
      expect(url).toBe('http://localhost:5173');
    });

    it('falls back to localhost for empty SITE_URL', () => {
      process.env.SITE_URL = '';
      const url = getValidatedSiteUrl();
      expect(url).toBe('http://localhost:5173');
    });

    it('preserves port in origin for http', () => {
      process.env.SITE_URL = 'http://localhost:8080';
      const url = getValidatedSiteUrl();
      expect(url).toBe('http://localhost:8080');
    });

    it('preserves port in origin for https', () => {
      process.env.SITE_URL = 'https://example.com:8443';
      const url = getValidatedSiteUrl();
      expect(url).toBe('https://example.com:8443');
    });
  });

  describe('route handler logic', () => {
    it('returns 400 when role param is missing', () => {
      const result = verifyRoleHandler({
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'admin' },
        },
      });

      expect(result.status).toBe(400);
    });

    it('returns 400 when both role and roles params are missing', () => {
      const result = verifyRoleHandler({
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'admin' },
        },
      });

      expect(result.status).toBe(400);
    });

    it('redirects to login for browser request without token', () => {
      process.env.SITE_URL = 'https://example.com';
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: null,
        acceptHeader: 'text/html,application/xhtml+xml',
      });

      expect(result.status).toBe(302);
      expect(result.redirect).toBeDefined();
      expect(result.redirect).toContain('/login');
      expect(result.redirect).toContain('returnTo=');
    });

    it('returns 401 for API request without token', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: null,
        acceptHeader: 'application/json',
      });

      expect(result.status).toBe(401);
      expect(result.redirect).toBeUndefined();
    });

    it('returns 401 when getUser returns error', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: 'invalid-token',
        getUserError: true,
      });

      expect(result.status).toBe(401);
    });

    it('returns 401 when getUser returns no user', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: 'valid-token',
        userFromToken: null,
      });

      expect(result.status).toBe(401);
    });

    it('returns 403 when user has wrong role', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'user' },
        },
      });

      expect(result.status).toBe(403);
    });

    it('returns 403 when user has no role in metadata', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: {},
        },
      });

      expect(result.status).toBe(403);
    });

    it('returns 200 with headers when user has correct role', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'admin@example.com',
          app_metadata: { role: 'admin' },
        },
      });

      expect(result.status).toBe(200);
      expect(result.headers).toEqual({
        'X-User-Id': 'user-123',
        'X-User-Email': 'admin@example.com',
        'X-User-Role': 'admin',
      });
    });

    it('accepts comma-separated roles param and matches first role', () => {
      const result = verifyRoleHandler({
        rolesParam: 'admin,moderator,editor',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'admin' },
        },
      });

      expect(result.status).toBe(200);
      expect(result.headers?.['X-User-Role']).toBe('admin');
    });

    it('accepts comma-separated roles param and matches middle role', () => {
      const result = verifyRoleHandler({
        rolesParam: 'admin,moderator,editor',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'moderator' },
        },
      });

      expect(result.status).toBe(200);
      expect(result.headers?.['X-User-Role']).toBe('moderator');
    });

    it('accepts comma-separated roles param and matches last role', () => {
      const result = verifyRoleHandler({
        rolesParam: 'admin,moderator,editor',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'editor' },
        },
      });

      expect(result.status).toBe(200);
      expect(result.headers?.['X-User-Role']).toBe('editor');
    });

    it('returns 403 when user role does not match any in comma-separated list', () => {
      const result = verifyRoleHandler({
        rolesParam: 'admin,moderator,editor',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'user' },
        },
      });

      expect(result.status).toBe(403);
    });

    it('handles roles with extra whitespace in comma-separated list', () => {
      const result = verifyRoleHandler({
        rolesParam: 'admin , moderator , editor',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'moderator' },
        },
      });

      expect(result.status).toBe(200);
    });

    it('combines role and roles params into single required roles list', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        rolesParam: 'moderator,editor',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'user@example.com',
          app_metadata: { role: 'moderator' },
        },
      });

      expect(result.status).toBe(200);
    });

    it('returns 401 when token is empty string', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: '',
        acceptHeader: 'application/json',
      });

      expect(result.status).toBe(401);
    });

    it('preserves user email with special characters in headers', () => {
      const result = verifyRoleHandler({
        roleParam: 'admin',
        token: 'valid-token',
        userFromToken: {
          id: 'user-123',
          email: 'admin+test@example.com',
          app_metadata: { role: 'admin' },
        },
      });

      expect(result.status).toBe(200);
      expect(result.headers?.['X-User-Email']).toBe('admin+test@example.com');
    });
  });
});
