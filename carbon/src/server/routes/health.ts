import { Hono } from 'hono';
import { pingDb } from '../db/client';
import { logger } from '../lib/logger';
import type { HonoVariables } from '../types';

const healthRoutes = new Hono<{ Variables: HonoVariables }>();

// Liveness probe: returns 200 if the server process is running.
// No external dependency checks — if this handler executes, the server is alive.
healthRoutes.get('/', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Readiness probe: returns 200 only when the app can serve traffic, i.e.
// Postgres answers. pingDb never throws; while the db is unreachable (still
// starting, restarting) this is a 503 and the server itself keeps running.
healthRoutes.get('/ready', async (c) => {
  if (await pingDb()) {
    return c.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        supabase: 'connected',
      },
    });
  }

  logger.error('Readiness check failed: database unreachable');
  return c.json(
    {
      status: 'not_ready',
      timestamp: new Date().toISOString(),
    },
    503
  );
});

export { healthRoutes };
