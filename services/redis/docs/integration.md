# Redis Integration Guide

Redis is an in-memory data store available to your app for caching, queues, and
pub/sub messaging.

## What the template uses Redis for (out of the box)

Exactly one thing: **distributed rate limiting**. The app's rate-limit store
(`src/server/lib/rate-limiter.ts`) uses Redis when `REDIS_URL` is set so
request budgets hold across multiple app replicas — which matters on the
Kubernetes tiers. On single-server Compose deploys the built-in in-memory
limiter is functionally equivalent (counters reset on redeploy). There is no
query/object/session cache in the shipped template — sessions are stateless
JWTs. Everything beyond rate limiting is yours to build on the connection
below.

## Connection Details

- **URL**: `REDIS_URL` (`redis://:<password>@redis:6379`) — wired into the app
  container by the addon overlay (compose) and the `vibecarbon-secrets` Secret
  (k8s); this is the variable your code should read
- **Host**: `redis` (internal) / `localhost` (external, dev only)
- **Port**: `6379`
- **Password**: See `REDIS_PASSWORD` in `.env.local` (keep it URL-safe — it is
  embedded in `REDIS_URL`)

## Usage in Your Application

### Server-Side Integration

`ioredis` is already a dependency (the rate limiter uses it). Create
`src/server/lib/redis.ts`:

```typescript
import Redis from 'ioredis';
import { env } from './env';

export const redis = new Redis(env.REDIS_URL ?? 'redis://localhost:6379', {
});

// Connection event handlers
redis.on('connect', () => console.log('Redis connected'));
redis.on('error', (err) => console.error('Redis error:', err));
```

### Caching Example

```typescript
import { redis } from './lib/redis';

// Cache a value for 1 hour
await redis.setex('user:123', 3600, JSON.stringify(userData));

// Retrieve cached value
const cached = await redis.get('user:123');
if (cached) {
  return JSON.parse(cached);
}
```

### Session Storage

```typescript
import { redis } from './lib/redis';

// Store session
await redis.hset(`session:${sessionId}`, {
  userId: user.id,
  email: user.email,
  createdAt: Date.now(),
});
await redis.expire(`session:${sessionId}`, 86400); // 24 hours

// Retrieve session
const session = await redis.hgetall(`session:${sessionId}`);
```

### Rate Limiting

```typescript
import { redis } from './lib/redis';

async function rateLimit(key: string, limit: number, windowSecs: number): Promise<boolean> {
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, windowSecs);
  }
  return current <= limit;
}

// Usage: 100 requests per minute per IP
const allowed = await rateLimit(`ratelimit:${ip}`, 100, 60);
```

### Pub/Sub Example

```typescript
import Redis from 'ioredis';

const subscriber = new Redis({ /* config */ });
const publisher = new Redis({ /* config */ });

// Subscribe to channel
subscriber.subscribe('notifications', (err, count) => {
  console.log(`Subscribed to ${count} channels`);
});

subscriber.on('message', (channel, message) => {
  console.log(`Received ${message} from ${channel}`);
});

// Publish message
await publisher.publish('notifications', JSON.stringify({ type: 'alert', data: '...' }));
```

## Environment Variables

`vibecarbon add redis` generates these for you — nothing to add by hand:

```env
REDIS_ENABLED=true
REDIS_PASSWORD=<generated, URL-safe>
```

`REDIS_URL` is derived from them at deploy time (compose overlay env / k8s
`vibecarbon-secrets`) — read it via `env.REDIS_URL` in server code.

## Docker Commands

```bash
# View Redis logs
pnpm docker:logs redis

# Connect to Redis CLI
docker exec -it {{PROJECT_NAME}}-redis redis-cli -a $REDIS_PASSWORD

# Monitor Redis commands in real-time
docker exec -it {{PROJECT_NAME}}-redis redis-cli -a $REDIS_PASSWORD MONITOR
```

## Performance Tips

1. **Use pipelining** for multiple commands:
   ```typescript
   const pipeline = redis.pipeline();
   pipeline.get('key1');
   pipeline.get('key2');
   const results = await pipeline.exec();
   ```

2. **Set appropriate TTLs** to prevent memory bloat

3. **Use Redis data structures** (hashes, sets, sorted sets) instead of serialized JSON when possible

4. **Monitor memory usage**:
   ```bash
   redis-cli -a $REDIS_PASSWORD INFO memory
   ```
