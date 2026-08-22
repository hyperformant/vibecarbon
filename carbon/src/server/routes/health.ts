import { Hono } from 'hono';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
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

// Readiness probe: returns 200 only when the app can serve traffic
// (i.e., database/Supabase is reachable).
healthRoutes.get('/ready', async (c) => {
  try {
    const { error } = await supabaseAdmin.from('organizations').select('id').limit(0);

    if (error) {
      throw error;
    }

    return c.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        supabase: 'connected',
      },
    });
  } catch (error) {
    logger.error({ error }, 'Readiness check failed');

    return c.json(
      {
        status: 'not_ready',
        timestamp: new Date().toISOString(),
      },
      503
    );
  }
});

export { healthRoutes };
