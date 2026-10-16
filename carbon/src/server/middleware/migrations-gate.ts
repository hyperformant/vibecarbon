import { createMiddleware } from 'hono/factory';
import { areMigrationsApplied } from '../db/migration-status';

/**
 * Serve nothing but the health routes until the database migrations are
 * applied (db/startup.ts migrateAtStartup). Before that, a route could read
 * or write a table that does not exist yet, or one a failed migration left
 * as it was; a 503 says "not ready" plainly instead. /api/health keeps
 * answering, so `vibecarbon deploy` and the orchestrator's probes see
 * `migrationStatus` (and /api/health/ready reports not ready).
 *
 * `isApplied` is a test seam.
 */
export function migrationsGate(isApplied: () => boolean = areMigrationsApplied) {
  return createMiddleware(async (c, next) => {
    if (isApplied()) return next();
    const path = c.req.path;
    if (path === '/api/health' || path.startsWith('/api/health/')) return next();
    c.header('Retry-After', '5');
    return c.json(
      { error: 'The server is starting: database migrations are not applied yet' },
      503
    );
  });
}
