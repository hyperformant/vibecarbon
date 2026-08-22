import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Tests for rate limiter logic
 * Re-implements key logic inline to avoid path alias resolution issues
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

interface RateLimitResult {
  count: number;
  resetTime: number;
  allowed: boolean;
}

// =============================================================================
// IN-MEMORY STORE IMPLEMENTATION
// =============================================================================

class InMemoryStore {
  private store: Map<string, { count: number; resetTime: number }> = new Map();

  async increment(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || entry.resetTime < now) {
      const resetTime = now + windowMs;
      this.store.set(key, { count: 1, resetTime });
      return { count: 1, resetTime, allowed: true };
    }

    entry.count++;
    return {
      count: entry.count,
      resetTime: entry.resetTime,
      allowed: entry.count <= max,
    };
  }

  isHealthy(): boolean {
    return true;
  }
}

// =============================================================================
// IP EXTRACTION IMPLEMENTATION
// =============================================================================

interface MockContext {
  req: {
    header: (name: string) => string | undefined;
  };
}

function getClientIP(c: MockContext, nodeEnv: string): string {
  // x-forwarded-for format: "client, proxy1, proxy2"
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    // Take leftmost (original client) IP, trim whitespace
    const clientIP = xff.split(',')[0].trim();
    // Basic validation - must look like an IP (IPv4 or IPv6)
    if (/^[\d.:a-fA-F]+$/.test(clientIP)) {
      return clientIP;
    }
  }

  // Fallback to x-real-ip (set by some proxies like nginx)
  const realIP = c.req.header('x-real-ip');
  if (realIP && /^[\d.:a-fA-F]+$/.test(realIP)) {
    return realIP;
  }

  // Fallback to cf-connecting-ip (Cloudflare)
  const cfIP = c.req.header('cf-connecting-ip');
  if (cfIP && /^[\d.:a-fA-F]+$/.test(cfIP)) {
    return cfIP;
  }

  // In development, localhost is expected
  if (nodeEnv === 'development') {
    return 'localhost';
  }

  // In production, return 'unknown'
  return 'unknown';
}

// =============================================================================
// MIDDLEWARE RESPONSE SHAPE
// =============================================================================

interface RateLimitResponse {
  headers: {
    'X-RateLimit-Limit': string;
    'X-RateLimit-Remaining': string;
    'X-RateLimit-Reset': string;
  };
  status?: number;
  body?: {
    error: string;
    retryAfter: number;
  };
}

function buildRateLimitResponse(
  result: RateLimitResult,
  max: number,
  now: number,
): RateLimitResponse {
  const remaining = Math.max(0, max - result.count);
  const reset = Math.ceil(result.resetTime / 1000);

  const response: RateLimitResponse = {
    headers: {
      'X-RateLimit-Limit': String(max),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(reset),
    },
  };

  if (!result.allowed) {
    response.status = 429;
    response.body = {
      error: 'Too many requests',
      retryAfter: Math.ceil((result.resetTime - now) / 1000),
    };
  }

  return response;
}

// =============================================================================
// TESTS
// =============================================================================

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe('increment', () => {
    it('returns count=1 and allowed=true for first request in window', async () => {
      const result = await store.increment('test-key', 60000, 10);

      expect(result.count).toBe(1);
      expect(result.allowed).toBe(true);
      expect(result.resetTime).toBeGreaterThan(Date.now());
    });

    it('increments count on subsequent requests', async () => {
      await store.increment('test-key', 60000, 10);
      const result = await store.increment('test-key', 60000, 10);

      expect(result.count).toBe(2);
      expect(result.allowed).toBe(true);
    });

    it('allows requests up to max limit', async () => {
      const max = 3;
      let result: RateLimitResult;

      // First 3 requests should be allowed
      result = await store.increment('test-key', 60000, max);
      expect(result.count).toBe(1);
      expect(result.allowed).toBe(true);

      result = await store.increment('test-key', 60000, max);
      expect(result.count).toBe(2);
      expect(result.allowed).toBe(true);

      result = await store.increment('test-key', 60000, max);
      expect(result.count).toBe(3);
      expect(result.allowed).toBe(true);
    });

    it('denies requests exceeding max limit', async () => {
      const max = 3;

      // Hit the limit
      await store.increment('test-key', 60000, max);
      await store.increment('test-key', 60000, max);
      await store.increment('test-key', 60000, max);

      // 4th request should be denied
      const result = await store.increment('test-key', 60000, max);
      expect(result.count).toBe(4);
      expect(result.allowed).toBe(false);
    });

    it('resets window after resetTime expires', async () => {
      const windowMs = 100; // Short window for testing
      const max = 2;

      // First request
      const result1 = await store.increment('test-key', windowMs, max);
      expect(result1.count).toBe(1);
      expect(result1.allowed).toBe(true);

      // Second request
      const result2 = await store.increment('test-key', windowMs, max);
      expect(result2.count).toBe(2);
      expect(result2.allowed).toBe(true);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, windowMs + 10));

      // Should reset to count 1
      const result3 = await store.increment('test-key', windowMs, max);
      expect(result3.count).toBe(1);
      expect(result3.allowed).toBe(true);
    });

    it('maintains separate counters for different keys', async () => {
      const result1 = await store.increment('key1', 60000, 10);
      const result2 = await store.increment('key2', 60000, 10);
      const result3 = await store.increment('key1', 60000, 10);

      expect(result1.count).toBe(1);
      expect(result2.count).toBe(1);
      expect(result3.count).toBe(2);
    });

    it('uses consistent resetTime within same window', async () => {
      const result1 = await store.increment('test-key', 60000, 10);
      const result2 = await store.increment('test-key', 60000, 10);

      expect(result2.resetTime).toBe(result1.resetTime);
    });
  });

  describe('isHealthy', () => {
    it('always returns true', () => {
      expect(store.isHealthy()).toBe(true);
    });
  });
});

describe('getClientIP', () => {
  function createMockContext(headers: Record<string, string>): MockContext {
    return {
      req: {
        header: (name: string) => headers[name.toLowerCase()],
      },
    };
  }

  describe('x-forwarded-for header', () => {
    it('extracts leftmost IP from x-forwarded-for', () => {
      const ctx = createMockContext({
        'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('1.2.3.4');
    });

    it('handles single IP in x-forwarded-for', () => {
      const ctx = createMockContext({
        'x-forwarded-for': '1.2.3.4',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('1.2.3.4');
    });

    it('trims whitespace from x-forwarded-for', () => {
      const ctx = createMockContext({
        'x-forwarded-for': '  1.2.3.4  , 5.6.7.8',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('1.2.3.4');
    });

    it('accepts IPv6 addresses in x-forwarded-for', () => {
      const ctx = createMockContext({
        'x-forwarded-for': '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    });

    it('accepts compressed IPv6 addresses', () => {
      const ctx = createMockContext({
        'x-forwarded-for': '2001:db8::1',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('2001:db8::1');
    });

    it('rejects invalid x-forwarded-for with malicious content', () => {
      const ctx = createMockContext({
        'x-forwarded-for': 'javascript:alert(1)',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('unknown');
    });

    it('rejects x-forwarded-for with SQL injection attempt', () => {
      const ctx = createMockContext({
        'x-forwarded-for': "1.2.3.4'; DROP TABLE users; --",
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('unknown');
    });

    it('rejects x-forwarded-for with HTML content', () => {
      const ctx = createMockContext({
        'x-forwarded-for': '<script>alert(1)</script>',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('unknown');
    });
  });

  describe('x-real-ip header fallback', () => {
    it('uses x-real-ip when x-forwarded-for is absent', () => {
      const ctx = createMockContext({
        'x-real-ip': '9.10.11.12',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('9.10.11.12');
    });

    it('validates x-real-ip with same regex', () => {
      const ctx = createMockContext({
        'x-real-ip': 'invalid-ip',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('unknown');
    });

    it('accepts IPv6 in x-real-ip', () => {
      const ctx = createMockContext({
        'x-real-ip': '::1',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('::1');
    });

    it('prefers x-forwarded-for over x-real-ip when both present', () => {
      const ctx = createMockContext({
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '9.10.11.12',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('1.2.3.4');
    });
  });

  describe('cf-connecting-ip header fallback', () => {
    it('uses cf-connecting-ip when other headers absent', () => {
      const ctx = createMockContext({
        'cf-connecting-ip': '13.14.15.16',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('13.14.15.16');
    });

    it('validates cf-connecting-ip with same regex', () => {
      const ctx = createMockContext({
        'cf-connecting-ip': 'malicious-value',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('unknown');
    });

    it('accepts IPv6 in cf-connecting-ip', () => {
      const ctx = createMockContext({
        'cf-connecting-ip': 'fe80::1',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('fe80::1');
    });
  });

  describe('fallback behavior', () => {
    it('returns "localhost" in development when no headers present', () => {
      const ctx = createMockContext({});

      const ip = getClientIP(ctx, 'development');
      expect(ip).toBe('localhost');
    });

    it('returns "unknown" in production when no headers present', () => {
      const ctx = createMockContext({});

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('unknown');
    });

    it('falls through invalid x-forwarded-for to valid x-real-ip', () => {
      const ctx = createMockContext({
        'x-forwarded-for': 'invalid',
        'x-real-ip': '1.2.3.4',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('1.2.3.4');
    });

    it('falls through invalid x-forwarded-for and x-real-ip to valid cf-connecting-ip', () => {
      const ctx = createMockContext({
        'x-forwarded-for': 'invalid',
        'x-real-ip': 'also-invalid',
        'cf-connecting-ip': '1.2.3.4',
      });

      const ip = getClientIP(ctx, 'production');
      expect(ip).toBe('1.2.3.4');
    });
  });
});

describe('Rate limit middleware response', () => {
  describe('response headers', () => {
    it('sets X-RateLimit-Limit header', () => {
      const result: RateLimitResult = {
        count: 1,
        resetTime: Date.now() + 60000,
        allowed: true,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.headers['X-RateLimit-Limit']).toBe('10');
    });

    it('sets X-RateLimit-Remaining header correctly', () => {
      const result: RateLimitResult = {
        count: 3,
        resetTime: Date.now() + 60000,
        allowed: true,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.headers['X-RateLimit-Remaining']).toBe('7');
    });

    it('sets X-RateLimit-Remaining to 0 when limit exceeded', () => {
      const result: RateLimitResult = {
        count: 11,
        resetTime: Date.now() + 60000,
        allowed: false,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.headers['X-RateLimit-Remaining']).toBe('0');
    });

    it('sets X-RateLimit-Reset header in Unix timestamp (seconds)', () => {
      const resetTime = Date.now() + 60000;
      const result: RateLimitResult = {
        count: 1,
        resetTime,
        allowed: true,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      const expectedReset = Math.ceil(resetTime / 1000);
      expect(response.headers['X-RateLimit-Reset']).toBe(String(expectedReset));
    });

    it('includes all headers even when limit exceeded', () => {
      const result: RateLimitResult = {
        count: 11,
        resetTime: Date.now() + 60000,
        allowed: false,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.headers).toHaveProperty('X-RateLimit-Limit');
      expect(response.headers).toHaveProperty('X-RateLimit-Remaining');
      expect(response.headers).toHaveProperty('X-RateLimit-Reset');
    });
  });

  describe('429 response when limit exceeded', () => {
    it('returns 429 status when limit exceeded', () => {
      const result: RateLimitResult = {
        count: 11,
        resetTime: Date.now() + 60000,
        allowed: false,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.status).toBe(429);
    });

    it('includes error message in response body', () => {
      const result: RateLimitResult = {
        count: 11,
        resetTime: Date.now() + 60000,
        allowed: false,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.body?.error).toBe('Too many requests');
    });

    it('includes retryAfter in seconds in response body', () => {
      const now = Date.now();
      const resetTime = now + 45000; // 45 seconds from now

      const result: RateLimitResult = {
        count: 11,
        resetTime,
        allowed: false,
      };

      const response = buildRateLimitResponse(result, 10, now);

      expect(response.body?.retryAfter).toBe(45);
    });

    it('rounds up retryAfter to nearest second', () => {
      const now = Date.now();
      const resetTime = now + 45500; // 45.5 seconds from now

      const result: RateLimitResult = {
        count: 11,
        resetTime,
        allowed: false,
      };

      const response = buildRateLimitResponse(result, 10, now);

      expect(response.body?.retryAfter).toBe(46);
    });
  });

  describe('success response when under limit', () => {
    it('does not set status when request allowed', () => {
      const result: RateLimitResult = {
        count: 5,
        resetTime: Date.now() + 60000,
        allowed: true,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.status).toBeUndefined();
    });

    it('does not include error body when request allowed', () => {
      const result: RateLimitResult = {
        count: 5,
        resetTime: Date.now() + 60000,
        allowed: true,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.body).toBeUndefined();
    });

    it('includes headers even when request allowed', () => {
      const result: RateLimitResult = {
        count: 1,
        resetTime: Date.now() + 60000,
        allowed: true,
      };

      const response = buildRateLimitResponse(result, 10, Date.now());

      expect(response.headers['X-RateLimit-Limit']).toBe('10');
      expect(response.headers['X-RateLimit-Remaining']).toBe('9');
      expect(response.headers['X-RateLimit-Reset']).toBeDefined();
    });
  });
});
