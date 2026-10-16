import { Hono } from 'hono';
import { getAdminStatus, isAdminReady } from '../auth/admin-status';
import { pingDb } from '../db/client';
import { dbErrorForLog } from '../db/errors';
import {
  areMigrationsApplied,
  getMigrationError,
  getMigrationStatus,
} from '../db/migration-status';
import { logger } from '../lib/logger';
import type { HonoVariables } from '../types';

const healthRoutes = new Hono<{ Variables: HonoVariables }>();

// Liveness probe: returns 200 if the server process is running.
// No external dependency checks — if this handler executes, the server is alive.
// `adminReady` says whether the startup bootstrap has confirmed the
// ADMIN_EMAIL super admin can sign in; `adminStatus` says why not
// (pending, or terminal: skipped / refused / failed, see auth/admin-status.ts).
// `migrationStatus` (pending | applied | failed, plus `migrationError`, a
// SQLSTATE, when failed) says whether the database migrations are applied
// (db/migration-status.ts). `vibecarbon deploy` waits for both, and stops
// early on a terminal status.
healthRoutes.get('/', (c) => {
  const migrationError = getMigrationError();
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    adminReady: isAdminReady(),
    adminStatus: getAdminStatus(),
    migrationStatus: getMigrationStatus(),
    ...(migrationError ? { migrationError } : {}),
  });
});

// Whether the last readiness probe found the database up. Probes arrive every
// few seconds from the orchestrator, so the outage is logged once, when it
// starts (with the cause), and once more when it ends, not on every probe.
let dbHealthy = true;

// Readiness probe: returns 200 only when the app can serve traffic, i.e.
// migrations are applied and Postgres answers. pingDb never throws; while
// the db is unreachable (still starting, restarting) this is a 503 and the
// server itself keeps running.
healthRoutes.get('/ready', async (c) => {
  // Not ready to serve until the migrations are applied: every other route
  // answers 503 until then (middleware/migrations-gate.ts).
  if (!areMigrationsApplied()) {
    return c.json(
      {
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        migrationStatus: getMigrationStatus(),
      },
      503
    );
  }
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
