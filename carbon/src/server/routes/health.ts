import { Hono } from 'hono';
import { getAdminStatus, isAdminReady } from '../auth/admin-status';
import { pingDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import { logger } from '../lib/logger';
import type { HonoVariables } from '../types';

const healthRoutes = new Hono<{ Variables: HonoVariables }>();

// Liveness probe: returns 200 if the server process is running.
// No external dependency checks — if this handler executes, the server is alive.
// `adminReady` says whether the startup bootstrap has confirmed the
// ADMIN_EMAIL super admin can sign in; `adminStatus` says why not
// (pending, or terminal: skipped / refused / failed, see auth/admin-status.ts).
// `vibecarbon deploy` waits for ready and stops early on a terminal status.
healthRoutes.get('/', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    adminReady: isAdminReady(),
    adminStatus: getAdminStatus(),
  });
});

// Whether the last readiness probe found the database up. Probes arrive every
// few seconds from the orchestrator, so the outage is logged once, when it
// starts (with the cause), and once more when it ends, not on every probe.
let dbHealthy = true;

// Readiness probe: returns 200 only when the app can serve traffic, i.e.
// Postgres answers. pingDb never throws; while the db is unreachable (still
// starting, restarting) this is a 503 and the server itself keeps running.
healthRoutes.get('/ready', async (c) => {
  const ping = await pingDb();
  if (ping.ok) {
    if (!dbHealthy) {
      logger.info('Readiness recovered: the database answers again');
      dbHealthy = true;
    }
    return c.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        supabase: 'connected',
      },
    });
  }

  if (dbHealthy) {
    logger.error(
      { err: dbErrorForLog(ping.error) },
      'Readiness check failed: database unreachable (logged once until it recovers)'
    );
    dbHealthy = false;
  }
  return c.json(
    {
      status: 'not_ready',
      timestamp: new Date().toISOString(),
    },
    503
  );
});

export { healthRoutes };
