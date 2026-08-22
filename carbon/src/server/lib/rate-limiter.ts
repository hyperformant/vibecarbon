import type { Context, Next } from 'hono';
import Redis from 'ioredis';
import { getClientIp } from './client-ip';
import { env } from './env';
import { logger } from './logger';

// =============================================================================
// RATE LIMIT STORE INTERFACE
// =============================================================================

interface RateLimitResult {
  count: number;
  resetTime: number;
  allowed: boolean;
}

interface RateLimitStore {
  increment(key: string, windowMs: number, max: number): Promise<RateLimitResult>;
  isHealthy(): boolean;
}

// =============================================================================
// IN-MEMORY STORE (fallback when Redis unavailable)
// =============================================================================

class InMemoryStore implements RateLimitStore {
  private store: Map<string, { count: number; resetTime: number }> = new Map();

  constructor() {
    // Clean up old entries every minute
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.store.entries()) {
        if (value.resetTime < now) {
          this.store.delete(key);
        }
      }
    }, 60000);
  }

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
// REDIS STORE (for distributed rate limiting)
// =============================================================================

class RedisStore implements RateLimitStore {
  private client: Redis;
  private healthy = false;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => {
        if (times > 3) {
          logger.warn('Redis connection failed, rate limiting will use in-memory fallback');
          return null; // Stop retrying
        }
        return Math.min(times * 100, 1000);
      },
      lazyConnect: true,
    });

    this.client.on('connect', () => {
      this.healthy = true;
      logger.info('Redis connected for rate limiting');
    });

    this.client.on('error', (err) => {
      this.healthy = false;
      logger.warn({ err: err.message }, 'Redis error');
    });

    this.client.on('close', () => {
      this.healthy = false;
    });

    // Attempt connection
    this.client.connect().catch(() => {
      // Connection failed, will use fallback
    });
  }

  async increment(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowKey = `ratelimit:${key}:${Math.floor(now / windowMs)}`;
    const resetTime = Math.ceil(now / windowMs) * windowMs + windowMs;

    try {
      // Use Redis MULTI for atomic increment and TTL set
      const results = await this.client
        .multi()
        .incr(windowKey)
        .pexpire(windowKey, windowMs + 1000) // Extra 1s buffer
        .exec();

      if (!results || results[0][0]) {
        throw new Error('Redis transaction failed');
      }

      const count = results[0][1] as number;
      return {
        count,
        resetTime,
        allowed: count <= max,
      };
    } catch (err) {
      // Redis operation failed, mark as unhealthy
      this.healthy = false;
      throw err;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }
}

// =============================================================================
// HYBRID STORE (Redis with in-memory fallback)
// =============================================================================

class HybridStore implements RateLimitStore {
  private redisStore: RedisStore | null = null;
  private memoryStore: InMemoryStore;
  private warnedAboutFallback = false;

  constructor(redisUrl?: string) {
    this.memoryStore = new InMemoryStore();

    if (redisUrl) {
      this.redisStore = new RedisStore(redisUrl);
    } else if (env.NODE_ENV === 'production') {
      logger.warn(
        'REDIS_URL not configured. Rate limiting uses in-memory store which does not scale across multiple instances. ' +
          'For production with multiple replicas, configure Redis: vibecarbon add redis'
      );
    }
  }

  async increment(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    // Try Redis first if available
    if (this.redisStore?.isHealthy()) {
      try {
        return await this.redisStore.increment(key, windowMs, max);
      } catch {
        // Fall through to memory store
        if (!this.warnedAboutFallback) {
          this.warnedAboutFallback = true;
          logger.warn('Redis unavailable, falling back to in-memory rate limiting');
        }
      }
    }

    // Use in-memory fallback
    return this.memoryStore.increment(key, windowMs, max);
  }

  isHealthy(): boolean {
    return this.redisStore?.isHealthy() || this.memoryStore.isHealthy();
  }
}

// =============================================================================
// SINGLETON STORE INSTANCE
// =============================================================================

let store: HybridStore | null = null;

function getStore(): HybridStore {
  if (!store) {
    store = new HybridStore(env.REDIS_URL);
  }
  return store;
}

// =============================================================================
// RATE LIMITER MIDDLEWARE
// =============================================================================

export function createRateLimiter(options: { windowMs: number; max: number }) {
  return async (c: Context, next: Next) => {
    // SECURITY: prefer a per-user bucket for authenticated requests so a single
    // account behind a shared/NAT'd IP can't exhaust everyone else's budget (and
    // can't dodge its own limit by rotating IPs). Falls back to the trusted
    // client IP — resolved via getClientIp, which ignores attacker-supplied
    // X-Forwarded-For entries. Note: the app-wide limiters in index.ts run
    // before the auth middleware sets `user`, so those key by IP.
    const user = c.get('user');
    const identifier = user?.id ? `user:${user.id}` : `ip:${getClientIp(c)}`;
    const key = `${identifier}:${c.req.path}`;
    const now = Date.now();

    const result = await getStore().increment(key, options.windowMs, options.max);
    const remaining = Math.max(0, options.max - result.count);
    const reset = Math.ceil(result.resetTime / 1000);

    c.res.headers.set('X-RateLimit-Limit', String(options.max));
    c.res.headers.set('X-RateLimit-Remaining', String(remaining));
    c.res.headers.set('X-RateLimit-Reset', String(reset));

    if (!result.allowed) {
      // Log rate limit violations for security monitoring
      logger.warn({ identifier, path: c.req.path, count: result.count }, 'Rate limit exceeded');
      return c.json(
        { error: 'Too many requests', retryAfter: Math.ceil((result.resetTime - now) / 1000) },
        429
      );
    }

    await next();
  };
}
